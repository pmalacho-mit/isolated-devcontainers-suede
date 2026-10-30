#!/usr/bin/env bash
# PROBE -- not a test. Answers a capability question about the environment so a
# design decision can be made; it asserts no invariant and gates nothing.
#
# QUESTION: does a process in the Colima VM that opens 127.0.0.1:<port> appear
# on the MAC's 127.0.0.1:<port>, with no docker publish anywhere -- and does it
# keep doing so for listeners that come and go while the stack is up?
#
# Why it matters. The per-project dind milestone deletes the published port
# range (`DESOLATE_PORT_MIN/MAX`, `ports:` on the dind service) and replaces it
# with `desolate-ingress`: a VM-side service that opens loopback listeners ON
# DEMAND and forwards each one into a project dind. That design has no portal
# container and no publish at all, so the only thing carrying a port to the Mac
# is Lima's own guest-port forwarding. If Lima does not forward a listener that
# appears after boot, or forwards it to the LAN rather than to loopback, or
# keeps a dead forward accepting connections, the ingress design falls back to
# the range design in SPEC v2. Each L below is one of those ways:
#
#   L1  DYNAMIC     a listener opened in the VM after the stack is up, bound to
#                   127.0.0.1: forwarded? how long until the Mac sees it? and is
#                   the Mac side bound to loopback, or to every interface?
#   L2  WILDCARD    the same, bound to 0.0.0.0 in the VM. Informational: the
#                   ingress binds 127.0.0.1, but this is what a docker publish
#                   looks like to Lima, and the two must not differ in where the
#                   Mac side ends up.
#   L3  PRIVILEGED  a root listener below 1024. Expected NOT forwarded; the
#                   ingress refuses those ports regardless.
#   L4  TEARDOWN    the L1 listener closes: how long until the Mac refuses, and
#                   what does a client see in between? An accept-then-drop is a
#                   browser showing an empty page, not "connection refused".
#   L5  REOPEN      the same port opened again: forwarded again?
#   L6  COLLISION   the Mac already listens on the port when the VM opens it.
#                   Who answers, and does the VM listener win once the Mac lets
#                   go? This is what `desolate --ports <p> --move` exists for.
#   L7  MANY        twenty listeners at once, one process: every one forwarded?
#                   Ten projects with two ports each is the budget, not a stretch.
#   L8  UID         a listener owned by an unprivileged system user (the ingress
#                   runs as its own uid, `desolate-ingress`).
#
# ANSWERED 2026-10-25 on the Mac (colima 0.10.1, limactl 2.1.2, portForwarder
# ssh, VM kernel 6.8.0-100): the ingress design STANDS, with two constraints it
# now has to honour rather than assume.
#
#   - L1/L5/L8: a loopback listener opened at any time, by any uid, appears on
#     the Mac's 127.0.0.1 in ~20-215 ms. L7: twenty at once, all within ~420 ms.
#   - L4: after a listener closes, a client gets EMPTY replies for ~270 ms and
#     then a refusal -- an accept-then-drop window, not an instant refusal.
#   - L2: a VM listener on 0.0.0.0 is forwarded to the Mac on EVERY interface
#     (`ssh@*`), i.e. onto the LAN. L3: so is a ROOT listener below 1024 even
#     when it is bound to 127.0.0.1 in the VM (`limactl@*`) -- the "expected:
#     not forwarded" in the plan was wrong. So "the ingress binds 127.0.0.1 and
#     refuses ports < 1024" is a SECURITY bound, not hygiene, and preflight has
#     to assert that nothing in the VM listens on 0.0.0.0 or below 1024 that the
#     stack did not put there.
#   - L6: when the Mac already holds a port, the Mac's listener wins, and Lima
#     does NOT retry once the Mac lets go (30 s, still refused). A collided
#     forward stays dead until the VM listener is closed and reopened -- which
#     is what `desolate --ports --move` and the ingress's reopen-on-rewrite
#     have to provide.
#
# ---------------------------------------------------------------------------
# HOW TO RUN -- on your Mac, with the stack UP (the question is about listeners
# that appear while it runs):
#
#   ./tests/probes/vm-loopback-forward.sh
#
# Unlike the other probes this does NOT re-exec itself inside the VM: the
# question is about both sides of the boundary, so it drives the VM over
# `colima ssh` and measures from the Mac. Every listener it opens is a python3
# process in the VM serving one fixed line that names its own port; every one is
# killed on exit, including on failure. It does not touch the desolate stack,
# any container, or any project. Paste the SUMMARY block back.
#
# There is no --runc mode. This is a property of the Mac<->VM boundary and no
# approximation of it exists inside a container.
#
# DESOLATE_LFPROBE_BASE=<port> moves the high ports it uses (default 18560;
# it takes the next 40 or so above it, and refuses to start if the Mac already
# holds one of them).
set -uo pipefail

