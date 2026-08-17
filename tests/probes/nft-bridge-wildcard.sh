#!/usr/bin/env bash
# PROBE -- not a test. Answers a capability question about the environment so a
# design decision can be made; it asserts no invariant and gates nothing.
#
# QUESTION: can ONE nftables rule cover every per-project bridge that will ever
# exist, so that interception does not depend on a runtime mutation nobody
# watches?
#
# Why it matters. `tests/probes/v2-baseline.sh` B5 answered that a per-project
# bridge is not covered by the desolate ruleset, and reading
# `release/proxy/vm/install.sh` says why: it writes
#
#     define DESOLATE_IFS = { "br-desolate", "br-desolate-in" }
#
# as a two-element literal, once, at install time. Every rule in
# `nftables-desolate.conf` matches `iifname $DESOLATE_IFS`, including the
# forward chain's closing `counter drop`. A bridge created later is therefore
# not merely un-intercepted -- it is outside the default-deny AND outside the
# four lateral-containment drops. Both walls, silently, for a bridge whose whole
# purpose is to carry a project's egress.
#
# `desolate-supervisor` cannot fix this at runtime: it is a container, and `nft`
# is on the VM. So the rule has to be written once, in advance, in a form that
# matches bridges that do not exist yet. `dind.bridge()` names them all
# `br-d-<hash>`, which makes a prefix match the obvious candidate -- if nftables
# supports one where this ruleset needs it.
#
#   W1  does `iifname "br-d-*"` match a bridge created after the rule?
#   W2  does the wildcard work INSIDE a set -- `{ "br-x", "br-d-*" }`? This is
#       the one that decides the shape of the fix. If yes, `DESOLATE_IFS` gains
#       one element and every rule in the file keeps working untouched. If no,
#       the ruleset needs a parallel rule per existing rule, which is the same
#       rule written twice and will drift.
#   W3  does the LIVE desolate ruleset see this traffic at all? Measured off its
#       own counters, so the bypass is demonstrated rather than deduced.
#
# ANSWERED 2026-08-17 on nftables v1.0.9 -- W1 and W2 are both YES, and the fix
# is in `nftables-desolate.conf` and `install.sh`. Measured, not read:
#
#   - `iifname "br-d-*"` counted 14 packets from a bridge created AFTER the rule
#     was written, both bare and inside a set.
#   - `{ "br-desolate", "br-desolate-in", "br-d-*" }` keeps all three elements.
#   - `{ "br-desolate", "br-desolate-in", "br-d*" }` -- one character shorter --
#     is stored by nft as `{ "br-d*" }`. Both named bridges are merged into the
#     wildcard, and every unrelated br-d... interface on the VM is dragged under
#     desolate's default-deny. The hyphen is the whole safety margin.
#
# It was answered on a container's nftables rather than on the VM's, so W3 -- the
# live bypass, off the real ruleset's counters -- is still worth running, and it
# re-checks W1/W2 against the version the VM actually has.
#
# SAFETY. Everything this adds is `counter` only, in a table of its own
# (`inet desolate_nftprobe`) at a priority AFTER the real one. It drops nothing,
# accepts nothing, and changes no existing rule. It removes its table, its
# throwaway docker network and its container on exit, including on failure.
#
# ---------------------------------------------------------------------------
# HOW TO RUN -- on your Mac. Needs sudo inside the VM (nft is root-only). The
# stack should be UP for W3 to have counters to read:
#
#   ./tests/probes/nft-bridge-wildcard.sh
set -uo pipefail

PROFILE="${COLIMA_PROFILE:-desolate}"

if [ "${DESOLATE_NFTPROBE_INVM:-}" != 1 ]; then
  if ! command -v colima >/dev/null 2>&1; then
    echo "This probe must run from the Mac (colima not found on PATH)." >&2
    echo "If you are already inside the VM, re-run with DESOLATE_NFTPROBE_INVM=1." >&2
    exit 1
  fi
  echo "== entering the Colima VM (profile '$PROFILE') =="
  exec colima ssh -p "$PROFILE" -- env DESOLATE_NFTPROBE_INVM=1 bash -s < "$0"
  exit 1
