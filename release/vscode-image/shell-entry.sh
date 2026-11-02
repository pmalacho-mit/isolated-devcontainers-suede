#!/bin/sh
# Hold the OUTER editor's security defaults, then exec the server.
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

# Every start, not once: $HOME is a volume a compromised editor can write, and
# a restart is what the README says ends an incident. editor-settings.ts seeds
# the file when absent, and otherwise puts back only the settings it holds --
# the rest of the file is yours. tests/static/08-editor-hardening.sh holds the
# values; release/README.md says why.
if ! tsx /usr/local/lib/desolate/editor-settings.ts "$SETTINGS"; then
    echo "shell-entry: could not hold the editor's security settings; not starting" >&2
    exit 1
fi

# The gate between the browser and the server (editor-gate.ts): compose puts
# the server on this container's loopback and publishes the gate's port, so
# the editor is reached through it or not at all.
if [ -n "${DESOLATE_EDITOR_GATE:-}" ]; then
    node /usr/local/lib/desolate/editor-gate.ts "${DESOLATE_EDITOR_GATE%%:*}" "${DESOLATE_EDITOR_GATE#*:}" &
fi

exec "$@"
