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
assert_contains "forward has a catch-all drop" "$(nocount "$FWD")" 'iifname $DESOLATE_IFS drop'
LAST=$(printf '%s' "$FWD" | grep -vE '^\s*(#.*)?$' | grep -v '^    }' | tail -1 | sed 's/^ *//')
assert_eq "the catch-all drop is the LAST forward rule" "$(nocount "$LAST")" 'iifname $DESOLATE_IFS drop'
# The counters are what make an SSH refusal diagnosable at all, so pin them.
assert_contains "the catch-all drop counts what it drops" "$FWD" 'counter drop'
assert_contains "the ssh allowlist accept is counted too" "$FWD" 'tcp dport 22 counter accept'

group "the two bridges are distinct and both are armed"
# Arming only the editor's bridge would leave the container world -- dind and
# every devcontainer in it -- with no egress filter and no lateral wall, which
# is the inverse of what this layer is for.
EDITOR_IF=$(sed -n 's/^define DESOLATE_IF = "\(.*\)"$/\1/p' "$CONF")
DIND_IF=$(sed -n 's/^define DESOLATE_DIND_IF = "\(.*\)"$/\1/p' "$CONF")
assert_eq "DESOLATE_IF is defined" "$([ -n "$EDITOR_IF" ] && echo yes || echo no)" "yes"
assert_eq "DESOLATE_DIND_IF is defined" "$([ -n "$DIND_IF" ] && echo yes || echo no)" "yes"
assert_eq "the two interfaces are different" \
  "$([ "$EDITOR_IF" != "$DIND_IF" ] && echo yes || echo no)" "yes"
IFS_LINE=$(sed -n 's/^define DESOLATE_IFS = //p' "$CONF")
assert_contains "DESOLATE_IFS includes the editor bridge" "$IFS_LINE" "$EDITOR_IF"
assert_contains "DESOLATE_IFS includes the container bridge" "$IFS_LINE" "$DIND_IF"

group "the lateral wall is stated, not inferred"
# The catch-all drop below happens to block dind->vscode as a side effect. That
# is not good enough: it is written as an EGRESS rule, so any future rule added
# above it for egress reasons could open the lateral path without anyone
# noticing. Assert the drops directly, and assert they precede the ct-state
# accept -- placed after it, an established flow would cross.
assert_contains "container->editor is dropped" "$(nocount "$FWD")" \
  'iifname $DESOLATE_DIND_IF oifname $DESOLATE_IF      drop'
assert_contains "editor->container is dropped" "$(nocount "$FWD")" \
  'iifname $DESOLATE_IF      oifname $DESOLATE_DIND_IF drop'
LATERAL_LINE=$(printf '%s' "$FWD" | grep -n 'oifname \$DESOLATE_IF ' | head -1 | cut -d: -f1)
CT_LINE=$(printf '%s' "$FWD" | grep -n 'ct state established,related accept' | head -1 | cut -d: -f1)
assert_eq "the lateral drops come BEFORE the established-state accept" \
  "$([ -n "$LATERAL_LINE" ] && [ -n "$CT_LINE" ] && [ "$LATERAL_LINE" -lt "$CT_LINE" ] && echo yes || echo no)" "yes"

group "git-over-ssh is the editor's, not the container world's"
# The editor mints deploy keys and runs git push; a devcontainer has no reason
# to speak SSH anywhere. Leaving :22 open to the container bridge pre-authorises
# the exfiltration half of a key theft.
assert_contains "ssh accept is scoped to the editor bridge" "$(nocount "$FWD")" \
  'iifname $DESOLATE_IF ip  daddr @ssh_allow_v4 tcp dport 22 accept'
assert_not_contains "ssh is NOT opened to every desolate interface" "$FWD" \
  'iifname $DESOLATE_IFS ip  daddr @ssh_allow_v4'

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
assert_contains "input has a catch-all drop" "$IN" 'iifname $DESOLATE_IFS drop'
LAST_IN=$(printf '%s' "$IN" | grep -vE '^\s*(#.*)?$' | grep -v '^    }' | tail -1 | sed 's/^ *//')
assert_eq "the catch-all drop is the LAST input rule" "$LAST_IN" 'iifname $DESOLATE_IFS drop'
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

