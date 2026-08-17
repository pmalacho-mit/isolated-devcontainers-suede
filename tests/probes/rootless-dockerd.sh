#!/usr/bin/env bash
# PROBE -- not a test. Answers a capability question about the environment so a
# design decision can be made; it asserts no invariant and gates nothing.
#
# QUESTION: can a devcontainer run ROOTLESS dockerd, unprivileged, inside the
# single shared dind we already have?
#
# This is the alternative SPEC-per-project-dind-v2 asks to price alongside the
# per-project split -- "the same probe day should test both paths and compare".
# Run it next to tests/probes/sibling-docker.sh; the two answer the same
# business question ("can allowPrivileged stop meaning host-adjacent privilege")
# by different means, and the comparison is the point:
#
#   sibling-docker.sh   one dind PER privileged project, devcontainer holds that
#                       dind's socket. New components: supervisor, portal,
#                       per-project bridges and nftables sets.
#   this probe          keep the ONE shared dind, run a rootless daemon inside
#                       the devcontainer. No new components at all -- and no
#                       blast-radius containment either, since every project
#                       still shares one daemon.
#
# The spec's own reading is that the second is a much smaller change if it
# works, and that it probably does not. Each R below is a reason it might not:
#
#   R1  USERNS   rootless docker is user namespaces. Can an unprivileged process
#                inside the devcontainer create one? Ubuntu 24.04 ships
#                kernel.apparmor_restrict_unprivileged_userns=1, which is the
#                specific thing most likely to answer no -- and the devcontainer
#                is TWO namespace levels down (sysbox, then dind).
#   R2  IDMAP    newuidmap/newgidmap have to exist and carry the file capability
#                that lets them write a map, and the user needs /etc/subuid and
#                /etc/subgid ranges. All three are image plumbing, not kernel.
#   R3  DAEMON   does dockerd-rootless actually come up?
#   R4  STORAGE  which driver did it land on? overlay2 in a userns needs kernel
#                >= 5.11; failing that fuse-overlayfs needs /dev/fuse; failing
#                that it falls back to VFS, which copies every layer in full.
#                A VFS answer is a NO wearing a YES costume.
#   R5  RUN      can it run a container and bind-mount from /workspaces?
#   R6  NET      rootless networking is slirp, and the spec calls out its
#                throughput cost. Indicative A/B, not a benchmark.
#
# ANSWERED 2026-08-17, on the VM under sysbox-runc: NO, at R1. An unprivileged
# process inside the devcontainer cannot create a user namespace, so nothing
# rootless can start and R2-R6 were never reached. The VM carries
# kernel.apparmor_restrict_unprivileged_userns=1 -- Ubuntu 24.04's default, and
# the exact switch the spec predicted would decide this.
#
# What the numbers rule out: user.max_user_namespaces is 159944 on the VM and
# 2147483647 inside the devcontainer, so this is a POLICY refusal and not an
# exhausted budget. The unblock would be `--security-opt apparmor=unconfined`
# on every such devcontainer -- which policy.ts refuses by name, and should --
# or clearing the sysctl VM-wide. Neither is worth buying for an option that
# leaves every project sharing one daemon regardless.
#
# sibling-docker.sh answered YES the same day. Prefer it, as the spec says to.
#
# WHAT THIS DOES NOT PROVE. The payload is `docker:29-dind-rootless`, the
# official image built for exactly this, run UNPRIVILEGED -- which is the whole
# question, since Docker's own instructions for that image say --privileged. A
# YES here means the mechanism works and a real devcontainer feature is worth
# building; it does not mean any devcontainer image already does this.
#
# ---------------------------------------------------------------------------
# HOW TO RUN -- on your Mac. The stack does NOT need to be up; this only needs
# the VM with sysbox-runc registered (./cli.sh vm install):
#
#   ./tests/probes/rootless-dockerd.sh
#
# It re-execs itself INSIDE the Colima VM, creates ONE throwaway container named
# desolate-rlprobe-* on the VM daemon plus two throwaway volumes, and removes
# all of it on exit including on failure. It does not touch the desolate stack,
# any project, /workspaces, or anything on your Mac. Paste the SUMMARY back.
#
# `--runc` and DESOLATE_RLPROBE_KEEP=1 work as they do in sibling-docker.sh.
# The --runc caveat is SHARPER here than there: sysbox exists to make a
# container's namespaces work like a machine's, so a rootless daemon that fails
# under plain runc may well succeed under sysbox, and vice versa. R1 in
# particular says nothing at all unless the outer container is a sysbox one.
set -uo pipefail

