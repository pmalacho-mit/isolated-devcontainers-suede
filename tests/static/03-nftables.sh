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
assert_contains "forward has a catch-all drop" "$FWD" 'iifname $DESOLATE_IF drop'
LAST=$(printf '%s' "$FWD" | grep -vE '^\s*(#.*)?$' | grep -v '^    }' | tail -1 | sed 's/^ *//')
assert_eq "the catch-all drop is the LAST forward rule" "$LAST" 'iifname $DESOLATE_IF drop'

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
assert_contains "ssh is restricted to a resolved-host set" "$RULES" "daddr @ssh_allow_v4 tcp dport 22 accept"
assert_contains "the v4 set exists" "$RULES" "set ssh_allow_v4"
assert_contains "the v6 set exists" "$RULES" "set ssh_allow_v6"
assert_contains "the sets expire so a stale IP does not stay reachable" "$RULES" "timeout 1h"

group "dnsmasq feeds the ssh allowlist"
DNS=$(cat "$RELEASE/proxy/vm/dnsmasq-desolate.conf")
assert_contains "resolver listens on the redirected port" "$DNS" "port=5353"
assert_contains "resolver ignores the VM's own resolv.conf" "$DNS" "no-resolv"
assert_contains "github is in the nftset allowlist" "$DNS" "nftset=/github.com/inet#desolate#ssh_allow_v4"

summary
