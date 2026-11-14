#!/usr/bin/env bash
# suede upstream — propose a vendored dependency's local changes to the library
# upstream as a reviewable PR, without ever touching the consumed `release` branch.
#
# HOSTED implementation (serve at https://suede.sh/upstream). Normally invoked
# by the `.suede/upstream` stub shipped inside a dependency, which passes the
# dependency root as the argument. Direct use:
#     bash <(curl -fsSL https://suede.sh/upstream) <path-to-dependency>
#
# It splits the dependency's local changes via git-subrepo and pushes them to a
# deterministic branch  downstream/<owner>/<repo>-<consumer-HEAD>  on the
# dependency's remote. A GitHub Action on the dependency then rebuilds that
# branch in place as a main-shaped PR head for the maintainers to test & merge.
# `release` is never modified, and local subrepo tracking is restored so a later
# `git subrepo pull` is safe.
#
# Then, for a dependency on GitHub, it waits for that Action and prints the
# PR's link: as a draft when replaying the change onto the current release hit
# conflicts, "nothing new" when the dependency's main already has the change
# (the Action deletes the branch), or the run's link when the Action failed.
# Pass --no-wait to skip that. Through GitHub's public API; needs jq. A token
# in GH_TOKEN (or GITHUB_TOKEN) lifts the 60-requests-an-hour limit.
#
# Exit: 0 proposed (a PR is open, or there was nothing new); 1 failed; 2 pushed,
# but no PR appeared within the wait.
#
# Env: SUEDE_GITHUB_API (default https://api.github.com), SUEDE_UPSTREAM_WAIT
# seconds to wait for the PR (default 180), SUEDE_UPSTREAM_INTERVAL seconds
# between polls (default 5).

set -euo pipefail

# Keep in sync with the action's  on.push.branches: ["downstream/**"].
BRANCH_PREFIX="downstream"

die() { echo "error: $*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
usage: upstream <path-to-dependency> [-r|--remote <name>] [--no-wait]
  Proposes the dependency's local changes upstream via a PR to its `main`,
  then waits for the PR and prints its link (--no-wait: do not wait).
  The dependency's `release` branch is left untouched.
USAGE
}

DIR=""
REMOTE_OVERRIDE=""
WAIT=1
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)   usage; exit 0 ;;
    -r|--remote) REMOTE_OVERRIDE="${2:-}"; shift 2 ;;
    --no-wait)   WAIT=0; shift ;;
    -*)          die "unknown flag: $1" ;;
    *)           [ -z "$DIR" ] || die "unexpected argument: $1"; DIR="$1"; shift ;;
  esac
done

# ---- locate the dependency and its containing repo --------------------------
[ -n "$DIR" ] || { usage; exit 1; }
command -v git  >/dev/null || die "git not found"
command -v curl >/dev/null || die "curl not found"

# The `.suede/core/upstream` stub does this too, but this script is documented
# for direct use, so it cannot assume the stub ran. GIT_SUBREPO_ROOT is the
# marker left by an install whose PATH a non-interactive shell never inherited.
ensure_git_subrepo() {
  git subrepo --version >/dev/null 2>&1 && return 0
  [[ -n "${GIT_SUBREPO_ROOT-}" && -f "${GIT_SUBREPO_ROOT-}/.rc" ]] || return 1
  # `.rc` ends by sourcing a completion script written for an interactive
  # shell, so strictness comes off for the duration and the outcome is checked
  # rather than trusted.
  set +eu
  # shellcheck disable=SC1091
  source "$GIT_SUBREPO_ROOT/.rc"
  set -eu
  git subrepo --version >/dev/null 2>&1
}

ensure_git_subrepo || die "git-subrepo not installed (see suede README)"

# Physical paths (`pwd -P`): a dependency is usually reached through a symlink
# (the declaration `suede.nests.sweater-vest -> suede.nests`, or an edge), and
# `git subrepo push` on a symlink path finds no history for it and fails with
# "not a valid object name". The real folder is the subrepo.
DIRABS="$(cd "$DIR" 2>/dev/null && pwd -P)" || die "no such directory: $DIR"
TOP="$(git -C "$DIRABS" rev-parse --show-toplevel 2>/dev/null)" \
  || die "'$DIR' is not inside a git repository"
