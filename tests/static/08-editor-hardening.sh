#!/usr/bin/env bash
# The outer editor's hardening, and the one setting that inverts if you flip it.
#
# The outer editor is the container that can reach the keyring's agent socket,
# so it is where hostile project content is worth executing. Two controls stand
# between a cloned repository and that socket, and both fail silently:
#
#   1. The git extensions are absent from this editor's tree. If they came back,
#      opening any repository would run its .git/config again -- and everything
#      would still appear to work, which is the problem.
#   2. Workspace Trust is ENABLED. `security.workspace.trust.enabled: false`
#      reads like "don't do trust checks" and means "treat every folder as
#      trusted", so a well-intentioned edit to quiet a prompt grants automatic
#      task execution to every repository. Asserted explicitly, in the direction
#      that is dangerous.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

DOCKERFILE="$RELEASE/vscode-image/Dockerfile"
ENTRY="$RELEASE/vscode-image/shell-entry.sh"
COMPOSE="$RELEASE/docker-compose.yml"

group "the outer editor runs a tree with no git extension"
DF=$(grep -v '^[[:space:]]*#' "$DOCKERFILE")
assert_contains "a separate shell root is built" "$DF" "DESOLATE_SHELL_ROOT"
assert_contains "it is hardlinked, not copied" "$DF" "cp -al"
for ext in git git-base github github-authentication; do
  assert_contains "the '$ext' extension is removed from it" "$DF" "$ext"
done
# The build must FAIL if the removal silently stops working -- a pruned tree
# that still carries git is worse than no pruning, because it reads as pruned.
assert_contains "the build asserts git is gone from the shell root" "$DF" \
  'test ! -e "${DESOLATE_SHELL_ROOT}/extensions/git"'
assert_contains "and asserts it SURVIVES in the server root" "$DF" \
  'test -e "${DESOLATE_SERVER_ROOT}/extensions/git"'

group "and gets a diff editor back without getting the extension back"
SHIM="$RELEASE/vscode-image/git-codium.sh"
assert_contains "the shim is installed onto PATH" "$DF" \
  "COPY git-codium.sh /usr/local/bin/git-codium"
# --system or nothing: $HOME is a volume, so a --global written at build time is
# shadowed at run time and the wiring is silently absent in every real session.
assert_contains "git is pointed at it for editing" "$DF" \
  'git config --system core.editor "/usr/local/bin/git-codium edit"'
assert_contains "for diffing" "$DF" "git config --system diff.tool codium"
assert_contains "and for merging" "$DF" "git config --system merge.tool codium"
assert_not_contains "never via a HOME the volume will shadow" "$DF" \
  "git config --global core.editor"
# The point of the shim: it hands two files to a CLI. If it ever grew a way to
# put the extension back, this whole group would be asserting the opposite of
# what it claims.
SH=$(grep -v '^[[:space:]]*#' "$SHIM")
assert_not_contains "the shim never installs an extension" "$SH" "--install-extension"
assert_not_contains "and never re-enables one" "$SH" "--enable-proposed-api"
# git deletes its temp copies as soon as the tool returns, so a diff opened
# without --wait is a tab pointing at files that no longer exist.
assert_contains "diffs are opened with --wait" "$SH" '--wait --diff'
assert_contains "merges too" "$SH" '--wait --merge'

group "compose actually runs that tree"
CFG=$(grep -v '^[[:space:]]*#' "$COMPOSE")
assert_contains "the editor entrypoint uses the shell root" "$CFG" \
  "/home/.desolate-shell/bin/codium-server"
assert_not_contains "and not the unpruned server root" "$CFG" \
  "/home/.desolate-server/bin/codium-server"
assert_contains "the seeding entrypoint is in the chain" "$CFG" \
  "/usr/local/bin/shell-entry"

group "workspace trust is ON, in the direction that matters"
# Comments in shell-entry.sh discuss the false value at length; strip them, or
# the assertion below passes on its own documentation.
SEED=$(grep -v '^[[:space:]]*//' "$ENTRY" | grep -v '^#')
assert_contains "trust is enabled" "$SEED" '"security.workspace.trust.enabled": true'
assert_not_contains "trust is never disabled" "$SEED" \
  '"security.workspace.trust.enabled": false'
assert_contains "the startup prompt is never offered" "$SEED" \
  '"security.workspace.trust.startupPrompt": "never"'
assert_contains "automatic tasks are off" "$SEED" '"task.allowAutomaticTasks": "off"'

group "the seed does not overwrite a user's own settings"
# It runs on every start. Seeding unconditionally would silently revert any
# change the user made, which is both rude and a good way to have the file
# ignored entirely.
assert_contains "it only writes when the file is absent" "$SEED" '[ ! -f "$SETTINGS" ]'
assert_contains "and execs the real command afterwards" "$SEED" 'exec "$@"'

summary
