#!/usr/bin/env bash
# examples/factory's dispatcher (lib/gh-dispatch.sh), executed against stand-in
# `gh` and `cli.sh`: --all over the stack's projects, an issue whose marker
# names an existing PR's branch, and what green, gray, orange and red do with
# it -- none of the agent's words reaching GitHub, which would be as you; a PR you
# opened yourself, issues that cannot be read, and worktrees of closed issues;
# a target busy or not answering yet, and a ^C mid-start; what counts toward
# --max-agents -- an agent whose worktree runs.
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
  "issue list")
    case "$*" in *acme/widget*) f=widget ;; *) f=app ;; esac
    [ ! -e "$STUB_DIR/$f-issues-fail" ] || { cat "$STUB_DIR/$f-issues-fail" >&2; exit 1; }
    cat "$STUB_DIR/$f-issues" ;;
  "api repos/acme/app/git/ref/heads/issue/3") [ -e "$STUB_DIR/app-pushed" ]; exit $? ;;
  "pr list") cat "$STUB_DIR/open-pr" 2>/dev/null || echo '[]' ;;
  "pr create") echo "https://github.com/acme/app/pull/9" ;;
esac
exit 0
EOF
cat > "$STUB/bin/cli" <<'EOF'
#!/bin/sh
printf 'cli %s\n' "$*" >> "$STUB_DIR/calls"
case "$1 $2" in
  "desolate --status") cat "$STUB_DIR/statuses" ;;
  "desolate --list")
    [ ! -e "$STUB_DIR/list-fails" ] || { echo "desolate: cannot reach the daemon" >&2; exit 1; }
    jq -cRn '[inputs | select(length > 0) | split(" ") | {project: .[0], worktree: .[1]}]' < "$STUB_DIR/running" ;;
  "worktree remove")
    if [ -e "$STUB_DIR/remove-fails" ]; then
      # As desolate says it: the reason, the files, and a hint last.
      printf '%s\n' "acme/app@issue-3 has uncommitted or untracked files:" "  ?? repro.html" "  M src/editor.ts" \
        "  ?? notes.md" "  ?? more.txt" "commit or stash them, or discard them with:" \
        "  ./cli.sh worktree remove acme/app issue-3 --force   (on your Mac)" >&2
      exit 3
    fi ;;
  "desolate acme/app")
    [ ! -e "$STUB_DIR/start-busy" ] || exit 75
    [ ! -e "$STUB_DIR/start-slow" ] || sleep 30 ;;
  "exec acme/app") [ ! -e "$STUB_DIR/exec-fails" ] || exit 1 ;;
esac
# What runs: a start of a worktree adds it, its --stop takes it away.
if [ "$1" = desolate ] && [ "${3:-}" = --worktree ]; then
  case "${5:-}" in
    "") echo "$2 $4" >> "$STUB_DIR/running" ;;
    --stop) grep -vxF "$2 $4" "$STUB_DIR/running" > "$STUB_DIR/running.new"; mv "$STUB_DIR/running.new" "$STUB_DIR/running"
            echo "stopped $2@$4 (container kept, so restarting is fast;" ;;
  esac
fi
exit 0
EOF
: > "$STUB/running"
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
  "gh pr create -R acme/app --draft --head issue/3 --base main --title Plain work --body Closes #3"
assert_not_contains "  its description is not the agent's words" "$(grep 'pr create' "$STUB/calls")" "app says"

group "green, with a PR you opened yourself: that one is taken, and made to close the issue"
rm -f "$STUB/state/acme__app/issue-3.pr"
echo '[{"number":27,"url":"https://github.com/acme/app/pull/27","body":"my own words"}]' > "$STUB/open-pr"
tick
assert_not_contains "no second PR is opened" "$(cat "$STUB/calls")" "gh pr create"
assert_contains "  it is the one recorded" "$(cat "$STUB/state/acme__app/issue-3.pr")" "https://github.com/acme/app/pull/27"
assert_contains "  and it now closes #3, so merging it ends the worktree" "$(cat "$STUB/calls")" "gh pr edit 27 -R acme/app --body my own words"
rm -f "$STUB/state/acme__app/issue-3.pr"
echo '[{"number":27,"url":"https://github.com/acme/app/pull/27","body":"Fixes #3."}]' > "$STUB/open-pr"
tick
assert_not_contains "one that closes it already is left as it is" "$(cat "$STUB/calls")" "gh pr edit"
rm -f "$STUB/open-pr"

