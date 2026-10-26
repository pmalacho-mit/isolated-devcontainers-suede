#!/usr/bin/env bash
# The factory, end to end, with the `file` adapter (F8).
#
#   ./tests/integration/factory/run.sh
#
# A project whose .desolate/work.md lists three items, a policy of at most two
# open worktrees that pushes on `done`. Everything the factory is made of runs
# for real -- desolate-work in the worktrees, the watcher, the file adapter,
# `work verify` -- on a real repository, pushing to a bare remote over an ssh
# that runs here. What needs the stack is stubbed: `desolate` (the broker's
# start, stop and purge) succeeds, and `worktree` is real `git worktree`.
# tests/integration/broker covers what the broker does with those requests,
# and the nested harness runs the watcher in the editor itself.
#
# Not asserted, and why: the plan's "the proxy audit shows the pushes under the
# project's name". A push goes over ssh with the deploy key, which the proxy
# never sees; the github adapter's REST calls are what will be audited (T4.6).
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
# shellcheck source=../../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"
HELPER="$RELEASE/proxy/container/desolate-work"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
WORKSPACES=$TMP/workspaces REPO=$TMP/workspaces/acme REMOTE=$TMP/remote.git BIN=$TMP/bin
mkdir -p "$WORKSPACES" "$BIN"
export DESOLATE_WORKSPACES=$WORKSPACES DESOLATE_WORK_WORKTREE_CMD=$BIN/worktree DESOLATE_WORK_DESOLATE_CMD=$BIN/desolate
export PATH="$BIN:$PATH" GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q -b main "$REPO"
mkdir -p "$REPO/.desolate"
printf '# work\n- [ ] Add rate-limit headers\n- [ ] Fix the login redirect\n- [ ] Document the API\n' > "$REPO/.desolate/work.md"
git -C "$REPO" add .desolate/work.md && git -C "$REPO" commit -q -m "work items"
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
printf '#!/bin/sh\nexit 0\n' > "$BIN/desolate"
chmod +x "$BIN/ssh" "$BIN/worktree" "$BIN/desolate"

tick() { node "$RELEASE/vscode-image/work-watcher.ts" --once >> "$TMP/watcher.log" 2>&1; }
work() { node "$RELEASE/vscode-image/work.ts" "$@" 2>&1; }
open_worktrees() { ls "$REPO/.worktrees" 2>/dev/null | sort | tr '\n' ' '; }
agent() { (cd "$REPO/.worktrees/$1" && shift && DESOLATE_TARGET=$(basename "$PWD") sh "$HELPER" "$@"); }
# The item a worktree was opened for, by the adapter's own naming.
title_of() {
  node -e 'const { fileItems } = await import(process.argv[1]);
    const items = fileItems(process.argv[2]); console.log(items.find((i) => i.worktree === process.argv[3])?.title ?? "")' \
    "$RELEASE/vscode-image/work-forge.ts" "$(git -C "$REPO" show HEAD:.desolate/work.md)" "$1"
}

group "a human enables it"
assert_ok "work init" work init acme --max 2 --on-done push --prefix factory/ --adapter file
assert_contains "the policy names the adapter as a requester" "$(cat "$WORKSPACES/.desolate/factory/acme.json")" '"forge/file"'

group "three items, a cap of two"
tick
OPEN=$(open_worktrees)
assert_eq "two worktrees are open" "$(printf '%s' "$OPEN" | wc -w | tr -d ' ')" "2"
REQUESTS=$(work requests acme)
assert_eq "three open requests, written by the adapter" "$(printf '%s\n' "$REQUESTS" | grep -c 'from forge/file')" "3"
assert_contains "and the third waits" "$REQUESTS" "-- waiting"
WAITING=$(printf '%s\n' "$REQUESTS" | grep -- '-- waiting' | sed -E 's/^[0-9A-Z]+  open ([^ ]+) .*/\1/')

group "the first agent finishes"
FIRST=$(printf '%s' "$OPEN" | awk '{print $1}')
git -C "$REPO/.worktrees/$FIRST" commit -q --allow-empty -m "the work"
agent "$FIRST" done "ready for review"
for _ in 1 2 3 4; do tick; done
assert_eq "its branch reached the remote" \
  "$(git -C "$REMOTE" rev-parse -q --verify "refs/heads/factory/$FIRST" 2>/dev/null)" "$(git -C "$REPO" rev-parse "factory/$FIRST")"
assert_contains "its box is ticked in the working copy, for a human to commit" \
  "$(cat "$REPO/.desolate/work.md")" "- [x] $(title_of "$FIRST")"
assert_eq "it was closed" "$(test -d "$REPO/.worktrees/$FIRST" && echo open || echo closed)" "closed"
assert_contains "and the one that waited is open now" "$(open_worktrees)" "$WAITING"
assert_contains "desolate said each step on its outbox" \
  "$(git -C "$REPO" log --format=%s refs/desolate/desolate/outbox | tr '\n' '|')" "state: closed $FIRST"

group "the conversation verifies -- until someone rewrites it"
assert_ok "work verify passes" work verify acme
REF=refs/desolate/agents/$FIRST/outbox
HEAD=$(git -C "$REPO" rev-parse "$REF")
BLOB=$(printf '{"v":1,"from":"%s","to":["main"],"type":"done","body":"I never said this","item":null,"commit":null,"reply_to":null}' "$FIRST" \
  | git -C "$REPO" hash-object -w --stdin)
TREE=$(printf '100644 blob %s\tmessage.json\n' "$BLOB" | git -C "$REPO" mktree)
FORGED=$(GIT_AUTHOR_NAME="desolate/$FIRST" GIT_AUTHOR_EMAIL="$FIRST@desolate.invalid" git -C "$REPO" commit-tree "$TREE" -m "done: I never said this")
git -C "$REPO" update-ref "$REF" "$FORGED" "$HEAD"
if OUT=$(work verify acme); then fail "a rewritten message fails verify" "it passed: $OUT"
else assert_contains "a rewritten message fails verify" "$OUT" "not an append"; fi

summary
