#!/usr/bin/env bash
# examples/factory/gh-dispatcher.sh -- GitHub issues in, any agent command, draft PRs out.
#
#   FACTORY_AGENT="claude -p" examples/factory/gh-dispatcher.sh <project> <owner/repo> <clone> [--label L] [--interval S] [--once]
#
# The loop is lib/gh-dispatch.sh. The agent here is FACTORY_AGENT, a command
# `cli.sh exec` runs in the worktree in the background, words split on
# spaces, with the task as its last argument; its output goes to the
# dispatcher's state dir. It brings its own credentials. For Claude Code on
# your subscription, in tmux, use claude/claude-dispatcher.sh instead.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

[ -n "${FACTORY_AGENT:-}" ] || { echo "gh-dispatcher: set FACTORY_AGENT to the command to run (for Claude: claude/claude-dispatcher.sh)" >&2; exit 2; }
read -r -a AGENT <<< "$FACTORY_AGENT"

agent_start() { # <project> <worktree> <task>
  nohup "$CLI" exec "$1" --worktree "$2" -- "${AGENT[@]}" "$3" </dev/null >> "$STATE/$2.agent.log" 2>&1 &
}

# shellcheck source=lib/gh-dispatch.sh
. "$HERE/lib/gh-dispatch.sh"
dispatch_main "$@"
