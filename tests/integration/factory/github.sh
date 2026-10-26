#!/usr/bin/env bash
# The factory's GitHub side, end to end: release/forge.sh as it runs on the
# Mac, the editor's `work github` it feeds, and the watcher that acts on it.
#
#   ./tests/integration/factory/github.sh
#
# Real: forge.sh, work.ts, the watcher, desolate-work in the worktrees, git, a
# push to a bare remote. Stood in: `gh` (fixture issues; it records every PR
# and comment it is asked for), `docker exec <editor> work` (runs work.ts
# here), and the broker's side, as tests/integration/factory/run.sh stubs it.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
# shellcheck source=../../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"
HELPER="$RELEASE/proxy/container/desolate-work"
TMP=$(mktemp -d)
trap '[ -n "${KEEP_TMP:-}" ] && echo "kept $TMP" || rm -rf "$TMP"' EXIT
WORKSPACES=$TMP/workspaces REPO=$TMP/workspaces/acme REMOTE=$TMP/remote.git BIN=$TMP/bin FIX=$TMP/github
mkdir -p "$WORKSPACES" "$BIN" "$FIX"
export DESOLATE_WORKSPACES=$WORKSPACES DESOLATE_WORK_WORKTREE_CMD=$BIN/worktree DESOLATE_WORK_DESOLATE_CMD=$BIN/desolate
export DESOLATE_FORGE_STATE=$TMP/forge-state FIX
export PATH="$BIN:$PATH" GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q -b main "$REPO"
git -C "$REPO" commit -q --allow-empty -m init
git init -q --bare "$REMOTE"
git -C "$REPO" remote add origin "git@localhost:$REMOTE"
cat > "$BIN/ssh" <<'EOF'
#!/bin/sh
for last; do :; done
exec sh -c "$last"
EOF
cat > "$BIN/worktree" <<EOF
#!/bin/sh
case "\$1" in
  add)    exec git -C "$REPO" worktree add -q -b "\$4" "$REPO/.worktrees/\$3" ;;
  remove) exec git -C "$REPO" worktree remove --force "$REPO/.worktrees/\$3" ;;
esac
EOF
cat > "$BIN/desolate" <<EOF
#!/bin/sh
if [ "\$1" = --bundle ]; then
  out="$WORKSPACES/.desolate/factory/push/acme--wt--\$3"; mkdir -p "\$out"
  b=\$(git -C "$REPO/.worktrees/\$3" symbolic-ref --short HEAD)
  git -C "$REPO/.worktrees/\$3" bundle create -q "\$out/branch.bundle" "refs/heads/\$b"
  echo "BUNDLED \$b \$(git -C "$REPO" rev-parse "refs/heads/\$b") \$out/branch.bundle"
fi
exit 0
EOF
# `docker exec [-i] [-e K=V] <editor> work ...` -> work.ts, here. With -i it
# takes ALL of its stdin, as docker does -- forwarding it whether or not the
# command reads it -- and without -i none.
cat > "$BIN/docker" <<EOF
#!/bin/sh
[ "\$1" = exec ] || exit 1; shift
interactive=""
while [ \$# -gt 0 ]; do
  case "\$1" in -i) interactive=1; shift ;; -e) shift 2 ;; *) break ;; esac
done
shift                      # the container
[ "\$1" = work ] || exit 1; shift
if [ -n "\$interactive" ]; then
  input=\$(cat)
  printf '%s' "\$input" | node "$RELEASE/vscode-image/work.ts" "\$@"
  exit
fi
exec node "$RELEASE/vscode-image/work.ts" "\$@" </dev/null
EOF
# gh: open issues are lines "<n><TAB><title>" in \$FIX/open; a closed issue is
# a file \$FIX/closed.<n>; a PR's state is \$FIX/pr.<n> (OPEN by default).
cat > "$BIN/gh" <<'EOF'
#!/bin/bash
args="$*"
case "$1 $2" in
  "auth status"|"label create") exit 0 ;;
  "repo view")
    case "$args" in *defaultBranchRef*) echo main ;; esac; exit 0 ;;
  "issue list")
    if [[ "$args" == *"number,title"* ]]; then
      printf '['; sep=""
      while IFS=$'\t' read -r n t; do
        [ -n "$n" ] || continue
        t=$(printf '%s' "$t" | sed 's/\x1b/\\u001b/g')      # as gh's JSON spells an escape
        printf '%s{"number":%s,"title":"%s"}' "$sep" "$n" "$t"; sep=,
      done < "$FIX/open"
      printf ']\n'
    else cut -f1 "$FIX/open"; fi ;;
  "issue view")
    n=$3
    case "$args" in
      *state*) [ -e "$FIX/closed.$n" ] && echo CLOSED || echo OPEN ;;
      *title*) awk -F'\t' -v n="$n" '$1 == n {print $2}' "$FIX/open" ;;
    esac ;;
  "issue comment") body=$(printf '%s\n' "$@" | awk 'prev == "--body" {print; exit} {prev = $0}')
                   printf '%s\t%s\n' "$3" "$body" >> "$FIX/comments" ;;
  "pr list") branch=$(printf '%s\n' "$@" | awk 'prev == "--head" {print; exit} {prev = $0}')
             [ -e "$FIX/pr-for.${branch//\//_}" ] && cat "$FIX/pr-for.${branch//\//_}"; exit 0 ;;
  "pr create")
    printf '%s\n' "$*" | tr '\n' ' ' >> "$FIX/pr-creates"; echo >> "$FIX/pr-creates"   # one line per call
    branch=$(printf '%s\n' "$@" | awk 'prev == "--head" {print; exit} {prev = $0}')
    n=$(( $(wc -l < "$FIX/pr-creates") + 100 ))
    url="https://github.com/acme/widgets/pull/$n"
    echo "$url" > "$FIX/pr-for.${branch//\//_}"
    echo "Creating draft pull request for $branch into main"; echo "$url" ;;
  "pr view") n=${3##*/}; cat "$FIX/pr.$n" 2>/dev/null || echo OPEN ;;
  *) echo "gh stub: no '$args'" >&2; exit 1 ;;
