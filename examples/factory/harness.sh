#!/usr/bin/env bash
# examples/factory/harness.sh -- a software factory ON desolate, as a sketch.
#
#   examples/factory/harness.sh <project> <owner/repo> <clone> [--label L] [--interval S] [--once]
#
# Runs on your Mac, with YOUR gh login and git credentials; desolate holds
# neither. Each tick, for every open issue labelled L (default desolate:run):
#
#   1. no worktree issue-<n> yet: `cli.sh worktree add`, on branch issue/<n>;
#   2. not running: start it;
#   3. no agent started here yet: start one with the issue as its task and
#      desolate-status as its voice -- Claude Code in a tmux session, on your
#      subscription (claude-harness.sh), unless FACTORY_AGENT names another;
#   4. its status (`cli.sh desolate --status --json`):
#        orange, red -- a comment on the issue, once per status;
#        green       -- `cli.sh bundle` its branch, push it from <clone> (never
#                       to the default branch, never forced), open a draft PR.
#
# and for every worktree it started whose issue is no longer open: stop it and
# `cli.sh worktree remove` it, which refuses one holding uncommitted work.
#
# A status is the agent's claim (docs/agents.md): this pushes what the bundle
# holds, and a human reviews the draft. Read it, change it; it is yours.
#
# Environment:
#   DESOLATE_CLI         path to cli.sh (default: the one beside this checkout)
#   FACTORY_AGENT        instead of claude-harness.sh: a command `cli.sh exec`
#                        runs in the background, words split on spaces; the
#                        task is its last argument (e.g. "claude -p")
#   FACTORY_STATE        where it remembers what it did
#                        (default: ~/.local/state/desolate-factory)
set -euo pipefail

usage() { sed -n '4p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
[ $# -ge 3 ] || usage
PROJECT=$1 REPO=$2 CLONE=$3; shift 3
LABEL=desolate:run INTERVAL=60 ONCE=
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL=${2:?}; shift 2 ;;
    --interval) INTERVAL=${2:?}; shift 2 ;;
    --once) ONCE=1; shift ;;
    *) usage ;;
  esac
