#!/usr/bin/env bash
# unwedge.sh -- recover desolate-dind when it stops responding and will not stop.
#
#   ./cli.sh unwedge              # diagnose only; prints findings + next step
#   ./cli.sh unwedge --force      # escalate: rm -f, then kill init, then shim
#   ./cli.sh unwedge --daemon     # + restart the VM's dockerd
#   ./cli.sh unwedge --vm         # + restart the whole Colima VM
#
# WHAT THE ERROR MEANS
#
#   "tried to kill container, but did not receive an exit event"
#
# dockerd sent SIGKILL and containerd never reported the process gone. That is
# almost always because dind's init is in D state (uninterruptible sleep):
# blocked inside a kernel syscall, where signals are QUEUED but not delivered
# until the syscall returns. A D-state process cannot be killed -- not by
# SIGKILL, not by root, not by anything. `kill -9` harder is not a strategy;
# the ladder below works by removing what the process is BLOCKED ON, or by
# restarting the supervisor that lost track of it.
#
# So this script diagnoses first and escalates only when told to. Each rung is
# more disruptive than the last, and it stops the moment the container is gone.
#
# WHAT IS NEVER AT RISK HERE
#
# Nothing in this script touches a volume. Your code (workspaces), deploy keys
# (keyring-keys), editor state (vscode-home) and inner images
# (dind-sysbox-data) survive every rung, INCLUDING a full VM restart -- Colima
# volumes live in the VM's disk image, which persists across stop/start.
#
# The two commands that DO destroy them are `cli.sh down -v` and `colima
# delete`. Neither is a fix for this and neither appears below. If you find
# yourself reaching for either, stop: a wedged container is a stuck process,
# not corrupted data, and deleting the data does not unstick a process.
set -uo pipefail

CONTAINER=desolate-dind
COLIMA_PROFILE="${COLIMA_PROFILE:-desolate}"

FORCE=0; DAEMON=0; VMRESTART=0
for a in "$@"; do
  case "$a" in
    --force)  FORCE=1 ;;
    --daemon) FORCE=1; DAEMON=1 ;;
    --vm)     FORCE=1; DAEMON=1; VMRESTART=1 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unwedge.sh: unknown option $a" >&2; exit 1 ;;
  esac
done

ok()   { echo "  ok    $*"; }
bad()  { echo "  FAIL  $*"; }
note() { echo "        $*"; }
step() { echo; echo "== $* =="; }

# Complex remote commands go in on STDIN, not as arguments. `colima ssh -- ...`
# re-parses its command line remotely, which is the same trap SECRET_LIST_JQ
# documents -- quotes and spaces do not survive. Piping a script sidesteps it
# entirely.
vm_sh()      { colima ssh -p "$COLIMA_PROFILE" -- sh -s; }
vm_sudo_sh() { colima ssh -p "$COLIMA_PROFILE" -- sudo sh -s; }

gone() { ! docker inspect "$CONTAINER" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
step "1. container state"
# ---------------------------------------------------------------------------

if gone; then
  # `docker inspect` also fails when the DAEMON is unreachable, which would
  # otherwise print "nothing wedged" at someone whose VM is down -- the same
  # false-green as the sysbox check above. Distinguish the two.
  if ! docker info >/dev/null 2>&1; then
    bad "cannot reach the Docker daemon -- nothing can be diagnosed"
    note "check the context and the VM:"
    note "  docker context ls          (expect colima-$COLIMA_PROFILE to be current)"
    note "  colima list                (expect $COLIMA_PROFILE to be Running)"
    exit 1
  fi
  ok "$CONTAINER does not exist -- nothing wedged"
  note "bring the stack back with: ./cli.sh up"
  exit 0
fi

STATUS=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)
PID=$(docker inspect -f '{{.State.Pid}}' "$CONTAINER" 2>/dev/null)
CID=$(docker inspect -f '{{.Id}}' "$CONTAINER" 2>/dev/null)
echo "  status=$STATUS  pid=$PID"
echo "  id=$CID"

if [ "$STATUS" = running ] && [ "${PID:-0}" -eq 0 ]; then
  bad "docker says running but the init pid is 0 -- dockerd lost the process"
  note "this is a bookkeeping failure, not a stuck process: skip to --daemon"
fi

