#!/bin/sh
# Seed the OUTER editor's security defaults, then exec the server.
#
# WHY THIS IS A START-TIME STEP AND NOT A DOCKERFILE LINE
#
# These settings live under $HOME, and $HOME is the `vscode-home` VOLUME. A file
# baked into the image at that path is shadowed the moment the volume mounts, so
# it would be present in `docker build` output and absent in every actual run --
# the worst kind of security control, one that reviews as applied.
#
# WHAT THEY ARE FOR
#
# The outer editor shares /workspaces read-write with every devcontainer and can
# reach the keyring's agent socket. It is therefore the container where hostile
# project content is worth executing, and VSCodium is full VS Code: a workspace
# can carry .vscode/tasks.json with "runOn": "folderOpen", and settings that
# point tools at attacker-chosen executables. Workspace Trust gates those.
#
# THE SETTING THAT LOOKS LIKE THE ANSWER AND IS NOT
#
# `security.workspace.trust.enabled: false` does NOT mean "never trust". It
# disables the FEATURE, and the workbench then short-circuits to treating every
# folder as trusted -- granting automatic execution to exactly the repositories
# this is meant to contain. It is deliberately set to `true` below, and
# tests/static/08-editor-hardening.sh fails the build if it is ever false.
#
# There is no "always restricted" switch (a --restricted-mode flag was requested
# upstream and closed as out of scope), so the approximation is: keep the feature
# on, never offer the trust prompt at startup, and leave granting it a deliberate
# act through the command palette. That matters because trust is remembered:
# trusting /workspaces once trusts every repository later cloned into it.
#
# WHAT THIS DOES NOT DO
#
# Restricted Mode does not stop git. The built-in git extension declares limited
# untrusted support, so it still runs `git`, and `core.fsmonitor`, hooks and
# .gitattributes filters still execute. That path is closed structurally instead
# -- the git extensions are not present in this editor's tree at all (see the
# Dockerfile's shell root) -- and the credentials it would reach are in the
# keyring, not here. This file is defence in depth, not a boundary.
set -eu

SETTINGS_DIR="${HOME}/.vscodium-server/data/User"
SETTINGS="${SETTINGS_DIR}/settings.json"

if [ ! -f "$SETTINGS" ]; then
    mkdir -p "$SETTINGS_DIR"
    cat > "$SETTINGS" <<'JSON'
{
  // Seeded once by shell-entry.sh. Yours to edit -- it is not rewritten.
  // See tests/static/08-editor-hardening.sh for the two values that are
  // asserted, and release/README.md for why.

  // ON, and true means the protection EXISTS. Setting it false would mean
  // "trust everything", which is the opposite of what it sounds like.
  "security.workspace.trust.enabled": true,

  // Never offer the prompt at startup. A folder stays in Restricted Mode until
  // you deliberately trust it (Workspaces: Manage Workspace Trust). Removes the
  // reflexive click that would trust /workspaces -- and so every repository you
  // later clone into it -- permanently.
  "security.workspace.trust.startupPrompt": "never",
  "security.workspace.trust.emptyWindow": false,
  "security.workspace.trust.banner": "always",

  // Terminals are BLOCKED in Restricted Mode by default, because a shell can
  // execute workspace content on startup (sourcing .env, direnv, rc scripts
  // that reference the cwd). This image's shell does none of that, and running
  // `desolate` from a terminal is the entire job of this editor -- so the
  // precondition upstream names for re-enabling it is met here.
  "terminal.integrated.allowInUntrustedWorkspace": true,

  // A trusted workspace can still declare tasks that run on folderOpen. Nothing
  // in this editor needs them; real work happens in the project's own editor,
  // inside its devcontainer, where there is no agent socket to reach.
  "task.allowAutomaticTasks": "off",

  // This editor is a launcher, not an IDE. Extensions here run beside the agent
  // socket; install them in the project editor instead.
  "extensions.autoCheckUpdates": false,
  "extensions.autoUpdate": false
}
JSON
    echo "shell-entry: seeded editor security defaults at $SETTINGS" >&2
fi

exec "$@"
