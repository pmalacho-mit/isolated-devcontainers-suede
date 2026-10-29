#!/usr/bin/env bash
# The desolate extension (T4.7) in a real browser, against the real editor.
#
#   ./tests/environments/extension/run.sh <editor-image> [<out-dir>]
#
# Starts the outer editor from <editor-image> (release/vscode-image, built), as
# compose starts it, with a fixture /workspaces and stand-ins for the commands
# the extension runs (DESOLATE_EXTENSION_BIN): each records its argv and prints
# what the real one would. Then headless Chromium (Playwright) opens the
# editor and the desolate views, and drives them: Needs you, Projects with its
# owners, branches, ports and note, Review & Push down to a file's two sides
# and the push, the context menu, the filter, the palette. The assertions read
# the views' text and what the stand-ins were asked. Screenshots land in
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
CA=${DESOLATE_TEST_CA:-/desolate/ca/ca.pem}
MAIN=$(printf 'a%.0s' $(seq 40)) ISSUE=$(printf 'b%.0s' $(seq 40))

cleanup() { docker rm -f "$EDITOR" "$BROWSER" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap '[ -n "${DESOLATE_TEST_KEEP:-}" ] || cleanup' EXIT
cleanup
docker network create "$NET" >/dev/null || { fail "create the test network"; summary; exit 1; }

docker run -d --name "$EDITOR" --network "$NET" -e DESOLATE_EXTENSION_BIN=/stubs \
  --entrypoint /usr/local/bin/shell-entry "$IMAGE" \
  /home/.desolate-shell/bin/codium-server --host=0.0.0.0 --port=3000 --connection-token="$TOKEN" >/dev/null \
  || { fail "start the editor from $IMAGE"; summary; exit 1; }
HOME_DIR=$(docker exec "$EDITOR" sh -c 'echo "$HOME"')

# /workspaces as the extension reads it: two projects, one with a worktree on a
# branch of its own, statuses where desolate-status writes them, a note, a
# port's label -- and GitHub, as the editor's cache last saw it: main pushed,
# issue/42 never.
docker exec -u 0 -e MAIN="$MAIN" -e ISSUE="$ISSUE" -e H="$HOME_DIR" "$EDITOR" sh -c '
  set -e
  for p in acme/widgets solo; do mkdir -p /workspaces/$p/.devcontainer /workspaces/$p/.git/refs/heads
    echo "{\"image\":\"alpine:3\",\"portsAttributes\":{\"5173\":{\"label\":\"vite\"}}}" > /workspaces/$p/.devcontainer/devcontainer.json
    echo "ref: refs/heads/main" > /workspaces/$p/.git/HEAD; echo "$MAIN" > /workspaces/$p/.git/refs/heads/main; done
  mkdir -p /workspaces/acme/widgets/.worktrees/issue-42/.devcontainer /workspaces/acme/widgets/.git/refs/heads/issue
  echo "{\"image\":\"alpine:3\"}" > /workspaces/acme/widgets/.worktrees/issue-42/.devcontainer/devcontainer.json
  mkdir -p /workspaces/acme/widgets/.git/worktrees/issue-42 /stubs
  echo "gitdir: /workspaces/acme/widgets/.git/worktrees/issue-42" > /workspaces/acme/widgets/.worktrees/issue-42/.git
  echo "ref: refs/heads/issue/42" > /workspaces/acme/widgets/.git/worktrees/issue-42/HEAD
  echo "$ISSUE" > /workspaces/acme/widgets/.git/refs/heads/issue/42
  echo "{\"color\":\"orange\",\"message\":\"needs a human: which API version?\",\"updated\":\"2026-10-27T12:00:00Z\"}" \
    > /workspaces/acme/widgets/.git/desolate-status.json
  echo "{\"color\":\"green\",\"message\":\"ready for a PR\",\"updated\":\"2026-10-27T12:05:00Z\"}" \
    > /workspaces/acme/widgets/.git/worktrees/issue-42/desolate-status.json
  printf "taking the parser; issue-42 has the tests\nsee ![x](https://tracker.invalid/p.png)\n" > /workspaces/acme/widgets/.git/desolate-note.md
  mkdir -p "$H/.cache/desolate/remotes/acme__widgets.git/refs/heads"
  echo "ref: refs/heads/main" > "$H/.cache/desolate/remotes/acme__widgets.git/HEAD"
  echo "$MAIN" > "$H/.cache/desolate/remotes/acme__widgets.git/refs/heads/main"
  chown -R 1000:1000 /workspaces /stubs "$H/.cache"'

# The commands, standing in. Each records its argv, one line per call.
docker exec -i -u 0 "$EDITOR" sh -c 'cat > /stubs/desolate && chmod +x /stubs/desolate' <<EOF
#!/bin/sh
echo "desolate \$*" >> /tmp/calls.log
case "\$*" in
  "--list --json")
    echo "desolate: driving acme/widgets's daemon"
    echo '[{"target":"acme/widgets","project":"acme/widgets","worktree":null,"daemon":"project","url":"http://127.0.0.1:8092/?tkn=secret-token-abc&folder=/workspaces/acme/widgets","ports":{"editor":8092,"5173":8093}}]' ;;
  "--dinds")
    echo '{"dinds":[{"project":"acme/widgets","name":"desolate-dind-acme__widgets","health":"healthy","running":true,"inUse":true,"memory":2147483648,"memoryLimit":6442450944,"imageStoreKib":3145728}],"headroom":{"running":1,"max":16,"available":32212254720,"floor":2147483648}}' ;;
  "--review --json --worktree issue-42 acme/widgets")
    dir="\$HOME/.cache/desolate/reviews/acme__widgets@issue-42"
    mkdir -p "\$dir"
    printf 'export const answer = 41;\nexport const name = "widgets";\n' > "\$dir/1.a"
    printf 'export const answer = 42;\nexport const name = "widgets";\n' > "\$dir/1.b"
    printf 'fresh\n' > "\$dir/2.b"
    echo "desolate: reviewing in its sandbox" >&2
    echo '{"branch":"issue/42","head":"$ISSUE","base":{"ref":"origin/main","commit":"$MAIN","from":"$MAIN"},"ahead":2,"behind":0,"uncommitted":1,"commits":[{"commit":"$(printf 'c%.0s' $(seq 40))","time":1793290000,"author":"Ada","subject":"the answer is 42"},{"commit":"$(printf 'd%.0s' $(seq 40))","time":1793280000,"author":"Ada","subject":"add a fresh file"}],"files":[{"index":1,"status":"M","path":"src/answer.ts","kind":"text","sizes":[52,52],"sides":{"a":true,"b":true}},{"index":2,"status":"A","path":"fresh.txt","kind":"text","sizes":[0,6],"sides":{"a":false,"b":true}},{"index":3,"status":"A","path":"logo.png","kind":"binary","sizes":[0,900],"sides":{"a":false,"b":true}}],"more":false,"dir":"'"\$dir"'"}' ;;
  *) echo "ready: http://127.0.0.1:8094/?tkn=another-secret-token" ;;
