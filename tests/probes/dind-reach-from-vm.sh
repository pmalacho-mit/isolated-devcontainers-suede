#!/usr/bin/env bash
# PROBE -- not a test. Answers a capability question about the environment so a
# design decision can be made; it asserts no invariant and gates nothing.
#
# QUESTION: can a process on the VM reach a port that a sysbox project dind's
# INNER daemon publishes -- with no `-p` on the dind itself -- by dialling the
# dind's address on its own `br-d-*` bridge? And does nothing else get the same
# reach?
#
# Why it matters. Under the milestone the browser's path to a dev server is
#
#   Mac 127.0.0.1:P -> (Lima) -> VM 127.0.0.1:P  desolate-ingress, a VM process
#                   -> dind-ip:P                 the project dind, on br-d-<hash>
#                   -> (inner publish)           the relay, `-p P:P` inside it
#                   -> devcontainer:port
#
# The first hop is `vm-loopback-forward.sh`. This probe is the second and third:
# the ingress dials a container address directly, which only works if the dind
# is reachable from the VM's own network stack and its inner daemon's publish
# answers on the dind's bridge address. Both are plausible and neither is
# promised: sysbox puts the dind in a user namespace, and an inner publish could
# just as well bind somewhere the VM never sees. Each R is one way it fails:
#
#   R1  REACH       the VM, as its login user, fetches through the inner relay.
#   R1b UID         the same as an unprivileged system uid. The ingress runs as
#                   its own uid, `desolate-ingress`, and the desolate ruleset
#                   already has uid-keyed output rules for the proxy.
#   R2  BIND        where the inner publish actually listens inside the dind, and
#                   whether docker-proxy or plain DNAT carries it.
#   R3  OTHERS      a container on a SECOND br-d-* bridge -- another project's
#                   dind -- cannot reach it. Docker isolates bridges from each
#                   other; this measures that it still does here.
#   R3b STACK       nor can a container on either of the stack's own bridges
#                   (br-desolate, br-desolate-in). Skipped where the stack is not
#                   up, e.g. under --runc in a devcontainer.
#   R4  RULESET     what the live nftables ruleset makes of br-d-* at all, so R1
#                   and R3 are read against the rules that were really loaded.
#   R5  NO PUBLISH  the dind publishes nothing on the VM: the reach in R1 is the
#                   bridge, never a port the VM opened to everyone.
#   R6  TEARDOWN    the relay is removed: the VM's next dial is refused, rather
#                   than accepted and dropped.
#
# ANSWERED 2026-10-25 on the VM under sysbox-runc (docker 29.2.1, kernel
# 6.8.0-100): HOLDS on everything it measured; R5 was not measured (see below).
#   R1/R1b YES -- the VM reaches the inner relay at the dind's br-d-* address,
#          as the login user and as `nobody`: sysbox's userns changes nothing.
#   R2     the inner publish binds 0.0.0.0 and [::] via two docker-proxies.
#   R3     a second br-d-* bridge times out (control on the dind's own bridge
#          reached it). R3b both stack bridges time out too.
#   R4     main's ruleset does not cover br-d-* (PR #10's change not installed).
#   R6     refused at once once the relay is gone.
#   R5     reported a VM listener on :8099 -- the STACK's own published range
#          (127.0.0.1:8080-8119 on the shared dind), not this probe's dind, whose
#          outer publish was empty. The probe now uses 18099 and compares the
#          VM's listeners before and after the dind starts; re-run for R5.
#
# APPROXIMATION 2026-10-25, --runc in this repo's own .devcontainer (docker
# 29.9.2, kernel 6.8.0-100): HOLDS. R1/R1b YES (login user and nobody); R2 the
# inner publish binds 0.0.0.0 and [::] via two docker-proxy processes; R3 a
# container on a second br-d-* bridge timed out, with the same container on the
# dind's own bridge reaching it as the control; R5 nothing published outward;
# R6 refused at once. R3b and R4 skipped (no stack, no desolate ruleset here).
# NOT the answer: R1 and R2 are exactly what sysbox's userns could change.
#
# ---------------------------------------------------------------------------
# HOW TO RUN -- on your Mac. The stack should be UP so R3b and R4 have the real
# bridges and ruleset to measure against:
#
#   ./tests/probes/dind-reach-from-vm.sh
#
# It re-execs itself INSIDE the Colima VM, creates ONE throwaway dind named
# desolate-reachprobe-dind, one throwaway container per bridge it tests from,
# two throwaway networks (bridges br-d-rprobe0a / br-d-rprobe0b) and one volume,
# and removes all of it on exit including on failure. It does not touch the
# desolate stack's containers, any project, or anything on your Mac. Paste the
# SUMMARY block back.
#
# DESOLATE_REACHPROBE_KEEP=1 leaves the throwaways up and prints how to remove
# them.
#
# Without sysbox -- e.g. from the repo's own .devcontainer -- pass --runc. The
# throwaway dind then runs --privileged instead of unprivileged under sysbox,
# which is precisely the userns question R1 and R2 ask, so that run is stamped
# APPROXIMATION and the real answer is the sysbox one.
#
# NOTE ON EGRESS: as in sibling-docker.sh, the dind is handed its images by
# `docker save` from the outer daemon and never pulls anything itself.
set -uo pipefail

