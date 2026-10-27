#!/usr/bin/env bash
# The desolate extension (T4.7, F6) in a real browser, against the real editor.
#
#   ./tests/environments/extension/run.sh <editor-image> [<out-dir>]
#
# Starts the outer editor from <editor-image> (release/vscode-image, built), as
# compose starts it, with a fixture /workspaces and stand-ins for the three
# commands the extension runs (DESOLATE_EXTENSION_BIN): each records its argv
# and prints what the real one would. Then headless Chromium (Playwright) opens
# the editor, the desolate views, and drives their actions; the assertions
# read the views' text and what the stand-ins were asked. Screenshots land in
# <out-dir>.
#
# Needs a docker daemon that can pull mcr.microsoft.com/playwright and npm's
# `playwright` -- through the proxy, with its CA, when run inside desolate.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
# shellcheck source=../../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"
IMAGE=${1:?usage: run.sh <editor-image> [<out-dir>]}
OUT=${2:-$(mktemp -d)}
mkdir -p "$OUT"
NET=desolate-ext-test EDITOR=desolate-ext-editor BROWSER=desolate-ext-browser
TOKEN=ext-test-token
PLAYWRIGHT=mcr.microsoft.com/playwright:v1.49.1-noble
CA=${DESOLATE_TEST_CA:-/desolate-ca/ca.pem}

cleanup() { docker rm -f "$EDITOR" "$BROWSER" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap '[ -n "${DESOLATE_TEST_KEEP:-}" ] || cleanup' EXIT
cleanup
docker network create "$NET" >/dev/null || { fail "create the test network"; summary; exit 1; }

docker run -d --name "$EDITOR" --network "$NET" -e DESOLATE_EXTENSION_BIN=/stubs \
  --entrypoint /usr/local/bin/shell-entry "$IMAGE" \
  /home/.desolate-shell/bin/codium-server --host=0.0.0.0 --port=3000 --connection-token="$TOKEN" >/dev/null \
  || { fail "start the editor from $IMAGE"; summary; exit 1; }

# /workspaces as the extension reads it: two projects, one with a worktree and
# a factory.
docker exec -u 0 "$EDITOR" sh -c '
  set -e
  for p in acme/widgets solo; do mkdir -p /workspaces/$p/.devcontainer /workspaces/$p/.git
    echo "{\"image\":\"alpine:3\"}" > /workspaces/$p/.devcontainer/devcontainer.json; done
  mkdir -p /workspaces/acme/widgets/.worktrees/issue-42/.devcontainer
  echo "{\"image\":\"alpine:3\"}" > /workspaces/acme/widgets/.worktrees/issue-42/.devcontainer/devcontainer.json
  mkdir -p /workspaces/.desolate/factory /stubs
  echo "{\"v\":1,\"max_open_worktrees\":2,\"requesters\":[\"main\",\"forge/github\"],\"branch_prefix\":\"factory/\",\"on_done\":\"hold\",\"allow_hooks\":false,\"adapters\":[\"github\"],\"remote\":\"\",\"github\":{\"repo\":\"acme/widgets\",\"label\":\"desolate:run\"}}" \
    > /workspaces/.desolate/factory/acme__widgets.json
  chown -R 1000:1000 /workspaces /stubs'

# The three commands, standing in. Each records its argv, one line per call.
docker exec -i -u 0 "$EDITOR" sh -c 'cat > /stubs/desolate && chmod +x /stubs/desolate' <<'EOF'
#!/bin/sh
echo "desolate $*" >> /tmp/calls.log
case "$*" in
  "--list --json")
    echo "desolate: driving acme/widgets's daemon"
    echo '[{"target":"acme/widgets","project":"acme/widgets","worktree":null,"daemon":"project","url":"http://127.0.0.1:8092/?tkn=secret-token-abc&folder=/workspaces/acme/widgets","ports":{"editor":8092,"5173":8093}}]' ;;
  "--dinds")
    echo '{"dinds":[{"project":"acme/widgets","name":"desolate-dind-acme__widgets","health":"healthy","running":true,"inUse":true,"memory":2147483648,"imageStoreKib":3145728}],"headroom":{"running":1,"max":16,"available":32212254720,"floor":2147483648}}' ;;
  *) echo "ready: http://127.0.0.1:8094/?tkn=another-secret-token" ;;
