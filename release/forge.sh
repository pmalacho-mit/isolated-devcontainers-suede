#!/usr/bin/env bash
# forge.sh -- a factory's GitHub side, run on the Mac with your own `gh`.
#
#   ./cli.sh forge add <project> <owner/repo> [--label desolate:run]
#   ./cli.sh forge run [--interval 60] [--once] [--no-comments]
#   ./cli.sh forge status <project>
#
# The factory's `github` adapter never reaches GitHub (work-forge.ts). This
# does, as you: it polls each enabled project's repository for open issues
# carrying the label, and hands the editor what it saw -- through `work github
# <project> sync`, in the editor container, as data on stdin. The editor turns
# new issues into `open` requests (worktree `issue-<n>`), and the watcher opens
# them; a project's main tree sees each on refs/desolate/* the moment it is
# running, and the requests wait for it if it is not. Back out, for every
# branch desolate reports pushed, this opens a draft PR that closes its issue,
# comments on the issue as the work moves, and once the PR is merged or closed
# -- or the issue is -- tells the editor, which asks for the worktree's close.
#
# So no forge token is ever in the VM, the proxy or a container: gh's
# credentials stay in your keychain, and every call is yours. It works while
# this runs; nothing is lost while it does not.
#
# Polling, not webhooks: a webhook needs something to receive it, and the only
# thing this stack listens on is loopback.
set -euo pipefail

EDITOR_CONTAINER=${DESOLATE_EDITOR_CONTAINER:-desolate-vscode}
STATE_DIR=${DESOLATE_FORGE_STATE:-$HOME/.local/state/desolate-forge}

die() { echo "forge: $*" >&2; exit 1; }
say() { echo "forge: $*"; }

# The editor's `work`. Only `sync` reads stdin; everything else gets none, or
# `docker exec -i` would swallow the rest of the loop it is called from.
work() { docker exec -e DESOLATE_PLANE=mac "$EDITOR_CONTAINER" work "$@" </dev/null; }
work_with_input() { docker exec -i -e DESOLATE_PLANE=mac "$EDITOR_CONTAINER" work "$@"; }
# gh, never reading the loop's stdin either. A failure is the caller's to
# handle: under `set -e` one failed call must not end the agent.
ghq() { gh "$@" </dev/null; }

need_gh() {
  command -v gh >/dev/null 2>&1 || die "gh is not installed (brew install gh)"
  gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
}

valid_number() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; }
valid_branch() { case "$1" in ''|*[!A-Za-z0-9._/-]*|-*) return 1 ;; esac; }
valid_pr() { case "$1" in -|https://github.com/*/pull/[1-9]*) return 0 ;; esac; return 1; }

# Said once per issue and state: a marker per comment, so a restart does not
# say it all again.
comment_once() {  # <project> <repo> <number> <state> <body>
  local marker="$STATE_DIR/${1//\//__}/$3.$4"
  [ -e "$marker" ] && return 0
  if ghq issue comment "$3" -R "$2" --body "$5" >/dev/null; then
    mkdir -p "$(dirname "$marker")" && : > "$marker"
  else
    say "$1: could not comment on $2#$3 (it will be tried again)"
  fi
}

tick_project() {  # <project> <repo> <label>
  local project=$1 repo=$2 label=$3 status open_json open_numbers finished="" line
  status=$(work github "$project" status) || { say "$project: the editor did not answer"; return 0; }
  open_json=$(ghq issue list -R "$repo" --label "$label" --state open --limit 200 --json number,title \
                --jq '[.[] | {number, title}]') || { say "$project: could not list $repo's issues"; return 0; }
  open_numbers=$(ghq issue list -R "$repo" --label "$label" --state open --limit 200 --json number --jq '.[].number') \
    || { say "$project: could not list $repo's issues"; return 0; }
  open_numbers=" $(printf '%s' "$open_numbers" | tr '\n' ' ') "

  # What is over at the forge: a closed issue -- whatever its PR is doing --
  # or a merged or closed PR. An issue that only lost its label is still open,
  # and its work goes on.
  while IFS=$'\t' read -r number worktree branch state pr; do
    valid_number "$number" && valid_branch "$branch" && valid_pr "$pr" || continue
    case "$state" in merged|closed) continue ;; esac
    case "$open_numbers" in
      *" $number "*) ;;
      *) if [ "$(ghq issue view "$number" -R "$repo" --json state --jq .state 2>/dev/null || true)" = CLOSED ]; then
           finished="$finished${finished:+,}$number"; continue
         fi ;;
    esac
    if [ "$pr" != - ]; then
      case "$(ghq pr view "$pr" --json state --jq .state 2>/dev/null || true)" in
        MERGED|CLOSED) finished="$finished${finished:+,}$number" ;;
      esac
    fi
  done <<EOF
