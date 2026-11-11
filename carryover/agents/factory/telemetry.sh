#!/usr/bin/env bash
# examples/factory/telemetry.sh -- read the factory's timing log.
#
#   telemetry.sh report [--since DAYS]   where the time went: per operation, per tick, per issue, per agent
#   telemetry.sh prompt [--since DAYS]   the same, wrapped as a prompt for a coding agent, with the slowest events
#   telemetry.sh path                    the log's path (JSON lines; docs/factory-telemetry.md)
#
# Reads $FACTORY_TELEMETRY (default ~/.local/state/desolate-factory/telemetry.jsonl).
set -euo pipefail
FILE=${FACTORY_TELEMETRY:-${FACTORY_STATE:-$HOME/.local/state/desolate-factory}/telemetry.jsonl}
CMD=${1:-}; [ $# -eq 0 ] || shift
DAYS=36500
while [ $# -gt 0 ]; do case "$1" in --since) DAYS=${2:?}; shift 2 ;; *) echo "telemetry: unknown option '$1'" >&2; exit 2 ;; esac; done
command -v jq >/dev/null || { echo "telemetry: needs jq" >&2; exit 1; }

report() {
  [ -s "$FILE" ] || { echo "no telemetry at $FILE yet"; return 0; }
  jq -rs --argjson days "$DAYS" '
    def pct(p): sort | .[((length - 1) * p) | floor];
    def sec: (. / 1000 * 10 | round) / 10;
    (now - $days * 86400) as $cut
    | map(select((.ts | fromdateiso8601) >= $cut)) as $e
    | "# Factory telemetry: \($e | length) events, \($e | map(.ts) | min) .. \($e | map(.ts) | max)",
      "runs: \($e | map(.run) | unique | length)",
      "",
      "## Operations (ms): calls into the stack (cli_*), GitHub (gh_*), the agent driver",
      "op | n | failed | p50 | p95 | max | total_s",
      ( $e | map(select(.event == "op")) | group_by(.op)
        | map({op: .[0].op, n: length, bad: (map(select(.exit != 0)) | length), ms: (map(.ms))})
        | sort_by(-(.ms | add)) | .[]
        | "\(.op) | \(.n) | \(.bad) | \(.ms | pct(0.5)) | \(.ms | pct(0.95)) | \(.ms | max) | \(.ms | add / 1000 | round)" ),
      "",
      "## Ticks (ms) per project",
      ( $e | map(select(.event == "tick")) | group_by(.project)
        | .[] | "\(.[0].project): n=\(length) p50=\(map(.ms) | pct(0.5)) p95=\(map(.ms) | pct(0.95)) max=\(map(.ms) | max)" ),
      "",
      "## Issues: seconds from the issue first seen to each milestone",
      ( $e | map(select(.issue != null and .issue != "")) | group_by([.project, .issue])
        | .[] | . as $g
        | "\($g[0].project)#\($g[0].issue): "
          + ( [ ($g[] | select(.event == "agent_started") | "agent_started +\(.since_issue_ms | sec)s"),
                ($g[] | select(.event == "status") | "\(.color) +\(.since_agent_ms | sec)s into the agent (\(.message[0:60]))"),
                ($g[] | select(.event == "pr") | "pr +\(.since_issue_ms | sec)s"),
                ($g[] | select(.event == "worktree_gone") | "gone +\(.since_issue_ms | sec)s") ] | join("; ") ) ),
      "",
      "## Agents: what the agent itself did (tool calls, and the longest gaps between its events)",
      ( $e | map(select(.event == "agent_event")) | group_by([.project, .issue]) | .[] | . as $g
        | ($g | sort_by(.t_ms)) as $s
        | ([range(1; $s | length) | {gap: (($s[.].t_ms - $s[. - 1].t_ms) / 1000 | round), after: $s[. - 1].kind, tool: ($s[. - 1].tool // "")}] | sort_by(-.gap) | .[0:3]) as $gaps
        | "\($g[0].project)#\($g[0].issue): \($s | length) events, \($s | map(select(.kind == "tool_start")) | length) tool calls, span \((($s[-1].t_ms - $s[0].t_ms) / 1000 | round))s; longest gaps: "
          + ($gaps | map("\(.gap)s after \(.after) \(.tool)") | join(", ")) ),
      "",
      "## Slowest single operations",
      ( $e | map(select(.event == "op")) | sort_by(-.ms) | .[0:10] | .[]
        | "\(.ts) \(.op) \(.ms)ms exit=\(.exit) \(.project)#\(.issue)" )
  ' "$FILE"
}

case "$CMD" in
  report) report ;;
  prompt)
    cat <<PROMPT
Below is a timing report from a "software factory" that runs on top of the desolate
devcontainer stack: a dispatcher polls GitHub issues, creates a worktree, starts a
devcontainer for it, and starts a Claude Code agent inside. Using this report, diagnose
where the time goes and what is slow, wasteful or failing, and propose and make concrete
improvements to the scripts in examples/factory (and to the stack, if the evidence
points there). Quote the numbers you rely on. The raw log is JSON lines at:
$FILE
(fields are documented in docs/factory-telemetry.md).

PROMPT
    report ;;
  path) echo "$FILE" ;;
  *) sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
