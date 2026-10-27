#!/usr/bin/env bash
# examples/factory/claude/claude-dispatcher.sh -- GitHub issues in, Claude Code on them, draft PRs out.
#
#   examples/factory/claude/claude-dispatcher.sh <project> [<owner/repo>] [--base B] [--label L] [--interval S] [--once]
#
# The loop is ../lib/gh-dispatch.sh; the agent is claude-helper.sh: Claude
# Code in a tmux session in each issue's worktree, on your subscription.
#   - At start, the token: stored already, or asked for (claude setup-token).
#   - When an agent's login fails (its status: red "claude: authentication
#     failed"), you are told -- here, with a bell, and by a notification on
#     this Mac -- and, in a terminal, asked for a new token; then every agent
#     that stopped on it carries on its conversation (`claude -c`). No new
#     agent starts while that waits.
#   - Watch one: claude-helper.sh attach <project> --worktree issue-<n>.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HELPER=$HERE/claude-helper.sh

agent_ready()   { "$HELPER" auth "$1"; }
agent_start()   { "$HELPER" start "$1" --worktree "$2" --task "$3"; }
agent_blocked() { [ "$1" = red ] && [ "$2" = "claude: authentication failed" ]; }
agent_renew()   { "$HELPER" auth "$1" --renew; }
agent_resume()  { "$HELPER" resume "$1" --worktree "$2"; }
agent_hint()    { local p=$1 w; shift; printf '%s auth %s --renew' "$HELPER" "$p"; for w; do printf '; %s resume %s --worktree %s' "$HELPER" "$p" "$w"; done; }

# shellcheck source=../lib/gh-dispatch.sh
. "$HERE/../lib/gh-dispatch.sh"
dispatch_main "$@"
