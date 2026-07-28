#!/usr/bin/env bash
# The nftables ruleset is what makes egress default-deny. A typo here does not
# fail loudly -- it just stops filtering.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

CONF="$RELEASE/proxy/vm/nftables-desolate.conf"
RULES=$(cat "$CONF")

group "ruleset parses"
if command -v nft >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
  # `delete table` on a table that does not exist is an error in check mode,
  # so feed nft the ruleset with the create/delete idempotency pair removed.
  TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
  grep -v '^delete table inet desolate$' "$CONF" | grep -v '^table inet desolate$' > "$TMP"
  assert_ok "nft -c -f accepts the ruleset" nft -c -f "$TMP"
else
  skip "nft -c -f accepts the ruleset" "needs nft and root"
fi

group "the forward chain is default-deny"
# Order matters: the catch-all drop must come after the accepts, and there must
# BE a catch-all drop. Without it the chain's `policy accept` lets everything
# out on any port, and the "egress can only leave via the proxy" claim is false.
FWD=$(printf '%s' "$RULES" | awk '/chain forward/,/^    }/')
assert_contains "forward accepts established flows" "$FWD" "ct state established,related accept"
assert_contains "forward drops QUIC so TLS falls back to interceptable TCP" "$FWD" "udp dport 443 drop"
# `counter` is optional on these rules and carries no semantics -- it only makes
# `nft list table` show which rule fired, which is how you tell "the ssh
# allowlist is empty" from "something else dropped it". Normalise it away so the
# assertion is about the DROP being present and last, not about its spelling.
nocount() { printf '%s' "$1" | sed 's/ counter / /g'; }
assert_contains "forward has a catch-all drop" "$(nocount "$FWD")" 'iifname $DESOLATE_IF drop'
LAST=$(printf '%s' "$FWD" | grep -vE '^\s*(#.*)?$' | grep -v '^    }' | tail -1 | sed 's/^ *//')
assert_eq "the catch-all drop is the LAST forward rule" "$(nocount "$LAST")" 'iifname $DESOLATE_IF drop'
# The counters are what make an SSH refusal diagnosable at all, so pin them.
assert_contains "the catch-all drop counts what it drops" "$FWD" 'counter drop'
assert_contains "the ssh allowlist accept is counted too" "$FWD" 'tcp dport 22 counter accept'

group "interception covers what it must"
PRE=$(printf '%s' "$RULES" | awk '/chain prerouting/,/^    }/')
assert_contains "http+https are redirected to the proxy" "$PRE" "tcp dport { 80, 443 } redirect to :18080"
assert_contains "udp dns is redirected to the local resolver" "$PRE" "udp dport 53  redirect to :5353"
assert_contains "tcp dns is redirected too" "$PRE" "tcp dport 53  redirect to :5353"
# Dev server ports must NOT be redirected: they are inbound from the Mac.
assert_not_contains "the 8080-8090 dev-server range is left alone" "$PRE" "dport 8080"

group "the input chain protects the rest of the VM"
IN=$(printf '%s' "$RULES" | awk '/chain input/,/^    }/')
for port in 18080 5353 18081; do
  # the file pads columns, so normalise whitespace before matching
  assert_contains "input allows :$port" "$(printf '%s' "$IN" | tr -s ' ')" "dport $port accept"
done
assert_contains "input has a catch-all drop" "$IN" 'iifname $DESOLATE_IF drop'
LAST_IN=$(printf '%s' "$IN" | grep -vE '^\s*(#.*)?$' | grep -v '^    }' | tail -1 | sed 's/^ *//')
assert_eq "the catch-all drop is the LAST input rule" "$LAST_IN" 'iifname $DESOLATE_IF drop'
# The VM's own SSH, the docker API, anything else on the VM: unreachable.
assert_not_contains "input does not blanket-accept tcp/22 to the VM" "$IN" "dport 22 accept"

group "git-over-ssh is allowlisted, not opened"
assert_contains "ssh is restricted to a resolved-host set" \
  "$(nocount "$RULES")" "daddr @ssh_allow_v4 tcp dport 22 accept"
assert_contains "the v4 set exists" "$RULES" "set ssh_allow_v4"
assert_contains "the v6 set exists" "$RULES" "set ssh_allow_v6"
# The sets hold CIDRs written by ssh-allow.sh, so `flags interval` is required.
# The entries are a fetched fact rather than a DNS side effect, so there is no
# timeout to expire them out from under a running clone.
NOCOMMENT=$(printf '%s' "$RULES" | grep -v '^[[:space:]]*#')
assert_contains "the ssh sets hold ranges (CIDRs from GitHub)" "$NOCOMMENT" "flags interval"

group "the ssh allowlist is a fetched fact, not a DNS side effect"
# It was filled by dnsmasq's nftset= for a long time and never once worked. The
# unfixable reason: containers resolve through Docker's embedded DNS at
# 127.0.0.11, which forwards upstream from a path the `iifname br-desolate`
# redirect never sees -- so that resolver never observes the lookups at all.
# Verified directly: a query aimed at 1.1.1.1:53 IS intercepted and logged, the
# same name via getent is not.
assert_not_contains "dnsmasq does not claim to fill the ssh sets" \
  "$(grep -v '^[[:space:]]*#' "$RELEASE/proxy/vm/dnsmasq-desolate.conf")" "nftset="
assert_ok "ssh-allow.sh exists and is executable" test -x "$RELEASE/proxy/vm/ssh-allow.sh"
assert_ok "the nft unit refills the sets after every reload" \
  grep -q "ExecStartPost=/opt/desolate-proxy/ssh-allow.sh" "$RELEASE/proxy/vm/install.sh"
assert_ok "install runs it too (the load above empties the sets)" \
  grep -q "^/opt/desolate-proxy/ssh-allow.sh" "$RELEASE/proxy/vm/install.sh"
