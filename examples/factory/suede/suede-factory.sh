#!/usr/bin/env bash
# examples/factory/suede/suede-factory.sh -- suede upstreaming and syncing, automated.
#
#   suede-factory.sh run [--interval S] [--once] [--dry-run] [--sync proposers|all|none]
#   suede-factory.sh sync [--dry-run] (<consumer>... | --all) [--dep <owner/repo>]...
#   suede-factory.sh approve <owner/repo>
#   suede-factory.sh status
#
# Runs on your Mac, with your gh, polling (docs/suede-factory.md). It never
# starts an agent: it files issues that claude-dispatcher.sh --all picks up.
# Run both. Each tick, for every project in the stack:
#
#   1. Its main moved: refresh origin/*, report its suede dependencies at
#      origin/<main> (`cli.sh deps report`), delivering any whose history the
#      project lacks. A dependency not in the stack is asked about once
#      (`approve` adds it with `cli.sh repo add`).
#   2. A dependency whose folder differs from its pin, unless that exact change
#      (its patch-id) is already proposed: `cli.sh deps upstream` pushes it as
#      suede's downstream/<consumer>-<commit> branch, and suede's own workflow
#      in the dependency opens the PR.
#   3. That PR appeared: an issue in the dependency, for an agent to decide
#      whether and how to integrate it -- how pressing, by how the consumer uses
#      it -- and the PR is edited to close it. A proposal it replaces (the same
#      consumer and folder, a different change) has its PR and issue closed,
#      and the commits added there are listed for the agent to carry over.
#   4. A dependency released: an issue to sync it, for the consumers whose
#      proposal was merged into that release and those blocked on it (a release
#      dependency whose copy still differs) -- release dependencies first --
#      with the release delivered, so the sync needs no network. `--sync all`:
#      every consumer whose pin is behind; `--sync none`: no syncs on a release.
#
# `sync` asks for syncs by hand, through the same issues: each consumer named
# (or --all: every project in the stack) is looked at now, and every suede
# dependency of its that is behind its release -- or only those --dep names --
# gets an issue for an agent. So:
#   sync acme/app --dep acme/widget             one consumer, one dependency
#   sync acme/app                               one consumer, all of them
#   sync acme/app acme/lib --dep acme/widget    several consumers, one dependency
#   sync --all --dep acme/widget                everywhere, one dependency
#   sync --all                                  everywhere, everything
#
# What it changes on GitHub: downstream/* branches (through desolate), issues,
# labels, PR descriptions, and closing what a new proposal replaces. Merging is
# always yours. --dry-run changes nothing there: it says what it would do.
#
# State: on GitHub, as markers in the issues it files; locally only what it has
# seen and asked (SUEDE_FACTORY_STATE, default ~/.local/state/suede-factory).
#
# Environment: DESOLATE_CLI (path to cli.sh; default: this checkout's).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI=${DESOLATE_CLI:-$HERE/../../../release/cli.sh}
STATE=${SUEDE_FACTORY_STATE:-$HOME/.local/state/suede-factory}
ME=suede-factory
UPSTREAM_LABEL=suede:upstream SYNC_LABEL=suede:sync DISPATCH_LABEL=desolate:run

