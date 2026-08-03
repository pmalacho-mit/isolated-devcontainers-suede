#!/usr/bin/env bash
# PROBE -- run this on your Mac, against a LIVE stack. It asserts nothing and
# gates nothing; it answers a question so a fix can be chosen.
#
#   ./tests/probes/devnet-reachability.sh
#
# THE QUESTION
#
# release/proxy/vm/nftables-desolate.conf ends its forward chain with
#
#     iifname $DESOLATE_IF counter drop
#
# and its input chain with a matching drop. Read plainly, that says nothing on
# the desolate bridge may reach anything except the proxy and the resolver.
#
# But `br-desolate` carries two kinds of traffic, and only one of them is
# ROUTED:
#
#   dind -> the internet        routed. Crosses the forward hook. Dropped or
#                               redirected as the rules intend.
#   dind -> desolate-vscode     BRIDGED. Same L2 segment, no routing decision.
#                               Whether netfilter sees it at all depends on the
#                               br_netfilter module and bridge-nf-call-iptables.
#
# There is a reason to think it is NOT seen: desolate.ts probes a freshly
# started project's editor with `fetch(http://dind:PORT)` from the orchestrator,
# which is bridged orchestrator -> dind on that same interface, and is not an
# established flow when the first SYN goes out. If the forward chain were
# filtering bridged traffic, that probe could not succeed -- and it does.
#
# If bridged traffic is unfiltered, then a devcontainer (which NATs out through
# dind onto this bridge) can open TCP connections to desolate-vscode and
# desolate-orchestrator. Neither is a container escape: the editor is token
# gated and the broker is a unix socket with no TCP listener. It is a wider
# internal surface than "one host-reachable surface, loopback-only" suggests,
# and it is worth knowing which it is before deciding whether to care.
#
# HOW IT ANSWERS
#
# The key signal is REFUSED vs TIMEOUT, and they mean opposite things:
#
#   connection refused  the packet ARRIVED and the kernel at the far end sent
#                       RST because nothing was listening. Reachable.
#   timeout             the packet was DROPPED in flight. Not reachable.
#   connected           reachable, and something is listening.
#
# The prober is a throwaway container on the INNER daemon -- the same daemon,
# the same default bridge and the same egress path a devcontainer has, so it
# stands in for one exactly. It is removed when it exits.
set -uo pipefail

ORCHESTRATOR=desolate-orchestrator
COLIMA_PROFILE="${COLIMA_PROFILE:-desolate}"
PROBE_IMAGE=alpine:3

head2()  { printf '\n\033[1m-- %s --\033[0m\n' "$*"; }
info()   { printf '  info      %s\n' "$*"; }
reach()  { printf '  \033[1;33mREACHABLE\033[0m %s\n' "$*"; }
blocked(){ printf '  \033[32mblocked\033[0m   %s\n' "$*"; }

docker inspect -f '{{.State.Status}}' "$ORCHESTRATOR" 2>/dev/null | grep -qx running || {
  echo "probe: the stack is not running -- start it first (./cli.sh up)" >&2
  exit 1
}

# Run a command on the INNER daemon, where devcontainers live.
inner() { docker exec "$ORCHESTRATOR" docker "$@"; }

# ---------------------------------------------------------------------------
head2 "0. is bridged traffic even subject to netfilter?"
# ---------------------------------------------------------------------------
# This single sysctl decides whether the forward-chain drop applies to
# container-to-container traffic on the same bridge. 0 (or the module absent)
# means the rules never see it.
NF=$(colima ssh -p "$COLIMA_PROFILE" -- \
      cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null | tr -d '\r' || true)
MOD=$(colima ssh -p "$COLIMA_PROFILE" -- lsmod 2>/dev/null | grep -c '^br_netfilter' || true)
if [ -z "$NF" ]; then
  info "bridge-nf-call-iptables: unreadable (br_netfilter not loaded)"
  info "  => the forward chain does NOT see bridged traffic. Expect step 2 to"
  info "     show the editor and orchestrator as reachable."
else
  info "bridge-nf-call-iptables = $NF   (br_netfilter loaded: $([ "${MOD:-0}" -gt 0 ] && echo yes || echo no))"
  [ "$NF" = "1" ] && info "  => bridged traffic IS evaluated by the forward chain."
  [ "$NF" = "0" ] && info "  => bridged traffic is NOT evaluated. Rules do not apply to it."
fi