PROFILE="${COLIMA_PROFILE:-desolate}"
BASE="${DESOLATE_LFPROBE_BASE:-18560}"
WAIT_SECONDS=30          # how long a forward or a teardown is given to happen
POLL_SECONDS=0.2

if ! command -v colima >/dev/null 2>&1; then
  echo "This probe must run from the Mac (colima not found on PATH)." >&2
  exit 1
fi
for tool in curl perl lsof; do
  command -v "$tool" >/dev/null 2>&1 || { echo "needs '$tool' on the Mac" >&2; exit 1; }
done

L1="UNKNOWN"; L2="UNKNOWN"; L3="UNKNOWN"; L4="UNKNOWN"
L5="UNKNOWN"; L6="UNKNOWN"; L7="UNKNOWN"; L8="UNKNOWN"
FACTS=""

note() { printf '      %s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }

now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }

# --- the VM side --------------------------------------------------------------
# One helper script, shipped over stdin on every call, so nothing below is a
# question of how many times a command line gets re-quoted on its way in.

VM_HELPER='
set -u
SERVER=/tmp/desolate-lfprobe.py
cmd=$1; shift
case "$cmd" in
  install)
    cat > "$SERVER" <<"PY"
import asyncio, sys

bind = sys.argv[1]
ports = [int(p) for p in sys.argv[2:]]

async def answer(reader, writer, port):
    try:
        await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
    except Exception:
        pass
    body = ("desolate-lfprobe vm %d\n" % port).encode()
    writer.write(b"HTTP/1.0 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n"
                 % len(body) + body)
    try:
        await writer.drain()
    finally:
        writer.close()

async def main():
    for port in ports:
        await asyncio.start_server(
            lambda r, w, port=port: answer(r, w, port), bind, port)
    await asyncio.Event().wait()

asyncio.run(main())
PY
    command -v python3 >/dev/null || { echo "no python3 in the VM" >&2; exit 1; } ;;
  start)   # <tag> <as: user|root|nobody> <bind> <port>...
    tag=$1 as=$2 bind=$3; shift 3
    log=/tmp/desolate-lfprobe-$tag.log pid=/tmp/desolate-lfprobe-$tag.pid
    launch="setsid nohup python3 $SERVER $bind $* >$log 2>&1 </dev/null & echo \$! > $pid"
    case "$as" in
      user)   sh -c "$launch" ;;
      root)   sudo sh -c "$launch" ;;
      nobody) sudo sh -c "rm -f $log; setsid nohup sudo -u nobody python3 $SERVER $bind $* >$log 2>&1 </dev/null & echo \$! > $pid" ;;
    esac
    # Return only once every port is LISTENING in the VM, held by THIS server
    # (not merely by something), so the Mac-side clock starts from a listener
    # that exists rather than one that is booting or that failed to bind.
    for _ in $(seq 1 50); do
      missing=0
      for port in "$@"; do
        sudo ss -Hltnp "sport = :$port" | grep -q python3 || missing=1
      done
      [ "$missing" = 0 ] && exit 0
      sleep 0.1
    done
    echo "listener $tag never came up in the VM:" >&2; sudo cat "$log" >&2; exit 1 ;;
  stop)    # <tag> <port>...
    tag=$1; shift
    sudo pkill -f "desolate-lfprobe.py .* $1( |\$)" 2>/dev/null
    sudo sh -c "kill \$(cat /tmp/desolate-lfprobe-$tag.pid) 2>/dev/null"
    for _ in $(seq 1 50); do
      gone=1
      for port in "$@"; do ss -Hltn "sport = :$port" | grep -q . && gone=0; done
      [ "$gone" = 1 ] && exit 0
      sleep 0.1
    done
    echo "listener $tag would not close" >&2; exit 1 ;;
  sweep)
    sudo pkill -f desolate-lfprobe.py 2>/dev/null
    sudo rm -f /tmp/desolate-lfprobe* ; exit 0 ;;
  facts)
    echo "vm kernel $(uname -r); python3 $(python3 -V 2>&1 | cut -d" " -f2)" ;;
esac
'

vm() { printf '%s' "$VM_HELPER" | colima ssh -p "$PROFILE" -- bash -s -- "$@"; }

