#!/usr/bin/env bash
# #52: an agent in a devcontainer holds its project daemon's socket, so it can
# `docker rm -f` its own container (or every sibling's). The recovery is a human
# running `desolate <target>`, and the docs say so. This pins the properties
# that claim rests on, read from the source (a start needs a daemon this suite
# does not have), and that the agent is TOLD.
#
# Measured separately, against a project daemon, with throwaway containers:
# `docker rm -f` leaves no trace of the container and nothing restarts it;
# `docker stop` keeps it, Exited (137).
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

TS="$RELEASE/vscode-image/desolate.ts"
DOCKER_TS="$RELEASE/vscode-image/docker.ts"

body_of() {   # <name>: a top-level function or arrow const, to its closing brace
  awk -v name="$1" '
    $0 ~ "^(async )?function " name "\\(" || $0 ~ "^const " name " = " { on = 1 }
    on { print }
    on && /^};?$/ { exit }' "$TS"
}

group "nothing brings a removed container back by itself"
# A restart policy would turn `rm -f` into "it came back", or, for a relay,
# into a socat pointed at an address that no longer means anything (docker.ts).
assert_eq "docker.ts starts nothing with a restart policy" \
  "$(grep -cE '"--restart|--restart[ =]' "$DOCKER_TS")" "0"

group "a start does not need the container that was removed"
RUN=$(awk '/^async function runTarget|^function runTarget/ {on=1} on {print} on && /^}$/ {exit}' "$TS")
assert_contains "  (found runTarget)" "$RUN" "devcontainerUp(target, config, noCache)"
assert_contains "it looks for an existing container, stopped ones included" "$RUN" 'devcontainerId(dir, true)'
assert_contains "no container found means one is created, as --rebuild would" "$RUN" 'const willCreate = rebuild || !existing;'
assert_contains "the fingerprint is saved for a created one" "$RUN" 'if (willCreate) spec.save(target, fingerprint);'
RELAYS=$(body_of recreateRelays)
assert_contains "  (found recreateRelays)" "$RELAYS" "startRelay("
REMOVE_AT=$(printf '%s\n' "$RELAYS" | grep -n 'docker.container.remove(old)' | head -1 | cut -d: -f1)
START_AT=$(printf '%s\n' "$RELAYS" | grep -n 'startRelay(' | head -1 | cut -d: -f1)
[ -n "$REMOVE_AT" ] && [ -n "$START_AT" ] && [ "$REMOVE_AT" -lt "$START_AT" ] \
  && pass "relays a dead container left are removed before new ones start (names would collide)" \
  || fail "relays a dead container left are removed before new ones start" "remove at '${REMOVE_AT:-none}', start at '${START_AT:-none}'"

group "--stop on a target whose container is gone is clean"
STOP=$(body_of stopTarget)
assert_contains "  (found stopTarget)" "$STOP" "ownRelayNames(target)"
assert_contains "relays are removed whether or not the container is" "$STOP" 'docker.container.remove(relays);'
assert_contains "the forwards are withdrawn whether or not it is" "$STOP" 'ingressFiles.withdraw(ports.load(target), target);'
assert_contains "no container is reported, not failed" "$STOP" 'else console.log("not running");'

group "the agent is told, and the human knows the way back"
AGENTS=$(cat "$RELEASE/AGENTS.md")
assert_contains "AGENTS.md has the section" "$AGENTS" "### Do not remove containers you did not start"
assert_contains "  it names the self-removal" "$AGENTS" '$(hostname)'
assert_contains "  and the sibling worktrees' containers" "$AGENTS" "every worktree of this project"
assert_contains "  and that only a human can bring it back" "$AGENTS" "Only a human can bring the container back"
README=$(cat "$RELEASE/README.md")
assert_contains "the README documents what happens and how to recover" "$README" 'An agent (or you) ran `docker rm -f` on the devcontainer'

summary