# ---------------------------------------------------------------------------
step "2. VM disk (the most common root cause)"
# ---------------------------------------------------------------------------
# When the VM's filesystem fills, overlayfs and containerd operations block in
# the kernel, and every process touching them goes D-state. dind is the biggest
# consumer in the stack by far: dind-sysbox-data holds every image every
# devcontainer has ever pulled, and nothing prunes it. A full disk presents
# exactly as "container stopped responding and will not die".
DF=$(printf 'df -h /var/lib/docker / 2>/dev/null\n' | vm_sh 2>/dev/null)
if [ -z "$DF" ]; then
  bad "could not reach the VM to check disk (colima list)"
elif echo "$DF" | sed 's/^/  /' && echo "$DF" | awk 'NR>1 && $5+0 >= 90 {found=1} END {exit !found}'; then
  bad "a filesystem is >=90% full -- this is very likely the cause"
  note "reclaim inner images AFTER recovery, from the orchestrator:"
  note "  ./cli.sh observe docker system df"
  note "  ./cli.sh observe docker image prune -a"
else
  ok "disk has headroom"
fi

# ---------------------------------------------------------------------------
step "3. is the init process actually stuck?"
# ---------------------------------------------------------------------------
STUCK=0
if [ "${PID:-0}" -gt 0 ]; then
  PS=$(printf 'ps -o pid=,stat=,wchan:28=,comm= -p %s 2>/dev/null\n' "$PID" | vm_sh 2>/dev/null)
  if [ -z "$PS" ]; then
    bad "pid $PID is not in the VM's process table"
    note "the process is already gone; dockerd has not noticed. --daemon fixes this"
  else
    echo "  $PS"
    # STAT column: D is uninterruptible sleep, Z is a zombie awaiting reap.
    case "$(echo "$PS" | awk '{print $2}')" in
      D*) STUCK=1
          bad "init is in D state -- SIGKILL will NOT be delivered"
          note "what it is blocked on (kernel stack):"
          printf 'cat /proc/%s/stack 2>/dev/null | head -6\n' "$PID" | vm_sudo_sh 2>/dev/null | sed 's/^/          /'
          note "killing this pid cannot work. Go to --daemon, then --vm." ;;
      Z*) bad "init is a zombie -- the shim never reaped it (see step 5)" ;;
      *)  ok "init is in a killable state" ;;
    esac
  fi
fi

# ---------------------------------------------------------------------------
step "3b. is dind the victim rather than the culprit?"
# ---------------------------------------------------------------------------
# dind is itself a Docker daemon, and a daemon cannot finish shutting down
# until it has stopped the containers it supervises. So an INNER container with
# a lost exit event blocks dind's shutdown indefinitely, and the outer daemon
# then reports the exact same "did not receive an exit event" about dind.
#
# The two cases look identical from the Mac and need opposite fixes. Reading
# dind's own log separates them: if the error names a container id that is not
# dind's, the wedge is one level down, and restarting the VM to clear it is
# like demolishing the house to open a stuck door.
DLOG=$(docker logs "$CONTAINER" --tail 400 2>&1)
INNER_WEDGE=0
if echo "$DLOG" | grep -q 'did not receive an exit event'; then
  INNER_ID=$(echo "$DLOG" | grep -o 'container=[0-9a-f]\{64\}' | tail -1 | cut -d= -f2)
  INNER_WEDGE=1
  bad "dind is blocked on an INNER container, not stuck itself"
  [ -n "$INNER_ID" ] && note "inner container: $INNER_ID"
  echo "$DLOG" | grep -q "Processing signal 'terminated'" \
    && note "dind has received SIGTERM and is stuck mid-shutdown behind it"
  note "the fix is to kill that container's shim INSIDE dind -- far cheaper"
  note "than restarting dockerd or the VM"
else
  ok "no inner container is holding dind's shutdown open"
fi

# Inner shims, read from /proc: dind is Alpine, and busybox ps has no -o.
SHIMS=$(docker exec "$CONTAINER" sh -c '
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    cmd=$(tr "\0" " " < "$p/cmdline" 2>/dev/null)
    case "$cmd" in
      *containerd-shim*) printf "%s %s\n" "$pid" "$(awk "{print \$3}" "$p/stat" 2>/dev/null)" ;;
    esac
  done' 2>/dev/null)