esac
EOF
chmod +x "$BIN"/*
: > "$FIX/open"

FORGE="$RELEASE/forge.sh"
tick() { node "$RELEASE/vscode-image/work-watcher.ts" --once >> "$TMP/watcher.log" 2>&1; }
work() { node "$RELEASE/vscode-image/work.ts" "$@" 2>&1; }
forge_once() { "$FORGE" run --once >> "$TMP/forge.log" 2>&1; }
agent() { (cd "$REPO/.worktrees/$1" && shift && DESOLATE_TARGET=$(basename "$PWD") sh "$HELPER" "$@"); }
open_worktrees() { ls "$REPO/.worktrees" 2>/dev/null | sort | tr '\n' ' '; }

group "a human enables it, on the Mac"
assert_ok "work init" work init acme --max 2 --on-done push --prefix factory/ --remote "git@localhost:$REMOTE"
assert_ok "forge add" "$FORGE" add acme acme/widgets
POLICY=$(cat "$WORKSPACES/.desolate/factory/acme.json")
assert_contains "the policy has the adapter" "$POLICY" '"repo": "acme/widgets"'
assert_contains "and its requester" "$POLICY" '"forge/github"'

group "two labelled issues become two worktrees"
printf '42\tFix the login\n43\tAdd rate limits\n' > "$FIX/open"
forge_once; tick
assert_eq "both are open" "$(open_worktrees)" "issue-42 issue-43 "
assert_eq "each from one request by forge/github" "$(work requests acme | grep -c 'from forge/github')" "2"
forge_once
assert_eq "each issue was told, once" "$(grep -c 'desolate opened worktree' "$FIX/comments")" "2"
forge_once
assert_eq "and not again" "$(grep -c 'desolate opened worktree' "$FIX/comments")" "2"

group "both agents finish: two draft PRs, in one pass"
for n in 42 43; do
  git -C "$REPO/.worktrees/issue-$n" commit -q --allow-empty -m "the work for #$n"
  agent "issue-$n" done "ready"
done
for _ in 1 2 3; do tick; done
for n in 42 43; do
  assert_eq "factory/issue-$n reached the remote" \
    "$(git -C "$REMOTE" rev-parse -q --verify "refs/heads/factory/issue-$n" 2>/dev/null)" "$(git -C "$REPO" rev-parse "factory/issue-$n")"
done
assert_contains "a push alone does not close a GitHub item" "$(open_worktrees)" "issue-42"
forge_once
# Both in ONE run: a `docker exec -i` inside the loop once swallowed the rest of
# its input, and the second pushed branch got no PR.
assert_eq "two PRs were opened, in one run" "$(wc -l < "$FIX/pr-creates" | tr -d ' ')" "2"
CREATE42=$(grep -- '--head factory/issue-42' "$FIX/pr-creates")
assert_contains "draft, for the item's branch" "$CREATE42" "--draft"
assert_contains "closing its issue" "$CREATE42" "Closes #42"
assert_contains "and the editor recorded it" "$(work github acme status)" "https://github.com/acme/widgets/pull/"
forge_once
assert_eq "and none twice" "$(wc -l < "$FIX/pr-creates" | tr -d ' ')" "2"

group "a merged PR, and a closed issue, close their worktrees"
PR42=$(work github acme status | awk -F'\t' '$1 == 42 {print $5}')
echo MERGED > "$FIX/pr.${PR42##*/}"
grep -v '^43' "$FIX/open" > "$FIX/open.next"; mv "$FIX/open.next" "$FIX/open"; : > "$FIX/closed.43"
forge_once
for _ in 1 2; do tick; done
assert_eq "both worktrees are closed" "$(open_worktrees)" ""
forge_once
assert_eq "and each issue was told" "$(grep -c 'desolate closed worktree' "$FIX/comments")" "2"
assert_eq "the editor says both are closed" "$(work github acme status | cut -f1,4 | tr '\t\n' ': ')" "42:closed 43:closed "

group "what reaches the editor is held to its shape"
printf '44\tA title \033[31mwith escapes\n' > "$FIX/open"
forge_once; tick
LOGGED=$(work log acme --type item)
assert_contains "its title arrives as one plain line" "$LOGGED" "A title [31mwith escapes"
assert_not_contains "with no escape left in it" "$(git -C "$REPO" log --format=%B refs/desolate/forge/github/outbox | cat -v)" "^["
assert_ok "work verify passes over all of it" work verify acme

summary
