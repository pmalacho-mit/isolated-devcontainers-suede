# completion.bash -- tab completion for the wrappers this image installs.
# Sourced by every interactive bash in the image; see the Dockerfile note below.
#
# WHY THIS IS NOT IN ~/.bashrc
#
# $HOME is the `vscode-home` VOLUME. A file baked into the image under $HOME is
# shadowed the moment the volume mounts -- present in `docker build` output and
# absent in every actual run. Same trap shell-entry.sh documents for the editor
# settings. /etc/bash.bashrc is on the image's own filesystem and is read by
# interactive non-login shells (Debian's bash), and by login shells via
# /etc/profile, so it covers both a VS Code terminal and `cli.sh shell`.
#
# WHY NOTHING HERE SHELLS INTO tsx
#
# Every wrapper is `with-ca tsx /usr/local/lib/desolate/*.ts`, and node's cold
# start is several hundred milliseconds. Asking `desolate --list` for project
# names would put that between the TAB and the terminal answering, on every
# press. The rule projects.ts applies is small enough to restate in globs, and
# a glob is free.
#
# The restatement is the one duplication here worth paying for; tests/static
# should diff it against list.startable() on a fixture tree, the way
# tests/static/05 executes cli.sh's jq programs rather than eyeballing them.

_desolate_workspaces="${DESOLATE_WORKSPACES:-/workspaces}"

# A project is a directory one or two levels under /workspaces carrying a
# devcontainer spec (devcontainer.ts:hasConfig -- .devcontainer/devcontainer.json
# or .devcontainer.json). Globs skip dot-prefixed names, which is exactly the
# rule projects.ts spells out for .desolate and .worktrees.
_desolate_projects() {
    local c d
    ( cd "$_desolate_workspaces" 2>/dev/null || return 0
      for c in */.devcontainer/devcontainer.json */.devcontainer.json \
               */*/.devcontainer/devcontainer.json */*/.devcontainer.json; do
          [ -e "$c" ] || continue
          d=${c%/.devcontainer/devcontainer.json}
          d=${d%/.devcontainer.json}
          printf '%s\n' "$d"
      done ) | sort -u
}

# Directories under <project>/.worktrees. A worktree names a DIRECTORY, never a
# branch -- see the note on validWorktree in projects.ts.
_desolate_worktrees() {
    local d
    ( cd "$_desolate_workspaces/$1/.worktrees" 2>/dev/null || return 0
      for d in */; do [ -d "$d" ] && printf '%s\n' "${d%/}"; done )
}

# Branch names, for `worktree add <project> <name> [<branch>]`. Local refs only:
# asking git for remotes can touch the network, and a completion callback must
# never do that.
_desolate_branches() {
    git -C "$_desolate_workspaces/$1" for-each-ref \
        --format='%(refname:short)' refs/heads 2>/dev/null
}

# --- desolate (editor container: the broker client, desolate-client.ts) ------
# Flag list mirrors OPS + VALUES there. tests/unit should assert parity: the
# two parsers already have to agree with each other, and this is a third voice.
_desolate_complete_desolate() {
    local cur prev
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    COMPREPLY=()

    case "$prev" in
        --worktree)
            # Needs the project, which may sit anywhere on the line.
            local w p=
            for w in "${COMP_WORDS[@]:1}"; do
                [[ $w == -* ]] || { p=$w; break; }
            done
            COMPREPLY=( $(compgen -W "$(_desolate_worktrees "$p")" -- "$cur") )
            return 0 ;;
        --branch)
            local w p=
            for w in "${COMP_WORDS[@]:1}"; do
                [[ $w == -* ]] || { p=$w; break; }
            done
            COMPREPLY=( $(compgen -W "$(_desolate_branches "$p")" -- "$cur") )
            return 0 ;;
    esac

    if [[ $cur == -* ]]; then
        COMPREPLY=( $(compgen -W "--list --stop --ports --rebuild --worktree --branch" -- "$cur") )
    else
        COMPREPLY=( $(compgen -W "$(_desolate_projects)" -- "$cur") )
    fi
}

# --- desolate-run (orchestrator: the direct runner, args.ts) ----------------
_desolate_complete_desolate_run() {
    local cur prev
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    COMPREPLY=()

    case "$prev" in
        --config)   COMPREPLY=( $(compgen -f -- "$cur") ); return 0 ;;
        --worktree)
            local w p=
            for w in "${COMP_WORDS[@]:1}"; do
                [[ $w == -* ]] || { p=$w; break; }
            done
            COMPREPLY=( $(compgen -W "$(_desolate_worktrees "$p")" -- "$cur") )
            return 0 ;;
    esac

    if [[ $cur == -* ]]; then
        COMPREPLY=( $(compgen -W "--config --worktree --stop --ports --purge --rebuild --no-cache" -- "$cur") )
    else
        COMPREPLY=( $(compgen -W "$(_desolate_projects)" -- "$cur") )
    fi
}

# --- worktree (worktrees.ts) ------------------------------------------------
#   worktree list   <project>
#   worktree add    <project> <name> [<branch>]
#   worktree remove <project> <name>
_desolate_complete_worktree() {
    local cur sub
    cur="${COMP_WORDS[COMP_CWORD]}"
    sub="${COMP_WORDS[1]:-}"
    COMPREPLY=()

    case "$COMP_CWORD" in
        1) COMPREPLY=( $(compgen -W "list add remove" -- "$cur") ) ;;
        2) COMPREPLY=( $(compgen -W "$(_desolate_projects)" -- "$cur") ) ;;
        3) # `remove` names an existing worktree; `add` invents one.
           [ "$sub" = remove ] && \
             COMPREPLY=( $(compgen -W "$(_desolate_worktrees "${COMP_WORDS[2]}")" -- "$cur") ) ;;
        4) [ "$sub" = add ] && \
             COMPREPLY=( $(compgen -W "$(_desolate_branches "${COMP_WORDS[2]}")" -- "$cur") ) ;;
    esac
}

# --- newrepo (newrepo.ts) ---------------------------------------------------
# owner/repo is remote and unguessable; only the verbs are offerable.
_desolate_complete_newrepo() {
    local cur
    cur="${COMP_WORDS[COMP_CWORD]}"
    COMPREPLY=()
    [ "$COMP_CWORD" -eq 1 ] && \
        COMPREPLY=( $(compgen -W "key clone status" -- "$cur") )
}

complete -F _desolate_complete_desolate     desolate
complete -F _desolate_complete_desolate_run desolate-run
complete -F _desolate_complete_worktree     worktree
complete -F _desolate_complete_newrepo      newrepo