PROFILE="${COLIMA_PROFILE:-desolate}"
RUNTIME="${DESOLATE_REACHPROBE_RUNTIME:-sysbox-runc}"

for arg in "$@"; do
  case "$arg" in
    --runc) RUNTIME=runc ;;
    *) echo "unknown argument '$arg' (only --runc is understood)" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Stage 0: get inside the VM, where `docker` is the daemon that will host
# project dinds and the VM's own network stack is the one the ingress uses.
# Flags do not survive `bash -s`, so the runtime travels as an environment
# variable.
# ---------------------------------------------------------------------------
if [ "${DESOLATE_REACHPROBE_INVM:-}" != 1 ]; then
  if ! command -v colima >/dev/null 2>&1; then
    echo "This probe must run from the Mac (colima not found on PATH)." >&2
    echo "If you are already somewhere with a usable daemon, re-run with" >&2
    echo "DESOLATE_REACHPROBE_INVM=1 (and --runc if it has no sysbox-runc)." >&2
    exit 1
  fi
  echo "== entering the Colima VM (profile '$PROFILE') =="
  exec colima ssh -p "$PROFILE" -- \
    env DESOLATE_REACHPROBE_INVM=1 DESOLATE_REACHPROBE_RUNTIME="$RUNTIME" bash -s < "$0"
  echo "could not enter the VM via 'colima ssh -p $PROFILE'." >&2
  exit 1
fi

# ---- from here on `docker` is the daemon that will host the project dind ----

DIND=desolate-reachprobe-dind
NET_A=desolate-reachprobe-a        # this project's bridge
NET_B=desolate-reachprobe-b        # another project's bridge
BRIDGE_A=br-d-rprobe0a             # br-d-* shaped, as dind.bridge() names them
BRIDGE_B=br-d-rprobe0b
DATA_VOL=desolate-reachprobe-data
FROM_B=desolate-reachprobe-from-b
FROM_STACK=desolate-reachprobe-from-stack

DIND_IMG="docker:29-dind"
RELAY_IMG="alpine/socat"           # relays.ts IMAGE: the relay is the real one
WEB_IMG="busybox:1.37"
SOCK=/run/dind-sock/docker.sock
# Outside the stack's published range (DESOLATE_PORT_MIN..MAX, 8080-8119 by
# default): R5 asks whether THIS dind opened a VM listener, and the first run
# answered the stack's instead.
PORT=18099
MARKER=REACHPROBE-MARKER

R1="UNKNOWN"; R1B="UNKNOWN"; R2="UNKNOWN"; R3="UNKNOWN"; R3B="UNKNOWN"
R4="UNKNOWN"; R5="UNKNOWN"; R6="UNKNOWN"
DIND_IP=""

