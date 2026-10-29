# examples/factory/lib/gh-dispatch.sh -- GitHub issues in, draft PRs out, on desolate's primitives.
#
# Sourced, not run: a dispatcher defines its agent, then calls
# `dispatch_main "$@"` (see ../gh-dispatcher.sh, ../claude/claude-dispatcher.sh).
#
#   <dispatcher> <project> [<owner/repo>] [--base B] [--label L] [--interval S] [--once]
#   <dispatcher> --all [--label L] [--interval S] [--once] [--max-agents N]
#
# <project> is desolate's name for it -- its path under /workspaces, what
# `./cli.sh desolate <project>` takes. <owner/repo> is its GitHub repository,
# for gh; it defaults to <project>, which is what `./cli.sh repo add owner/repo`
# clones it as. With --all, every project in the stack whose name is an
# owner/repo, each with its repository named after it.
#
# Runs on your Mac, with YOUR gh login; desolate holds no forge credential.
# There is no clone here: the repository lives in desolate, and its branches
# are pushed from the outer editor, by you. Each tick, for every open issue labelled L (default desolate:run):
#
#   1. no worktree issue-<n> yet: `cli.sh worktree add`, on a new branch
#      issue/<n> started from B (--base: a branch or ref of the project's,
#      `v2` or `origin/v2`; default: the project's HEAD), and its draft PR
#      targets B too (without `origin/`; default: the repo's default branch);
#   2. not running: start it -- or, when desolate says it is being started or
#      changed already (exit 75: by the panel, or by a start a ^C left running
#      in the stack), wait a tick;
#   3. no agent started here yet, and the target answers (`cli.sh exec -- true`):
#      agent_start, with the issue as its task and desolate-status as its voice
#      -- unless --max-agents (default 3) are already working, across every
#      project: then it waits a tick;
#   4. its status (`cli.sh desolate --status --json`):
#        the agent's own access broken (agent_blocked: a failed login, say) --
#                       you are told, here and by a notification, and asked to
#                       fix it when this runs in a terminal; then agent_resume;
#        orange, red -- a comment on the issue, once per status;
#        green       -- you are told to review and push it (`desolate --push`,
#                       or the panel's Review & Push); once GitHub has issue/<n>, a
#                       draft PR is opened for it -- or the one already open
#                       for that branch is taken, and made to close the issue;
#        gray        -- withdrawn: the agent recommends this not be merged;
#                       said on the issue (and its PR), once per status;
#
# and for every worktree it started whose issue is no longer open: stop it and
# `cli.sh worktree remove` it, which refuses one holding uncommitted work. One
# that will not go is left to you, said once; either way its agent no longer
# counts as working. A repository with issues turned off is skipped, quietly;
# issues that could not be read skip the tick -- unread is not closed.
#
# A status is the agent's claim (docs/agents.md): you look before you push,
# and review the draft after.
#
# An issue may carry a marker, written by another tool (the suede factory,
# docs/suede-factory.md), saying more than the issue's number can:
#   <!-- desolate-dispatch: {"branch": B, "start": S, "fetch": true, "pr": N, "base": P} -->
#   branch  the worktree's branch, instead of issue/<n>
#   start   where it starts, when the branch is new here (an origin/... ref)
#   fetch   refresh the project's origin/* first (`cli.sh pull --fetch-only`)
#   pr      the branch already has PR #N: on green you are asked to push to it,
#           and no PR is opened
#   base    the new PR's base, instead of --base or the default branch
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
STATUS_HELPER=${DESOLATE_STATUS_HELPER:-/desolate/status}
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

# The marker's field, or the default. An issue body is anyone's text: only a
# well-formed marker counts, and every value is checked where it is used.
marker_field() { # <body> <field> <default>
  local marker value
  marker=$(printf '%s\n' "$1" | sed -n 's/^<!-- desolate-dispatch: \({.*}\) -->$/\1/p' | head -n 1)
  value=$( [ -n "$marker" ] && jq -r --arg f "$2" '.[$f] // empty | tostring' <<< "$marker" 2>/dev/null )
  printf '%s' "${value:-$3}"
}