# --- the Mac side -------------------------------------------------------------

# What a Mac client gets from 127.0.0.1:<port>, as one word:
#   vm       the VM listener answered (its body names the port)
#   mac      the Mac's own collision listener answered
#   refused  nothing listens (curl 7)
#   empty    something accepted and closed without a reply (curl 52/56)
#   timeout  something accepted and never answered (curl 28)
#   other:N  anything else, with curl's exit code
probe_mac() {
  local port=$1 body code
  body=$(curl -sS -m 1 "http://127.0.0.1:$port/" 2>/dev/null); code=$?
  case "$code" in
    0)  case "$body" in
          "desolate-lfprobe vm $port") echo vm ;;
          "desolate-lfprobe mac $port") echo mac ;;
          *) echo "other:body" ;;
        esac ;;
    7)  echo refused ;;
    52|56) echo empty ;;
    28) echo timeout ;;
    *)  echo "other:$code" ;;
  esac
}

# Poll until the Mac sees <want> on <port>. Sets WAITED to the elapsed ms, and
# SEEN to every DISTINCT answer on the way, which is what L4 reports: the states
# a client passes through, not just the last one. Globals rather than output,
# because a `$(...)` caller would run this in a subshell and lose SEEN.
WAITED=""; SEEN=""
wait_for() {
  local port=$1 want=$2 start answer deadline
  WAITED=""; SEEN=""
  start=$(now_ms); deadline=$((start + WAIT_SECONDS * 1000))
  while :; do
    answer=$(probe_mac "$port")
    case " $SEEN " in *" $answer "*) ;; *) SEEN="${SEEN:+$SEEN }$answer" ;; esac
    if [ "$answer" = "$want" ]; then WAITED=$(( $(now_ms) - start )); return 0; fi
    [ "$(now_ms)" -ge "$deadline" ] && return 1
    sleep "$POLL_SECONDS"
  done
}

# Where the Mac-side forward listens, e.g. "127.0.0.1" or "*". The process is
# Lima's hostagent (or ssh), never something this probe started.
mac_bind_of() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null \
    | awk 'NR>1 { sub(":[0-9]+$", "", $9); print $1 "@" $9 }' \
    | sort -u | tr '\n' ' ' | sed 's/ $//'
}

MAC_SERVER_PID=""
start_mac_server() {   # a Mac listener that answers "desolate-lfprobe mac <port>"
  local port=$1
  perl -MIO::Socket::INET -e '
    my $port = shift;
    my $s = IO::Socket::INET->new(LocalAddr => "127.0.0.1", LocalPort => $port,
                                  Listen => 16, ReuseAddr => 1) or die "bind: $!";
    while (my $c = $s->accept) {
      my $body = "desolate-lfprobe mac $port\n";
      while (my $l = <$c>) { last if $l =~ /^\r?\n$/ }
      print $c "HTTP/1.0 200 OK\r\nContent-Length: " . length($body) .
               "\r\nConnection: close\r\n\r\n$body";
      close $c;
    }' "$port" &
  MAC_SERVER_PID=$!
  for _ in $(seq 1 50); do
    [ "$(probe_mac "$port")" = mac ] && return 0
    sleep 0.1
  done
  return 1
}
stop_mac_server() {
  [ -n "$MAC_SERVER_PID" ] && kill "$MAC_SERVER_PID" 2>/dev/null
  wait "$MAC_SERVER_PID" 2>/dev/null
  MAC_SERVER_PID=""
}

