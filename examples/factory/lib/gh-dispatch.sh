# examples/factory/lib/gh-dispatch.sh -- GitHub issues in, draft PRs out, on desolate's primitives.
#
# Sourced, not run: a dispatcher defines its agent, then calls
# `dispatch_main "$@"` (see ../gh-dispatcher.sh, ../claude/claude-dispatcher.sh).
#
#   <dispatcher> <project> <owner/repo> [--label L] [--interval S] [--once]
#
# Runs on your Mac, with YOUR gh login; desolate holds no forge credential.
# There is no clone here: the repository lives in desolate, and its branches
# are pushed from the outer editor, by you. Each tick, for every open issue labelled L (default desolate:run):
#
#   1. no worktree issue-<n> yet: `cli.sh worktree add`, on branch issue/<n>;
#   2. not running: start it;
#   3. no agent started here yet: agent_start, with the issue as its task and
#      desolate-status as its voice;
#   4. its status (`cli.sh desolate --status --json`):
#        the agent's own access broken (agent_blocked: a failed login, say) --
#                       you are told, here and by a notification, and asked to
#                       fix it when this runs in a terminal; then agent_resume;
#        orange, red -- a comment on the issue, once per status;
#        green       -- you are told to push issue/<n> from the editor; once
#                       GitHub has that branch, a draft PR is opened for it;
#
# and for every worktree it started whose issue is no longer open: stop it and
# `cli.sh worktree remove` it, which refuses one holding uncommitted work.
#
# A status is the agent's claim (docs/agents.md): you look before you push,
# and review the draft after.
#
# The agent, as functions the dispatcher defines (each has a default here):
#   agent_ready   <project>                    credentials in place; may ask -- once, at start
#   agent_start   <project> <worktree> <task>  start one; 0 once it is running
#   agent_blocked <color> <message>            0 when a status means the agent's OWN access is broken
#   agent_renew   <project>                    fix that; may ask
#   agent_resume  <project> <worktree>         carry on after agent_renew
#   agent_hint    <project> <worktree...>      how to fix it by hand, for when no one is here to ask
#
# Environment:
#   DESOLATE_CLI            path to cli.sh (default: this checkout's)
#   DESOLATE_STATUS_HELPER  desolate-status's path inside a target
#   FACTORY_STATE           where it remembers what it did
#                           (default: ~/.local/state/desolate-factory)

FACTORY_LIB=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI=${DESOLATE_CLI:-$FACTORY_LIB/../../../release/cli.sh}
STATUS_HELPER=${DESOLATE_STATUS_HELPER:-/desolate-ca/desolate-status}
DISPATCHER=$(basename "$0" .sh)

declare -F agent_ready   >/dev/null || agent_ready()   { :; }
declare -F agent_start   >/dev/null || agent_start()   { echo "dispatch: no agent_start defined" >&2; return 1; }
declare -F agent_blocked >/dev/null || agent_blocked() { return 1; }
declare -F agent_renew   >/dev/null || agent_renew()   { return 1; }
declare -F agent_resume  >/dev/null || agent_resume()  { :; }
declare -F agent_hint    >/dev/null || agent_hint()    { echo "fix the agent's access, then restart it"; }

log() { printf '%s %s: %s\n' "$(date +%H:%M:%S)" "$DISPATCHER" "$*"; }

# Said here, and where you will see it if this terminal is out of sight.
notify() {
  log "$*"
  printf '\a'
  if command -v osascript >/dev/null; then
    osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "desolate"' -e 'end run' "$*" >/dev/null 2>&1 || true
  fi
}

# The task an agent starts with.
dispatch_task() { # <n> <title> <body>
  cat <<EOF
You are working on GitHub issue #$1 of $REPO, in a desolate worktree on branch issue/$1.

Title: $2

$3

Say how it is going with $STATUS_HELPER; a human sees it beside this worktree:
  set blue "<what you are doing>" while working;
  set orange "<your question>" when you need a human, then stop;
  set red "<what failed>" when you cannot go on;
  set green "<one line for the PR>" when the work is committed on issue/$1.
Commit your work on issue/$1; do not push. A human pushes it, and a draft PR follows.
EOF
}

# Green: the push is yours, from the outer editor, where the deploy key is --
# never this script's, which would run an agent-written repository's hooks and
# config there with no one looking. Asked for once per status; the PR follows
# as soon as GitHub has the branch.
dispatch_pull_request() { # <n> <name> <title> <message> <updated>
  local n=$1 name=$2 title=$3 message=$4 updated=$5 branch=issue/$1
  if ! gh api "repos/$REPO/git/ref/heads/$branch" --silent 2>/dev/null; then
    [ "$(cat "$STATE/$name.push" 2>/dev/null)" = "$updated" ] && return
    notify "#$n is ready ($message) -- review it, then push from the editor: git -C /workspaces/$PROJECT push origin $branch"
    echo "$updated" > "$STATE/$name.push"
    return
  fi
  gh pr create -R "$REPO" --draft --head "$branch" --base "$DEFAULT_BRANCH" \
    --title "$title" --body "$message

Closes #$n" > "$STATE/$name.pr"
  log "#$n: draft PR $(cat "$STATE/$name.pr")"
}