# The task an agent starts with.
dispatch_task() { # <n> <title> <body> <branch> <pr>
  local after="A human pushes it, and a draft PR follows."
  [ -z "$5" ] || after="A human pushes it to PR #$5."
  cat <<EOF
You are working on GitHub issue #$1 of $REPO, in a desolate worktree on branch $4.

Title: $2

$3

Say how it is going with $STATUS_HELPER; a human sees it beside this worktree:
  set blue "<what you are doing>" while working;
  set orange "<your question>" when you need a human, then stop;
  set red "<what failed>" when you cannot go on;
  set green "<one line for the PR>" when the work is committed on $4;
  set gray "withdrawn: <why>" if you conclude this should not be merged.
Other agents may be working in this repository too: read \`$STATUS_HELPER board\` when you start and before you finish,
and leave a \`$STATUS_HELPER note\` when they should know something.
Commit your work on $4; do not push. $after
How this environment works -- the proxy, secrets, what you cannot reach: /desolate/AGENTS.md.
EOF
}

# Green: the push is yours, after you have looked at what the agent wrote --
# through desolate's push, which never runs the project's git in the editor
# (transfer.ts). Asked for once per status; the PR follows as soon as GitHub
# has the branch.
dispatch_pull_request() { # <n> <name> <title> <message> <updated> <branch> <base>
  local n=$1 name=$2 title=$3 message=$4 updated=$5 branch=$6 base=$7
  if ! gh api "repos/$REPO/git/ref/heads/$branch" --silent 2>/dev/null; then
    [ "$(cat "$STATE/$name.push" 2>/dev/null)" = "$updated" ] && return
    notify "#$n is ready ($message) -- review it, then push: the panel's Review & Push on $name, or desolate --push --worktree $name $PROJECT"
    echo "$updated" > "$STATE/$name.push"
    return
  fi
  # One already open for the branch (opened by hand, say) is taken -- and made
  # to close the issue, which is what ends the worktree.
  local open
  open=$(gh pr list -R "$REPO" --head "$branch" --state open --json number,url,body 2>/dev/null | jq -c '.[0] // empty' 2>/dev/null || true)
  if [ -n "$open" ]; then
    jq -r .url <<< "$open" > "$STATE/$name.pr"
    log "#$n: $branch already has a PR: $(cat "$STATE/$name.pr")"
    if ! jq -e --arg n "$n" '.body // "" | test("\\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #" + $n + "\\b"; "i")' <<< "$open" >/dev/null; then
      gh pr edit "$(jq -r .number <<< "$open")" -R "$REPO" --body "$(jq -r '.body // ""' <<< "$open")

Closes #$n" >/dev/null 2>&1 && log "#$n: that PR now closes it" || log "#$n: could not make that PR close it; merging it will not end the worktree"
    fi
    return
  fi
  if gh pr create -R "$REPO" --draft --head "$branch" --base "$base" \
    --title "$title" --body "$message

Closes #$n" > "$STATE/$name.pr" 2> "$STATE/$name.pr-error"; then
    log "#$n: draft PR $(cat "$STATE/$name.pr")"
  else
    rm -f "$STATE/$name.pr"
    [ "$(cat "$STATE/$name.pr-tried" 2>/dev/null)" = "$updated" ] \
      || log "#$n: no draft PR: $(tail -n 1 "$STATE/$name.pr-error") -- tried again each tick"
    echo "$updated" > "$STATE/$name.pr-tried"
  fi
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
  # What is not read is not closed: worktrees are removed below for the issues
  # missing from this, so a failed read ends the tick.
  if ! issues=$(gh issue list -R "$REPO" --label "$LABEL" --state open --limit 100 --json number,title,body 2> "$STATE/.issues-error"); then
    if grep -q "has disabled issues" "$STATE/.issues-error"; then
      [ -e "$STATE/.issues-off" ] || log "$REPO has issues turned off; skipped while it does"
      : > "$STATE/.issues-off"
      return 0
    fi
    log "$REPO: issues not read: $(tail -n 1 "$STATE/.issues-error")"
    return 1
  fi
  rm -f "$STATE/.issues-off"
  statuses=$("$CLI" desolate --status --json "$PROJECT" </dev/null) && jq -e 'type == "array"' <<< "$statuses" >/dev/null 2>&1 \
    || { log "$PROJECT: its worktrees not read"; return 1; }
  running=$("$CLI" desolate --list --json | sed -n '/^\[/p' | tail -n 1)
  local can_start=1
  dispatch_unblock "$statuses" || can_start=""

  local issue n title body name row color message updated branch start fetch pr base
  while IFS= read -r issue; do
    n=$(jq -r .number <<< "$issue"); title=$(jq -r .title <<< "$issue"); body=$(jq -r '.body // ""' <<< "$issue")
    name=issue-$n
    branch=$(marker_field "$body" branch "issue/$n"); start=$(marker_field "$body" start "$BASE")
    fetch=$(marker_field "$body" fetch ""); pr=$(marker_field "$body" pr ""); base=$(marker_field "$body" base "$PR_BASE")
    case "$pr" in *[!0-9]*) pr="" ;; esac

    if [ ! -e "$STATE/$name.agent" ]; then
      [ -n "$can_start" ] || continue
      if [ "$(working_agents)" -ge "$MAX_AGENTS" ]; then
        log "#$n: waiting -- $MAX_AGENTS agents are working (--max-agents)"
        continue
      fi
      if ! jq -e --arg w "$name" 'any(.[]; .worktree == $w)' <<< "$statuses" >/dev/null; then
        if [ "$fetch" = true ]; then
          "$CLI" pull "$PROJECT" --fetch-only </dev/null >/dev/null || { log "#$n: could not refresh $PROJECT's origin/*"; continue; }
        fi
        log "#$n: a worktree on $branch"
        "$CLI" worktree add "$PROJECT" "$name" "$branch" ${start:+"$start"} || { log "#$n: worktree add failed"; continue; }
      fi
      if ! jq -e --arg w "$name" 'any(.[]?; .worktree == $w)' <<< "${running:-[]}" >/dev/null; then
        log "#$n: starting it"
        local code=0
        "$CLI" desolate "$PROJECT" --worktree "$name" </dev/null || code=$?
        if [ "$code" -eq 75 ]; then log "#$n: it is being started or changed already; waiting for that"; continue; fi
        [ "$code" -eq 0 ] || { log "#$n: start failed"; continue; }
      fi
      # Up as far as an agent needs: a command runs in it. A start still under
      # way -- one a ^C left running in the stack, say -- answers 75.
      if ! "$CLI" exec "$PROJECT" --worktree "$name" -- true </dev/null >/dev/null 2>&1; then
        log "#$n: not answering yet; the agent waits a tick"
        continue
      fi
      log "#$n: an agent"
      if agent_start "$PROJECT" "$name" "$(dispatch_task "$n" "$title" "$body" "$branch" "$pr")" </dev/null > "$STATE/$name.log" 2>&1; then
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
        if [ -n "$pr" ]; then
          [ "$(cat "$STATE/$name.push" 2>/dev/null)" = "$updated" ] && continue
          notify "#$n is ready ($message) -- review it, then push to PR #$pr: the panel's Review & Push on $name, or desolate --push --worktree $name $PROJECT"
          echo "$updated" > "$STATE/$name.push"
        else
          [ -e "$STATE/$name.pr" ] || dispatch_pull_request "$n" "$name" "$title" "$message" "$updated" "$branch" "$base"
        fi ;;
      gray)
        [ "$(cat "$STATE/$name.told" 2>/dev/null)" = "$updated" ] && continue
        gh issue comment "$n" -R "$REPO" --body "desolate: the agent **withdrew** -- $message. It recommends this not be merged." >/dev/null
        [ -z "$pr" ] || gh pr comment "$pr" -R "$REPO" --body "desolate: the agent working on #$n **withdrew** -- $message. It recommends this not be merged." >/dev/null
        echo "$updated" > "$STATE/$name.told"
        notify "#$n: the agent withdrew ($message)" ;;
    esac
  done < <(jq -c '.[]' <<< "$issues")

  # Worktrees this started, for issues no longer open: done with. One that is
  # gone already is done; one that will not go is left to you, said once.
  local started out
  for started in "$STATE"/issue-*.agent; do
    [ -e "$started" ] || continue
    name=$(basename "$started" .agent); n=${name#issue-}
    jq -e --argjson n "$n" 'any(.[]; .number == $n)' <<< "$issues" >/dev/null && continue
    if ! jq -e --arg w "$name" 'any(.[]; .worktree == $w)' <<< "$statuses" >/dev/null; then
      log "#$n: no longer open, and $name is gone already"
      mv "$started" "$started.done"
      continue
    fi
    log "#$n: no longer open; stopping and removing $name"
    "$CLI" desolate "$PROJECT" --worktree "$name" --stop </dev/null || true
    if out=$("$CLI" worktree remove "$PROJECT" "$name" </dev/null 2>&1); then
      mv "$started" "$started.done"
    else
      log "#$n: $name was not removed ($(printf '%s\n' "$out" | tail -n 1)) -- it is yours now: ./cli.sh worktree remove $PROJECT $name [--force]"
      mv "$started" "$started.kept"
    fi
  done
}

# One project's tick: PROJECT, REPO, STATE, PR_BASE for it, and its agent ready.
dispatch_project() { # <project> <repo>
  PROJECT=$1 REPO=$2
  STATE=${FACTORY_STATE:-$HOME/.local/state/desolate-factory}/${PROJECT//\//__}
  mkdir -p "$STATE"
  if [ ! -s "$STATE/.default-branch" ]; then
    gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name > "$STATE/.default-branch" 2>/dev/null \
      || { rm -f "$STATE/.default-branch"; log "$REPO: not reachable with gh; skipped"; return 0; }
  fi
  DEFAULT_BRANCH=$(cat "$STATE/.default-branch")
  PR_BASE=${BASE#origin/}; PR_BASE=${PR_BASE:-$DEFAULT_BRANCH}
  if [ ! -e "$STATE/.ready" ]; then
    agent_ready "$PROJECT" || { log "$PROJECT: the agent is not ready; skipped"; return 0; }
    : > "$STATE/.ready"
  fi
  dispatch_tick || log "$PROJECT: tick failed; trying again next time"
}

# Agents this has started that are still on an open issue: an .agent file is
# moved aside once its issue closes -- .done when its worktree is removed or
# gone, .kept when the worktree was left to you.
working_agents() {
  local count=0 file
  for file in "${FACTORY_STATE:-$HOME/.local/state/desolate-factory}"/*/issue-*.agent; do
    [ -e "$file" ] && count=$((count + 1))
  done
  echo "$count"
}

# Every project in the stack whose name is owner/repo.
stack_projects() {
  "$CLI" desolate --status --json </dev/null \
    | jq -r '[.[] | select(.worktree == null) | .project | select(test("^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$"))] | unique | .[]'
}

dispatch_main() {
  set -euo pipefail
  [ $# -ge 1 ] || { sed -n '6,7p' "$FACTORY_LIB/gh-dispatch.sh" | sed "s/^# \{0,1\}//; s/<dispatcher>/$DISPATCHER.sh/" >&2; exit 2; }
  local ALL=""
  if [ "$1" = --all ]; then
    ALL=1; shift
  else
    PROJECT=$1; shift
    REPO=$PROJECT
    case "${1:-}" in ""|-*) ;; *) REPO=$1; shift ;; esac
    case "$REPO" in */*) ;; *) echo "$DISPATCHER: $PROJECT is no owner/repo; name its GitHub repository after it" >&2; exit 2 ;; esac
  fi
  LABEL=desolate:run INTERVAL=60 ONCE= BASE= MAX_AGENTS=3
  while [ $# -gt 0 ]; do
    case "$1" in
      --label) LABEL=${2:?}; shift 2 ;;
      --base) BASE=${2:?--base takes a branch, e.g. v2}; shift 2 ;;
      --interval) INTERVAL=${2:?}; shift 2 ;;
      --once) ONCE=1; shift ;;
      --max-agents) MAX_AGENTS=${2:?}; shift 2; case "$MAX_AGENTS" in ""|*[!0-9]*) echo "$DISPATCHER: --max-agents takes a number" >&2; exit 2 ;; esac ;;
      *) echo "$DISPATCHER: unknown option '$1'" >&2; exit 2 ;;
    esac
  done
  [ -z "$ALL" ] || [ -z "$BASE" ] || { echo "$DISPATCHER: --base is one project's; with --all, an issue's marker says it" >&2; exit 2; }
  # A ^C stops this, not half of it: `docker exec` passes no signal on, so a
  # start already under way goes on in the stack, and the next run finds it.
  trap 'echo >&2; log "stopped. A start under way goes on in the stack; the next run of this picks it up." >&2; exit 130' INT TERM
  local tool project
  for tool in gh jq; do
    command -v "$tool" >/dev/null || { echo "$DISPATCHER: needs $tool" >&2; exit 1; }
  done
  if [ -z "$ALL" ]; then
    agent_ready "$PROJECT" || { echo "$DISPATCHER: the agent is not ready" >&2; exit 1; }
    mkdir -p "${FACTORY_STATE:-$HOME/.local/state/desolate-factory}/${PROJECT//\//__}"
    : > "${FACTORY_STATE:-$HOME/.local/state/desolate-factory}/${PROJECT//\//__}/.ready"
  fi
  while :; do
    if [ -n "$ALL" ]; then
      for project in $(stack_projects); do dispatch_project "$project" "$project"; done
    else
      dispatch_project "$PROJECT" "$REPO"
    fi
    [ -z "$ONCE" ] || exit 0
    sleep "$INTERVAL"
  done
}