esac
EOF
docker exec -i -u 0 "$EDITOR" sh -c 'cat > /stubs/work && chmod +x /stubs/work' <<'EOF'
#!/bin/sh
echo "work $*" >> /tmp/calls.log
case "$1" in
  requests) echo '{"id":"01JREQ0000000000000000000A","action":"open","worktree":"issue-43","from":"forge/github","outcome":"refused: the repository has hooks","approved":false}' ;;
  log) echo '{"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","time":"2026-10-26T12:00:00Z","from":"issue-42","to":["main"],"type":"ask","body":"Which API version should I target?"}'
       echo '{"commit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","time":"2026-10-26T11:00:00Z","from":"issue-42","to":["*"],"type":"status","body":"started"}' ;;
esac
EOF
docker exec -i -u 0 "$EDITOR" sh -c 'cat > /stubs/worktree && chmod +x /stubs/worktree' <<'EOF'
#!/bin/sh
echo "worktree $*" >> /tmp/calls.log
EOF

for _ in $(seq 1 60); do
  docker exec "$EDITOR" sh -c 'exec 3<>/dev/tcp/127.0.0.1/3000' 2>/dev/null && break
  sleep 1
done

# The browser: Playwright's own image, with its npm package for the script.
docker create --name "$BROWSER" --network "$NET" -e NODE_EXTRA_CA_CERTS=/ca.pem \
  "$PLAYWRIGHT" sh -c 'mkdir -p /run/test && cd /run/test && npm init -y >/dev/null \
    && npm install --silent playwright@1.49.1 >/dev/null && cp /test.js . && node test.js' >/dev/null
[ -f "$CA" ] && docker cp "$CA" "$BROWSER:/ca.pem" >/dev/null
SCRIPT=$(mktemp -d)
cat > "$SCRIPT/test.js" <<EOF
const { chromium } = require("playwright");
(async () => {
  const report = {};
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto("http://$EDITOR:3000/?tkn=$TOKEN&folder=/workspaces");
  await page.waitForSelector(".monaco-workbench", { timeout: 90000 });
  await page.waitForTimeout(5000);
  // Workspace Trust asks about /workspaces: say no. The extension must work in
  // Restricted Mode, which is where this editor should be for a folder of
  // other people's code.
  const dialog = page.locator(".monaco-dialog-box");
  if (await dialog.isVisible().catch(() => false)) {
    report.dialog = await dialog.innerText();
    const no = dialog.locator("a.monaco-button, button", { hasText: /don.t trust/i }).first();
    if (await no.count()) await no.click(); else await page.keyboard.press("Escape");
    await page.waitForTimeout(2000);
  }
  await page.locator('.activitybar [aria-label^="desolate"]').first().click();
  await page.waitForTimeout(6000);
  // Every section open, every tree expanded, so its text can be read.
  for (const header of await page.locator(".pane-header[aria-expanded=false]").all()) await header.click();
  // A tree draws its children after the click, so expand in rounds, letting
  // each one render, until nothing is left collapsed.
  for (let round = 0; round < 8; round++) {
    const collapsed = await page.locator(".sidebar .monaco-tl-twistie.collapsible.collapsed").all();
    if (!collapsed.length) break;
    for (const twistie of collapsed) await twistie.click().catch(() => {});
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/run/test/views.png" });
  report.sidebar = await page.locator(".part.sidebar").innerText();

  // Rebuild asks first: cancelled, nothing runs; confirmed, it does.
  const project = page.locator('.sidebar .monaco-list-row:has-text("acme/widgets")').first();
  await project.hover();
  await project.locator('[aria-label="Rebuild…"]').click();
  await page.waitForTimeout(1500);
  const confirm = page.locator(".monaco-dialog-box");
  report.rebuildAsked = await confirm.innerText().catch(() => "");
  await page.screenshot({ path: "/run/test/rebuild-confirm.png" });
  await confirm.locator("a.monaco-button, button", { hasText: /^Cancel$/ }).first().click();
  await page.waitForTimeout(1500);
  await project.hover();
  await project.locator('[aria-label="Rebuild…"]').click();
  await page.waitForTimeout(1500);
  await page.locator(".monaco-dialog-box a.monaco-button, .monaco-dialog-box button", { hasText: /^Rebuild$/ }).first().click();
  await page.waitForTimeout(3000);
  // Each port row has its own Open.
  report.portOpens = await page.locator('.sidebar .monaco-list-row:has-text("127.0.0.1:") [aria-label="Open"]').count();

  // Start a stopped project from its inline action.
  const solo = page.locator('.sidebar .monaco-list-row:has-text("solo")').first();
  await solo.hover();
  await solo.locator('[aria-label="Start"]').click();
  await page.waitForTimeout(3000);
  // Open the log the action wrote to.
  await page.keyboard.press("Control+Shift+U");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "/run/test/after-start.png" });
  report.panel = await page.locator(".part.panel").innerText().catch(() => "");
  console.log("REPORT " + JSON.stringify(report));
  await browser.close();
})().catch((err) => { console.log("REPORT " + JSON.stringify({ error: String(err) })); process.exit(1); });
EOF
docker cp "$SCRIPT/test.js" "$BROWSER:/test.js" >/dev/null
docker start -a "$BROWSER" >/dev/null 2>&1
OUTPUT=$(docker logs "$BROWSER" 2>&1)
docker cp "$BROWSER:/run/test/views.png" "$OUT/" >/dev/null 2>&1
docker cp "$BROWSER:/run/test/after-start.png" "$OUT/" >/dev/null 2>&1
docker cp "$BROWSER:/run/test/rebuild-confirm.png" "$OUT/" >/dev/null 2>&1
REPORT=$(printf '%s\n' "$OUTPUT" | sed -n 's/^REPORT //p' | tail -1)
CALLS=$(docker exec "$EDITOR" cat /tmp/calls.log 2>/dev/null)
# Monaco renders a space as U+00A0; read it as one.
field() { node -e 'const r = JSON.parse(process.argv[1] || "{}"); process.stdout.write(String(r[process.argv[2]] ?? "").replace(/\u00a0/g, " "))' "$REPORT" "$1"; }

