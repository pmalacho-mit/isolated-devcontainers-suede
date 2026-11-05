#!/usr/bin/env bash
# A start's order (desolate.ts runTarget): nothing of the project's runs in its
# container before the container is known to hold the directory that was
# checked (audit M4, follow-up R3).
#
# `devcontainer up` runs the lifecycle commands -- onCreate, updateContent,
# postCreate, postStart, postAttach -- before it returns, and the workspace
# check can only ask a container that exists. So `up` holds them back
# (--skip-post-create) and `run-user-commands` runs them once the check has
# passed. Read from the source: the order is the property, and a start needs a
# daemon this suite does not have.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

TS="$RELEASE/vscode-image/desolate.ts"

body_of() {   # <name>: a top-level function or arrow const, to its closing brace
  awk -v name="$1" '
    $0 ~ "^(async )?function " name "\\(" || $0 ~ "^const " name " = " { on = 1 }
    on { print }
    on && /^};?$/ { exit }' "$TS"
}

group "up holds the lifecycle commands back"
UP=$(body_of devcontainerUp)
assert_contains "  (found devcontainerUp)" "$UP" '"up",'
assert_contains "devcontainer up is given --skip-post-create" "$UP" '"--skip-post-create"'
assert_eq "the runner calls devcontainer up in that one place" \
  "$(grep -c '"up",' "$TS")" "1"
LIFE=$(body_of runLifecycleCommands)
assert_contains "run-user-commands runs them, with the same frozen spec" "$LIFE" '"run-user-commands",'
assert_contains "  and the same override-config" "$LIFE" 'overrideConfigFlag(config)'

group "every up is checked before anything of the project's runs in it"
# Each call's line, in order, inside the function that starts a target -- and
# inside the recreate a stale-mount retry runs.
calls() {
  body_of runTarget | grep -oE '(devcontainerUp|verifyWorkspaceMount|installProxyCa|runLifecycleCommands|startEditor)\(' | tr -d '(' | tr '\n' ' '
}
ORDER=$(calls)
assert_contains "  (found runTarget's calls)" "$ORDER" "startEditor"
assert_eq "up, check, CA, lifecycle, editor -- and the recreate in the same order" "${ORDER% }" \
  "devcontainerUp verifyWorkspaceMount installProxyCa runLifecycleCommands devcontainerUp verifyWorkspaceMount installProxyCa runLifecycleCommands startEditor"
assert_eq "startEditor calls no up of its own" "$(body_of startEditor | grep -c 'devcontainerUp(')" "0"

group "a project the proxy restricts is refused the shared daemon before anything starts"
FIRST=$(body_of runTarget | grep -oE '(refuseRestrictedOnTheSharedDaemon|daemons\.use|useProjectDaemon|devcontainerUp)\(' | head -1)
assert_eq "it is asked first, once the daemon is known" "$FIRST" "refuseRestrictedOnTheSharedDaemon("

group "a refused derived spec is the project's when its own spec is refused too"
# From the Mac nothing else judges the project's own spec, and a worktree's is
# its branch's copy: a fork's `build.options` was once reported as a desolate
# bug, sending its owner to the main tree's devcontainer.json, which was fine.
JUDGE=$(body_of runTarget | awk '/const judge = \(\) => \{/,/^  \};/')
assert_contains "  (found the judge)" "$JUDGE" "enforcePolicy("
OWN_AT=$(printf '%s\n' "$JUDGE" | grep -n 'projectRefusal(' | cut -d: -f1 | head -1)
BUG_AT=$(printf '%s\n' "$JUDGE" | grep -n 'this is a desolate bug' | cut -d: -f1 | head -1)
[ -n "$OWN_AT" ] && [ -n "$BUG_AT" ] && [ "$OWN_AT" -lt "$BUG_AT" ] \
  && pass "the project's own spec is judged before a refusal is called desolate's" \
  || fail "the project's own spec is judged before a refusal is called desolate's" "projectRefusal at '${OWN_AT:-none}', the bug message at '${BUG_AT:-none}'"
assert_contains "a worktree's refusal says whose copy of the spec it was" "$(body_of projectRefusal)" "a worktree's own copy, as its branch has it"

summary
