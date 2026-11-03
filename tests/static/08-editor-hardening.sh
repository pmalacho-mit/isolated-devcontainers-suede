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
#
# And the one thing ADDED to that tree, the desolate extension (T4.7, F6): built
# into the shell root alone, it may run the editor's own commands -- desolate,
# worktree, and newrepo for a first clone -- and nothing else: no network, no
# shell, no git or docker of its own.
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
assert_contains "extensions this editor installs land on a tmpfs, gone at the next start" "$CFG" \
  "--extensions-dir=/home/workspace/.vscodium-server/extensions"
assert_contains "  (the tmpfs)" "$CFG" "- /home/workspace/.vscodium-server/extensions"
# ... and the editor's user's: mounted root's, the server wrote no
# extensions.json and loaded no extension -- the desolate panel went missing
# (tests/environments/extension now starts the editor this way, from here).
assert_contains "  the editor's user's, and only theirs" "$CFG" \
  "- /home/workspace/.vscodium-server/extensions:uid=1000,gid=1000,mode=0700"
# A mountpoint's missing parents are made root's: in a fresh home the server
# could not make its data/ beside it. The image makes the directory, the user's.
assert_contains "the image makes the server's directory, the user's, for a fresh home" "$(cat "$RELEASE/vscode-image/Dockerfile")" \
  "install -d -o 1000 -g 1000 /home/workspace/.vscodium-server /home/workspace/.vscodium-server/extensions"

group "workspace trust is ON, in the direction that matters"
# The values live in editor-settings.ts (HELD), which shell-entry runs at every
# start. Comments there discuss the false value; strip them, or the assertion
# below passes on its own documentation.
HELD_TS="$RELEASE/vscode-image/editor-settings.ts"
SEED=$(grep -v '^[[:space:]]*//' "$HELD_TS" | grep -v '^ \*')
assert_contains "trust is enabled" "$SEED" '"security.workspace.trust.enabled": true'
assert_not_contains "trust is never disabled" "$SEED" \
  '"security.workspace.trust.enabled": false'
assert_contains "the startup prompt is never offered" "$SEED" \
  '"security.workspace.trust.startupPrompt": "never"'
assert_contains "automatic tasks are off" "$SEED" '"task.allowAutomaticTasks": "off"'
assert_contains "the terminal reads no rc file from the home volume" "$SEED" '"--rcfile", "/dev/null"'

group "the settings are held at EVERY start, and the user's own left alone"
# $HOME is a volume a compromised editor can write; seeding once left workspace
# trust one write away from off, for good (audit M3). Holding puts back only
# the settings in HELD -- tests/unit/desolate/editor-settings.test.ts shows the
# rest of the file untouched -- so a restart ends what a compromise set.
ENTRY_SH=$(grep -v '^#' "$ENTRY")
assert_contains "shell-entry runs the holder, unconditionally" "$ENTRY_SH" 'tsx /usr/local/lib/desolate/editor-settings.ts "$SETTINGS"'
assert_not_contains "  not only when the file is absent" "$ENTRY_SH" '[ ! -f "$SETTINGS" ]'
assert_contains "  and refuses to start the editor when it cannot" "$ENTRY_SH" 'exit 1'
assert_contains "and execs the real command afterwards" "$ENTRY_SH" 'exec "$@"'
assert_contains "the editor's code is root's: a compromised editor cannot rewrite it in place" "$DF" 'COPY *.ts /usr/local/lib/desolate/'
assert_not_contains "  not the editor's own" "$DF" 'COPY --chown=1000:1000 *.ts'
assert_contains "the rc-less bash still reaches completion and the guard: asserted at build" "$DF" \
  "bash --rcfile /dev/null -ic 'complete -p desolate"
# The other way into the editor's bash: `cli.sh shell`, from the Mac
# (follow-up R2). Every bash it starts must say so; a bare `with-ca bash` reads
# ~/.bashrc off the volume, keys in reach.
SHELL_LINES=$(grep -n 'with-ca bash' "$RELEASE/cli.sh")
assert_contains "cli.sh shell reads no rc or profile file from the home volume" "$SHELL_LINES" \
  'with-ca bash --noprofile --rcfile /dev/null "$@"'