group "gray, orange, red: told to you, once -- never on GitHub, as you"
statuses gray ""
tick
assert_contains "gray: you are told it withdrew, and why" "$(cat "$STUB/out")" "#7: the agent withdrew (widget says) -- it recommends this not be merged"
assert_not_contains "  nothing on the issue" "$(cat "$STUB/calls")" "gh issue comment"
assert_not_contains "  nothing on its PR" "$(cat "$STUB/calls")" "gh pr comment"
tick
assert_not_contains "  and not again for the same status" "$(cat "$STUB/out")" "withdrew"
statuses orange red
tick
assert_contains "orange: its question, to you" "$(cat "$STUB/out")" "#7 asks (acme/widget@issue-7): widget says"
assert_contains "red: what failed, to you" "$(cat "$STUB/out")" "#3 is stuck (acme/app@issue-3): app says"
assert_not_contains "  nothing on GitHub" "$(cat "$STUB/calls")" "comment"

group "issues that cannot be read: the tick ends, and nothing is removed"
statuses green green
echo "HTTP 502: Bad Gateway" > "$STUB/app-issues-fail"
tick
assert_contains "it says why, once" "$(cat "$STUB/out")" "acme/app: issues not read (HTTP 502: Bad Gateway); trying again next tick"
assert_not_contains "  and not a second time as a failed tick" "$(cat "$STUB/out")" "tick failed"
assert_not_contains "and does not take the issue for closed" "$(cat "$STUB/calls")" "worktree remove acme/app"
echo "the 'acme/app' repository has disabled issues" > "$STUB/app-issues-fail"
tick
assert_contains "issues turned off: said once" "$(cat "$STUB/out")" "acme/app has issues turned off; skipped while it does"
tick
assert_not_contains "  and not every tick" "$(cat "$STUB/out")" "acme/app"
rm -f "$STUB/app-issues-fail"

group "a closed issue's worktree: removed; one that will not go is left to you, said once"
echo '[]' > "$STUB/app-issues"
touch "$STUB/remove-fails"
tick
assert_contains "it is stopped and removed" "$(cat "$STUB/calls")" "cli worktree remove acme/app issue-3"
assert_contains "  the refusal says why, with the first files -- not the hint it ends with" "$(cat "$STUB/out")" \
  "issue-3 was not removed: acme/app@issue-3 has uncommitted or untracked files (?? repro.html, M src/editor.ts, ?? notes.md) -- it is yours now"
assert_not_contains "  and its own stop's chatter is not in the log" "$(cat "$STUB/out")" "container kept"
assert_contains "  and its agent no longer counts as working" "$(ls "$STUB/state/acme__app")" "issue-3.agent.kept"
tick
assert_not_contains "  not tried again" "$(cat "$STUB/calls")" "worktree remove"
rm -f "$STUB/remove-fails"
echo '[]' > "$STUB/widget-issues"; statuses "" ""
tick
assert_contains "one gone already is done, not retried" "$(cat "$STUB/out")" "#7: no longer open, and issue-7 is gone already"
assert_not_contains "  nothing is removed" "$(cat "$STUB/calls")" "worktree remove"
assert_contains "  and its agent no longer counts" "$(ls "$STUB/state/acme__widget")" "issue-7.agent.done"
echo '[{"number":3,"title":"Plain work","body":"do it"}]' > "$STUB/app-issues"

group "--max-agents: no more agents start while that many are working"
rm -rf "$STUB/state"; mkdir -p "$STUB/state"; : > "$STUB/running"
jq -n --arg body "x" '[{number: 7, title: "a", body: $body}]' > "$STUB/widget-issues"
statuses "" ""
: > "$STUB/calls"
PATH="$STUB/bin:$PATH" DESOLATE_CLI="$STUB/bin/cli" FACTORY_STATE="$STUB/state" FACTORY_AGENT=true \
  bash "$ROOT/examples/factory/gh-dispatcher.sh" --all --once --max-agents 1 </dev/null > "$STUB/out" 2>&1
assert_contains "the first starts (projects in name order: acme/app)" "$(cat "$STUB/calls")" "cli worktree add acme/app issue-3"
assert_not_contains "the second waits" "$(cat "$STUB/calls")" "cli worktree add acme/widget"
assert_contains "  and says why" "$(cat "$STUB/out")" "waiting -- 1 agents are working"

group "a marker is checked, not trusted"
jq -n --arg body '<!-- desolate-dispatch: {"pr":"12; rm -rf /"} -->' '[{number: 8, title: "x", body: $body}]' > "$STUB/widget-issues"
statuses "" ""
tick
assert_contains "a pr that is no number is no pr: the worktree gets issue/8" "$(cat "$STUB/calls")" "cli worktree add acme/widget issue-8 issue/8"