PROFILE="${COLIMA_PROFILE:-desolate}"
RUNTIME="${DESOLATE_RLPROBE_RUNTIME:-sysbox-runc}"

for arg in "$@"; do
  case "$arg" in
    --runc) RUNTIME=runc ;;
    *) echo "unknown argument '$arg' (only --runc is understood)" >&2; exit 2 ;;
  esac
done

if [ "${DESOLATE_RLPROBE_INVM:-}" != 1 ]; then
  if ! command -v colima >/dev/null 2>&1; then
    echo "This probe must run from the Mac (colima not found on PATH)." >&2
    echo "If you are already somewhere with a usable daemon, re-run with" >&2
    echo "DESOLATE_RLPROBE_INVM=1 (and --runc if it has no sysbox-runc)." >&2
    exit 1
  fi
  echo "== entering the Colima VM (profile '$PROFILE') =="
  exec colima ssh -p "$PROFILE" -- \
    env DESOLATE_RLPROBE_INVM=1 DESOLATE_RLPROBE_RUNTIME="$RUNTIME" bash -s < "$0"
  echo "could not enter the VM via 'colima ssh -p $PROFILE'." >&2
  exit 1
fi

# ---- from here on `docker` is the daemon that hosts the shared dind ---------

DIND=desolate-rlprobe-dind          # stands in for the ONE shared desolate-dind
DEV=desolate-rlprobe-dev            # the devcontainer running rootless dockerd
WS_VOL=desolate-rlprobe-ws          # stands in for the workspaces volume
DATA_VOL=desolate-rlprobe-data      # the shared dind's image store

DIND_IMG="docker:29-dind"
ROOTLESS_IMG="docker:29-dind-rootless"
RL_SOCK=/run/user/1000/docker.sock  # where dockerd-rootless publishes it
PROJ=rlproj

R1="UNKNOWN"; R2="UNKNOWN"; R3="UNKNOWN"; R4="UNKNOWN"; R5="UNKNOWN"; R6="UNKNOWN"

note() { printf '      %s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }
tail4(){ tail -n 4 | sed 's/^/        /'; }

vm()    { docker "$@"; }                        # hosts the shared dind
inner() { docker exec "$DIND" docker "$@"; }    # the shared dind's daemon
dev()   { inner exec "$DEV" "$@"; }             # inside the devcontainer
# The rootless daemon, driven from inside the devcontainer that owns it.
rootless() { dev env DOCKER_HOST="unix://$RL_SOCK" docker "$@"; }

cleanup() {
  [ -n "${DESOLATE_RLPROBE_KEEP:-}" ] && {
    printf '\n  kept: docker rm -f %s && docker volume rm -f %s %s\n' \
      "$DIND" "$WS_VOL" "$DATA_VOL"
    return
  }
  vm rm -f "$DIND" >/dev/null 2>&1
  vm volume rm -f "$WS_VOL" "$DATA_VOL" >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

# --- 0. the host daemon, and the kernel switches that decide R1 -------------

require_runtime() {
  if ! vm info >/dev/null 2>&1; then
    bad "cannot reach the docker daemon"
    note "on the Mac:  colima start -p $PROFILE"
    exit 1
  fi
  [ "$RUNTIME" = sysbox-runc ] || {
    ok "runtime: runc + --privileged (APPROXIMATION -- and see the header)"
    return
  }
  if vm info --format '{{json .Runtimes}}' 2>/dev/null | grep -q sysbox-runc; then
    ok "sysbox-runc is registered -- the shared dind runs UNPRIVILEGED"
  else
    bad "sysbox-runc is NOT registered on this daemon"
    note "install it first:  ./cli.sh vm install"
    note "or accept the weaker run:  $0 --runc"
    exit 1
  fi
}

# Read on the host, before anything is nested, because these are what a failed
# R1 will point at -- and a sysctl read from inside sysbox is a virtualised one.
report_userns_switches() {
  for knob in kernel.unprivileged_userns_clone user.max_user_namespaces \
              kernel.apparmor_restrict_unprivileged_userns; do
    note "$knob = $(sysctl -n "$knob" 2>/dev/null || echo '<not present>')"
  done
}

containment_args() {
  case "$RUNTIME" in
    sysbox-runc) printf '%s\n' --runtime=sysbox-runc ;;
    runc)        printf '%s\n' --privileged ;;
  esac
}