# To stderr: some functions print data (a report) that callers capture.
log() { printf '%s %s: %s\n' "$(date +%H:%M:%S)" "$ME" "$*" >&2; }
notify() {
  log "$*"
  printf '\a' >&2
  if command -v osascript >/dev/null; then
    osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "suede factory"' -e 'end run' "$*" >/dev/null 2>&1 || true
  fi
}
usage() { sed -n '4,7p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

# --- state ---------------------------------------------------------------
tag_of() { printf '%s' "${1//\//__}"; }
get() { cat "$STATE/$1" 2>/dev/null || true; }
put() { mkdir -p "$(dirname "$STATE/$1")"; printf '%s\n' "$2" > "$STATE/$1"; }

# A GitHub write: done, or in --dry-run only said.
write() {
  if [ -n "$DRY" ]; then log "would: $*"; return 0; fi
  "$@"
}

# --- the stack and its dependencies ----------------------------------------
stack_projects() {
  "$CLI" desolate --status --json </dev/null \
    | jq -r '[.[] | select(.worktree == null) | .project | select(test("^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$"))] | unique | .[]'
}
in_stack() { printf '%s\n' "$PROJECTS" | grep -qxF "$1"; }

# 0 when <dependency> is in the stack -- added now, if you approved it before.
ensure_dependency() { # <dependency> <consumer>
  in_stack "$1" && return 0
  if grep -qxF "$1" "$STATE/approved" 2>/dev/null; then
    [ -z "$DRY" ] || { log "would: add $1 to the stack (approved)"; return 1; }
    log "$1: approved; adding it to the stack"
    "$CLI" repo add "$1" </dev/null || { log "$1: repo add failed; trying again next tick"; return 1; }
    PROJECTS=$(stack_projects)
    return 0
  fi
  if ! grep -qxF "$1" "$STATE/asked" 2>/dev/null; then
    notify "$1, a suede dependency of $2, is not in the stack. To include it (it is cloned, and given a write deploy key): $0 approve $1"
    mkdir -p "$STATE"; echo "$1" >> "$STATE/asked"
  fi
  return 1
}

default_branch() { # <repo>
  local cached; cached=$(get "default/$(tag_of "$1")")
  [ -n "$cached" ] || { cached=$(gh repo view "$1" --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null) || return 1; put "default/$(tag_of "$1")" "$cached"; }
  printf '%s' "$cached"
}
head_of() { gh api "repos/$1/commits/$2" --jq .sha 2>/dev/null; }   # <repo> <ref>

report() { "$CLI" deps report "$1" --ref "$2" </dev/null | sed -n 's/^DEPS //p' | tail -n 1; }   # <project> <ref>

# The markers in issues this files: `suede-factory` is ours; `desolate-dispatch`
# is the dispatcher's (lib/gh-dispatch.sh).
marked_issues() { # <repo> <label> <state> -> [{number, url, marker}]
  gh issue list -R "$1" --label "$2" --state "$3" --limit 200 --json number,url,body 2>/dev/null \
    | jq -c '[.[] | {number, url, marker: ((.body // "") | capture("<!-- suede-factory: (?<m>\\{.*\\}) -->").m? // empty | fromjson? // empty)} | select(.marker != null)]'
}

ensure_labels() { # <repo>
  [ -n "$DRY" ] && return 0
  [ -e "$STATE/labels/$(tag_of "$1")" ] && return 0
  gh label create "$DISPATCH_LABEL" -R "$1" --color 5319e7 --description "desolate: an agent works on this" >/dev/null 2>&1 || true
  gh label create "$UPSTREAM_LABEL" -R "$1" --color 0e8a16 --description "suede: a consumer's changes, proposed upstream" >/dev/null 2>&1 || true
  gh label create "$SYNC_LABEL" -R "$1" --color 1d76db --description "suede: sync a dependency to its latest release" >/dev/null 2>&1 || true
  put "labels/$(tag_of "$1")" ok
}

# --- looking at a consumer ---------------------------------------------------
# Its suede dependencies at origin/<main>, now: origin/* refreshed (fetch only),
# history it lacks delivered for what is in the stack, the report kept for the
# release side. Prints the report; returns 1 when there is none, 2 when it is
# complete only for what is in the stack.
fresh_report() { # <project> <main>
  local project=$1 main=$2 rep dep delivered="" complete=0
  "$CLI" pull "$project" --fetch-only </dev/null >/dev/null || { log "$project: could not refresh origin/*"; return 1; }
  rep=$(report "$project" "origin/$main")
  [ -n "$rep" ] || { log "$project: no report from its sandbox"; return 1; }
  for dep in $(jq -r '.dependencies[] | select(.state == "nopin") | .repo // empty' <<< "$rep" | sort -u); do
    ensure_dependency "$dep" "$project" || { complete=2; continue; }
    "$CLI" deps deliver "$project" "$dep" </dev/null >/dev/null && delivered=1 || { log "$project: could not deliver $dep"; complete=2; }
  done
  [ -z "$delivered" ] || rep=$(report "$project" "origin/$main")
  [ -n "$rep" ] || return 1
  put "deps/$(tag_of "$project").json" "$rep"
  printf '%s\n' "$rep"
  return "$complete"
}

# --- 1 and 2: a consumer's main moved --------------------------------------
consumer_tick() { # <project>
  local project=$1 main head seen rep ok=1 dependency code=0
  main=$(default_branch "$project") || { log "$project: not reachable with gh; skipped"; return 0; }
  head=$(head_of "$project" "$main") || { log "$project: could not read $main's head"; return 0; }
  seen=$(get "heads/$(tag_of "$project").main")
  [ "$head" != "$seen" ] || return 0
  log "$project: $main is at ${head:0:12}; looking at its suede dependencies"
  rep=$(fresh_report "$project" "$main") || code=$?
  [ "$code" -ne 1 ] || return 0
  [ "$code" -eq 0 ] || ok=""
  while IFS= read -r dependency; do
    propose "$project" "$main" "$dependency" || ok=""
  done < <(jq -c '.dependencies[] | select(.state == "diff" and .repo != null)' <<< "$rep")
  # Seen only once everything it called for was done: otherwise next tick retries.
  [ -z "$ok" ] || [ -n "$DRY" ] || put "heads/$(tag_of "$project").main" "$head"
}

propose() { # <consumer> <main> <dependency report>
  local consumer=$1 main=$2 d=$3 dep dir patch open same pending out branch
  dep=$(jq -r .repo <<< "$d"); dir=$(jq -r .dir <<< "$d"); patch=$(jq -r .patch <<< "$d")
  ensure_dependency "$dep" "$consumer" || return 1
  # Already proposed, the same change: open, or pushed and waiting for its PR.
  open=$(marked_issues "$dep" "$UPSTREAM_LABEL" open | jq -c --arg c "$consumer" --arg d "$dir" '[.[] | select(.marker.consumer == $c and .marker.dir == $d)]')
  same=$(jq -r --arg p "$patch" '[.[] | select(.marker.patch == $p)][0].url // empty' <<< "$open")
  [ -z "$same" ] || { log "$consumer: $dir's change is already proposed ($same)"; return 0; }
  for pending in "$STATE/pending/$(tag_of "$dep")"/*.json; do
    [ -e "$pending" ] || continue
    jq -e --arg c "$consumer" --arg d "$dir" --arg p "$patch" '.consumer == $c and .dir == $d and .patch == $p' "$pending" >/dev/null && return 0
  done
  if [ -n "$DRY" ]; then
    log "would: propose $consumer's changes to $dir upstream to $dep ($(jq -r '.files | length' <<< "$d") file(s))"
    return 0
  fi
  out=$("$CLI" deps upstream "$consumer" "$dir" --ref "origin/$main" </dev/null 2>&1) || { log "$consumer: proposing $dir failed: $(printf '%s' "$out" | tail -n 1)"; return 1; }
  branch=$(printf '%s\n' "$out" | sed -n 's/^UPSTREAMED [^ ]* \([^ ]*\) .*/\1/p')
  [ -n "$branch" ] || { log "$consumer: $dir has nothing to propose"; return 0; }
  log "$consumer: proposed $dir to $dep as $branch"
  put "pending/$(tag_of "$dep")/$(printf '%s' "$branch" | tr '/' '_').json" "$(jq -cn \
    --arg dep "$dep" --arg branch "$branch" --arg consumer "$consumer" --arg dir "$dir" --argjson d "$d" \
    --argjson supersedes "$(jq -c '[.[] | {issue: .number, pr: .marker.pr, branch: .marker.branch}]' <<< "$open")" \
    --arg at "$(date -u +%s)" \
    '{dep: $dep, branch: $branch, consumer: $consumer, dir: $dir, kind: $d.kind, patch: $d.patch, pin: $d.pin, files: $d.files, supersedes: $supersedes, at: ($at | tonumber)}')"
}

# --- 3: the PR suede's workflow opened --------------------------------------
pending_tick() { # <dependency>
  local dep=$1 file branch pr
  for file in "$STATE/pending/$(tag_of "$dep")"/*.json; do
    [ -e "$file" ] || continue
    branch=$(jq -r .branch "$file")
    pr=$(gh pr list -R "$dep" --head "$branch" --state all --json number,state,url,title,body --jq '.[0] // empty' 2>/dev/null || true)
    if [ -z "$pr" ]; then
      if ! gh api "repos/$dep/branches/$branch" --silent 2>/dev/null \
         && [ $(( $(date -u +%s) - $(jq -r .at "$file") )) -gt 600 ]; then
        log "$dep: suede removed $branch and opened no PR -- its main already has that change"
        rm -f "$file"
      fi
      continue
    fi
    file_upstream_issue "$file" "$pr" && rm -f "$file"
  done
}

kind_text() { # <kind> <consumer> <dependency>
  case "$1" in
    release) printf '%s' "**Blocking.** $2 is itself a suede dependency and ships $3 as a *release dependency*, so it cannot publish while its copy differs from a release of $3. Find a way to integrate these changes -- adapted where they need to be -- so $2 can sync to a release that has them, and publish." ;;
    vendored) printf '%s' "$2 vendors $3 inside its own \`release/\`, so it ships this changed copy as source. Integrating the changes lets $2 stop carrying a fork. Not blocking." ;;
    *) printf '%s' "These changes were useful to $2. They may help other consumers of $3, now or later -- or they may not. That is for you to decide: whether they, or a reworked version of them, belong in $3. Concluding they do not is a fine outcome: finish with \`gray \"withdrawn: <why>\"\`." ;;
  esac
}

# The issue's text. Printed by a function rather than built in $( ) around a
# heredoc: bash 3.2 (macOS's) misreads an apostrophe in a heredoc there.
upstream_body() {
  cat <<EOF
## Upstream from $consumer: should these changes to $dep be integrated?

$consumer changed its copy of $dep (its folder \`$dir\`, pinned at \`$pin_short\`). desolate proposed those changes as #$number (branch \`$branch\`), which suede rebuilt on top of \`main\`.

**How $consumer uses $dep:** $(kind_text "$kind" "$consumer" "$dep")

**Files changed:**
$files_list

### The PR's description
$pr_quoted
$carry_section$others_section
### What to do
- You are on \`$branch\`, the branch of #$number. Commit there; do not push -- a human pushes it to the PR, and merges.
- Run $dep's tests.
- Finish with \`green "<one line for the PR>"\` when it is ready to merge, or \`gray "withdrawn: <why>"\` if it should not be.

<!-- desolate-dispatch: $dispatch -->
<!-- suede-factory: $factory -->
EOF
}

file_upstream_issue() { # <pending file> <pr json>
  local file=$1 pr=$2 dep consumer dir kind branch number url others carry="" body issue old
  dep=$(jq -r .dep "$file"); consumer=$(jq -r .consumer "$file"); dir=$(jq -r .dir "$file")
  kind=$(jq -r .kind "$file"); branch=$(jq -r .branch "$file")
  number=$(jq -r .number <<< "$pr"); url=$(jq -r .url <<< "$pr")
  others=$(gh pr list -R "$dep" --state open --json number,title,headRefName,url \
    --jq "[.[] | select((.headRefName | startswith(\"downstream/\")) and .number != $number)] | map(\"- #\(.number) \(.title) (\`\(.headRefName)\`)\") | join(\"\n\")" 2>/dev/null || true)
  # What this replaces: its PR closed, its issue closed, its later commits carried.
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    local old_pr old_issue old_branch commits
    old_pr=$(jq -r '.pr // empty' <<< "$old"); old_issue=$(jq -r .issue <<< "$old"); old_branch=$(jq -r '.branch // empty' <<< "$old")
    commits=$( [ -n "$old_pr" ] && gh api "repos/$dep/pulls/$old_pr/commits" --jq '.[1:] | .[] | "  - \(.sha[0:12]) \(.commit.message | split("\n")[0]) (\(.commit.author.name))"' 2>/dev/null || true)
    if [ -n "$commits" ]; then
      carry="$carry
- PR #$old_pr (\`$old_branch\`), issue #$old_issue. Commits added there after the proposal -- look at them (\`git log origin/main..origin/$old_branch\`) and carry over what still applies:
$commits"
    else
      carry="$carry
- PR #$old_pr (\`$old_branch\`), issue #$old_issue. Nothing was added there after the proposal."
    fi
  done < <(jq -c '.supersedes[]?' "$file")
  local pin_short files_list pr_quoted carry_section="" others_section="" dispatch factory
  pin_short=$(jq -r '.pin[0:12]' "$file")
  files_list=$(jq -r '.files[] | "- `\(.status)` \(.path)"' "$file")
  pr_quoted=$(jq -r '.body // ""' <<< "$pr" | sed 's/^/> /')
  [ -z "$carry" ] || carry_section="
### Carry these forward: proposals this replaces
The same consumer and folder, an older change. They are closed now; their branches are kept.$carry
"
  [ -z "$others" ] || others_section="
### Other proposals into $dep right now
Other agents may be working on them in this repository, each in its own worktree. Read \`/desolate/status board\` when you start and before you finish, and leave a \`/desolate/status note\` when they should know something. One branch carrying another's change is a fine outcome: agree it in your notes, and the one that hands its change over finishes \`gray \"withdrawn: carried by <worktree>\"\`.
$others
"
  dispatch=$(jq -cn --arg b "$branch" --argjson n "$number" '{branch: $b, start: ("origin/" + $b), fetch: true, pr: $n}')
  factory=$(jq -c --argjson n "$number" '{kind: "upstream", consumer, dir, patch, pr: $n, branch}' "$file")
  body=$(upstream_body)
  if [ -n "$DRY" ]; then log "would: file an issue in $dep for #$number ($consumer's $dir)"; return 0; fi
  ensure_labels "$dep"
  issue=$(gh issue create -R "$dep" --title "Upstream from $consumer: changes to $dir" --body "$body" \
    --label "$DISPATCH_LABEL" --label "$UPSTREAM_LABEL" 2>/dev/null) || { log "$dep: could not file the issue for #$number"; return 1; }
  issue=${issue##*/}
  gh pr edit "$number" -R "$dep" --body "$(jq -r '.body // ""' <<< "$pr")

Closes #$issue" >/dev/null 2>&1 || log "$dep: could not link #$number to #$issue"
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    local old_pr old_issue
    old_pr=$(jq -r '.pr // empty' <<< "$old"); old_issue=$(jq -r .issue <<< "$old")
    [ -z "$old_pr" ] || gh pr close "$old_pr" -R "$dep" --comment "Replaced by #$number: a newer change from $consumer to the same folder. Its branch is kept; what was added here is listed in #$issue." >/dev/null 2>&1 || true
    # Not planned: a replaced proposal never counts as merged into a release.
    gh issue close "$old_issue" -R "$dep" --reason "not planned" --comment "Replaced by #$issue." >/dev/null 2>&1 || true
  done < <(jq -c '.supersedes[]?' "$file")
  log "$dep: #$issue filed for $consumer's $dir (PR #$number)"
}