group "a target being started already, or not answering yet: the agent waits"
rm -rf "$STUB/state"; mkdir -p "$STUB/state"; : > "$STUB/running"
echo '[]' > "$STUB/widget-issues"; echo '[{"number":3,"title":"Plain work","body":"do it"}]' > "$STUB/app-issues"
statuses "" ""
touch "$STUB/start-busy"
tick
assert_contains "busy (exit 75): said, and waited for" "$(cat "$STUB/out")" "#3: it is being started or changed already; waiting for that"
assert_not_contains "  and no agent" "$(ls "$STUB/state/acme__app")" "issue-3.agent"
rm -f "$STUB/start-busy"; touch "$STUB/exec-fails"
tick
assert_contains "started, but nothing runs in it yet: the agent waits" "$(cat "$STUB/out")" "#3: not answering yet; the agent waits a tick"
assert_not_contains "  and no agent" "$(ls "$STUB/state/acme__app")" "issue-3.agent"
rm -f "$STUB/exec-fails"
tick
assert_contains "it answers: asked with exec -- true" "$(cat "$STUB/calls")" "cli exec acme/app --worktree issue-3 -- true"
assert_contains "  and the agent starts" "$(ls "$STUB/state/acme__app")" "issue-3.agent"

group "a ^C mid-start stops it cleanly, and says the start goes on"
if command -v setsid >/dev/null; then
  rm -rf "$STUB/state"; mkdir -p "$STUB/state"; : > "$STUB/running"; touch "$STUB/start-slow"; : > "$STUB/calls"
  # Its own process group, as a terminal's foreground job is: a ^C reaches
  # the dispatcher and the command it is waiting on alike. TERM, which the trap
  # takes as it takes INT: a background job here starts with INT ignored.
  PATH="$STUB/bin:$PATH" DESOLATE_CLI="$STUB/bin/cli" FACTORY_STATE="$STUB/state" FACTORY_AGENT=true \
    setsid bash "$ROOT/examples/factory/gh-dispatcher.sh" --all --once </dev/null > "$STUB/out" 2>&1 &
  pid=$!
  for _ in $(seq 100); do grep -q "#3: starting it" "$STUB/out" 2>/dev/null && break; sleep 0.1; done
  kill -TERM -- "-$pid"
  wait "$pid"; code=$?
  assert_eq "it exits 130, at once" "$code" "130"
  assert_contains "  saying a start under way goes on in the stack" "$(cat "$STUB/out")" "stopped. A start under way goes on in the stack"
  assert_not_contains "  and not going on to the agent" "$(cat "$STUB/out")" "#3: an agent"
  rm -f "$STUB/start-slow"
else
  skip "a ^C mid-start" "no setsid"
fi

group "a worktree you stopped is not working: its place is free, and it is not started again"
rm -rf "$STUB/state"; mkdir -p "$STUB/state"; : > "$STUB/running"
echo '[{"number":3,"title":"Plain work","body":"do it"}]' > "$STUB/app-issues"
jq -n '[{number: 7, title: "a", body: "x"}]' > "$STUB/widget-issues"
statuses "" ""
capped() { # <max agents>
  : > "$STUB/calls"
  PATH="$STUB/bin:$PATH" DESOLATE_CLI="$STUB/bin/cli" FACTORY_STATE="$STUB/state" FACTORY_AGENT=true \
    bash "$ROOT/examples/factory/gh-dispatcher.sh" --all --once --max-agents "$1" </dev/null > "$STUB/out" 2>&1
}
capped 1
assert_contains "issue-3 runs, so #7 waits" "$(cat "$STUB/out")" "#7: waiting -- 1 agents are working"
# Its PR waits to be merged: you stop its worktree, from the panel.
STUB_DIR="$STUB" "$STUB/bin/cli" desolate acme/app --worktree issue-3 --stop
capped 1
assert_contains "stopped, its place is #7's" "$(cat "$STUB/calls")" "cli worktree add acme/widget issue-7"
assert_not_contains "  and issue-3 is not started again behind your back" "$(cat "$STUB/calls")" "cli desolate acme/app --worktree issue-3"
assert_contains "  its agent is still the dispatcher's, for when its issue closes" "$(ls "$STUB/state/acme__app")" "issue-3.agent"

group "what runs could not be read: every agent counts"
jq -n '[{number: 7, title: "a", body: "x"}, {number: 9, title: "b", body: "y"}]' > "$STUB/widget-issues"
touch "$STUB/list-fails"
capped 2
assert_contains "a failed read lifts no cap: #9 waits" "$(cat "$STUB/out")" "#9: waiting -- 2 agents are working"
rm -f "$STUB/list-fails"
capped 2
assert_contains "read again, only #7 runs: #9 starts" "$(cat "$STUB/calls")" "cli worktree add acme/widget issue-9"

group "another project's worktree of the same name is not this one's"
rm -rf "$STUB/state"; mkdir -p "$STUB/state"; echo "acme/widget issue-3" > "$STUB/running"
echo '[{"number":3,"title":"Plain work","body":"do it"}]' > "$STUB/app-issues"; echo '[]' > "$STUB/widget-issues"
tick
assert_contains "acme/app's issue-3 is started, though acme/widget's runs" "$(cat "$STUB/calls")" "cli desolate acme/app --worktree issue-3"

summary