cleanup() {
  stop_mac_server
  vm sweep >/dev/null 2>&1
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# --- 0. facts, and a clean slate ----------------------------------------------

P1=$BASE; P2=$((BASE + 1)); P6=$((BASE + 2)); P8=$((BASE + 3))
LOW=981
MANY_FIRST=$((BASE + 10)); MANY_COUNT=20
MANY=""; i=0
while [ "$i" -lt "$MANY_COUNT" ]; do MANY="$MANY $((MANY_FIRST + i))"; i=$((i + 1)); done

echo
echo "== 0. facts =="
COLIMA_VERSION=$(colima version 2>/dev/null | head -1)
LIMA_VERSION=$(limactl --version 2>/dev/null | head -1)
FORWARDER=$(grep -E '^\s*portForwarder:' "$HOME/.colima/$PROFILE/colima.yaml" 2>/dev/null \
  | awk '{print $2}')
note "$COLIMA_VERSION"
note "${LIMA_VERSION:-limactl not on PATH}"
note "colima.yaml portForwarder: ${FORWARDER:-<unset, colima default>}"
if ! vm install; then
  bad "could not install the listener helper in the VM (is the VM up? python3?)"
  exit 1
fi
VM_FACTS=$(vm facts); note "$VM_FACTS"
FACTS="$COLIMA_VERSION; ${LIMA_VERSION:-lima ?}; portForwarder=${FORWARDER:-default}; $VM_FACTS"

held=""
for port in $P1 $P2 $P6 $P8 $LOW $MANY; do
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && held="$held $port"
done
if [ -n "$held" ]; then
  bad "the Mac already listens on:$held"
  note "pick another range: DESOLATE_LFPROBE_BASE=<port> $0"
  exit 1
fi
ok "every port this probe uses is free on the Mac"

# --- L1 / L2: dynamic listeners, loopback and wildcard -------------------------

forwarded_case() {   # <label> <tag> <as> <bind> <port>  -> sets RESULT
  local label=$1 tag=$2 as=$3 bind=$4 port=$5 ms="" where
  RESULT="UNKNOWN"
  if ! vm start "$tag" "$as" "$bind" "$port"; then
    bad "$label: the VM listener did not start"; RESULT="ERROR (VM listener did not start)"; return
  fi
  if wait_for "$port" vm; then ms=$WAITED
    where=$(mac_bind_of "$port")
    ok "$label: the Mac reached the VM listener after ~${ms} ms"
    note "Mac side listens as: ${where:-<not visible to lsof>}"
    case "$where" in
      *"@127.0.0.1"*|*"@[::1]"*) RESULT="YES after ~${ms} ms, Mac side bound ${where}" ;;
      "")                        RESULT="YES after ~${ms} ms, Mac bind NOT VISIBLE to lsof" ;;
      *)                         RESULT="YES after ~${ms} ms, but Mac side bound ${where} -- NOT loopback" ;;
    esac
  else
    bad "$label: not forwarded within ${WAIT_SECONDS}s (answers seen: $SEEN)"
    RESULT="NO (not forwarded in ${WAIT_SECONDS}s; Mac saw: $SEEN)"
  fi
}

echo
echo "== L1. a VM listener on 127.0.0.1:$P1, opened now =="
forwarded_case L1 l1 user 127.0.0.1 "$P1"; L1=$RESULT

echo
echo "== L2. a VM listener on 0.0.0.0:$P2 =="
forwarded_case L2 l2 user 0.0.0.0 "$P2"; L2=$RESULT
vm stop l2 "$P2" >/dev/null 2>&1

echo
echo "== L3. a root VM listener on 127.0.0.1:$LOW (below 1024) =="
if vm start l3 root 127.0.0.1 "$LOW"; then
  # Below 1024 a forward is expected NOT to appear, so the wait is the full
  # window either way; a YES here is the surprise.
  if wait_for "$LOW" vm; then ms=$WAITED
    note "forwarded after ~${ms} ms -- the ingress refuses ports below 1024 regardless"
    L3="YES, forwarded after ~${ms} ms (Mac side: $(mac_bind_of "$LOW"))"
  else
    ok "not forwarded within ${WAIT_SECONDS}s, as expected"
    L3="NO, not forwarded (expected)"
  fi
  vm stop l3 "$LOW" >/dev/null 2>&1
else
  L3="ERROR (root listener did not start)"
fi

# --- L4 / L5: teardown and reopen ---------------------------------------------

echo
echo "== L4. the L1 listener closes =="
case "$L1" in
  YES*)
    if vm stop l1 "$P1"; then
      if wait_for "$P1" refused; then ms=$WAITED
        ok "the Mac refused after ~${ms} ms"
        note "states a client passed through: $SEEN"
        L4="refused after ~${ms} ms; client saw: $SEEN"
      else
        bad "the Mac never refused within ${WAIT_SECONDS}s (saw: $SEEN)"
        L4="NEVER refused in ${WAIT_SECONDS}s; client saw: $SEEN -- a dead forward keeps accepting"
      fi
    else
      L4="ERROR (VM listener would not close)"
    fi ;;
  *) note "skipped: L1 was not forwarded"; L4="SKIPPED (L1 not forwarded)" ;;
esac

echo
echo "== L5. the same port, $P1, opened again =="
case "$L4" in
  refused*) forwarded_case L5 l5 user 127.0.0.1 "$P1"; L5=$RESULT
            vm stop l5 "$P1" >/dev/null 2>&1 ;;
  *)        note "skipped: L4 did not reach a clean teardown"; L5="SKIPPED (no clean teardown)" ;;