note() { printf '      %s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }
tail4(){ tail -n 4 | sed 's/^/        /'; }

vm()    { docker "$@"; }                       # hosts the project dind
inner() { docker exec "$DIND" docker "$@"; }   # the project dind's own daemon

remove_throwaways() {
  vm rm -f "$DIND" "$FROM_B" "$FROM_STACK" >/dev/null 2>&1
  vm network rm "$NET_A" "$NET_B" >/dev/null 2>&1
  vm volume rm -f "$DATA_VOL" >/dev/null 2>&1
}
cleanup() {
  [ -n "${DESOLATE_REACHPROBE_KEEP:-}" ] && {
    printf '\n  kept: docker rm -f %s %s %s && docker network rm %s %s && docker volume rm -f %s\n' \
      "$DIND" "$FROM_B" "$FROM_STACK" "$NET_A" "$NET_B" "$DATA_VOL"
    return
  }
  remove_throwaways
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# The VM-side client: curl if the VM has it, else python3. Prints the body on
# success; on failure prints nothing and returns curl's exit code (7 refused,
# 28 timeout, 52/56 accepted-then-dropped).
fetch() {   # <as: self|nobody> <url>
  local as=$1 url=$2 prefix=()
  # setpriv as root rather than `sudo -u`: a sudoers that grants root alone (a
  # devcontainer's, under --runc) refuses `-u nobody` and the R would measure
  # sudo instead of the network.
  [ "$as" = nobody ] && prefix=(sudo -n setpriv --reuid="$(id -u nobody)"
                                 --regid="$(id -g nobody)" --clear-groups)
  "${prefix[@]}" curl -sS -m 3 "$url" 2>/dev/null
}

stamp() {
  [ "$RUNTIME" = runc ] && printf 'APPROXIMATION (runc) -- %s' "$1" || printf '%s' "$1"
}

echo
echo "== 0. the outer daemon, and which boundary this run tests =="
if ! vm info >/dev/null 2>&1; then
  bad "cannot reach the docker daemon"; note "on the Mac:  colima start -p $PROFILE"; exit 1
fi
command -v curl >/dev/null || { bad "this probe needs curl on the VM"; exit 1; }
if [ "$RUNTIME" = sysbox-runc ]; then
  if vm info --format '{{json .Runtimes}}' 2>/dev/null | grep -q sysbox-runc; then
    ok "sysbox-runc is registered -- the project dind runs UNPRIVILEGED"
  else
    bad "sysbox-runc is NOT registered on this daemon"
    note "install it first:  ./cli.sh vm install    or accept the weaker run:  $0 --runc"
    exit 1
  fi
  CONTAINMENT=(--runtime=sysbox-runc)
else
  ok "runtime: runc + --privileged (APPROXIMATION -- see the header)"
  CONTAINMENT=(--privileged)
fi
note "outer docker $(vm version --format '{{.Server.Version}}' 2>/dev/null); kernel $(uname -r)"

# --- 1. two br-d-* bridges and a project dind on one of them, no -p ----------

echo
echo "== 1. a project dind on $BRIDGE_A, publishing nothing =="
remove_throwaways   # a previous run killed before its trap ran
for pair in "$NET_A:$BRIDGE_A" "$NET_B:$BRIDGE_B"; do
  net=${pair%%:*} bridge=${pair#*:}
  vm network create --opt "com.docker.network.bridge.name=$bridge" "$net" >/dev/null 2>&1 \
    || { bad "could not create network $net (bridge $bridge)"; exit 1; }
  # A bridge whose name was silently not applied would make R3 and R4 measure
  # some other interface; check the name the kernel actually has.
  ip link show "$bridge" >/dev/null 2>&1 \
    || { bad "network $net exists but no interface is named $bridge"; exit 1; }
done
ok "created $BRIDGE_A and $BRIDGE_B"

# R5 is a difference, not an absolute: whatever already listens on the port is
# someone else's, and only what appears with the dind is the dind's.
VM_LISTEN_BEFORE=$(ss -Hltn "sport = :$PORT" 2>/dev/null | wc -l | tr -d ' ')

vm run -d --name "$DIND" "${CONTAINMENT[@]}" --network "$NET_A" \
  -e DOCKER_TLS_CERTDIR="" -e DOCKER_HOST="unix://$SOCK" \
  -v "$DATA_VOL:/var/lib/docker" --tmpfs /run/dind-sock \
  "$DIND_IMG" dockerd --host="unix://$SOCK" --group=1000 >/dev/null 2>&1 \
  || { bad "could not start the project dind"; exit 1; }
for _ in $(seq 1 60); do inner info >/dev/null 2>&1 && break; sleep 1; done
inner info >/dev/null 2>&1 || { bad "the project dind never became reachable"; vm logs "$DIND" 2>&1 | tail4; exit 1; }
DIND_IP=$(vm inspect -f "{{(index .NetworkSettings.Networks \"$NET_A\").IPAddress}}" "$DIND")
[ -n "$DIND_IP" ] || { bad "the dind has no address on $NET_A"; exit 1; }
ok "project dind is up at $DIND_IP"

for image in "$RELAY_IMG" "$WEB_IMG"; do
  vm image inspect "$image" >/dev/null 2>&1 || vm pull -q "$image" >/dev/null 2>&1 \
    || { bad "the outer daemon cannot pull $image"; exit 1; }
  vm save "$image" | vm exec -i "$DIND" docker load >/dev/null 2>&1 \
    || { bad "could not load $image into the dind"; exit 1; }
done
ok "loaded $RELAY_IMG and $WEB_IMG into the dind (no pulls inside it)"

# The relay's real shape (docker.ts relay.start): it joins the devcontainer's
# network, publishes P:P on the dind's daemon, and dials the devcontainer by IP.
# A busybox httpd stands in for the devcontainer's dev server.
inner network create rp-inner >/dev/null 2>&1
inner run -d --name rp-web --network rp-inner "$WEB_IMG" \
  sh -c "mkdir -p /www && echo $MARKER > /www/index.html && httpd -f -p 8000 -h /www" >/dev/null 2>&1 \
  || { bad "could not start the stand-in dev server in the dind"; exit 1; }
WEB_IP=$(inner inspect -f '{{(index .NetworkSettings.Networks "rp-inner").IPAddress}}' rp-web)
inner run -d --name rp-relay --network rp-inner -p "$PORT:$PORT" "$RELAY_IMG" \
  "tcp-listen:$PORT,fork,reuseaddr" "tcp:$WEB_IP:8000" >/dev/null 2>&1 \
  || { bad "could not start the relay in the dind"; exit 1; }
# Proved from inside the dind first: an R1 NO must not be a relay that never
# worked.
for _ in $(seq 1 20); do
  vm exec "$DIND" wget -T 2 -qO- "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q "$MARKER" && break
  sleep 0.5
done
if vm exec "$DIND" wget -T 2 -qO- "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q "$MARKER"; then
  ok "inside the dind, 127.0.0.1:$PORT answers through the relay"
else
  bad "the relay does not answer even inside the dind"; exit 1
fi

# --- R1 / R1b: the VM dials the dind -------------------------------------------

echo
echo "== R1. the VM fetches http://$DIND_IP:$PORT/ =="
body=$(fetch self "http://$DIND_IP:$PORT/"); code=$?
if [ "$body" = "$MARKER" ]; then
  ok "reached the dev server through the inner relay, as $(id -un)"
  R1=$(stamp "YES (as $(id -un))")
else
  bad "no answer (curl exit $code)"
  R1=$(stamp "NO (curl exit $code)")
fi

echo
echo "== R1b. the same, as uid 'nobody' =="
body=$(fetch nobody "http://$DIND_IP:$PORT/"); code=$?
if [ "$body" = "$MARKER" ]; then
  ok "reached it as nobody"; R1B=$(stamp "YES (as nobody)")
else
  bad "no answer as nobody (curl exit $code)"; R1B=$(stamp "NO as nobody (curl exit $code)")
fi

# --- R2: where the inner publish listens ----------------------------------------

echo
echo "== R2. where the inner publish listens =="
listen=$(vm exec "$DIND" sh -c "netstat -ltn 2>/dev/null | awk '\$4 ~ /:$PORT\$/ {print \$4}' | sort -u | tr '\n' ' '")
proxy=$(vm exec "$DIND" sh -c "ps -o args 2>/dev/null | grep -c '[d]ocker-proxy.*$PORT'")
published=$(inner port rp-relay 2>/dev/null | tr '\n' ' ')
note "docker port: ${published:-<none>}"
note "listening inside the dind: ${listen:-<no socket; DNAT only>}"
note "docker-proxy processes for $PORT: $proxy"
R2=$(stamp "publish '${published% }', sockets '${listen% }', docker-proxy x$proxy")

# --- R3 / R3b: nobody else reaches it --------------------------------------------

# One container per vantage point, each asked the same question R1 asked.
# A NO carries wget's own words, so "timed out" (dropped) and "refused" are
# told apart, and neither is mistaken for a container that never started.
reach_from() {   # <container-name> <network>  -> prints YES / NO (<why>)
  local name=$1 net=$2 out code
  vm rm -f "$name" >/dev/null 2>&1
  out=$(vm run --rm --name "$name" --network "$net" "$WEB_IMG" \
          wget -T 3 -qO- "http://$DIND_IP:$PORT/" 2>&1); code=$?
  if [ "$code" = 0 ] && [ "$out" = "$MARKER" ]; then echo "YES"
  else echo "NO (wget exit $code: $(printf '%s' "$out" | tail -n 1 | cut -c1-60))"; fi
}

# The control: the same container, on the dind's OWN bridge, must reach it --
# otherwise every NO below is this function failing, not isolation working.
echo
echo "== R3 control. a container on $BRIDGE_A (the dind's own bridge) dials it =="
control=$(reach_from "$FROM_B" "$NET_A")
if [ "$control" = YES ]; then
  ok "reached -- reach_from works, so a NO below means isolation"
else
  bad "the control failed: $control -- R3 and R3b would measure nothing"
fi

echo
echo "== R3. a container on $BRIDGE_B (another project) dials the dind =="
answer=$(reach_from "$FROM_B" "$NET_B")
[ "$control" = YES ] || answer="UNMEASURED (control failed: $control)"
case "$answer" in
  YES) bad "REACHED -- bridges are NOT isolated from each other here"; R3=$(stamp "REACHED from $BRIDGE_B -- NOT isolated") ;;
  UNMEASURED*) bad "$answer"; R3=$(stamp "$answer") ;;
  *)   ok "refused: $answer"; R3=$(stamp "isolated ($answer)") ;;