# Addresses of the outer containers, read from the OUTER daemon.
addr() { docker inspect -f \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1" 2>/dev/null | tr -d '\r'; }
VSCODE_IP=$(addr desolate-vscode)
ORCH_IP=$(addr "$ORCHESTRATOR")
GW=$(docker network inspect desolate_devnet \
      -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null | tr -d '\r')
info "desolate-vscode       $VSCODE_IP"
info "desolate-orchestrator $ORCH_IP"
info "VM gateway on devnet  $GW"

# ---------------------------------------------------------------------------
# One probe container, many targets: starting alpine per target is slow and the
# result is identical. `nc -w` gives us refused-vs-timeout in its exit code and
# in how long it takes.
# ---------------------------------------------------------------------------
# Quoted heredoc: everything below reaches the container verbatim, and is only
# ever expanded by the container's own shell.
#
# `nc -w SEC host port </dev/null`, NOT `nc -z`. The image is alpine, whose nc
# is busybox, which has no -z -- `nc -w 4 -z host port` there produces no output
# and no error, i.e. a probe that reports nothing while looking like it ran.
# `-w SEC  Timeout for connects` is in busybox's own help; -z is OpenBSD's.
PROBE_FUNCTIONS=$(cat <<'PROBE'
try() {
  name=$1; host=$2; port=$3
  [ -z "$host" ] && { printf '%s\tno-address\tSKIPPED\n' "$name"; return 0; }
  start=$(date +%s)
  nc -w 4 "$host" "$port" </dev/null >/dev/null 2>&1 && verdict=CONNECTED || verdict=
  took=$(( $(date +%s) - start ))
  if [ -z "$verdict" ]; then
    # A RST comes back immediately; a dropped packet costs the full -w. One
    # second of resolution is plenty to tell 0s from 4s.
    if [ "$took" -ge 3 ]; then verdict=TIMEOUT; else verdict=REFUSED; fi
  fi
  printf '%s\t%s:%s\t%s\n' "$name" "$host" "$port" "$verdict"
}
PROBE
)

# Runs the probes and ACCOUNTS FOR EVERY ONE. A probe container can die partway
# -- egress enforcement between here and the target can kill it outright -- and
# the failure then looks exactly like "nothing to report", which is the shape of
# bug this repo is most prone to. So the expected names are known here, and any
# that did not come back is said out loud rather than omitted.
run_probes() {
  local script="$1" expected out
  expected=$(printf '%s\n' "$script" | sed -n "s/^try '\([^']*\)'.*/\1/p")
  out=$(inner run --rm "$PROBE_IMAGE" sh -c "$PROBE_FUNCTIONS
$script" 2>/dev/null)

  printf '%s\n' "$out" | while IFS=$'\t' read -r name target verdict; do
    [ -z "$name" ] && continue
    case "$verdict" in
      CONNECTED) reach   "$name ($target) -- connected, something is listening" ;;
      REFUSED)   reach   "$name ($target) -- refused, so the packet ARRIVED" ;;
      TIMEOUT)   blocked "$name ($target) -- timed out, dropped in flight" ;;
      SKIPPED)   info    "$name -- skipped, no address to probe" ;;
    esac
  done

  # awk with an exact field compare, not grep: these names carry parentheses and
  # spaces, and building a regex out of them would match by accident or not at all.
  printf '%s\n' "$expected" | while IFS= read -r name; do
    [ -z "$name" ] && continue
    printf '%s\n' "$out" | awk -F'\t' -v n="$name" '$1 == n { found = 1 } END { exit !found }' || \
      printf '  \033[1;31mNO RESULT\033[0m %s -- the probe container did not report.\n            Re-run; if it persists, the container is being killed mid-probe\n            (some egress enforcement does this) and the result is unknown,\n            NOT "blocked".\n' "$name"
  done
}

# ---------------------------------------------------------------------------
head2 "1. can a devcontainer reach the outer stack containers?"
# ---------------------------------------------------------------------------
# The editor is the interesting one: reachable means a compromised project can
# at least talk to it, and brute-force or CSRF it, rather than being unable to
# address it at all.
run_probes "
try 'editor (openvscode)' '$VSCODE_IP' 3000
try 'orchestrator'        '$ORCH_IP'   3000
"

# ---------------------------------------------------------------------------
head2 "2. can it reach the VM itself, beyond the two allowed ports?"
# ---------------------------------------------------------------------------
# The input chain allows 18080 (proxy), 5353 (dns), 18081 (CA) and drops the
# rest. sshd on 22 is the one worth checking: reachable would mean a project can
# at least knock on the VM's front door.
run_probes "
try 'proxy (expected reachable)'     '$GW' 18080
try 'CA server (expected reachable)' '$GW' 18081
try 'VM sshd (expected blocked)'     '$GW' 22
"

# ---------------------------------------------------------------------------
head2 "3. can it reach a sibling devcontainer?"
# ---------------------------------------------------------------------------
# Known and documented (icc=true on the inner daemon's default bridge). Included
# because a fix for step 1 is not automatically a fix for this, and the two are
# easy to conflate.
SIBLINGS=$(inner ps --format '{{.Names}}\t{{.Networks}}' 2>/dev/null \
            | grep -v '^desolate-relay-' | head -5 || true)
if [ -z "$SIBLINGS" ]; then
  info "no containers on the inner daemon -- start a project to test this"
else
  printf '%s\n' "$SIBLINGS" | while IFS=$'\t' read -r n _; do
    ip=$(inner inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$n" 2>/dev/null | tr -d '\r')
    [ -n "$ip" ] && info "sibling $n at $ip"
  done
  info "(all on the same icc=true bridge, so mutually reachable by design)"
fi

# ---------------------------------------------------------------------------
head2 "verdict"
# ---------------------------------------------------------------------------
cat <<EOF
  REFUSED and CONNECTED both mean the packet arrived. Only TIMEOUT means the
  ruleset stopped it.

  If step 1 shows the editor REACHABLE, the forward-chain drop is not covering
  bridged traffic, and 'nothing but the proxy and the resolver' is true of
  ROUTED egress only. That is a smaller claim than the README makes.

  Fixes, cheapest first -- see tests/probes/README-devnet-fixes.md
EOF
