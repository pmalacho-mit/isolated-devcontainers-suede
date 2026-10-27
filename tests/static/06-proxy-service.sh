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

group "desolate's directory: the layout, over the old flat one"
# What every container mounts at /desolate, laid out by install.sh and filled
# with the CA by desolate-proxy-ca.service. Both blocks EXECUTED here against a
# scratch directory, the one change being where that directory is (and who
# owns it) -- over the flat layout a VM had before the move, which must go.
PUB_ROOT=$(mktemp -d)
PUB="$PUB_ROOT/public"
mkdir -p "$PUB"
for old in ca.pem install-ca.sh trust-proxy-in-builds.sh desolate-status desolate-net desolate-work; do
  echo "the old flat $old" > "$PUB/$old"
done
LAYOUT=$(sed -n '/^PUBLIC=\/var\/lib\/desolate-proxy\/public$/,/"\$PUBLIC\/desolate-net" "\$PUBLIC\/desolate-work"$/p' "$RELEASE/proxy/vm/install.sh" \
  | sed "s|^PUBLIC=.*|PUBLIC=$PUB|; s|-o desolate-proxy -g desolate-proxy ||")
if [ -z "$LAYOUT" ]; then
  fail "found the public layout in install.sh" "sed matched nothing -- did the block move?"
else
  (cd "$RELEASE/proxy/vm" && sh -c "$LAYOUT") && (cd "$RELEASE/proxy/vm" && sh -c "$LAYOUT") \
    && pass "it runs, twice (over the old flat layout, then over itself)" || fail "it runs, twice" ""
  for f in ca/install-ca.sh ca/trust-proxy-in-builds.sh status net AGENTS.md; do
    [ -f "$PUB/$f" ] && [ ! -L "$PUB/$f" ] && pass "$f is there" || fail "$f is there" "$(ls -la "$PUB/$f" 2>&1)"
  done
  assert_eq "status is the shipped helper" "$(cmp -s "$PUB/status" "$RELEASE/proxy/container/desolate-status" && echo same)" "same"
  assert_eq "nothing of the old layout is left" "$(cd "$PUB" && ls -A | sort | tr '\n' ' ')" "AGENTS.md ca net status "
fi

# desolate-proxy-ca.service's ExecStartPre: the cert into ca/.
CA_PRE=$(sed -n "/^ExecStartPre=\/bin\/sh -c '/,/'\$/p" "$RELEASE/proxy/vm/desolate-proxy-ca.service" \
  | sed "1s|^ExecStartPre=/bin/sh -c '||; \$s|'\$||; s|\\\\\$||" | tr '\n' ' ')
mkdir -p "$PUB_ROOT/opt"
echo "minted" > "$PUB_ROOT/mitmproxy-ca-cert.pem"
cp "$RELEASE/proxy/container/install-ca.sh" "$PUB_ROOT/opt/install-ca.sh"
CA_PRE=${CA_PRE//\/var\/lib\/desolate-proxy/$PUB_ROOT}
CA_PRE=${CA_PRE//\/opt\/desolate-proxy/$PUB_ROOT/opt}
if sh -c "$CA_PRE" 2>/dev/null; then pass "the CA unit's ExecStartPre runs"; else fail "the CA unit's ExecStartPre runs" "$CA_PRE"; fi
assert_eq "the cert lands in ca/" "$(cat "$PUB/ca/ca.pem" 2>&1)" "minted"
assert_eq "and nothing at the top level" "$(cd "$PUB" && ls -A | sort | tr '\n' ' ')" "AGENTS.md ca net status "
rm -rf "$PUB_ROOT"

summary
