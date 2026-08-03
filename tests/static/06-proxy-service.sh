#!/usr/bin/env bash
# The mitmproxy options the "proven destination" model depends on.
#
# addon.py decides two things on the TLS SNI: whether a secret may be
# substituted, and (since the allow/deny split) whether the network policy
# permits the request at all. The SNI is chosen by the client. What makes it
# PROVEN rather than claimed is entirely outside addon.py:
#
#   - mitmproxy completes the upstream TLS handshake BEFORE the request hook,
#     so a forged SNI toward an attacker's address never produces a request;
#   - and that handshake verifies the certificate.
#
# The first is `connection_strategy=eager`, the second is `ssl_insecure=false`.
# Both are mitmproxy DEFAULTS, which is exactly the problem: nothing in this
# tree chose them, so an upstream change would move the security boundary with
# no error, no failed request and no other symptom. The unit pins them; this
# asserts the pin, because mitmproxy does not validate `--set` values against an
# option's declared choices -- `--set connection_strategy=bogus` loads happily,
# so a typo would silently restore the default.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

UNIT="$RELEASE/proxy/vm/desolate-proxy.service"
if [ ! -f "$UNIT" ]; then
  fail "desolate-proxy.service exists" "$UNIT not found"
  summary; exit $?
fi

# The comment block above ExecStart explains all of this; strip comments so the
# assertions are about what systemd will RUN, not about the prose.
EXEC=$(grep -v '^[[:space:]]*#' "$UNIT" | awk '/^ExecStart=/,/[^\\]$/')

group "the proxy runs in the mode addon.py assumes"
# destination_address() reads the original destination out of request.host,
# which is only the real destination in transparent mode.
assert_contains "the proxy runs in transparent mode" "$EXEC" "--mode transparent"
assert_contains "the addon is actually loaded" "$EXEC" "-s /opt/desolate-proxy/addon.py"

group "the proven-destination options are pinned, not inherited"
assert_contains "connection_strategy is pinned to eager" "$EXEC" \
  "--set connection_strategy=eager"
assert_contains "ssl_insecure is pinned to false" "$EXEC" \
  "--set ssl_insecure=false"
# The failure that matters is the inverse, and it is worth naming separately:
# lazy defers the upstream handshake until after policy has decided.
assert_not_contains "connection_strategy is NOT lazy" "$EXEC" \
  "connection_strategy=lazy"
assert_not_contains "upstream certificates are NOT accepted blindly" "$EXEC" \
  "ssl_insecure=true"

group "the integration harness runs the same proxy it ships"
# tests/integration/proxy launches its own mitmdump. If it does not carry the
# same pins, it exercises a proxy the users never run -- and would keep passing
# after a regression in the unit.
PROXY_RUN="$ROOT/tests/integration/proxy/run.sh"
if [ ! -f "$PROXY_RUN" ]; then
  skip "proxy harness pins" "tests/integration/proxy/run.sh not found"
else
  HARNESS=$(grep -v '^[[:space:]]*#' "$PROXY_RUN")
  assert_contains "the harness pins connection_strategy too" "$HARNESS" \
    "connection_strategy=eager"
  assert_contains "the harness pins ssl_insecure too" "$HARNESS" \
    "ssl_insecure=false"
fi

summary