# --- 4: a dependency released ----------------------------------------------
now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Consumers whose proposal into <dependency> was merged since <since>: its issue
# closed as completed (the PR closed it) and the PR merged. One per line,
# `consumer<TAB>dir`. A proposal that was replaced is closed as not planned.
proposers() { # <dependency> <since>
  marked_closed_issues "$1" \
    | jq -r --arg s "$2" '.[] | select(.reason == "COMPLETED" and .closed >= $s) | [.marker.consumer, .marker.dir, (.marker.pr | tostring)] | @tsv' \
    | while IFS=$'\t' read -r consumer dir pr; do
        [ -n "$(gh pr view "$pr" -R "$1" --json mergedAt --jq '.mergedAt // empty' 2>/dev/null)" ] && printf '%s\t%s\n' "$consumer" "$dir"
      done
}
marked_closed_issues() { # <repo>
  gh issue list -R "$1" --label "$UPSTREAM_LABEL" --state closed --limit 200 --json number,body,closedAt,stateReason 2>/dev/null \
    | jq -c '[.[] | {number, closed: (.closedAt // ""), reason: (.stateReason // ""), marker: ((.body // "") | capture("<!-- suede-factory: (?<m>\\{.*\\}) -->").m? // empty | fromjson? // empty)} | select(.marker != null)]'
}