esac

# --- L6: collision --------------------------------------------------------------

echo
echo "== L6. the Mac already holds $P6 when the VM opens it =="
if start_mac_server "$P6"; then
  if vm start l6 user 127.0.0.1 "$P6"; then
    sleep 5
    first=$(probe_mac "$P6")
    note "with both listening, a Mac client reaches: $first"
    stop_mac_server
    if wait_for "$P6" vm; then ms=$WAITED
      note "after the Mac let go: the VM listener answered after ~${ms} ms"
      L6="while both listen: $first; after the Mac lets go: VM after ~${ms} ms"
    else
      note "after the Mac let go: the VM listener never answered (saw: $SEEN)"
      L6="while both listen: $first; after the Mac lets go: VM NEVER forwarded in ${WAIT_SECONDS}s (saw: $SEEN)"
    fi
    vm stop l6 "$P6" >/dev/null 2>&1
  else
    L6="ERROR (VM listener did not start)"
  fi
else
  L6="ERROR (could not start the Mac-side listener)"
fi
stop_mac_server

# --- L7: many at once -------------------------------------------------------------

echo
echo "== L7. $MANY_COUNT VM listeners at once ($MANY_FIRST..$((MANY_FIRST + MANY_COUNT - 1))) =="
# shellcheck disable=SC2086  # MANY is a list of ports, split on purpose
if vm start l7 user 127.0.0.1 $MANY; then
  start=$(now_ms); deadline=$((start + WAIT_SECONDS * 1000))
  pending="$MANY"; slowest=0
  while [ -n "$pending" ] && [ "$(now_ms)" -lt "$deadline" ]; do
    still=""
    for port in $pending; do
      if [ "$(probe_mac "$port")" = vm ]; then
        slowest=$(( $(now_ms) - start ))
      else
        still="$still $port"
      fi
    done
    pending=$still
    [ -n "$pending" ] && sleep "$POLL_SECONDS"
  done
  missing=$(echo $pending | wc -w | tr -d ' ')
  if [ "$missing" = 0 ]; then
    ok "all $MANY_COUNT forwarded; the last after ~${slowest} ms"
    L7="YES, all $MANY_COUNT forwarded; the last after ~${slowest} ms"
  else
    bad "$missing of $MANY_COUNT never forwarded:$pending"
    L7="NO, $missing of $MANY_COUNT not forwarded in ${WAIT_SECONDS}s"
  fi
  # shellcheck disable=SC2086
  vm stop l7 $MANY >/dev/null 2>&1
else
  L7="ERROR (VM listeners did not start)"
fi

# --- L8: a listener owned by a system uid -------------------------------------------

echo
echo "== L8. a VM listener on 127.0.0.1:$P8 owned by 'nobody' =="
forwarded_case L8 l8 nobody 127.0.0.1 "$P8"; L8=$RESULT
vm stop l8 "$P8" >/dev/null 2>&1

# --- verdict ---------------------------------------------------------------------

# The ingress design stands on L1 (forwarded, to loopback), L4 (a closed
# listener stops answering) and L7 (the budget fits). L5 and L8 are the same
# question asked again under the conditions the ingress will actually create.
stands=YES
case "$L1" in "YES after"*", Mac side bound "*) ;; *) stands=NO ;; esac
case "$L1" in *"NOT loopback"*) stands=NO ;; esac
case "$L4" in refused*) ;; *) stands=NO ;; esac
case "$L5" in YES*) ;; *) stands=NO ;; esac
case "$L7" in YES*) ;; *) stands=NO ;; esac
case "$L8" in YES*) ;; *) stands=NO ;; esac

echo
echo "================================ SUMMARY ================================"
echo "vm-loopback-forward.sh  $(date '+%Y-%m-%d')  profile=$PROFILE"
echo "facts: $FACTS"
echo "L1 DYNAMIC    $L1"
echo "L2 WILDCARD   $L2"
echo "L3 PRIVILEGED $L3"
echo "L4 TEARDOWN   $L4"
echo "L5 REOPEN     $L5"
echo "L6 COLLISION  $L6"
echo "L7 MANY       $L7"
echo "L8 UID        $L8"
if [ "$stands" = YES ]; then
  echo "VERDICT: the ingress design STANDS (T2.3, T2.4 proceed as planned)"
else
  echo "VERDICT: the ingress design does NOT stand as written -- see the failing L"
fi
echo "========================================================================="