done

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI=${DESOLATE_CLI:-$HERE/../../release/cli.sh}
AGENT=()
[ -z "${FACTORY_AGENT:-}" ] || read -r -a AGENT <<< "$FACTORY_AGENT"
STATE=${FACTORY_STATE:-$HOME/.local/state/desolate-factory}/${PROJECT//\//__}
mkdir -p "$STATE"
for tool in gh git jq; do
  command -v "$tool" >/dev/null || { echo "harness: needs $tool" >&2; exit 1; }
done
git -C "$CLONE" rev-parse --git-dir >/dev/null || { echo "harness: $CLONE is not a git clone" >&2; exit 1; }
# Claude's token in the VM before anything starts (it asks, the first time).
[ ${#AGENT[@]} -gt 0 ] || "$HERE/claude-harness.sh" auth "$PROJECT"
DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name)

log() { printf '%s harness: %s\n' "$(date +%H:%M:%S)" "$*"; }

task() { # <n> <title> <body>
  cat <<EOF
You are working on GitHub issue #$1 of $REPO, in a desolate worktree on branch issue/$1.

Title: $2

$3

Say how it is going with /desolate-ca/desolate-status; a human sees it beside this worktree:
  set blue "<what you are doing>" while working;
  set orange "<your question>" when you need a human, then stop;
  set red "<what failed>" when you cannot go on (authentication failing, say);
  set green "<one line for the PR>" when the work is committed on issue/$1.
Commit your work; do not push. A human pushes and opens the PR.
EOF
}

tick() {
  local issues statuses running
  issues=$(gh issue list -R "$REPO" --label "$LABEL" --state open --limit 100 --json number,title,body)
  statuses=$("$CLI" desolate --status --json "$PROJECT")
  running=$("$CLI" desolate --list --json | sed -n '/^\[/p' | tail -n 1)

  local n title body name row color message updated
  while IFS= read -r issue; do
    n=$(jq -r .number <<< "$issue"); title=$(jq -r .title <<< "$issue"); body=$(jq -r .body <<< "$issue")
    name=issue-$n

    if ! jq -e --arg w "$name" 'any(.[]; .worktree == $w)' <<< "$statuses" >/dev/null; then
      log "#$n: a worktree"
      "$CLI" worktree add "$PROJECT" "$name" "issue/$n" || { log "#$n: worktree add failed"; continue; }
    fi
    if ! jq -e --arg w "$name" 'any(.[]?; .worktree == $w)' <<< "${running:-[]}" >/dev/null; then
      log "#$n: starting it"
      "$CLI" desolate "$PROJECT" --worktree "$name" </dev/null || { log "#$n: start failed"; continue; }
    fi
    if [ ! -e "$STATE/$name.agent" ]; then
      log "#$n: an agent"
      if [ ${#AGENT[@]} -gt 0 ]; then
        nohup "$CLI" exec "$PROJECT" --worktree "$name" -- "${AGENT[@]}" "$(task "$n" "$title" "$body")" \
          </dev/null > "$STATE/$name.log" 2>&1 &
      elif ! "$HERE/claude-harness.sh" start "$PROJECT" --worktree "$name" --task "$(task "$n" "$title" "$body")" \
          </dev/null > "$STATE/$name.log" 2>&1; then
        log "#$n: claude did not start ($(tail -n 1 "$STATE/$name.log")); trying again next tick"
        continue
      fi
      date -u +%FT%TZ > "$STATE/$name.agent"
      continue
    fi

    row=$(jq -c --arg w "$name" '.[] | select(.worktree == $w) | .status // empty' <<< "$statuses")
    [ -n "$row" ] || continue
    color=$(jq -r .color <<< "$row"); message=$(jq -r .message <<< "$row"); updated=$(jq -r .updated <<< "$row")
    case "$color" in
      orange|red)
        [ "$(cat "$STATE/$name.told" 2>/dev/null)" = "$updated" ] && continue
        gh issue comment "$n" -R "$REPO" --body "desolate: **$color** -- $message" >/dev/null
        echo "$updated" > "$STATE/$name.told"
        log "#$n: $color, said on the issue" ;;
      green)
        [ -e "$STATE/$name.pr" ] || pull_request "$n" "$name" "$title" "$message" ;;
    esac
  done < <(jq -c '.[]' <<< "$issues")

  # Worktrees this harness started, for issues no longer open: done with.
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

pull_request() { # <n> <name> <title> <message>
  local n=$1 name=$2 title=$3 message=$4 tmp out branch commit
  tmp=$(mktemp -d)
  out=$("$CLI" bundle "$PROJECT" --worktree "$name" "$tmp/branch.bundle") || { log "#$n: bundle failed"; rm -rf "$tmp"; return; }
  # cli.sh: <branch> at <commit> -> <file>
  read -r _ branch _ commit _ <<< "$(printf '%s\n' "$out" | grep '^cli.sh: ')"
  if [ -z "$branch" ] || [ "$branch" = "$DEFAULT_BRANCH" ]; then
    log "#$n: refusing to push '${branch:-?}'"; rm -rf "$tmp"; return
  fi
  git -C "$CLONE" fetch --quiet "$tmp/branch.bundle" "refs/heads/$branch"
  [ "$(git -C "$CLONE" rev-parse FETCH_HEAD)" = "$commit" ] || { log "#$n: the bundle is not what it said"; rm -rf "$tmp"; return; }
  git -C "$CLONE" push --quiet origin "$commit:refs/heads/$branch"
  rm -rf "$tmp"
  gh pr create -R "$REPO" --draft --head "$branch" --base "$DEFAULT_BRANCH" \
    --title "$title" --body "$message

Closes #$n" > "$STATE/$name.pr"
  log "#$n: draft PR $(cat "$STATE/$name.pr")"
}

while :; do
  tick || log "tick failed; trying again next time"
  [ -z "$ONCE" ] || exit 0
  sleep "$INTERVAL"
done