# Consumers blocked on <dependency>: they ship it as a release dependency and
# their copy differs from its pin, so they cannot publish until they sync.
blocked() { # <dependency>
  local file
  for file in "$STATE"/deps/*.json; do
    [ -e "$file" ] || continue
    jq -r --arg r "$1" --arg c "$(basename "$file" .json | sed 's/__/\//')" \
      '.dependencies[] | select(.repo == $r and .kind == "release" and .state == "diff") | [$c, .dir] | @tsv' "$file"
  done
}

# Consumers whose pin of <dependency> is behind <release>, as `consumer<TAB>report
# of it`, release dependencies first -- only those in <only> (`consumer<TAB>dir`
# lines) when it is given.
behind() { # <dependency> <release> [<only>]
  local file consumer
  for file in "$STATE"/deps/*.json; do
    [ -e "$file" ] || continue
    consumer=$(basename "$file" .json | sed 's/__/\//')
    jq -c --arg r "$1" --arg h "$2" '.dependencies[] | select(.repo == $r and .pin != $h)' "$file" \
      | while IFS= read -r d; do
          [ $# -lt 3 ] || printf '%s\n' "$3" | grep -qxF "$consumer"$'\t'"$(jq -r .dir <<< "$d")" || continue
          printf '%s\t%s\n' "$consumer" "$d"
        done
  done | awk -F'\t' '{ print ($2 ~ /"kind":"release"/ ? 0 : 1) "\t" $0 }' | sort -s -k1,1 | cut -f2-
}

# A sync issue for each row of `behind`, unless one is open already.
file_syncs() { # <dependency> <release> <rows>
  local dep=$1 head=$2 consumer d dir pin kind main open
  while IFS=$'\t' read -r consumer d; do
    [ -n "$consumer" ] || continue
    in_stack "$consumer" || continue
    dir=$(jq -r .dir <<< "$d"); pin=$(jq -r .pin <<< "$d"); kind=$(jq -r .kind <<< "$d")
    open=$(marked_issues "$consumer" "$SYNC_LABEL" open | jq -r --arg r "$dep" --arg d "$dir" '[.[] | select(.marker.dependency == $r and .marker.dir == $d)][0].url // empty')
    if [ -n "$open" ]; then
      log "$consumer: a sync of $dir is already open ($open); its release is redelivered"
      [ -n "$DRY" ] || "$CLI" deps deliver "$consumer" "$dep" </dev/null >/dev/null || true
      continue
    fi
    main=$(default_branch "$consumer") || continue
    file_sync_issue "$consumer" "$dep" "$dir" "$pin" "$head" "$kind" "$main" || return 1
  done <<< "$3"
}

sync_tick() { # <dependency>
  local dep=$1 head seen since now rows=""
  head=$(gh api "repos/$dep/branches/release" --jq .commit.sha 2>/dev/null) || return 0
  seen=$(get "heads/$(tag_of "$dep").release")
  [ "$head" != "$seen" ] || return 0
  now=$(now_utc)
  if [ -z "$seen" ]; then
    # First sight: recorded, nothing filed. Syncs follow releases from here on.
    [ -n "$DRY" ] || { put "heads/$(tag_of "$dep").release" "$head"; put "heads/$(tag_of "$dep").release.at" "$now"; }
    return 0
  fi
  since=$(get "heads/$(tag_of "$dep").release.at")
  log "$dep: released ${head:0:12}"
  case "$SYNC_MODE" in
    all) rows=$(behind "$dep" "$head") ;;
    proposers)
      local who
      who=$( { proposers "$dep" "$since"; blocked "$dep"; } | sort -u)
      [ -z "$who" ] || rows=$(behind "$dep" "$head" "$who")
      [ -n "$rows" ] || log "$dep: no consumer proposed into this release or is blocked on it; nothing to sync (\`sync\` asks by hand)" ;;
  esac
  file_syncs "$dep" "$head" "$rows" || return 0
  [ -n "$DRY" ] || { put "heads/$(tag_of "$dep").release" "$head"; put "heads/$(tag_of "$dep").release.at" "$now"; }
}

# `sync`: the consumers named, looked at now; each dependency behind its
# release -- or each --dep names -- gets an issue.
sync_by_hand() { # <consumers> <dependencies, or nothing for all>
  local consumer main rep code dep head d dir rows
  for consumer in $1; do
    in_stack "$consumer" || { log "$consumer is not a project in the stack"; continue; }
    main=$(default_branch "$consumer") || { log "$consumer: not reachable with gh"; continue; }
    code=0; rep=$(fresh_report "$consumer" "$main") || code=$?
    [ "$code" -ne 1 ] || continue
    while IFS= read -r d; do
      dep=$(jq -r .repo <<< "$d"); dir=$(jq -r .dir <<< "$d")
      [ -z "$2" ] || printf '%s\n' "$2" | grep -qxF "$dep" || continue
      in_stack "$dep" || { ensure_dependency "$dep" "$consumer" || true; continue; }
      head=$(gh api "repos/$dep/branches/release" --jq .commit.sha 2>/dev/null) || { log "$dep: its release branch could not be read"; continue; }
      if [ "$(jq -r .pin <<< "$d")" = "$head" ]; then log "$consumer: $dir is at $dep's latest release"; continue; fi
      rows=$(printf '%s\t%s\n' "$consumer" "$d")
      file_syncs "$dep" "$head" "$rows" || true
    done < <(jq -c '.dependencies[] | select(.repo != null)' <<< "$rep")
    if [ -n "$2" ]; then
      for dep in $2; do
        jq -e --arg r "$dep" 'any(.dependencies[]; .repo == $r)' <<< "$rep" >/dev/null || log "$consumer has no suede dependency $dep"
      done
    fi
  done
}

sync_body() {
  cat <<EOF
## Sync $dep to its latest release

$dep released \`${release:0:12}\`. $consumer's copy, its folder \`$dir\`, is pinned at \`${pin:0:12}\`.
$blocking
### How
desolate delivered $dep's \`release\` branch into this repository's git dir, so the sync needs no network and no key. From the repository root:

\`\`\`bash
bundle="\$(cd "\$(git rev-parse --git-common-dir)" && pwd)/desolate-dep-$tag.bundle"
remote="\$(git config -f '$dir/.gitrepo' subrepo.remote)"
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="url.\$bundle.insteadOf" GIT_CONFIG_VALUE_0="\$remote" bash '$dir/.suede/core/sync'
\`\`\`

(\`sync\` is \`git subrepo pull\`; the rewrite points the recorded remote at the delivered release for this one command, and \`$dir/.gitrepo\` keeps the real one. Commit first if the tree is not clean.)

Then:
- Resolve any conflicts with $consumer's own changes to \`$dir\`: keep what $consumer still needs that the release does not have.
- Run $consumer's tests.$deps_check
- Finish with \`green "<one line for the PR>"\`; a human pushes it, and a draft PR follows.

<!-- desolate-dispatch: $dispatch -->
<!-- suede-factory: $factory -->
EOF
}

file_sync_issue() { # <consumer> <dependency> <dir> <pin> <release> <kind> <main>
  local consumer=$1 dep=$2 dir=$3 pin=$4 release=$5 kind=$6 main=$7 body tag issue
  tag=$(tag_of "$dep")
  if [ -n "$DRY" ]; then log "would: file an issue in $consumer to sync $dir to $dep's ${release:0:12}"; return 0; fi
  "$CLI" deps deliver "$consumer" "$dep" </dev/null >/dev/null || { log "$consumer: could not deliver $dep"; return 1; }
  local blocking="" deps_check="" dispatch factory
  [ "$kind" != release ] || blocking="
**$consumer ships $dep as a release dependency:** it publishes again once this sync is merged.
"
  [ "$kind" != release ] || deps_check="
- \`bash $dir/.suede/core/deps.sh --check\` should pass: what $dep needs beside it."
  dispatch=$(jq -cn --arg s "origin/$main" --arg b "$main" '{start: $s, fetch: true, base: $b}')
  factory=$(jq -cn --arg r "$dep" --arg d "$dir" --arg h "$release" '{kind: "sync", dependency: $r, dir: $d, release: $h}')
  body=$(sync_body)
  ensure_labels "$consumer"
  issue=$(gh issue create -R "$consumer" --title "Sync $dir to $dep's latest release" --body "$body" --label "$SYNC_LABEL" --label "$DISPATCH_LABEL" 2>/dev/null) \
    || { log "$consumer: could not file the sync issue"; return 1; }
  log "$consumer: ${issue##*/} filed to sync $dir"
}

