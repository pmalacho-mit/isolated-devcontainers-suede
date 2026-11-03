# examples/factory/lib/telemetry.sh -- one JSON line per thing the factory did, and how long it took.
#
# Sourced by gh-dispatch.sh and claude/claude-helper.sh. Appends to
#   $FACTORY_TELEMETRY   (default: $FACTORY_STATE/telemetry.jsonl,
#                         i.e. ~/.local/state/desolate-factory/telemetry.jsonl)
# Set FACTORY_TELEMETRY=off to write nothing. It never fails its caller.
#
# Every line: {"ts": ISO-8601 UTC, "run": <id of this process tree>, "event": ..., ...fields}
# Events (see docs/factory-telemetry.md for the fields):
#   run_start, tick        the loop and how long each project's tick took
#   op                     one timed call into the stack or GitHub: op, ms, exit, project, issue
#   issue_seen, agent_started, status, pr, worktree_gone    an issue's lifecycle, with
#                          since_issue_ms / since_agent_ms, so "where did the time go" is a subtraction
#   agent_event            the agent's own events (session start, each tool call, stop), pulled
#                          out of the devcontainer; see claude-helper.sh `events`
# Summarise with: examples/factory/telemetry.sh report | prompt

TELEMETRY_FILE=${FACTORY_TELEMETRY:-${FACTORY_STATE:-$HOME/.local/state/desolate-factory}/telemetry.jsonl}
TELE_RUN=${TELE_RUN:-$(date +%s)-$$}
export TELE_RUN

# Milliseconds since the epoch: GNU date, else perl (macOS's date has no %N), else whole seconds.
now_ms() {
  local t; t=$(date +%s%3N 2>/dev/null)
  case "$t" in ""|*[!0-9]*) t=$(perl -MTime::HiRes=time -e 'printf "%d", time()*1000' 2>/dev/null) ;; esac
  case "$t" in ""|*[!0-9]*) t=$(( $(date +%s) * 1000 )) ;; esac
  echo "$t"
}

# tele_event <event> [key=value...]   numbers stay numbers; strings are cut at 200 chars, controls dropped.
tele_event() {
  [ "$TELEMETRY_FILE" != off ] || return 0
  command -v jq >/dev/null || return 0
  {
    local obj kv v
    obj=$(jq -nc --arg e "$1" --arg ts "$(date -u +%FT%TZ)" --arg r "$TELE_RUN" '{ts:$ts,run:$r,event:$e}') || return 0
    shift
    for kv in "$@"; do
      v=$(printf '%s' "${kv#*=}" | tr -d '\000-\037\177' | cut -c1-200)
      obj=$(jq -c --arg k "${kv%%=*}" --arg v "$v" '.[$k] = (if ($v|test("^-?[0-9]+$")) then ($v|tonumber) else $v end)' <<< "$obj") || return 0
    done
    mkdir -p "$(dirname "$TELEMETRY_FILE")" && printf '%s\n' "$obj" >> "$TELEMETRY_FILE"
  } 2>/dev/null || true
  return 0
}

# tele_timed <op> <command...>   runs it unchanged (stdin, stdout, stderr, exit status) and records the time.
# Context fields come from $PROJECT and $TELE_ISSUE when set.
tele_timed() {
  local op=$1 start code=0; shift
  start=$(now_ms)
  "$@" || code=$?
  tele_event op op="$op" ms=$(( $(now_ms) - start )) exit="$code" project="${PROJECT:-}" issue="${TELE_ISSUE:-}"
  return "$code"
}