group "the proxy's own egress is bounded (the deputy chain)"
# The chains above filter packets FROM the container bridges. None of them see
# the packet the PROXY sends on a container's behalf: prerouting redirects
# :80/:443 here whatever the destination was, and mitmproxy then dials that
# destination as a VM process. addon.py refuses internal addresses itself, but
# it cannot be the only wall -- connection_strategy=eager dials before the
# request hook runs, tls_passthrough never reaches that hook, and an addon that
# fails to load enforces nothing. All three are invisible to the kernel.
OUT=$(printf '%s' "$RULES" | awk '/chain output/,/^    }/')
assert_eq "there is an output chain" \
  "$([ -n "$OUT" ] && echo yes || echo no)" "yes"
assert_contains "it drops internal v4 destinations for the proxy uid" "$(nocount "$OUT")" \
  'meta skuid desolate-proxy ip  daddr $DESOLATE_INTERNAL4 drop'
assert_contains "it drops internal v6 destinations for the proxy uid" "$(nocount "$OUT")" \
  'meta skuid desolate-proxy ip6 daddr $DESOLATE_INTERNAL6 drop'
assert_contains "the drops are counted, so an attempt is visible" "$OUT" 'counter drop'

# ORDER. Both of these accepts MUST precede the drops, and each for a reason
# that is invisible once it is working:
#
#   - replies: mitmproxy answers every intercepted client on the container
#     bridges (172.16/12) and the CA server shares that uid on :18081. Those
#     are output packets to a private address from the restricted uid, so
#     without the ct-state accept first this chain drops every reply the stack
#     is built on -- interception included.
#   - DNS: the proxy resolves the hosts it dials through the VM's resolver,
#     which on Colima is itself an RFC1918 address over vmnet. Dropped, every
#     request times out and nothing points back here.
DROP_LINE=$(printf '%s' "$OUT" | grep -n 'daddr \$DESOLATE_INTERNAL4' | head -1 | cut -d: -f1)
CT_ACCEPT=$(printf '%s' "$OUT" | grep -n 'ct state established,related accept' | head -1 | cut -d: -f1)
DNS_ACCEPT=$(printf '%s' "$OUT" | grep -n 'udp dport 53 accept' | head -1 | cut -d: -f1)
assert_eq "replies are accepted BEFORE the drops" \
  "$([ -n "$CT_ACCEPT" ] && [ -n "$DROP_LINE" ] && [ "$CT_ACCEPT" -lt "$DROP_LINE" ] && echo yes || echo no)" "yes"
assert_eq "the proxy's DNS is accepted BEFORE the drops" \
  "$([ -n "$DNS_ACCEPT" ] && [ -n "$DROP_LINE" ] && [ "$DNS_ACCEPT" -lt "$DROP_LINE" ] && echo yes || echo no)" "yes"
assert_contains "loopback is accepted too (the local resolver and CA server)" "$OUT" \
  'meta skuid desolate-proxy oifname "lo" accept'

# The ranges themselves. addon.py's is_internal() is the authority; these are
# the kernel's copy of it, and the two drifting apart is how one of them ends up
# enforcing less than the other.
V4=$(sed -n 's/^define DESOLATE_INTERNAL4 = //p' "$CONF")
for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 169.254.0.0/16 100.64.0.0/10; do
  assert_contains "internal v4 list covers $range" "$V4" "$range"
done
V6=$(sed -n 's/^define DESOLATE_INTERNAL6 = //p' "$CONF")
for range in ::1/128 fc00::/7 fe80::/10; do
  assert_contains "internal v6 list covers $range" "$V6" "$range"
done

# nft resolves `skuid desolate-proxy` to a uid at PARSE time, so a missing
# account is not a rule that fails -- it is a file that does not parse, and
# `nft -f` applies nothing at all. Interception and the forward default-deny
# would be absent together, on a VM that looks installed.
assert_ok "install.sh checks the account exists before loading the ruleset" \
  grep -q 'id desolate-proxy >/dev/null 2>&1 ||' "$RELEASE/proxy/vm/install.sh"

summary