esac

echo
echo "== R3b. containers on the stack's own bridges dial the dind =="
R3B=""
for bridge in br-desolate br-desolate-in; do
  net=$(vm network ls -q 2>/dev/null | xargs -r docker network inspect \
          -f '{{.Name}} {{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null \
        | awk -v b="$bridge" '$2 == b {print $1}')
  if [ -z "$net" ]; then
    note "$bridge: no such network here (stack not up?) -- skipped"
    R3B="${R3B:+$R3B; }$bridge skipped"
    continue
  fi
  answer=$(reach_from "$FROM_STACK" "$net")
  [ "$control" = YES ] || answer="UNMEASURED (control failed)"
  case "$answer" in
    YES) bad "$bridge ($net): REACHED"; R3B="${R3B:+$R3B; }$bridge REACHED" ;;
    UNMEASURED*) bad "$bridge ($net): $answer"; R3B="${R3B:+$R3B; }$bridge UNMEASURED" ;;
    *)   ok "$bridge ($net): refused: $answer"; R3B="${R3B:+$R3B; }$bridge isolated" ;;
  esac
done
R3B=$(stamp "$R3B")

# --- R4: the live ruleset --------------------------------------------------------

echo
echo "== R4. what the live nftables ruleset says about br-d-* =="
if ! command -v nft >/dev/null 2>&1; then
  note "no nft here"; R4="no nft on this host"