assert_eq "  and starts no bash that does" "$(printf '%s\n' "$SHELL_LINES" | grep -vc -- '--rcfile /dev/null')" "0"

group "the desolate extension is the shell root's only addition, and holds no new power"
EXT="$RELEASE/vscode-image/extension"
assert_contains "it is built into the shell root" "$DF" 'out="${DESOLATE_SHELL_ROOT}/extensions/desolate"'
assert_contains "and the build fails if the server root ever gets it" "$DF" \
  'test ! -e "${DESOLATE_SERVER_ROOT}/extensions/desolate"'
assert_contains "by the esbuild tsx already carries, fetching nothing" "$DF" 'require.resolve("esbuild", { paths: [process.argv[1]] })'
SRC=$(cat "$EXT"/*.mts)
assert_eq "its only process API is execFile" "$(grep -oE 'from "node:[a-z_]+"' "$EXT"/*.mts | sed 's/.*from //' | sort -u | tr '\n' ' ')" '"node:child_process" '
assert_not_contains "it never spawns through a shell" "$SRC" "shell:"
for api in 'node:http' 'node:https' 'node:net' 'node:dgram' 'fetch(' 'WebSocket' 'exec(' 'spawn('; do
  assert_not_contains "it uses no $api" "$SRC" "$api"
done
assert_eq "it runs exactly the editor's three commands" \
  "$(grep -oE 'command: "[a-z]+"( \| "[a-z]+")*' "$EXT/extension.mts" | sort -u | tr '\n' ' ')" 'command: "desolate" | "worktree" | "newrepo" '
assert_contains "what it logs goes through redactTokens" "$SRC" "log.append(redactTokens("
MANIFEST=$(cat "$EXT/package.json")
assert_contains "its manifest's main is the bundle" "$MANIFEST" '"main": "./extension.js"'
for key in '"browser"' '"extensionDependencies"' '"extensionPack"' '"authentication"' '"enabledApiProposals"'; do
  assert_not_contains "its manifest declares no $key" "$MANIFEST" "$key"
done
assert_contains "and refuses to run in a virtual workspace" "$MANIFEST" '"virtualWorkspaces": false'

group "the editor's typed git refuses a project (git-guard.bash)"
GUARD="$RELEASE/vscode-image/git-guard.bash"
G_TMP=$(mktemp -d)
mkdir -p "$G_TMP/plain" && ln -s /workspaces "$G_TMP/link"
guarded() { (cd "${1}" && shift && bash -c ". '$GUARD'; $*" 2>&1; echo "exit=$?"); }
if [ -d /workspaces ]; then
  for case in "/workspaces|git status" \
              "$G_TMP/plain|git -C /workspaces log" \
              "$G_TMP/plain|git -c core.pager=cat -C /workspaces status" \
              "$G_TMP/plain|git --git-dir=/workspaces/x/.git status" \
              "$G_TMP/plain|git --git-dir /workspaces/x/.git status" \
              "$G_TMP/plain|GIT_DIR=/workspaces/x/.git git status" \
              "$G_TMP/plain|git -C $G_TMP/link status" \
              "$G_TMP/plain|git -C /tmp -C /workspaces push"; do
    OUT=$(guarded "${case%%|*}" "${case#*|}")
    assert_contains "refused: (in ${case%%|*}) ${case#*|}" "$OUT" "no git in a project from the outer editor"
    assert_contains "  and it fails" "$OUT" "exit=1"
  done
  assert_contains "git elsewhere is git" "$(guarded "$G_TMP/plain" "git --version")" "git version"
  assert_contains "a -C that stays outside /workspaces is git" "$(guarded "$G_TMP/plain" "git -C . config --get nothing.here; true")" "exit=0"
  assert_contains "command git is the way past it, on purpose" \
    "$(guarded /workspaces "command git --version")" "git version"
else
  skip "the git guard against /workspaces" "no /workspaces here"
fi
rm -rf "$G_TMP"
assert_contains "the image sources it in interactive shells" "$(cat "$RELEASE/vscode-image/Dockerfile")" "/etc/desolate/git-guard.bash; do"

summary
