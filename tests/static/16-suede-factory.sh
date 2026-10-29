#!/usr/bin/env bash
# examples/factory/suede/suede-factory.sh, executed tick by tick against
# stand-in `gh` and `cli.sh` (docs/suede-factory.md): a consumer's main moving,
# the proposal pushed, suede's PR appearing and the issue filed for it, the
# same change not proposed twice, a new change replacing the old proposal, a
# release and the syncs it calls for, a dependency outside the stack, --dry-run.
#
# The stand-ins answer from files in $STUB_DIR and record every call.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

command -v jq >/dev/null || { skip "the suede factory" "jq not installed"; summary; exit $?; }

STUB=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] && echo "kept $STUB" || rm -rf "$STUB"' EXIT
mkdir -p "$STUB/bin"
export STUB_DIR=$STUB
H1=$(printf '1%.0s' $(seq 40)); H2=$(printf '2%.0s' $(seq 40)); H3=$(printf '3%.0s' $(seq 40))
PIN=$(printf 'a%.0s' $(seq 40)); REL2=$(printf 'b%.0s' $(seq 40))

cat > "$STUB/bin/gh" <<'EOF'
#!/bin/bash
printf 'gh %s\n' "$*" >> "$STUB_DIR/calls"
args="$*"
case "$args" in
  "repo view "*) echo main ;;
  "api repos/acme/app/commits/main"*) cat "$STUB_DIR/app-head" ;;
  "api repos/acme/widget/branches/release "*) cat "$STUB_DIR/widget-release" ;;
  "api repos/acme/widget/branches/downstream/"*) exit 0 ;;
  "api repos/acme/widget/pulls/12/commits"*) echo "  - cccccccccccc the agent's fix (Claude)" ;;
  "issue list -R acme/widget --label suede:upstream --state open"*) cat "$STUB_DIR/widget-open-issues" 2>/dev/null || echo '[]' ;;
  "issue list -R acme/app --label suede:sync --state open"*) echo '[]' ;;
  "pr list -R acme/widget --head "*)
    branch=$(printf '%s\n' "$args" | sed -n 's/.*--head \([^ ]*\).*/\1/p')
    [ -f "$STUB_DIR/pr-for-$(printf '%s' "$branch" | tr '/' '_')" ] && cat "$STUB_DIR/pr-for-$(printf '%s' "$branch" | tr '/' '_')" ;;
  "pr list -R acme/widget --state open"*) echo "- #20 Another consumer's proposal (\`downstream/acme/other-x\`)" ;;
  "issue create "*)
    n=$(( $(cat "$STUB_DIR/next-issue" 2>/dev/null || echo 30) + 1 )); echo "$n" > "$STUB_DIR/next-issue"
    printf '%s' "$args" > "$STUB_DIR/issue-$n"
    echo "https://github.com/x/y/issues/$n" ;;
esac
exit 0
EOF
cat > "$STUB/bin/cli" <<'EOF'
#!/bin/bash
printf 'cli %s\n' "$*" >> "$STUB_DIR/calls"
case "$*" in
  "desolate --status --json") cat "$STUB_DIR/stack" ;;
  "deps report acme/app --ref origin/main") echo "desolate: driving its daemon"; printf 'DEPS %s\n' "$(cat "$STUB_DIR/report")" ;;
  "deps upstream acme/app widget --ref origin/main")
    echo "UPSTREAMED acme/widget downstream/acme/app-$(cat "$STUB_DIR/app-head") $(printf 'c%.0s' $(seq 40)) $(cat "$STUB_DIR/patch")" ;;
esac
exit 0
EOF
chmod +x "$STUB/bin/gh" "$STUB/bin/cli"

