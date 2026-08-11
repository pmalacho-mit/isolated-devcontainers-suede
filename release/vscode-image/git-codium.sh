#!/usr/bin/env bash
# git-codium.sh -- the shim git runs whenever it wants an editor, a diff, or a
# three-way merge. Installed to /usr/local/bin/git-codium and wired up by
# /etc/gitconfig (this image) or .devcontainer/setup-git.sh (this repo's own
# container). Not meant to be called by hand.
#
#   git-codium edit  <file>                                core.editor
#   git-codium diff  <local> <remote>                      difftool.codium.cmd
#   git-codium merge <remote> <local> <base> <merged>      mergetool.codium.cmd
#
# This exists because the outer editor has no git extension -- see the pruning
# step in the Dockerfile for why it must not have one -- and so no Source
# Control view and no diff editor. What it does have is a codium the user is
# already looking at, and a CLI that can open a diff in it. The distinction that
# keeps the pruning meaningful is WHO invokes git: here it is the user typing
# `git difftool`, never an extension host doing it to a repository on its own.
#
# Why a shim, rather than putting `codium --wait --diff` straight into git
# config: git is not only run from an editor terminal. Hooks, `docker exec`, CI
# and the agent CLIs all run git in places where the codium CLI has no window to
# draw in, and a core.editor that fails there turns `git commit` into a dead end
# with no visible cause. Every mode below therefore degrades to something that
# works on a bare TTY.
set -euo pipefail

usage() {
    echo "usage: ${0##*/} edit|diff|merge <args...>" >&2
    exit 2
}

[ $# -ge 1 ] || usage
mode=$1
shift

# The CLI ships in the editor server's remote-cli directory. VS Code puts that
# directory on PATH for terminals it spawns, which covers the case that matters;
# the rest of the list is for everything else, and spans both layers -- the
# outer shell runs the pruned tree, a devcontainer runs its own server.
codium=""
for candidate in \
    "$(command -v codium 2>/dev/null || true)" \
    "${DESOLATE_SHELL_ROOT:+$DESOLATE_SHELL_ROOT/bin/remote-cli/codium}" \
    "${DESOLATE_SERVER_ROOT:+$DESOLATE_SERVER_ROOT/bin/remote-cli/codium}" \
    /home/.desolate-shell/bin/remote-cli/codium \
    /vscode-server/bin/remote-cli/codium; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
        codium=$candidate
        break
    fi
done

# VSCODE_IPC_HOOK_CLI is the socket the CLI hands the file over on. Without it
# the CLI has no window to reach and exits non-zero -- and for a difftool that
# is worse than not trying at all, because git deletes the temp copies it made
# the instant we return, leaving an error and nothing to look at. Require the
# socket up front rather than discovering its absence mid-diff.
if [ -n "$codium" ] && [ -n "${VSCODE_IPC_HOOK_CLI:-}" ]; then
    # --wait is what makes any of this usable: it returns only when the tab is
    # closed, which is the signal git waits on before cleaning up its temp
    # copies or moving on to the next file.
    case "$mode" in
    edit) exec "$codium" --wait "$@" ;;
    diff) exec "$codium" --wait --diff "$1" "$2" ;;
    merge) exec "$codium" --wait --merge "$1" "$2" "$3" "$4" ;;
    *) usage ;;
    esac
fi

# ---------------------------------------------------------------- fallbacks --
case "$mode" in
edit)
    exec "${GIT_CODIUM_FALLBACK_EDITOR:-vim}" "$@"
    ;;
diff)
    # difftastic, where it is installed, is already what plain `git diff`
    # renders with, so a terminal difftool that looks identical is the least
    # surprising thing to land on.
    if command -v difftastic >/dev/null 2>&1; then
        exec difftastic "$1" "$2"
    fi
    # --no-ext-diff so this cannot recurse back into an external differ that
    # may be the thing that just failed to run.
    exec git --no-pager diff --no-index --no-ext-diff -- "$1" "$2"
    ;;
merge)
    # No safe terminal equivalent: silently resolving conflicts in a tool the
    # user did not choose is how a bad merge gets committed. Say so and stop.
    echo "git-codium: no codium window available to merge in." >&2
    echo "            run this from a terminal inside the editor, or:" >&2
    echo "            git mergetool --tool=vimdiff" >&2
    exit 1
    ;;
*)
    usage
    ;;
esac