elif ! sudo -n nft list table inet desolate >/dev/null 2>&1; then
  note "no 'inet desolate' table loaded"; R4=$(stamp "no inet desolate table loaded")
else
  covered=$(sudo -n nft list table inet desolate 2>/dev/null | grep -c '"br-d-\*"')
  output_rules=$(sudo -n nft list chain inet desolate output 2>/dev/null | grep -c 'skuid')
  note "lines naming \"br-d-*\": $covered; uid-keyed output rules: $output_rules"
  if [ "$covered" -gt 0 ]; then
    R4="inet desolate loaded; br-d-* IS covered ($covered lines); $output_rules uid-keyed output rules"
  else
    R4="inet desolate loaded; br-d-* NOT covered (PR #10's ruleset not installed); $output_rules uid-keyed output rules"
  fi
fi

# --- R5: the dind publishes nothing on the VM ---------------------------------------

echo
echo "== R5. the dind publishes nothing on the VM =="
outer_ports=$(vm port "$DIND" 2>/dev/null | tr '\n' ' ')
vm_listen=$(ss -Hltn "sport = :$PORT" 2>/dev/null | wc -l | tr -d ' ')
note "VM listeners on :$PORT before the dind: $VM_LISTEN_BEFORE, now: $vm_listen"
if [ -z "$outer_ports" ] && [ "$vm_listen" = "$VM_LISTEN_BEFORE" ]; then
  ok "no outer publish, and the dind opened no VM listener on :$PORT"
  R5="YES, nothing published (VM listeners on :$PORT unchanged at $vm_listen)"