esac
EOF
for cmd in worktree newrepo; do
  docker exec -i -u 0 "$EDITOR" sh -c "cat > /stubs/$cmd && chmod +x /stubs/$cmd" <<EOF
#!/bin/sh
echo "$cmd \$*" >> /tmp/calls.log
EOF
done

for _ in $(seq 1 60); do
  docker exec "$EDITOR" sh -c 'exec 3<>/dev/tcp/127.0.0.1/3000' 2>/dev/null && break
  sleep 1
done

# A status written while the view is open, with nothing clicked after it: once
# the browser has started 'solo', solo's agent speaks.
docker exec -d -u 1000 "$EDITOR" sh -c '
  until grep -q "^desolate solo$" /tmp/calls.log 2>/dev/null; do sleep 0.5; done
  echo "{\"color\":\"red\",\"message\":\"authentication failed\"}" > /workspaces/solo/.git/desolate-status.json'

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
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const shot = (name) => page.screenshot({ path: "/run/test/" + name + ".png" });
  const wait = (ms) => page.waitForTimeout(ms);
  await page.goto("http://$EDITOR:3000/?tkn=$TOKEN&folder=/workspaces");
  await page.waitForSelector(".monaco-workbench", { timeout: 90000 });
  await wait(5000);
  // Workspace Trust asks about /workspaces: say no. The extension must work in
  // Restricted Mode, which is where this editor should be for a folder of
  // other people's code.
  const dialog = page.locator(".monaco-dialog-box");
  if (await dialog.isVisible().catch(() => false)) {
    report.dialog = await dialog.innerText();
    const no = dialog.locator("a.monaco-button, button", { hasText: /don.t trust/i }).first();
    if (await no.count()) await no.click(); else await page.keyboard.press("Escape");
    await wait(2000);
  }
  await page.locator('.activitybar [aria-label^="desolate"]').first().click();
  await wait(6000);
  // Every section open, every tree expanded, so its text can be read.
  for (const header of await page.locator(".pane-header[aria-expanded=false]").all()) await header.click();
  for (let round = 0; round < 8; round++) {
    const collapsed = await page.locator(".sidebar .monaco-tl-twistie.collapsible.collapsed").all();
    if (!collapsed.length) break;
    for (const twistie of collapsed) await twistie.click().catch(() => {});
    await wait(700);
  }
  await wait(1500);
  await shot("views");
  report.sidebar = await page.locator(".part.sidebar").innerText();
  // The count is the icon's sibling, not inside its label.
  report.badge = await page.locator('.activitybar .action-item:has([aria-label^="desolate"]) .badge-content').first().innerText().catch(() => "");

  const pane = (name) => page.locator(".pane").filter({ has: page.locator(".pane-header", { hasText: name }) }).first();
  const projects = pane(/projects/i), needs = pane(/needs you/i);
  const row = (where, text) => where.locator(".monaco-list-row").filter({ hasText: text }).first();
  const menu = async (target, item) => {
    await target.click({ button: "right" });
    await wait(800);
    await page.locator(".monaco-menu .action-label", { hasText: item }).first().click();
    await wait(1500);
  };
  // A list draws only the rows in sight: Dinds folded away, so Projects has the room.
  await page.locator(".pane-header", { hasText: /dinds/i }).first().click();
  await wait(1000);
  const widgets = row(projects, /^widgets/);
  const issue = row(projects, /^issue-42/);

  // Rebuild is in the row's menu now, and asks first: cancelled, nothing runs.
  await menu(widgets, /^Rebuild…$/);
  report.rebuildAsked = await page.locator(".monaco-dialog-box").innerText().catch(() => "");
  await page.locator(".monaco-dialog-box a.monaco-button, .monaco-dialog-box button", { hasText: /^Cancel$/ }).first().click();
  await wait(1000);
  await menu(widgets, /^Rebuild…$/);
  await page.locator(".monaco-dialog-box a.monaco-button, .monaco-dialog-box button", { hasText: /^Rebuild$/ }).first().click();
  await wait(3000);

  // Review & Push, from the row of a branch GitHub does not have.
  report.inline = await (async () => { await issue.hover(); return issue.locator(".actions [aria-label]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))); })();
  await issue.locator('[aria-label="Review & Push…"]').click();
  await wait(4000);
  const review = pane(/review/i);
  report.review = await review.innerText().catch(() => "");
  await row(review, /answer\.ts/).click();
  await wait(3000);
  await shot("review-diff");
  report.diff = await page.locator(".editor-instance").first().innerText().catch(() => "");
  report.tabs = await page.locator(".tabs-container").innerText().catch(() => "");
  await review.locator('.pane-header [aria-label="Push…"]').click();
  await wait(1500);
  report.pushAsked = await page.locator(".monaco-dialog-box").innerText().catch(() => "");
  await page.locator(".monaco-dialog-box a.monaco-button, .monaco-dialog-box button", { hasText: /^Push$/ }).first().click();
  await wait(5000);

  // Pull, from the worktree's menu; each port's Open.
  await menu(issue, /^Pull$/);
  report.portOpens = await projects.locator('.monaco-list-row:has-text(":809") [aria-label="Open"]').count();

  // Needs you: marked as seen, it goes until its agent says something new.
  const asks = row(needs, /which API version/);
  await asks.hover();
  await asks.locator('[aria-label="Mark as seen"]').click();
  await wait(2000);
  report.needsAfterSeen = await needs.innerText().catch(() => "");

  // Start a stopped project from its inline action; its agent then fails,
  // and that reaches Needs you, and a notification, by itself.
  const solo = row(projects, /^solo/);
  await solo.hover();
  await solo.locator('[aria-label="Start"]').click();
  report.lateStatus = await row(needs, /authentication failed/).waitFor({ timeout: 10000 }).then(() => true, () => false);
  await wait(1500);
  report.toast = await page.locator(".notification-toast").allInnerTexts().then((t) => t.join(" | ")).catch(() => "");
  await shot("needs-you");

  // Only what runs.
  await projects.locator('.pane-header [aria-label="Show only what is running"]').click();
  await wait(1500);
  report.filtered = await projects.innerText();
  await shot("running-only");
  await projects.locator('.pane-header [aria-label="Show stopped ones too"]').click();
  await wait(1000);

  // The palette's way in: a target, then what to do with it.
  await page.keyboard.press("Control+Alt+KeyD");
  await wait(1500);
  report.quickOpen = await page.locator(".quick-input-widget").innerText().catch(() => "");
  await shot("quick-open");
  await page.keyboard.press("Escape");
  await wait(500);

  // The log the actions wrote to, from the panel's own command.
  await page.keyboard.press("F1");
  await wait(800);
  await page.keyboard.type("desolate: Show log");
  await wait(800);
  await page.keyboard.press("Enter");
  await wait(2000);
  await shot("log");
  report.panel = await page.locator(".part.panel").innerText().catch(() => "");
  console.log("REPORT " + JSON.stringify(report));
  await browser.close();
})().catch((err) => { console.log("REPORT " + JSON.stringify({ error: String(err) })); process.exit(1); });
EOF
docker cp "$SCRIPT/test.js" "$BROWSER:/test.js" >/dev/null
docker start -a "$BROWSER" >/dev/null 2>&1
OUTPUT=$(docker logs "$BROWSER" 2>&1)
for png in views review-diff needs-you running-only quick-open log; do
  docker cp "$BROWSER:/run/test/$png.png" "$OUT/" >/dev/null 2>&1
done
REPORT=$(printf '%s\n' "$OUTPUT" | sed -n 's/^REPORT //p' | tail -1)
CALLS=$(docker exec "$EDITOR" cat /tmp/calls.log 2>/dev/null)
# Monaco renders a space as U+00A0; read it as one.
field() { node -e 'const r = JSON.parse(process.argv[1] || "{}"); const v = r[process.argv[2]]; process.stdout.write((Array.isArray(v) ? v.join("|") : String(v ?? "")).replace(/ /g, " "))' "$REPORT" "$1"; }

group "the views, as the browser shows them"
[ -n "$REPORT" ] || { fail "the browser ran" "$(printf '%s' "$OUTPUT" | tail -5)"; summary; exit 1; }
[ -z "$(field error)" ] || fail "the browser script finished" "$(field error)"
SIDEBAR=$(field sidebar)
for text in "NEEDS YOU" "widgets · issue-42" "ready for a PR" "needs a human: which API version?" \
            "PROJECTS" "acme" "widgets" "main · needs a human: which API version? · 2.0 / 6.0 GiB" \
            "vite (5173)" ":8093" "note" "taking the parser; issue-42 has the tests" \
            "issue-42" "issue/42 ↑ not on GitHub · ready for a PR" "solo" "1 running · 30.0 GiB free" "DINDS"; do
  assert_contains "the sidebar shows '$text'" "$SIDEBAR" "$text"
done
assert_not_contains "an owner directory is not a project" "$SIDEBAR" $'\nacmestopped'
assert_not_contains "no editor token is shown" "$SIDEBAR" "secret-token"
assert_not_contains "what an icon says is not also said in words" "$SIDEBAR" "running · own dind"
assert_eq "the activity bar counts what needs you" "$(field badge)" "2"
assert_eq "a status written later shows by itself, within seconds" "$(field lateStatus)" "true"
assert_contains "  and is said in a notification" "$(field toast)" "authentication failed"
assert_contains "with Workspace Trust declined" "$(field dialog)" "trust"

group "a row offers its own few actions; the rest are in its menu"
assert_contains "Review & Push on a branch GitHub does not have" "$(field inline)" "Review & Push…"
assert_not_contains "and no Rebuild beside it" "$(field inline)" "Rebuild"
assert_contains "Rebuild asks, naming what is lost" "$(field rebuildAsked)" "outside /workspaces is lost"
assert_eq "cancelled, it ran once -- for the confirmed one" "$(printf '%s\n' "$CALLS" | grep -c '^desolate --rebuild acme/widgets$')" "1"
assert_eq "both of acme/widgets' ports offer Open" "$(field portOpens)" "2"

group "Review & Push: what a push would send, read first, then sent"
REVIEW=$(field review)
for text in "issue/42 → origin/main" "2 commits to push" "1 uncommitted change" "the answer is 42" "answer.ts" "fresh.txt" "(binary: not shown)"; do
  assert_contains "the review shows '$text'" "$REVIEW" "$text"
done
assert_contains "it is desolate --review, in the sandbox" "$CALLS" "desolate --review --json --worktree issue-42 acme/widgets"
assert_contains "a file opens its two sides" "$(field tabs)" "answer.ts (origin/main ↔ issue/42)"
assert_contains "  side by side" "$(field diff)" "answer = 42"
assert_contains "Push asks, with what it sends" "$(field pushAsked)" "Push 2 commits of issue/42"
assert_contains "  and what it leaves" "$(field pushAsked)" "1 uncommitted change is not sent"
assert_contains "confirmed, it ran desolate --push for the worktree" "$CALLS" "desolate --push --worktree issue-42 acme/widgets"
assert_contains "Pull on a worktree ran desolate --pull for it" "$CALLS" "desolate --pull --worktree issue-42 acme/widgets"

group "Needs you, the filter, the palette"
assert_not_contains "marked as seen, it is gone" "$(field needsAfterSeen)" "which API version"
assert_contains "  and the rest stay" "$(field needsAfterSeen)" "ready for a PR"
assert_not_contains "running only: solo is not shown" "$(field filtered)" "solo"
assert_contains "  widgets, which runs, is" "$(field filtered)" "widgets"
assert_contains "ctrl+alt+d offers every target" "$(field quickOpen)" "acme/widgets · issue-42"

group "an action runs the editor's command, and its log keeps no token"
assert_contains "Start on 'solo' ran desolate solo" "$CALLS" "desolate solo"
PANEL=$(field panel)
assert_contains "the command reached the desolate log" "$PANEL" "$ desolate solo"
assert_contains "and so did its output" "$PANEL" "ready: http://127.0.0.1:8094/?tkn="
assert_not_contains "with the token redacted, all of it" "$PANEL" "secret-token"
assert_contains "the views read through the commands" "$CALLS" "desolate --list --json"
assert_not_contains "and statuses, notes and branches through none" "$CALLS" "--status"
note() { printf '       %s\n' "$1"; }
note "screenshots: $OUT/{views,review-diff,needs-you,running-only,quick-open,log}.png"
summary
