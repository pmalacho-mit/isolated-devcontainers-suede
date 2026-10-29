#!/usr/bin/env bash
# examples/factory's dispatcher (lib/gh-dispatch.sh), executed against stand-in
# `gh` and `cli.sh`: --all over the stack's projects, an issue whose marker
# names an existing PR's branch, and what green and gray do with it.
#
# The stand-ins answer from files in $STUB_DIR, and record every call; the
# dispatcher's agent is `true`, so nothing starts.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

command -v jq >/dev/null || { skip "the dispatcher" "jq not installed"; summary; exit $?; }

STUB=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] && echo "kept $STUB" || rm -rf "$STUB"' EXIT
mkdir -p "$STUB/bin" "$STUB/state"
export STUB_DIR=$STUB

cat > "$STUB/bin/gh" <<'EOF'
#!/bin/sh
printf 'gh %s\n' "$*" >> "$STUB_DIR/calls"
case "$1 $2" in
  "repo view") echo main ;;
  "issue list") case "$*" in *acme/widget*) cat "$STUB_DIR/widget-issues" ;; *) cat "$STUB_DIR/app-issues" ;; esac ;;
  "api repos/acme/app/git/ref/heads/issue/3") [ -e "$STUB_DIR/app-pushed" ]; exit $? ;;
  "pr create") echo "https://github.com/acme/app/pull/9" ;;
esac
exit 0
EOF
cat > "$STUB/bin/cli" <<'EOF'
#!/bin/sh
printf 'cli %s\n' "$*" >> "$STUB_DIR/calls"
case "$1 $2" in
  "desolate --status") cat "$STUB_DIR/statuses" ;;
  "desolate --list") echo '[]' ;;
esac
exit 0
EOF
chmod +x "$STUB/bin/gh" "$STUB/bin/cli"

MARKER='<!-- desolate-dispatch: {"branch":"downstream/acme/app-aaaa","start":"origin/downstream/acme/app-aaaa","fetch":true,"pr":12} -->'
jq -n --arg body "Review the upstream PR.
$MARKER" '[{number: 7, title: "Upstream from acme/app", body: $body}]' > "$STUB/widget-issues"
echo '[{"number":3,"title":"Plain work","body":"do it"}]' > "$STUB/app-issues"
statuses() { # <widget issue-7 color> <app issue-3 color>
  jq -cn --arg w "$1" --arg a "$2" '[
    {target:"acme/widget", project:"acme/widget", worktree:null, status:null},
    {target:"acme/app", project:"acme/app", worktree:null, status:null},
    {target:"solo", project:"solo", worktree:null, status:null}]
    + (if $w == "" then [] else [{target:"acme/widget@issue-7", project:"acme/widget", worktree:"issue-7", status:{color:$w, message:"widget says", updated:("t-" + $w)}}] end)
    + (if $a == "" then [] else [{target:"acme/app@issue-3", project:"acme/app", worktree:"issue-3", status:{color:$a, message:"app says", updated:("t-" + $a)}}] end)' > "$STUB/statuses"
}
tick() {
  : > "$STUB/calls"
  PATH="$STUB/bin:$PATH" DESOLATE_CLI="$STUB/bin/cli" FACTORY_STATE="$STUB/state" FACTORY_AGENT=true \
    bash "$ROOT/examples/factory/gh-dispatcher.sh" --all --once </dev/null > "$STUB/out" 2>&1
}

group "--all: every owner/repo project in the stack, each its own repository"
statuses "" ""
tick
assert_contains "acme/widget's issues are read" "$(cat "$STUB/calls")" "gh issue list -R acme/widget --label desolate:run"
assert_contains "and acme/app's" "$(cat "$STUB/calls")" "gh issue list -R acme/app --label desolate:run"
assert_not_contains "a project that is no owner/repo is not" "$(cat "$STUB/calls")" "-R solo"

group "an issue whose marker names an existing PR's branch"
CALLS=$(cat "$STUB/calls")
assert_contains "origin/* is refreshed first, fetch only" "$CALLS" "cli pull acme/widget --fetch-only"
assert_contains "the worktree is on the PR's branch, from origin" "$CALLS" \
  "cli worktree add acme/widget issue-7 downstream/acme/app-aaaa origin/downstream/acme/app-aaaa"
assert_contains "a plain issue still gets issue/<n>" "$CALLS" "cli worktree add acme/app issue-3 issue/3"
assert_contains "the agent was started for each" "$(ls "$STUB/state/acme__widget" "$STUB/state/acme__app")" "issue-7.agent"

group "green: a PR that exists is pushed to, not opened again"
statuses green green
tick
assert_contains "you are asked to push to PR #12" "$(cat "$STUB/out")" "push to PR #12"
assert_contains "the plain issue: asked to push it, since GitHub does not have issue/3 yet" "$(cat "$STUB/out")" "#3 is ready (app says) -- review it, then push"
assert_not_contains "and no PR is created for the widget" "$(cat "$STUB/calls")" "pr create -R acme/widget"
touch "$STUB/app-pushed"
tick
assert_contains "the plain issue's PR is opened once its branch is there" "$(cat "$STUB/calls")" \
  "gh pr create -R acme/app --draft --head issue/3 --base main"

group "gray: withdrawn, said on the issue and its PR, once"
statuses gray ""
tick
CALLS=$(cat "$STUB/calls")
assert_contains "on the issue" "$CALLS" "gh issue comment 7 -R acme/widget --body desolate: the agent **withdrew** -- widget says."
assert_contains "on its PR" "$CALLS" "gh pr comment 12 -R acme/widget"
tick
assert_not_contains "and not again for the same status" "$(cat "$STUB/calls")" "gh issue comment 7"

group "a marker is checked, not trusted"
jq -n --arg body '<!-- desolate-dispatch: {"pr":"12; rm -rf /"} -->' '[{number: 8, title: "x", body: $body}]' > "$STUB/widget-issues"
statuses "" ""
tick
assert_contains "a pr that is no number is no pr: the worktree gets issue/8" "$(cat "$STUB/calls")" "cli worktree add acme/widget issue-8 issue/8"

summary