# Agents whose own access broke: say so once per status, fix it if a person is
# here to, and let them carry on. 1 while any stays broken, so no more start.
dispatch_unblock() { # <statuses json>
  local blocked="" row name color message updated
  while IFS= read -r row; do
    name=$(jq -r .worktree <<< "$row"); [ -e "$STATE/$name.agent" ] || continue
    color=$(jq -r .status.color <<< "$row"); message=$(jq -r .status.message <<< "$row")
    agent_blocked "$color" "$message" || continue
    blocked="$blocked $name"
    updated=$(jq -r .status.updated <<< "$row")
    if [ "$(cat "$STATE/$name.blocked" 2>/dev/null)" != "$updated" ]; then
      notify "$PROJECT@$name: $message -- the agent needs you"
      echo "$updated" > "$STATE/$name.blocked"
    fi
  done < <(jq -c '.[] | select(.worktree != null and .status != null)' <<< "$1")
  [ -n "$blocked" ] || return 0
  if [ -t 0 ] && agent_renew "$PROJECT"; then
    for name in $blocked; do log "$name: carrying on"; agent_resume "$PROJECT" "$name" || log "$name: could not resume"; done
    return 0
  fi
  # shellcheck disable=SC2086
  log "waiting on you for:$blocked -- run this in a terminal to be asked, or: $(agent_hint "$PROJECT" $blocked)"
  return 1
}

dispatch_tick() {
  local issues statuses running
  issues=$(gh issue list -R "$REPO" --label "$LABEL" --state open --limit 100 --json number,title,body)
  statuses=$("$CLI" desolate --status --json "$PROJECT")
  running=$("$CLI" desolate --list --json | sed -n '/^\[/p' | tail -n 1)
  local can_start=1
  dispatch_unblock "$statuses" || can_start=""

  local issue n title body name row color message updated
  while IFS= read -r issue; do
    n=$(jq -r .number <<< "$issue"); title=$(jq -r .title <<< "$issue"); body=$(jq -r '.body // ""' <<< "$issue")
    name=issue-$n

    if [ ! -e "$STATE/$name.agent" ]; then
      [ -n "$can_start" ] || continue
      if ! jq -e --arg w "$name" 'any(.[]; .worktree == $w)' <<< "$statuses" >/dev/null; then
        log "#$n: a worktree"
        "$CLI" worktree add "$PROJECT" "$name" "issue/$n" || { log "#$n: worktree add failed"; continue; }
      fi
      if ! jq -e --arg w "$name" 'any(.[]?; .worktree == $w)' <<< "${running:-[]}" >/dev/null; then
        log "#$n: starting it"
        "$CLI" desolate "$PROJECT" --worktree "$name" </dev/null || { log "#$n: start failed"; continue; }
      fi
      log "#$n: an agent"
      if agent_start "$PROJECT" "$name" "$(dispatch_task "$n" "$title" "$body")" </dev/null > "$STATE/$name.log" 2>&1; then
        date -u +%FT%TZ > "$STATE/$name.agent"
      else
        log "#$n: the agent did not start: $(tail -n 1 "$STATE/$name.log")"
      fi
      continue
    fi

    row=$(jq -c --arg w "$name" '.[] | select(.worktree == $w) | .status // empty' <<< "$statuses")
    [ -n "$row" ] || continue
    color=$(jq -r .color <<< "$row"); message=$(jq -r .message <<< "$row"); updated=$(jq -r .updated <<< "$row")
    agent_blocked "$color" "$message" && continue    # the agent's own access: ours to fix, not the issue's
    case "$color" in
      orange|red)
        [ "$(cat "$STATE/$name.told" 2>/dev/null)" = "$updated" ] && continue
        gh issue comment "$n" -R "$REPO" --body "desolate: **$color** -- $message" >/dev/null
        echo "$updated" > "$STATE/$name.told"
        log "#$n: $color, said on the issue" ;;
      green)
        [ -e "$STATE/$name.pr" ] || dispatch_pull_request "$n" "$name" "$title" "$message" "$updated" ;;
    esac
  done < <(jq -c '.[]' <<< "$issues")

  # Worktrees this started, for issues no longer open: done with.
  local started
  for started in "$STATE"/issue-*.agent; do
    [ -e "$started" ] || continue
    name=$(basename "$started" .agent); n=${name#issue-}
    jq -e --argjson n "$n" 'any(.[]; .number == $n)' <<< "$issues" >/dev/null && continue
    log "#$n: no longer open; stopping and removing $name"
    "$CLI" desolate "$PROJECT" --worktree "$name" --stop </dev/null || true
    if "$CLI" worktree remove "$PROJECT" "$name"; then
      mv "$started" "$started.done"
    else
      log "#$n: $name kept (uncommitted work?) -- remove it yourself"
    fi
  done
}

dispatch_main() {
  set -euo pipefail
  [ $# -ge 2 ] || { sed -n '6p' "$FACTORY_LIB/gh-dispatch.sh" | sed "s/^# \{0,1\}//; s/<dispatcher>/$DISPATCHER.sh/" >&2; exit 2; }
  PROJECT=$1 REPO=$2; shift 2
  LABEL=desolate:run INTERVAL=60 ONCE=
  while [ $# -gt 0 ]; do
    case "$1" in
      --label) LABEL=${2:?}; shift 2 ;;
      --interval) INTERVAL=${2:?}; shift 2 ;;
      --once) ONCE=1; shift ;;
      *) echo "$DISPATCHER: unknown option '$1'" >&2; exit 2 ;;
    esac
  done
  STATE=${FACTORY_STATE:-$HOME/.local/state/desolate-factory}/${PROJECT//\//__}
  mkdir -p "$STATE"
  local tool
  for tool in gh jq; do
    command -v "$tool" >/dev/null || { echo "$DISPATCHER: needs $tool" >&2; exit 1; }
  done
  agent_ready "$PROJECT" || { echo "$DISPATCHER: the agent is not ready" >&2; exit 1; }
  DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
  while :; do
    dispatch_tick || log "tick failed; trying again next time"
    [ -z "$ONCE" ] || exit 0
    sleep "$INTERVAL"
  done
}