# --- 1. the shared dind, exactly as the stack runs one today ----------------

start_shared_dind() {
  vm rm -f "$DIND" >/dev/null 2>&1
  vm volume rm -f "$WS_VOL" "$DATA_VOL" >/dev/null 2>&1
  mapfile -t containment < <(containment_args)

  vm run -d --name "$DIND" "${containment[@]}" \
    -e DOCKER_TLS_CERTDIR="" \
    -v "$WS_VOL:/workspaces" \
    -v "$DATA_VOL:/var/lib/docker" \
    "$DIND_IMG" >/dev/null 2>&1 \
    || { bad "could not start the shared dind"; exit 1; }

  for _ in $(seq 1 60); do inner info >/dev/null 2>&1 && { ok "shared dind is up"; return; }; sleep 1; done
  bad "the shared dind never became reachable"
  vm logs "$DIND" 2>&1 | tail4
  exit 1
}

# The dind pulls nothing: an intercepting proxy or an offline VM would otherwise
# read as a rootless failure.
preload_images() {
  for image in "$ROOTLESS_IMG" alpine:3; do
    vm image inspect "$image" >/dev/null 2>&1 || vm pull -q "$image" >/dev/null 2>&1 || {
      bad "the host daemon cannot pull $image"
      exit 1
    }
    vm save "$image" | vm exec -i "$DIND" docker load >/dev/null 2>&1 || {
      bad "could not load $image into the shared dind"
      exit 1
    }
  done
  ok "loaded $ROOTLESS_IMG and alpine:3 into the dind (no pulls inside it)"
}

seed_workspace() {
  vm exec -i -u 0 "$DIND" sh -s <<SEED >/dev/null 2>&1
set -e
mkdir -p /workspaces/$PROJ
echo WORKSPACE-MARKER > /workspaces/$PROJ/marker.txt
chown -R 1000:1000 /workspaces
SEED
  vm exec "$DIND" test -s "/workspaces/$PROJ/marker.txt" || {
    bad "could not seed the project inside the dind"
    exit 1
  }
  ok "seeded /workspaces/$PROJ inside the dind"
}

# --- the devcontainer: unprivileged, with the rootless daemon in it ---------

start_devcontainer() {
  # No --privileged and no --cap-add, which is the entire question. --security-opt
  # is left alone too: turning seccomp off here would be answering a different
  # question than the one a real devcontainer gets to ask, since policy.ts
  # refuses `seccomp=unconfined` outright.
  inner run -d --name "$DEV" \
    -v "/workspaces/$PROJ:/workspaces/$PROJ" \
    "$ROOTLESS_IMG" sleep infinity >/dev/null 2>&1 \
    || { bad "could not start the devcontainer stand-in"; exit 1; }
  ok "devcontainer is up, unprivileged, running as $(dev id -un 2>/dev/null | tr -d '\r')"
}

# --- R1: user namespaces ----------------------------------------------------

# Creating the namespace only. Populating its uid map is a separate privilege
# with a separate failure -- that is R2's question, and folding the two together
# here (`unshare -Ur`) reports a missing setgroups write as a kernel refusal.
check_userns() {
  local out
  out=$(dev unshare -U true 2>&1)
  if [ -z "$out" ]; then
    ok "an unprivileged process in the devcontainer created a user namespace"
    R1="YES"
    return 0
  fi
  bad "it cannot create a user namespace -- rootless docker is impossible here"
  note "unshare said: $out"
  note "max_user_namespaces inside the devcontainer: $(dev sh -c 'cat /proc/sys/user/max_user_namespaces 2>/dev/null' | tr -d '\r')"
  R1="NO -- ${out#unshare: }"
  return 1
}

# --- R2: the setuid-shaped plumbing -----------------------------------------

