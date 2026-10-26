#!/usr/bin/env bash
# The factory's watcher runs git on a timer, in the editor, against project
# repositories whose config names commands. What keeps that from executing
# anything is a handful of flags and one rule (plumbing only); this file pins
# both, and where the watcher runs.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

GIT_TS="$RELEASE/vscode-image/work-git.ts"
WATCHER="$RELEASE/vscode-image/work-watcher.ts"

group "every git the watcher runs is hardened"
for flag in '"core.fsmonitor=false"' '"core.hooksPath=/dev/null"' '"core.pager=cat"' '"--no-pager"' \
            'GIT_CONFIG_GLOBAL: "/dev/null"' 'GIT_CONFIG_SYSTEM: "/dev/null"'; do
  assert_ok "work-git.ts sets $flag" grep -qF -- "$flag" "$GIT_TS"
done
assert_ok "and every call goes through HARDENED" grep -q '\["-C", repo, ...HARDENED, ...args\]' "$GIT_TS"

group "it runs plumbing, and the one porcelain it needs is isolated"
# Every git subcommand the two files run, read off their call sites: porcelain
# that reads content or a work tree would run filters and hooks.
CALLED=$(grep -ohE '(workGit\.git\([^,]+, |git\(repo, |inBare\()(pushArguments|\["[a-z-]+")' "$GIT_TS" "$WATCHER" \
  | sed -E 's/.*\["//; s/.*\(//; s/"$//; s/pushArguments/push/' | sort -u | tr '\n' ' ')
ALLOWED=" cat-file commit-tree config for-each-ref hash-object init mktree push rev-list rev-parse symbolic-ref update-ref "
assert_ok "found the call sites" test -n "$CALLED"
for sub in $CALLED; do
  case "$ALLOWED" in *" $sub "*) pass "git $sub is plumbing (or the isolated push)" ;;
    *) fail "git $sub is plumbing (or the isolated push)" "it is not on the allowed list" ;; esac
done
assert_ok "the push is made from a throwaway repository, not the project" grep -q '"--git-dir", bare' "$WATCHER"
assert_ok "with no template (so no hooks) and --no-verify" grep -q '"--template="' "$WATCHER"

group "it runs in the editor and nowhere else"
assert_ok "shell-entry.sh starts it" grep -q 'work-watcher.ts' "$RELEASE/vscode-image/shell-entry.sh"
USERS=$(grep -c '^ *- /usr/local/bin/shell-entry' "$RELEASE/docker-compose.yml")
assert_eq "and only the editor's service uses shell-entry" "$USERS" "1"
assert_ok "that service is the editor" sh -c "sed -n '/^  vscode:/,/^  [a-z]/p' '$RELEASE/docker-compose.yml' | grep -q shell-entry"

summary