if [ -n "$SHIMS" ]; then
  echo "  inner shims (pid state):"
  echo "$SHIMS" | sed 's/^/    /'
  echo "$SHIMS" | awk '$2 ~ /^D/ {f=1} END {exit !f}' \
    && bad "an inner shim is in D state -- unkillable; escalate to --daemon"
fi

# ---------------------------------------------------------------------------
step "4. sysbox daemons"
# ---------------------------------------------------------------------------
# dind runs under sysbox-runc, which is not just a runtime: sysbox-fs is a FUSE
# server backing the container's emulated /proc and /sys, and sysbox-mgr owns
# its uid-shifting and inner-docker state. If sysbox-fs wedges, EVERY process
# in the container that reads /proc blocks in D state -- which looks exactly
# like the symptom being debugged. This is the one rung specific to your
# runtime choice, and worth checking before touching dockerd.
SBX=$(printf 'for u in sysbox-mgr sysbox-fs; do printf "%%s %%s\\n" "$u" "$(systemctl is-active $u 2>/dev/null)"; done\n' | vm_sh 2>/dev/null)
if [ -z "$SBX" ]; then
  # Empty means the ssh itself failed, NOT that the daemons are fine. Reporting
  # "ok" here would be the worst kind of wrong: a green line for a check that
  # never ran.
  bad "could not reach the VM -- is Colima up? (colima list)"
elif echo "$SBX" | sed 's/^/  /' && echo "$SBX" | grep -qv ' active$'; then
  bad "a sysbox daemon is not active -- restart it before anything heavier:"
  note "  colima ssh -p $COLIMA_PROFILE -- sudo systemctl restart sysbox-fs sysbox-mgr"
  note "  (this disturbs every sysbox container, which here is only dind)"
else
  ok "sysbox-mgr and sysbox-fs are active"
fi

# ---------------------------------------------------------------------------
if [ "$FORCE" -eq 0 ]; then
  step "diagnosis only -- nothing was changed"
  if [ "$STUCK" -eq 1 ]; then
    echo "  The init process is unkillable, so removing the container cannot"
    echo "  succeed until dockerd is restarted. Recommended:"
    echo
    echo "      ./cli.sh unwedge --daemon"
    echo
    echo "  If that leaves it stuck, the block is below dockerd:"
    echo
    echo "      ./cli.sh unwedge --vm"
  else
    echo "  Recommended:"
    echo
    echo "      ./cli.sh unwedge --force"
  fi
  echo
  exit 0
fi

# ---------------------------------------------------------------------------
step "5. force removal"
# ---------------------------------------------------------------------------