group "the views, as the browser shows them"
[ -n "$REPORT" ] || { fail "the browser ran" "$(printf '%s' "$OUTPUT" | tail -5)"; summary; exit 1; }
[ -z "$(field error)" ] || fail "the browser script finished" "$(field error)"
SIDEBAR=$(field sidebar)
assert_not_contains "an owner directory is not a project" "$SIDEBAR" $'\nacmestopped'
for text in "PROJECTS" "acme/widgets" "issue-42" "solo" "running · own dind" "127.0.0.1:8093" \
            "DINDS" "healthy · in use" "headroom" "FACTORY" "waiting on you" "Which API version"; do
  assert_contains "the sidebar shows '$text'" "$SIDEBAR" "$text"
done
assert_not_contains "no editor token is shown" "$SIDEBAR" "secret-token"

assert_contains "with Workspace Trust declined" "$(field dialog)" "trust"

group "rebuild asks first, and each port has an Open"
assert_contains "Rebuild asks, naming what is lost" "$(field rebuildAsked)" "outside /workspaces is lost"
assert_eq "cancelled, it ran once -- for the confirmed one" "$(printf '%s\n' "$CALLS" | grep -c '^desolate --rebuild acme/widgets$')" "1"
assert_eq "both of acme/widgets' ports offer Open" "$(field portOpens)" "2"

group "an action runs the editor's command, and its log keeps no token"
assert_contains "Start on 'solo' ran desolate solo" "$CALLS" "desolate solo"
PANEL=$(field panel)
assert_contains "the command reached the desolate log" "$PANEL" "$ desolate solo"
assert_contains "and so did its output" "$PANEL" "ready: http://127.0.0.1:8094/?tkn="
assert_not_contains "with the token redacted, all of it" "$PANEL" "secret-token"
assert_contains "the views read through the commands" "$CALLS" "work requests acme/widgets --json"
note() { printf '       %s\n' "$1"; }
note "screenshots: $OUT/views.png $OUT/after-start.png"
summary
