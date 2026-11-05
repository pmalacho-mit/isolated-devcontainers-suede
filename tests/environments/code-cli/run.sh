#!/usr/bin/env bash
# `code` in a project editor's terminal (Dockerfile, the server tree): git
# configured `core.editor "code --wait"` -- with the base images'
# /usr/local/bin/code shim in place, as mcr.microsoft.com/devcontainers ships
# it -- opens the message in the editor, and finishing there finishes git.
#
#   ./tests/environments/code-cli/run.sh <editor-image>
#
# Runs the SERVER tree's codium-server, the one project editors run, in one
# container; headless Chromium (Playwright) in its network namespace opens a
# terminal, runs `git commit --edit`, waits for COMMIT_EDITMSG to open as an
# editor tab, closes it, and the commit is read back. On an image without the
# `code` link, the same steps make no commit: the shim says "code or
# code-insiders is not installed" (the control, run by hand against the
# previous image).
#
# Needs a docker daemon that can pull mcr.microsoft.com/playwright and npm's
# `playwright` -- through the proxy, with its CA, when run inside desolate.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
# shellcheck source=../../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"
IMAGE=${1:?usage: run.sh <editor-image>}
EDITOR=desolate-codecli-editor BROWSER=desolate-codecli-browser TOKEN=codecli-token-$$
PLAYWRIGHT=mcr.microsoft.com/playwright:v1.49.1-noble
CA=${DESOLATE_TEST_CA:-/desolate/ca/ca.pem}
SCRIPT=$(mktemp -d)
cleanup() { docker rm -f "$EDITOR" "$BROWSER" >/dev/null 2>&1; rm -rf "$SCRIPT"; }
trap '[ -n "${DESOLATE_TEST_KEEP:-}" ] || cleanup' EXIT
docker rm -f "$EDITOR" "$BROWSER" >/dev/null 2>&1

docker run -d --name "$EDITOR" --user 1000:1000 --entrypoint sh "$IMAGE" -c \
  "exec \"\$DESOLATE_SERVER_ROOT/bin/codium-server\" --host=127.0.0.1 --port=3000 --connection-token=$TOKEN" >/dev/null \
  || { fail "start the editor from $IMAGE"; summary; exit 1; }
# The base images' shim, verbatim in what it does: the next `code` on PATH, or
# the error the user saw.
docker exec -i -u 0 "$EDITOR" sh -c 'cat > /usr/local/bin/code && chmod 0755 /usr/local/bin/code' <<'SHIM'
#!/bin/sh
get_in_path_except_current() {
    which -a "$1" | grep -A1 "$0" | grep -v "$0"
}
code="$(get_in_path_except_current code)"
if [ -n "$code" ]; then
    exec "$code" "$@"
elif [ "$(command -v code-insiders)" ]; then
    exec code-insiders "$@"
else
    echo "code or code-insiders is not installed" >&2
    exit 127
fi
SHIM
docker exec "$EDITOR" sh -c 'git config --global core.editor "code --wait" && git config --global user.name t && git config --global user.email t@t \
  && git init -q -b main /tmp/repo && git -C /tmp/repo commit -q --allow-empty -m first'
for _ in $(seq 60); do docker exec "$EDITOR" bash -c 'exec 3<>/dev/tcp/127.0.0.1/3000' 2>/dev/null && break; sleep 1; done

cat > "$SCRIPT/test.js" <<JS
const { chromium } = require("playwright");
(async () => {
  const report = {};
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const wait = (ms) => page.waitForTimeout(ms);
  const command = async (name) => {
    await page.keyboard.press("F1"); await wait(800);
    await page.keyboard.type(name); await wait(800);
    await page.keyboard.press("Enter"); await wait(1500);
  };
  // An empty window: trusted, so its terminal opens with no prompt.
  await page.goto("http://127.0.0.1:3000/?tkn=$TOKEN");
  await page.waitForSelector(".monaco-workbench", { timeout: 90000 });
  await wait(4000);
  await command("Terminal: Create New Terminal");
  await wait(3000);
  await page.keyboard.type("cd /tmp/repo && command -v code > /tmp/which-code; git commit --allow-empty -m 'made through code --wait' --edit > /tmp/commit.log 2>&1; echo \$? > /tmp/commit.rc");
  await page.keyboard.press("Enter");
  await wait(5000);
  // The file is outside any folder this empty window trusts, so the editor
  // asks first; in a project editor it is inside the project. Answered as a
  // person would.
  const ask = page.locator(".monaco-dialog-box").filter({ hasText: /untrusted files/i });
  report.asked = await ask.isVisible().catch(() => false);
  if (report.asked) { await ask.locator("a.monaco-button, button", { hasText: /^Open$/ }).first().click(); await wait(3000); }
  report.tabs = await page.locator(".tabs-container .tab").allInnerTexts().catch(() => []);
  await page.screenshot({ path: "/run/test/editing.png" });
  await command("View: Close Editor");
  await wait(4000);
  console.log("REPORT " + JSON.stringify(report));
  await browser.close();
})().catch((err) => { console.log("REPORT " + JSON.stringify({ error: String(err) })); process.exit(1); });
JS
docker create --name "$BROWSER" --network "container:$EDITOR" -e NODE_EXTRA_CA_CERTS=/ca.pem "$PLAYWRIGHT" \
  sh -c 'mkdir -p /run/test && cd /run/test && npm init -y >/dev/null && npm install --silent playwright@1.49.1 >/dev/null && cp /test.js . && node test.js' >/dev/null
[ -f "$CA" ] && docker cp "$CA" "$BROWSER:/ca.pem" >/dev/null
docker cp "$SCRIPT/test.js" "$BROWSER:/test.js" >/dev/null
docker start -a "$BROWSER" >/dev/null 2>&1
REPORT=$(docker logs "$BROWSER" 2>&1 | sed -n 's/^REPORT //p' | tail -1)
[ -n "${DESOLATE_TEST_SHOTS:-}" ] && docker cp "$BROWSER:/run/test/editing.png" "$DESOLATE_TEST_SHOTS/" >/dev/null 2>&1
field() { node -e 'const r = JSON.parse(process.argv[1] || "{}"); const v = r[process.argv[2]]; process.stdout.write(Array.isArray(v) ? v.join("|") : String(v ?? ""))' "$REPORT" "$1"; }
inside() { docker exec "$EDITOR" sh -c "$1" 2>/dev/null; }

group "git's editor, \`code --wait\`, in an editor terminal"
[ -n "$REPORT" ] && [ -z "$(field error)" ] || { fail "the browser ran" "$(field error)"; summary; exit 1; }
assert_contains "the terminal's \`code\` is the editor's own CLI, ahead of the shim" "$(inside 'cat /tmp/which-code')" "/bin/remote-cli/code"
assert_contains "git opened the message as an editor tab" "$(field tabs)" "COMMIT_EDITMSG"
assert_eq "closing it finished git" "$(inside 'cat /tmp/commit.rc')" "0"
assert_eq "  with the commit made" "$(inside 'git -C /tmp/repo log -1 --format=%s')" "made through code --wait"
assert_not_contains "  and no shim error" "$(inside 'cat /tmp/commit.log')" "is not installed"
summary