TOP="$(cd "$TOP" && pwd -P)"   # so the prefix strip below compares like with like
cd "$TOP"
RELDIR="${DIRABS#"$TOP"/}"
[ "$RELDIR" != "$DIRABS" ] || die "the dependency must live inside the repo, not at its root"
[ -f "$RELDIR/.gitrepo" ] || die "'$RELDIR' is not a subrepo (no .gitrepo file)"

# Clean tree => the restore (git reset --hard) is a safe total undo, AND keeps
# consumer-HEAD <-> dependency-state 1:1 (git subrepo push also refuses a dirty tree).
git diff --quiet && git diff --cached --quiet \
  || die "you have uncommitted changes — commit or stash them, then re-run"

# ---- deterministic branch name: <owner>/<repo>-<consumer HEAD> --------------
# Owner and repo are kept as SEPARATE, slash-separated segments (never joined
# with a dash) so the upstream workflow can recover the exact `owner/repo`: both
# segments may legitimately contain dashes, which a dash-join would make
# ambiguous. Each segment is still sanitized to stay ref- and filename-safe.
sanitize_seg() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '-' | sed -E 's/-+/-/g; s/^[-.]+//; s/[-.]+$//'
}
remote_url="$(git config --get remote.origin.url 2>/dev/null || true)"
owner=""
if [ -n "$remote_url" ]; then
  # Strip scheme / userinfo / host, leaving the owner/repo path.
  path="${remote_url%.git}"; path="${path#*://}"; path="${path#*@}"; path="${path#*[:/]}"
  repo="$(sanitize_seg "${path##*/}")"                                # last path segment
  [ "$path" = "${path#*/}" ] || owner="$(sanitize_seg "${path%%/*}")" # first segment, if a slash exists
else
  repo="$(sanitize_seg "$(basename "$TOP")")"
fi
repo="${repo:-repo}"
[ -n "$owner" ] && slug="${owner}/${repo}" || slug="$repo"

PRE="$(git rev-parse HEAD)"        # full hash; use `--short=12 HEAD` for shorter branch names
BRANCH="${BRANCH_PREFIX}/${slug}-${PRE}"

# ---- pre-flight: already proposed this exact snapshot? ----------------------
dep_remote="${REMOTE_OVERRIDE:-$(git config -f "$RELDIR/.gitrepo" subrepo.remote 2>/dev/null || true)}"
if [ -n "$dep_remote" ] && git ls-remote --heads --exit-code "$dep_remote" "$BRANCH" >/dev/null 2>&1; then
  die "this exact snapshot (commit ${PRE}) is already proposed — see the open PR for '$BRANCH'"
fi

echo "Proposing '$RELDIR' upstream -> branch '$BRANCH' ..."

# ---- push the split to the branch -------------------------------------------
# NOTE: no --https here, unlike install, diff, deps.sh and sync. Those only
# read, so a keyless machine can fall back to HTTPS for anything public; this
# writes, and the only credential it assumes is the SSH key behind the remote
# the .gitrepo records (or -r). Pushing from a keyless environment - a CI
# runner holding a GitHub token, say - is not supported yet. Enabling it would
# mean pushing to the HTTPS spelling with the token supplied (an insteadOf rule
# carrying it, or passing that URL as -r), and checking that git subrepo push
# picks the credential up in both the `ls-remote` pre-flight above and the
# push below.
# No --update: the tracked (pull) branch in .gitrepo stays = release. subrepo
# still makes a local 'finalize' commit + bumps .gitrepo's commit field; we undo
# both below so the tracking pointer keeps referencing `release`.
push_args=(push "$RELDIR" -b "$BRANCH")
[ -n "$REMOTE_OVERRIDE" ] && push_args+=(-r "$REMOTE_OVERRIDE")
git subrepo "${push_args[@]}" \
  || die "subrepo push failed — no write access, or your subdir isn't merged with upstream HEAD"

# ---- restore local state ----------------------------------------------------
git reset --hard "$PRE" >/dev/null

cat <<MSG

OK Proposed upstream. Local state restored — safe to 'git subrepo pull' anytime.

  - A PR against the dependency's 'main' opens automatically (branch: $BRANCH).
  - The maintainers own that branch from here: they may test and push to it.
  - Further local changes become a NEW snapshot/branch/PR (one-off per commit).
  - The 'release' branch was NOT modified; other consumers are unaffected.
MSG

# ---- wait for the PR --------------------------------------------------------
[ "$WAIT" = 1 ] || exit 0

API="${SUEDE_GITHUB_API:-https://api.github.com}"
WAIT_FOR="${SUEDE_UPSTREAM_WAIT:-180}"
INTERVAL="${SUEDE_UPSTREAM_INTERVAL:-5}"

github_slug() { # <url> -> owner/name, or nothing for a remote not on GitHub
  local rest
  case "$1" in
    https://github.com/*|http://github.com/*) rest="${1#*github.com/}" ;;
    git@github.com:*)                         rest="${1#git@github.com:}" ;;
    ssh://git@github.com/*)                   rest="${1#ssh://git@github.com/}" ;;
    *) return 1 ;;
  esac
  rest="${rest%/}"; rest="${rest%.git}"
  printf '%s' "$rest"
}

api() { # <path>
  local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}" auth=()
  [ -n "$token" ] && auth=(-H "Authorization: Bearer $token")
  curl -fsSL -H "Accept: application/vnd.github+json" ${auth[@]+"${auth[@]}"} "$API/$1"
}

if ! dep_slug="$(github_slug "$dep_remote")"; then
  echo
  echo "($dep_remote is not on GitHub, so there is no PR to wait for: the branch is $BRANCH)"
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  echo
  echo "(install jq to have upstream wait for the PR and print its link: https://github.com/$dep_slug/pulls)"
  exit 0
fi

echo
echo "Waiting for the PR (up to ${WAIT_FOR}s; --no-wait skips this) ..."
dep_owner="${dep_slug%%/*}"
deadline=$((SECONDS + WAIT_FOR))
while :; do
  pr="$(api "repos/$dep_slug/pulls?head=$dep_owner:$BRANCH&state=all&per_page=1" 2>/dev/null | jq -c '.[0] // empty' 2>/dev/null || true)"
  if [ -n "$pr" ]; then
    if [ "$(jq -r '.draft' <<<"$pr")" = true ]; then
      echo "PR opened as a draft: replaying your change onto the current release hit conflicts,"
      echo "which are left as markers for the maintainers to resolve."
    else
      echo "PR opened:"
    fi
    echo "  $(jq -r '.html_url' <<<"$pr")"
    exit 0
  fi
  run="$(api "repos/$dep_slug/actions/runs?branch=$BRANCH&per_page=1" 2>/dev/null | jq -c '.workflow_runs[0] // empty' 2>/dev/null || true)"
  if [ -n "$run" ] && [ "$(jq -r '.status' <<<"$run")" = completed ]; then
    if [ "$(jq -r '.conclusion' <<<"$run")" != success ]; then
      echo "The Action that opens the PR ended: $(jq -r '.conclusion' <<<"$run")"
      echo "  $(jq -r '.html_url' <<<"$run")"
      exit 1
    fi
    # It succeeded without a PR: either the branch had nothing new and the
    # Action deleted it, or the PR is a moment from showing in the API.
    if ! git ls-remote --heads --exit-code "$dep_remote" "$BRANCH" >/dev/null 2>&1; then
      echo "Nothing new to propose: the dependency's main already has this change, so the"
      echo "Action removed the branch and opened no PR."
      exit 0
    fi
  fi
  [ "$SECONDS" -lt "$deadline" ] || break
  sleep "$INTERVAL"
done
echo "No PR after ${WAIT_FOR}s. Follow the Action at https://github.com/$dep_slug/actions (branch: $BRANCH)."
exit 2