stack() { printf '%s' "$1" | jq -Rc 'split(" ") | map({project: ., worktree: null})' > "$STUB/stack"; }
report() { # <patch> [<extra dependency json>]
  echo "$1" > "$STUB/patch"
  jq -cn --arg p "$1" --arg pin "$PIN" --argjson extra "${2:-null}" '{commit: "x", suede: false, dependencies: ([
    {dir: "widget", repo: "acme/widget", remote: "https://github.com/acme/widget", pin: $pin, kind: "app", state: "diff", patch: $p,
     files: [{status: "M", path: "lib.ts"}]}] + (if $extra then [$extra] else [] end))}' > "$STUB/report"
}
tick() {
  : > "$STUB/calls"
  PATH="$STUB/bin:$PATH" DESOLATE_CLI="$STUB/bin/cli" SUEDE_FACTORY_STATE="$STUB/state" \
    bash "$ROOT/examples/factory/suede/suede-factory.sh" run --once "$@" </dev/null > "$STUB/out" 2>&1
}
calls() { cat "$STUB/calls"; }
pr_appears() { # <head> <number>
  jq -cn --argjson n "$2" '{number: $n, state: "OPEN", url: "u", title: "t", body: "suede rebuilt it.\nFrom acme/app."}' \
    > "$STUB/pr-for-downstream_acme_app-$1"
}

group "a consumer's main moved: its changes are proposed, once"
stack "acme/app acme/widget"; echo "$H1" > "$STUB/app-head"; echo "$PIN" > "$STUB/widget-release"; report patch1
tick
assert_contains "origin/* is refreshed, fetch only" "$(calls)" "cli pull acme/app --fetch-only"
assert_contains "the report is of origin/main" "$(calls)" "cli deps report acme/app --ref origin/main"
assert_contains "the change is pushed as suede's branch" "$(calls)" "cli deps upstream acme/app widget --ref origin/main"
assert_contains "and waits for suede's PR" "$(PATH="$STUB/bin:$PATH" SUEDE_FACTORY_STATE="$STUB/state" bash "$ROOT/examples/factory/suede/suede-factory.sh" status)" \
  "acme/widget: downstream/acme/app-$H1 (acme/app/widget)"
tick
assert_not_contains "the same main is not looked at again" "$(calls)" "deps report"

group "suede's PR appeared: an issue for an agent, and the PR closes it"
pr_appears "$H1" 12
tick
ISSUE=$(cat "$STUB/issue-31" 2>/dev/null)
assert_contains "filed in the dependency, for the dispatcher" "$ISSUE" "issue create -R acme/widget --title Upstream from acme/app: changes to widget"
assert_contains "  with the dispatcher's label and its own" "$ISSUE" "--label desolate:run --label suede:upstream"
assert_contains "  framed for an app: maybe useful, the agent decides" "$ISSUE" "They may help other consumers of acme/widget, now or later -- or they may not."
assert_contains "  the files" "$ISSUE" '- `M` lib.ts'
assert_contains "  the PR's own text" "$ISSUE" "> suede rebuilt it."
assert_contains "  the other proposals into it, and the board" "$ISSUE" "#20 Another consumer's proposal"
assert_contains "  the dispatcher's marker: the PR's branch, fetched" "$ISSUE" \
  "<!-- desolate-dispatch: {\"branch\":\"downstream/acme/app-$H1\",\"start\":\"origin/downstream/acme/app-$H1\",\"fetch\":true,\"pr\":12} -->"
assert_contains "  and its own, with the change's patch id" "$ISSUE" '"consumer":"acme/app","dir":"widget","patch":"patch1","pr":12'
assert_contains "the PR closes the issue" "$(calls)" "gh pr edit 12 -R acme/widget --body suede rebuilt it."
assert_contains "  (Closes #31)" "$(calls)" "Closes #31"

group "main moves with the same change: not proposed again"
MARKER31=$(sed -n 's/.*<!-- suede-factory: \({.*}\) -->.*/\1/p' "$STUB/issue-31")
jq -cn --arg m "<!-- suede-factory: $MARKER31 -->" '[{number: 31, url: "https://github.com/acme/widget/issues/31", body: ("text\n" + $m)}]' > "$STUB/widget-open-issues"
echo "$H2" > "$STUB/app-head"
tick
assert_contains "it is looked at" "$(calls)" "deps report acme/app"
assert_not_contains "but nothing is pushed" "$(calls)" "deps upstream"
assert_contains "and it says why" "$(cat "$STUB/out")" "already proposed (https://github.com/acme/widget/issues/31)"