# --- the loop ----------------------------------------------------------------
tick() {
  PROJECTS=$(stack_projects) || { log "could not read the stack"; return 1; }
  local project dep deps
  for project in $PROJECTS; do consumer_tick "$project" || log "$project: tick failed"; done
  deps=$( { for f in "$STATE"/deps/*.json; do [ -e "$f" ] && jq -r '.dependencies[].repo // empty' "$f"; done
            ls "$STATE/pending" 2>/dev/null | sed 's/__/\//'; } | sort -u)
  for dep in $deps; do
    in_stack "$dep" || continue
    pending_tick "$dep" || log "$dep: PRs not read"
    sync_tick "$dep" || log "$dep: releases not read"
  done
}

[ $# -ge 1 ] || usage
COMMAND=$1; shift
case "$COMMAND" in
  approve)
    [ $# -eq 1 ] && [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || usage
    mkdir -p "$STATE"
    grep -qxF "$1" "$STATE/approved" 2>/dev/null || echo "$1" >> "$STATE/approved"
    echo "$ME: $1 approved; it is added to the stack on the next tick" ;;
  status)
    echo "approved: $(tr '\n' ' ' < "$STATE/approved" 2>/dev/null)"
    echo "asked:    $(tr '\n' ' ' < "$STATE/asked" 2>/dev/null)"
    echo "waiting for suede to open a PR:"
    for f in "$STATE"/pending/*/*.json; do [ -e "$f" ] && jq -r '"  \(.dep): \(.branch) (\(.consumer)/\(.dir))"' "$f"; done
    echo "consumers' dependencies:"
    for f in "$STATE"/deps/*.json; do [ -e "$f" ] && jq -r --arg c "$(basename "$f" .json | sed 's/__/\//')" \
      '.dependencies[] | "  \($c): \(.dir) -> \(.repo // .remote) [\(.kind), \(.state)]"' "$f"; done ;;
  sync)
    DRY="" ALL="" CONSUMERS="" DEPS=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --dry-run) DRY=1; shift ;;
        --all) ALL=1; shift ;;
        --dep) [[ "${2:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || usage; DEPS="$DEPS $2"; shift 2 ;;
        -*) usage ;;
        *) [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || usage; CONSUMERS="$CONSUMERS $1"; shift ;;
      esac
    done
    [ -n "$ALL" ] || [ -n "$CONSUMERS" ] || usage
    [ -z "$ALL" ] || [ -z "$CONSUMERS" ] || { echo "$ME: name consumers or --all, not both" >&2; exit 2; }
    for tool in gh jq; do command -v "$tool" >/dev/null || { echo "$ME: needs $tool" >&2; exit 1; }; done
    mkdir -p "$STATE"
    PROJECTS=$(stack_projects) || { echo "$ME: could not read the stack" >&2; exit 1; }
    [ -z "$ALL" ] || CONSUMERS=$PROJECTS
    [ -z "$DRY" ] || log "dry run: nothing is filed or changed on GitHub"
    sync_by_hand "$CONSUMERS" "$(printf '%s\n' $DEPS)" ;;
  run)
    INTERVAL=60 ONCE="" DRY="" SYNC_MODE=proposers
    while [ $# -gt 0 ]; do
      case "$1" in
        --interval) INTERVAL=${2:?}; shift 2 ;;
        --once) ONCE=1; shift ;;
        --dry-run) DRY=1; shift ;;
        --sync) SYNC_MODE=${2:?}; shift 2; case "$SYNC_MODE" in proposers|all|none) ;; *) usage ;; esac ;;
        *) usage ;;
      esac
    done
    for tool in gh jq; do command -v "$tool" >/dev/null || { echo "$ME: needs $tool" >&2; exit 1; }; done
    mkdir -p "$STATE"
    [ -z "$DRY" ] || log "dry run: nothing is pushed, filed or changed on GitHub"
    while :; do
      tick || log "tick failed; trying again next time"
      [ -z "$ONCE" ] || exit 0
      sleep "$INTERVAL"
    done ;;
  *) usage ;;
esac