check_idmap_tools() {
  local subuid mode caps
  subuid=$(dev sh -c 'grep "^$(id -un):" /etc/subuid /etc/subgid 2>/dev/null | tr "\n" " "' | tr -d '\r')
  mode=$(dev sh -c 'ls -l /usr/bin/newuidmap 2>/dev/null' | tr -d '\r')
  # An image without getcap cannot answer the capability half at all, and
  # reading that silence as "no capability" would blame the plumbing for
  # something only R3 can actually decide.
  caps=$(dev sh -c 'command -v getcap >/dev/null 2>&1 && getcap /usr/bin/newuidmap 2>/dev/null || echo NO-GETCAP' | tr -d '\r')

  if [ -z "$subuid" ]; then
    bad "the user has no /etc/subuid or /etc/subgid range"
    R2="NO -- no subuid/subgid range"
    return
  fi
  ok "subuid/subgid ranges present: $subuid"
  note "newuidmap: ${mode:-<absent>}"

  case "$mode:$caps" in
    *rws*)        ok "newuidmap is setuid";       R2="YES -- ranges and a setuid newuidmap" ;;
    *cap_setuid*) ok "newuidmap has cap_setuid";  R2="YES -- ranges and a capability-carrying newuidmap" ;;
    *NO-GETCAP*)  note "no getcap in the image, so its file capabilities cannot be read here"
                  R2="ranges yes; newuidmap is not setuid and its capabilities are unreadable -- R3 decides" ;;
    *)            bad "newuidmap can neither setuid nor carry a capability"
                  R2="NO -- newuidmap cannot write a map" ;;
  esac
}

# --- R3/R4: the daemon, and what it had to fall back to ---------------------

start_rootless_daemon() {
  dev sh -c 'XDG_RUNTIME_DIR=/run/user/1000 dockerd-entrypoint.sh >/tmp/rootless.log 2>&1 &' >/dev/null 2>&1
  for _ in $(seq 1 45); do
    rootless info >/dev/null 2>&1 && {
      ok "rootless dockerd came up inside the unprivileged devcontainer"
      R3="YES"
      return 0
    }
    sleep 1
  done
  bad "rootless dockerd did not come up"
  # The log's tail is mostly modprobe noise from the iptables probing, so lead
  # with the lines that name a refusal.
  dev sh -c 'grep -iE "denied|not permitted|error" /tmp/rootless.log | tail -3' 2>/dev/null | sed 's/^/        /'
  dev tail -n 4 /tmp/rootless.log 2>/dev/null | sed 's/^/        /'
  R3="NO -- daemon never became reachable"
  return 1
}

# VFS is the fallback of last resort: no copy-on-write at all, so every layer of
# every image is a full copy on disk. A rootless daemon that only works on VFS
# is not a rootless daemon anyone can develop in.
check_storage_driver() {
  local driver rootkit
  driver=$(rootless info --format '{{.Driver}}' 2>/dev/null | tr -d '\r')
  rootkit=$(dev grep -oE 'RootlessKit[^"]*' /tmp/rootless.log 2>/dev/null | tail -1 | tr -d '\r')
  note "rootlesskit: ${rootkit:-<nothing in the log>}"
  case "$driver" in
    vfs) bad "storage driver is VFS -- every image layer is copied in full"
         R4="NO -- vfs" ;;
    "")  bad "could not read the storage driver"
         R4="UNKNOWN" ;;
    *)   ok "storage driver is '$driver'"
         R4="YES -- $driver" ;;
  esac
}

# --- R5: does it do the job -------------------------------------------------

check_container_and_bind() {
  inner save alpine:3 | vm exec -i "$DIND" docker exec -i "$DEV" \
    env DOCKER_HOST="unix://$RL_SOCK" docker load >/dev/null 2>&1

  local seen
  seen=$(rootless run --rm -v "/workspaces/$PROJ:/x" alpine:3 cat /x/marker.txt 2>/dev/null | tr -d '\r')
  if [ "$seen" = WORKSPACE-MARKER ]; then
    ok "it ran a container that bind-mounted the project from /workspaces"
    R5="YES"
  else
    bad "the container could not read the project through a bind mount"
    note "got '${seen:-<nothing>}'"
    R5="NO -- bind mount or container start failed"
  fi
}

# --- R6: what slirp costs ---------------------------------------------------