group "a different change from the same consumer replaces the open proposal"
echo "$H3" > "$STUB/app-head"; report patch2
tick
assert_contains "the new change is pushed" "$(calls)" "deps upstream acme/app widget"
pr_appears "$H3" 15
tick
ISSUE=$(cat "$STUB/issue-32" 2>/dev/null)
assert_contains "its issue lists what the old PR had added, to carry over" "$ISSUE" "cccccccccccc the agent's fix (Claude)"
assert_contains "  and where to look" "$ISSUE" "git log origin/main..origin/downstream/acme/app-$H1"
assert_contains "the old PR is closed, pointing at the new" "$(calls)" "gh pr close 12 -R acme/widget --comment Replaced by #15"
assert_contains "the old issue is closed" "$(calls)" "gh issue close 31 -R acme/widget --comment Replaced by #32."

group "a release: every consumer whose pin is behind gets a sync"
echo "$REL2" > "$STUB/widget-release"
tick
ISSUE=$(cat "$STUB/issue-33" 2>/dev/null)
assert_contains "the release is delivered to the consumer first" "$(calls)" "cli deps deliver acme/app acme/widget"
assert_contains "the sync issue is in the consumer, for the dispatcher" "$ISSUE" "issue create -R acme/app --title Sync widget to acme/widget's latest release"
assert_contains "  labelled" "$ISSUE" "--label suede:sync --label desolate:run"
assert_contains "  with the offline sync" "$ISSUE" "GIT_CONFIG_KEY_0=\"url.\$bundle.insteadOf\" GIT_CONFIG_VALUE_0=\"\$remote\" bash 'widget/.suede/core/sync'"
assert_contains "  its worktree from a fresh origin/main" "$ISSUE" '<!-- desolate-dispatch: {"start":"origin/main","fetch":true,"base":"main"} -->'
tick
assert_not_contains "the same release is not synced twice" "$(calls)" "issue create"

group "a dependency outside the stack: asked once, added once approved"
stack "acme/app acme/widget"; echo "$(printf '4%.0s' $(seq 40))" > "$STUB/app-head"
report patch2 '{"dir": "other", "repo": "acme/other", "remote": "r", "pin": "p", "kind": "app", "state": "nopin", "files": []}'
tick
assert_contains "you are asked, with the command" "$(cat "$STUB/out")" "suede-factory.sh approve acme/other"
assert_not_contains "nothing is added without you" "$(calls)" "repo add"
tick
assert_not_contains "and you are not asked again" "$(cat "$STUB/out")" "approve acme/other"
PATH="$STUB/bin:$PATH" SUEDE_FACTORY_STATE="$STUB/state" bash "$ROOT/examples/factory/suede/suede-factory.sh" approve acme/other >/dev/null
tick
assert_contains "once approved, it is added to the stack" "$(calls)" "cli repo add acme/other"

group "--dry-run: everything read, nothing pushed, filed or changed"
rm -rf "$STUB/state" "$STUB"/issue-* "$STUB/next-issue" "$STUB"/pr-for-*; rm -f "$STUB/widget-open-issues"
stack "acme/app acme/widget"; echo "$H1" > "$STUB/app-head"; report patch1
tick --dry-run
assert_contains "it reads" "$(calls)" "deps report acme/app"
assert_not_contains "it does not push" "$(calls)" "deps upstream"
assert_contains "it says what it would" "$(cat "$STUB/out")" "would: propose acme/app's changes to widget upstream to acme/widget (1 file(s))"
tick --dry-run
assert_contains "and says it again next time: nothing was recorded as done" "$(cat "$STUB/out")" "would: propose"

summary