fi

# ---- inside the VM ---------------------------------------------------------

TABLE=desolate_nftprobe
NETWORK=desolate-nftprobe-net
BRIDGE=br-d-nftprobe          # the shape dind.bridge() produces: br-d-<hash>
CONTAINER=desolate-nftprobe
DECOY=br-d-absent             # a name in the set that matches no interface

W1="UNKNOWN"; W2="UNKNOWN"; W3="UNKNOWN"; NFT_VERSION=""

note() { printf '      %s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }

nft() { sudo nft "$@"; }

cleanup() {
  nft delete table inet "$TABLE" >/dev/null 2>&1
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  docker network rm "$NETWORK" >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

require_nft() {
  NFT_VERSION=$(nft --version 2>/dev/null)
  [ -n "$NFT_VERSION" ] || { bad "cannot run nft (needs sudo in the VM)"; exit 1; }
  note "$NFT_VERSION"
}

# The bridge is created BEFORE the rules on purpose in one respect and after in
# another: docker must have made the interface for traffic to flow, but the
# RULES are written without naming it, which is the whole question.
create_probe_bridge() {
  docker network rm "$NETWORK" >/dev/null 2>&1
  docker network create -o "com.docker.network.bridge.name=$BRIDGE" "$NETWORK" >/dev/null 2>&1 \
    || { bad "could not create a docker network named $BRIDGE"; exit 1; }
  ok "created $BRIDGE, the shape dind.bridge() produces"
}

# Two counters, in one table of our own, both matching only by wildcard.
install_counting_rules() {
  nft delete table inet "$TABLE" >/dev/null 2>&1
  if ! nft -f - <<RULES 2>/tmp/nftprobe.err
table inet $TABLE {
  chain forward {
    type filter hook forward priority filter + 10; policy accept;
    iifname "br-d-*" counter comment "bare-wildcard"
    iifname { "$DECOY", "br-d-*" } counter comment "wildcard-in-set"
  }
}
RULES
  then
    bad "nftables refused the ruleset -- one of the two forms does not parse"
    sed 's/^/        /' /tmp/nftprobe.err
    # Which one? Retry with only the bare wildcard, so a set-only failure is
    # reported as such rather than condemning both.
    if nft -f - <<BARE >/dev/null 2>&1
table inet $TABLE {
  chain forward {
    type filter hook forward priority filter + 10; policy accept;
    iifname "br-d-*" counter comment "bare-wildcard"
  }
}
BARE
    then
      note "the bare wildcard parses; the SET form is what nftables refused"
      W2="NO -- a wildcard inside a set does not parse here"
      return 0
    fi
    W1="NO -- 'iifname \"br-d-*\"' does not parse here"
    W2="NO -- not reached"
    return 1
  fi
  ok "both forms parse"
  return 0
}

desolate_forward_drops() {
  nft list table inet desolate 2>/dev/null |
    awk '/iifname .*counter/ && /drop/ { sum += $(NF-2) } END { print sum + 0 }'
}

# Parsing does not mean matching. Only traffic proves it.
generate_traffic() {
  docker pull -q alpine:3 >/dev/null 2>&1
  docker run --rm --name "$CONTAINER" --network "$NETWORK" alpine:3 \
    sh -c 'ping -c 2 -W 2 1.1.1.1 >/dev/null 2>&1; wget -q -T 3 -O /dev/null http://1.1.1.1 2>/dev/null; true' \
    >/dev/null 2>&1
  ok "sent traffic from a container on $BRIDGE"
}

counter_for() {
  nft list table inet "$TABLE" 2>/dev/null |
    awk -v want="$1" '$0 ~ want { for (i = 1; i <= NF; i++) if ($i == "packets") print $(i+1) }'
}

report_matches() {
  local bare set_form
  bare=$(counter_for "bare-wildcard")
  set_form=$(counter_for "wildcard-in-set")
  note "bare wildcard  counted: ${bare:-unreadable} packets"
  note "wildcard-in-set counted: ${set_form:-unreadable} packets"

  if [ "${bare:-0}" -gt 0 ] 2>/dev/null; then
    ok "'iifname \"br-d-*\"' MATCHES a bridge created after the rule"
    W1="YES"
  else
    bad "the bare wildcard did not match"
    W1="NO -- parsed but matched nothing"
  fi

  case "$W2" in
    NO*) return ;;  # it did not parse; nothing to measure
  esac
  if [ "${set_form:-0}" -gt 0 ] 2>/dev/null; then
    ok "the wildcard matches INSIDE a set -- DESOLATE_IFS can just gain an element"
    W2="YES"
  else
    bad "the wildcard parsed inside a set but matched nothing"
    W2="NO -- parsed in a set but did not match"
  fi
}

# The bypass, from the real ruleset's own counters rather than by inference.
check_live_ruleset() {
  if ! nft list table inet desolate >/dev/null 2>&1; then
    note "no 'inet desolate' table -- is the proxy installed? (./cli.sh vm install)"
    W3="UNKNOWN -- no desolate table"
    return
  fi
  local after=$1 before=$2
  note "desolate forward drop counters: $before -> $after"
  if [ "$after" = "$before" ]; then
    bad "the live ruleset did not see ANY of that traffic"
    note "so a per-project bridge is outside the default-deny AND the lateral drops"
    W3="CONFIRMED bypass -- counters did not move"
  else
    W3="the desolate table counted it ($before -> $after)"
  fi
}

echo
echo "== 0. nftables on this VM =="
require_nft
echo
echo "== 1. a bridge shaped like a per-project one =="
create_probe_bridge
echo
echo "== W1/W2. do the two wildcard forms parse =="
if install_counting_rules; then
  BEFORE=$(desolate_forward_drops)
  echo
  echo "== W1/W2. and do they MATCH =="
  generate_traffic
  report_matches
  echo
  echo "== W3. did the live desolate ruleset see any of it =="
  check_live_ruleset "$(desolate_forward_drops)" "$BEFORE"
fi

echo
echo "=============== SUMMARY (paste this back) ==============="
echo "  nft                 : ${NFT_VERSION:-unknown}"
echo "  W1 bare wildcard    : $W1"
echo "  W2 wildcard in a set: $W2"
echo "  W3 live ruleset     : $W3"
echo "========================================================="
echo
case "$W2" in
  YES) echo "VERDICT: the fix is one element. Add \"br-d-*\" to DESOLATE_IFS in"
       echo "         install.sh's sed, and every rule in nftables-desolate.conf --"
       echo "         redirect, lateral drops, default-deny, input -- covers every"
       echo "         per-project bridge without any runtime mutation." ;;
  *)   case "$W1" in
         YES) echo "VERDICT: the wildcard works but not inside a set, so DESOLATE_IFS cannot"
              echo "         carry it. Either define a NAMED set of type ifname and populate it"
              echo "         (which needs something on the VM to add to it), or accept a"
              echo "         parallel rule per existing rule -- the same rule written twice,"
              echo "         which is what preflight then has to check has not drifted." ;;
         *)   echo "VERDICT: no wildcard match available here. A named set updated at runtime"
              echo "         is the remaining option, and it needs a VM-side component -- which"
              echo "         is precisely the 'new place interception can be silently absent'"
              echo "         the spec warned about. Budget the preflight assertion accordingly." ;;
       esac ;;
esac
echo
echo "Whichever wins, the preflight assertion is not optional: every br-* interface"
echo "on the VM should be matched by some rule in the desolate table, or the stack"
echo "should refuse to come up. That is what turns a silent bypass into a loud one."
echo