# Indicative, not a benchmark: the same payload to the same listener, once from
# a container behind rootlesskit's network stack and once from an ordinary
# sibling on the dind's bridge. Anything within noise of each other means the
# spec's throughput worry does not apply here; a large ratio means it does.
check_network_cost() {
  local address
  address=$(dev sh -c "ip -4 -o addr show eth0 | awk '{print \$4}' | cut -d/ -f1" 2>/dev/null | tr -d '\r')
  [ -n "$address" ] || { R6="UNKNOWN -- could not find the devcontainer's address"; return; }

  dev sh -c 'nc -l -p 9000 > /dev/null 2>&1 &' >/dev/null 2>&1
  local through_slirp
  through_slirp=$(time_transfer rootless "$address")
  dev sh -c 'nc -l -p 9000 > /dev/null 2>&1 &' >/dev/null 2>&1
  local direct
  direct=$(time_transfer inner "$address")

  note "200 MB through rootlesskit : ${through_slirp}s"
  note "200 MB from an ordinary sibling: ${direct}s"
  R6="slirp ${through_slirp}s vs direct ${direct}s for 200 MB"
}

# $1 is the function that drives a daemon -- `rootless` or `inner` -- so the two
# runs differ in nothing but which network stack the payload crosses.
time_transfer() {
  local daemon="$1" address="$2" start end
  start=$(date +%s%N)
  "$daemon" run --rm alpine:3 sh -c \
    "dd if=/dev/zero bs=1M count=200 2>/dev/null | nc -w 5 $address 9000" >/dev/null 2>&1
  end=$(date +%s%N)
  awk -v ns="$((end - start))" 'BEGIN { printf "%.1f", ns / 1000000000 }'
}

# --- the report -------------------------------------------------------------

summary() {
  local stamp="sysbox-runc (the boundary the stack ships)"
  [ "$RUNTIME" = sysbox-runc ] || stamp="runc + --privileged (APPROXIMATION)"
  echo
  echo "=============== SUMMARY (paste this back) ==============="
  echo "  kernel                  : $(uname -r 2>/dev/null)"
  echo "  shared dind contained by: $stamp"
  echo "  R1 unprivileged userns  : $R1"
  echo "  R2 subuid + newuidmap   : $R2"
  echo "  R3 rootless dockerd up  : $R3"
  echo "  R4 storage driver       : $R4"
  echo "  R5 container + bind     : $R5"
  echo "  R6 network cost         : $R6"
  echo "========================================================="
  echo
}

verdict() {
  case "$R1$R3$R5" in
    YESYESYES)
      echo "VERDICT: the alternative is LIVE. A devcontainer can run rootless docker"
      echo "         unprivileged in the shared dind, which gets the same"
      echo "         '--privileged disappears' outcome with no supervisor, no portal"
      echo "         and no nftables changes."
      echo
      echo "         Weigh it against sibling-docker.sh on the two things it does"
      echo "         NOT give you: every project still shares one daemon, so a wedge"
      echo "         or a compromise still reaches all of them; and check R4 and R6"
      echo "         before calling it usable -- a VFS driver or a large slirp ratio"
      echo "         is paid on every build, all day."
      ;;
    *)
      echo "VERDICT: the alternative does not work here. The first R above that is"
      echo "         not YES is why -- and if that is R1, nothing further in is"
      echo "         reachable: user namespaces are what rootless docker IS."
      echo "         That leaves the per-project split as the way to remove"
      echo "         --privileged. Run tests/probes/sibling-docker.sh for its half."
      ;;
  esac
  [ "$RUNTIME" = sysbox-runc ] || {
    echo
    echo "         This run used --runc. sysbox is precisely what makes namespaces"
    echo "         inside a container behave, so R1 here predicts very little about"
    echo "         R1 there. Re-run on the VM before believing any of it."
  }
}

# --- what actually runs -----------------------------------------------------

echo
echo "== 0. the daemon that will host the shared dind =="
require_runtime
report_userns_switches
echo
echo "== 1. the shared dind, as the stack runs one today =="
start_shared_dind
preload_images
seed_workspace
start_devcontainer
echo
echo "== R1. can an unprivileged process in it make a user namespace =="
if check_userns; then
  echo
  echo "== R2. subuid ranges and the newuidmap helpers =="
  check_idmap_tools
  echo
  echo "== R3/R4. the rootless daemon, and what it fell back to =="
  if start_rootless_daemon; then
    check_storage_driver
    echo
    echo "== R5. running a container and bind-mounting the project =="
    check_container_and_bind
    echo
    echo "== R6. what rootless networking costs =="
    check_network_cost
  fi
fi

summary
verdict
echo