# The surgical case FIRST. If dind is only blocked behind an inner container,
# killing that container's shim inside dind lets dind's containerd deliver the
# exit event it has been waiting for -- and dind, already holding a SIGTERM,
# finishes its own shutdown and exits by itself. No daemon restart, no VM
# restart, no other container disturbed.
if [ "$INNER_WEDGE" -eq 1 ] && [ -n "${INNER_ID:-}" ]; then
  echo "  killing the inner shim for $INNER_ID inside dind"
  docker exec "$CONTAINER" sh -c "
    for p in /proc/[0-9]*; do
      pid=\${p#/proc/}
      cmd=\$(tr '\\0' ' ' < \"\$p/cmdline\" 2>/dev/null)
      case \"\$cmd\" in *$INNER_ID*) kill -9 \"\$pid\" 2>/dev/null ;; esac
    done" >/dev/null 2>&1
  echo "  waiting up to 15s for dind to finish the shutdown it was blocked on"
  for _ in $(seq 15); do gone && break; sleep 1; done
  gone && ok "dind exited on its own once the inner shim was reaped"
fi

# `restart: unless-stopped` FIRST. A wedged container is still "running" as far
# as dockerd is concerned, so restarting the daemon (step 6) would faithfully
# bring it back -- reviving the exact process being removed. Clearing the
# policy before escalating is what stops the loop.
if ! gone; then
echo "  clearing restart policy (else a daemon restart revives it)"
docker update --restart=no "$CONTAINER" >/dev/null 2>&1 \
  && ok "restart policy set to no" \
  || note "could not clear it; continuing"
fi

if ! gone; then
  echo "  docker rm -f (30s)"
  timeout 30 docker rm -f "$CONTAINER" >/dev/null 2>&1
  gone && ok "removed"
fi

if ! gone && [ "${PID:-0}" -gt 0 ] && [ "$STUCK" -eq 0 ]; then
  echo "  killing init pid $PID in the VM"
  printf 'kill -9 %s 2>/dev/null; sleep 2\n' "$PID" | vm_sudo_sh >/dev/null 2>&1
  timeout 20 docker rm -f "$CONTAINER" >/dev/null 2>&1
  gone && ok "removed after killing init"
fi

if ! gone; then
  # The shim is the process that REPORTS exit events to containerd. If it is
  # the wedged party, the container it supervises can be perfectly dead while
  # dockerd waits forever for news. Killing the shim makes containerd notice.
  echo "  killing the containerd shim for this container"
  printf 'pkill -9 -f %s 2>/dev/null; sleep 2\n' "$CID" | vm_sudo_sh >/dev/null 2>&1
  timeout 20 docker rm -f "$CONTAINER" >/dev/null 2>&1
  gone && ok "removed after killing the shim"
fi

# ---------------------------------------------------------------------------
if ! gone && [ "$DAEMON" -eq 1 ]; then
  step "6. restarting the VM's dockerd"
  # dockerd rebuilds its container state from containerd on startup, which is
  # what clears a lost exit event. It drops every container in the stack, not
  # just dind -- but `down` already removed the other three, and no volume is
  # touched.
  echo "  this restarts ALL containers on the VM's daemon"
  printf 'systemctl restart docker; sleep 5\n' | vm_sudo_sh >/dev/null 2>&1
  sleep 3
  timeout 30 docker rm -f "$CONTAINER" >/dev/null 2>&1
  gone && ok "removed after daemon restart" || bad "still present after daemon restart"
fi

# ---------------------------------------------------------------------------
if ! gone && [ "$VMRESTART" -eq 1 ]; then
  step "7. restarting the Colima VM"
  # The last rung. A D-state process blocked in the kernel outlives dockerd and
  # containerd both; only the kernel going away resolves it. Volumes are in the
  # VM's disk image and survive -- `colima delete` is what would not, and is
  # not what this does.
  echo "  colima stop -f -p $COLIMA_PROFILE   (-f because a graceful stop hangs on the same wedge)"
  colima stop -f -p "$COLIMA_PROFILE" || bad "colima stop failed"
  echo "  colima start -p $COLIMA_PROFILE"
  colima start -p "$COLIMA_PROFILE" || bad "colima start failed"
  gone && ok "gone after VM restart" || bad "STILL present after a VM restart"
fi

# ---------------------------------------------------------------------------
step "8. cleanup"
# ---------------------------------------------------------------------------

if gone; then
  # A force-removed container often leaves its endpoint attached to the
  # network, and the next `up` then fails with "network has active endpoints"
  # -- a confusing second failure that reads like a new problem.
  for n in desolate_dindnet desolate_devnet; do
    docker network disconnect -f "$n" "$CONTAINER" >/dev/null 2>&1 \
      && note "detached stale endpoint from $n"
  done

  # dind publishes a 40-port range. Orphaned docker-proxy processes keep those
  # bound, and `up` then fails with "port is already allocated".
  LEFT=$(printf 'ss -lntp 2>/dev/null | grep -c docker-proxy\n' | vm_sudo_sh 2>/dev/null | tr -d '[:space:]')
  [ -n "$LEFT" ] && [ "$LEFT" != 0 ] && note "$LEFT docker-proxy listeners still bound (usually harmless; a daemon restart clears them)"

  echo
  ok "recovered -- recreate the stack with:  ./cli.sh up"
  note "then confirm the invariants still hold:  ./cli.sh preflight"
  exit 0
fi

echo
bad "$CONTAINER is still present"
if [ "$VMRESTART" -eq 0 ]; then
  note "next rung:  ./cli.sh unwedge $([ "$DAEMON" -eq 1 ] && echo --vm || echo --daemon)"
else
  note "a VM restart did not clear it, which points at the VM's disk or"
  note "storage rather than any one container. Check:"
  note "  colima ssh -p $COLIMA_PROFILE -- df -h"
  note "  colima ssh -p $COLIMA_PROFILE -- sudo dmesg | tail -40"
  note "Do NOT reach for 'colima delete' -- it destroys workspaces and deploy keys."
fi
exit 1