$status
EOF
  printf '{"open":%s,"finished":[%s]}' "$open_json" "$finished" | work_with_input github "$project" sync >/dev/null \
    || { say "$project: the editor refused the snapshot"; return 0; }

  # A pushed branch gets its draft PR -- one, found again rather than made twice.
  local base=""
  while IFS=$'\t' read -r number worktree branch state pr; do
    valid_number "$number" && valid_branch "$branch" && valid_pr "$pr" || continue
    if [ "$state" = pushed ] && [ "$pr" = - ]; then
      [ -n "$base" ] || base=$(ghq repo view "$repo" --json defaultBranchRef --jq .defaultBranchRef.name) || base=""
      pr=$(ghq pr list -R "$repo" --head "$branch" --state all --json url --jq '.[0].url // empty') || pr=""
      if [ -z "$pr" ] && [ -n "$base" ]; then
        title=$(ghq issue view "$number" -R "$repo" --json title --jq .title) || title="issue #$number"
        pr=$(ghq pr create -R "$repo" --draft --head "$branch" --base "$base" --title "$title" \
               --body "$(printf 'Opened by the desolate factory from worktree `%s`.\n\nCloses #%s' "$worktree" "$number")") || pr=""
        pr=$(printf '%s\n' "$pr" | tail -n 1)
      fi
      if valid_pr "$pr" && work github "$project" pr "$number" "$pr" >/dev/null; then
        say "$project: #$number -> $pr"
      else
        say "$project: could not record a PR for #$number"
      fi
    fi
    [ -n "$COMMENTS" ] || continue
    case "$state" in
      opened)  comment_once "$project" "$repo" "$number" opened \
                 "desolate opened worktree \`$worktree\` for this issue, on branch \`$branch\`." ;;
      refused|failed)
               comment_once "$project" "$repo" "$number" "$state" \
                 "desolate did not open a worktree for this issue ($state). \`./cli.sh work requests $project\` says why." ;;
      closed)  comment_once "$project" "$repo" "$number" closed \
                 "desolate closed worktree \`$worktree\`." ;;
    esac
  done <<EOF
$status
EOF
}

tick_all() {
  local projects
  projects=$(work github-projects) || { say "the editor did not answer; is the stack up?"; return 0; }
  while IFS=$'\t' read -r project repo label; do
    [ -n "$project" ] || continue
    tick_project "$project" "$repo" "$label" || say "$project: this tick failed; the next one tries again"
  done <<EOF
$projects
EOF
}

COMMENTS=1
case "${1:-}" in
  add)
    project=${2:?usage: forge add <project> <owner/repo> [--label l]}
    repo=${3:?usage: forge add <project> <owner/repo> [--label l]}
    label=desolate:run
    [ "${4:-}" = --label ] && label=${5:?--label takes a name}
    need_gh
    ghq repo view "$repo" --json nameWithOwner >/dev/null 2>&1 || die "gh cannot see $repo"
    ghq label create "$label" -R "$repo" --color 5319e7 \
      --description "desolate: work this issue in a factory worktree" >/dev/null 2>&1 || true
    work github "$project" enable "$repo" --label "$label"
    say "now run: ./cli.sh forge run   (and label an issue '$label' in $repo)" ;;
  run)
    shift
    interval=60 once=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --interval)    interval=${2:?--interval takes seconds}; shift 2 ;;
        --once)        once=1; shift ;;
        --no-comments) COMMENTS=""; shift ;;
        *) die "unknown option '$1'" ;;
      esac
    done
    valid_number "$interval" && [ "$interval" -ge 10 ] || die "--interval is at least 10 seconds"
    need_gh
    while :; do
      tick_all
      [ -n "$once" ] && break
      sleep "$interval"
    done ;;
  status)
    project=${2:?usage: forge status <project>}
    printf 'issue\tworktree\tbranch\tstate\tpr\n'
    work github "$project" status ;;
  *)
    sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
    exit 2 ;;
esac
