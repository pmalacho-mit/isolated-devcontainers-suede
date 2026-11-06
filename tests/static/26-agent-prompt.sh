#!/usr/bin/env bash
# What an agent is started with (#58): examples/factory/claude/claude-helper.sh
# run against stand-in `cli.sh`, `tmux`, `git` and `claude`, and the argv the
# stand-in claude actually receives read back -- so the multi-line system
# prompt is seen to survive the trip, not only to be present in the source.
# Also the task text the dispatcher builds (lib/gh-dispatch.sh).
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"
command -v jq >/dev/null || { skip "the agent's start" "jq not installed"; summary; exit $?; }

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home"
HELPER="$ROOT/examples/factory/claude/claude-helper.sh"

group "the task text"
cat > "$T/task.sh" <<EOS
. "$ROOT/examples/factory/lib/gh-dispatch.sh"
REPO=acme/app dispatch_task 7 "A title" "A body" issue/7 ""
EOS
TASK=$(bash "$T/task.sh" 2>&1)
assert_contains "names the issue" "$TASK" "GitHub issue #7 of acme/app"
assert_contains "asks to go on until done" "$TASK" "keep going until the work is done and checked"
assert_contains "asks to check each thing the issue asks" "$TASK" "check each thing it asks for"
assert_contains "asks to reproduce a bug first" "$TASK" "reproduce it first"
assert_contains "asks to install a missing tool" "$TASK" "install it (this container is a sandbox"
assert_contains "keeps the review of the diff" "$TASK" 'review your own diff'
assert_contains "keeps the way to ask a human" "$TASK" 'set orange with the specific question'

# stand-ins: the VM's secret and the running target, and exec as a local run
cat > "$T/bin/cli" <<'EOS'
#!/bin/sh
case "$1" in
  secret) echo "  DESOLATE-CLAUDE-OAUTH  ->  api.anthropic.com   [headers: authorization]" ;;
  desolate) echo '[{"target":"acme/app@issue-7","daemon":"project"}]' ;;
  exec) shift; shift; [ "$1" != --worktree ] || shift 2; [ "$1" != -- ] || shift; exec "$@" ;;
esac
EOS
cat > "$T/bin/tmux" <<'EOS'
#!/bin/sh
case "$1" in has-session) exit 1 ;; esac
exit 0
EOS
cat > "$T/bin/git" <<'EOS'
#!/bin/sh
exit 0
EOS
cat > "$T/bin/claude" <<'EOS'
#!/bin/sh
: > "$STUB_ARGV"
for a; do printf '%s\0' "$a" >> "$STUB_ARGV"; done
EOS
printf '#!/bin/sh\nexit 0\n' > "$T/bin/status"
chmod +x "$T"/bin/*

# start <name> <helper args...>: runs the helper, then the script it left for tmux
begin() { # <session> <command> <project> <helper args...>
  local session=$1 cmd=$2 project=$3; shift 3
  rm -rf "$T/home/.local"
  env HOME="$T/home" PATH="$T/bin:$PATH" DESOLATE_CLI="$T/bin/cli" DESOLATE_STATUS_HELPER="$T/bin/status" \
      FACTORY_TELEMETRY=off TELEMETRY_FILE=off STUB_ARGV="$T/argv.$session" \
      bash "$HELPER" "$cmd" "$project" --session "$session" "$@" </dev/null >"$T/out.$session" 2>&1
  local code=$?
  [ $code -eq 0 ] || { cat "$T/out.$session" >&2; return $code; }
  env HOME="$T/home" PATH="$T/bin:$PATH" STUB_ARGV="$T/argv.$session" \
      bash "$T/home/.local/state/desolate-claude/$session/run" </dev/null >/dev/null 2>&1
}
has_arg() { tr '\0' '\n' < "$T/argv.$1" | grep -qxF -- "$2"; }
arg_after() { tr '\0' '\n' < "$T/argv.$1" | awk -v f="$2" 'p { print; exit } $0 == f { p = 1 }'; }
# the prompt argument is multi-line: read it NUL-delimited
prompt_of() { awk -v RS='\0' -v ORS='\0' 'p { print; exit } $0 == "--append-system-prompt" { p = 1 }' "$T/argv.$1" | tr -d '\0'; }

group "a task: Opus, xhigh, and the standing instruction"
begin t1 start acme/app --worktree issue-7 --task "do it"; assert_eq "the helper ran" "$?" 0
assert_eq "--model is opus" "$(arg_after t1 --model)" opus
P=$(prompt_of t1)
assert_contains "the system prompt is appended, in one piece" "$P" "A standing instruction from the user"
assert_contains "  naming the early stop it forbids" "$P" "announcing the next step"
assert_contains "  and the stops it wants" "$P" "the orange, red and gray statuses"
assert_contains "  and what done means" "$P" '"Done" means you have seen it work'
assert_contains "  and that installing is expected" "$P" "installing things here is expected"
assert_contains "  and that its last line arrived whole" "$P" "only when the task needs it."
assert_eq "the task is still the last argument" "$(tr '\0' '\n' < "$T/argv.t1" | tail -n 1)" "do it"
assert_eq "effort is xhigh" "$(jq -r .effortLevel "$T/home/.local/state/desolate-claude/t1/settings.json")" xhigh

group "overrides and no task"
begin t2 start acme/app --worktree issue-7 --task "do it" -- --model sonnet; assert_eq "the helper ran" "$?" 0
assert_eq "an explicit --model wins" "$(arg_after t2 --model)" sonnet
assert_eq "  and Opus is not added beside it" "$(tr '\0' '\n' < "$T/argv.t2" | grep -c '^opus$')" 0
begin t3 start acme/app --worktree issue-7 --task "do it" -- --append-system-prompt "mine"; assert_eq "the helper ran" "$?" 0
assert_eq "an explicit system prompt is the only one" "$(prompt_of t3)" "mine"
begin t4 start acme/app --worktree issue-7; assert_eq "the helper ran" "$?" 0
assert_eq "without a task it is still Opus" "$(arg_after t4 --model)" opus
if has_arg t4 --append-system-prompt; then fail "without a task nothing is appended (a person is at the keyboard)"; else pass "without a task nothing is appended (a person is at the keyboard)"; fi
begin t5 resume acme/app --worktree issue-7; assert_eq "the helper ran" "$?" 0
assert_contains "a resumed agent gets the instruction again" "$(prompt_of t5)" "A standing instruction"
assert_eq "  on its conversation" "$(tr '\0' '\n' < "$T/argv.t5" | grep -cxF -- -c)" 1
summary