else
  bad "outer publish '${outer_ports}', VM listeners on :$PORT: $VM_LISTEN_BEFORE -> $vm_listen"
  R5="NO: outer publish '${outer_ports% }', VM listeners on :$PORT: $VM_LISTEN_BEFORE -> $vm_listen"
fi

# --- R6: teardown -------------------------------------------------------------------

echo
echo "== R6. the relay is removed; the VM dials again =="
case "$R1" in
  *YES*)
    inner rm -f rp-relay >/dev/null 2>&1
    fetch self "http://$DIND_IP:$PORT/" >/dev/null; code=$?
    case "$code" in
      7)  ok "refused at once (curl 7)"; R6=$(stamp "refused (curl 7)") ;;
      0)  bad "STILL ANSWERS after the relay is gone"; R6=$(stamp "STILL ANSWERS") ;;
      *)  note "curl exit $code (28 timeout, 52/56 accepted then dropped)"; R6=$(stamp "not a clean refusal (curl exit $code)") ;;
    esac ;;
  *) note "skipped: R1 never reached it"; R6="SKIPPED (R1 NO)" ;;
esac

# --- verdict -------------------------------------------------------------------------

holds=YES
case "$R1"  in *YES*) ;; *) holds=NO ;; esac
case "$R1B" in *YES*) ;; *) holds=NO ;; esac
case "$R3"  in *isolated*) ;; *) holds=NO ;; esac
case "$R3B" in *REACHED*|*UNMEASURED*) holds=NO ;; esac
case "$R5"  in YES*) ;; *) holds=NO ;; esac

echo
echo "================================ SUMMARY ================================"
echo "dind-reach-from-vm.sh  $(date '+%Y-%m-%d')  runtime=$RUNTIME"
[ "$RUNTIME" = runc ] && echo "APPROXIMATION (runc): the real answer is the sysbox run on the VM"
echo "R1  REACH       $R1"
echo "R1b UID         $R1B"
echo "R2  BIND        $R2"
echo "R3  OTHERS      $R3"
echo "R3b STACK       $R3B"
echo "R4  RULESET     $R4"
echo "R5  NO PUBLISH  $R5"
echo "R6  TEARDOWN    $R6"
if [ "$holds" = YES ]; then
  echo "VERDICT: the VM reaches an inner publish on the dind's bridge, and nothing else does (T2.3 dials dind-ip:port directly)"
else
  echo "VERDICT: does NOT hold as written -- the ingress needs another hop (see the failing R)"
fi
echo "========================================================================="
