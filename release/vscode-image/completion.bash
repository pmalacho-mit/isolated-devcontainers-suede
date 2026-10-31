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
# As projects.ts lists them: a top-level directory with a spec is a project,
# and its subdirectories are its source, never projects -- so a project cannot
# put a "project" of its own choosing on this list. One without a spec is an
# owner, whose children with a spec are projects.
_desolate_has_spec() { [ -e "$1/.devcontainer/devcontainer.json" ] || [ -e "$1/.devcontainer.json" ]; }
_desolate_projects() {
    local top sub
    ( cd "$_desolate_workspaces" 2>/dev/null || return 0
      for top in */; do
          top=${top%/}
          if _desolate_has_spec "$top"; then printf '%s\n' "$top"; continue; fi
          for sub in "$top"/*/; do
              sub=${sub%/}
              _desolate_has_spec "$sub" && printf '%s\n' "$sub"
          done
      done ) 2>/dev/null | sort -u
}

# Offer each line of stdin that begins with the word being completed -- never
# through `compgen -W`, which EXPANDS its word list: a directory a project made
# under its .worktrees, a branch it named, a subdirectory it gave a spec --
# `$(...)` and all -- would run here, in the editor, beside the keys. <kind>
# says how the words must be spelled, as the parsers (projects.ts, worktrees.ts)
# will insist; anything else is left unoffered, since what is offered is
# inserted into the line as it is.
_desolate_offer() {   # <kind> <producer...>
    local kind=$1 w; shift
    while IFS= read -r w; do
        case "$kind" in
            project)  [[ $w =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$ ]] || continue ;;
            worktree) [[ $w =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || continue ;;
            branch)   [[ $w =~ ^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,254}$ ]] || continue ;;
            *) return 1 ;;
        esac
        case "$w" in *__*|*--wt--*) continue ;; esac   # names no namespace can hold
        [[ $w == "$cur"* ]] && COMPREPLY+=("$w")
    done < <("$@")   # not a pipeline: that would fill COMPREPLY in a subshell
    return 0
}

# Directories under <project>/.worktrees. A worktree names a DIRECTORY, never a
# branch -- see the note on validWorktree in projects.ts.
_desolate_worktrees() {
    local d
    ( cd "$_desolate_workspaces/$1/.worktrees" 2>/dev/null || return 0
      for d in */; do [ -d "$d" ] && printf '%s\n' "${d%/}"; done )
}

# `all` is offerable as a project word only where --stop is on the line, which
# is the one command that reads it as "every running target". A real project of
# that name completes from _desolate_projects either way, and takes precedence
# at the runner -- see meansEveryTarget in projects.ts.
_desolate_project_words() { _desolate_projects; _desolate_all_word; }
_desolate_all_word() {
    local w
    for w in "${COMP_WORDS[@]}"; do
        [ "$w" = --stop ] && { printf 'all\n'; return 0; }
    done
}

# Branch names, for `worktree add <project> <name> [<branch>]`. Local refs only:
# asking git for remotes can touch the network, and a completion callback must
# never do that. And no git at all: this runs in the editor, over a repository
# whose config the project writes (worktrees.ts: git runs in the sandbox). The
# refs are files, read as files -- loose ones under refs/heads, packed ones in
# packed-refs; a repository in another ref format completes none, which is the
# worst this can do.
_desolate_branches() {
    local git="$_desolate_workspaces/$1/.git"
    [ -d "$git" ] || return 0
    ( cd "$git/refs/heads" 2>/dev/null && find . -type f 2>/dev/null | sed 's|^\./||'
      sed -n 's|^[0-9a-fA-F]\{40,64\} refs/heads/||p' "$git/packed-refs" 2>/dev/null ) | sort -u
}

# The project on the line: its first word that is neither a flag nor a flag's
# value, wherever it sits -- before the cursor or after it.
_desolate_line_project() {
    local i=1 skip=0 w
    while [ "$i" -lt "${#COMP_WORDS[@]}" ]; do
        w=${COMP_WORDS[i]}
        if [ "$skip" -gt 0 ]; then skip=$((skip - 1))   # a flag's value, the cursor's word too
        elif [ "$i" -eq "$COMP_CWORD" ]; then :
        else
            case "$w" in
                --worktree|--branch|--config|--expect) skip=1 ;;
                --move) skip=2 ;;
                -*) ;;
                *) printf '%s' "$w"; return 0 ;;
            esac
        fi
        i=$((i + 1))
    done
}

# Those of the flags given that are not on the line yet (the word being
# completed aside).
_desolate_unused() {
    local f i seen
    for f in "$@"; do
        seen= i=1
        while [ "$i" -lt "${#COMP_WORDS[@]}" ]; do
            [ "$i" -ne "$COMP_CWORD" ] && [ "${COMP_WORDS[i]}" = "$f" ] && { seen=1; break; }
            i=$((i + 1))
        done
        [ -n "$seen" ] || printf '%s\n' "$f"
    done
}

# The operation already on the line, if any: one of <ops>.
_desolate_line_op() {
    local i=1 op
    while [ "$i" -lt "${#COMP_WORDS[@]}" ]; do
        if [ "$i" -ne "$COMP_CWORD" ]; then
            for op in "$@"; do [ "${COMP_WORDS[i]}" = "$op" ] && { printf '%s' "$op"; return 0; }; done
        fi
        i=$((i + 1))
    done
}

# --- desolate (editor container: the broker client, desolate-client.ts) ------
# What it accepts where, as desolate-client.ts reads it: --status, --push,
# --pull and --review only as the first word, each with its own flags; otherwise one of OPS
# with the MODIFIERS and VALUES that mean something beside it.
# tests/static/17-completion.sh checks every flag the client knows is offered.
_desolate_complete_desolate() {
    local cur prev first op= flags
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    first="${COMP_WORDS[1]:-}"
    COMPREPLY=()

    case "$prev" in
        --worktree)
            _desolate_offer worktree _desolate_worktrees "$(_desolate_line_project)"
            return 0 ;;
        --branch)
            _desolate_offer branch _desolate_branches "$(_desolate_line_project)"
            return 0 ;;
        --move) COMPREPLY=( $(compgen -W "editor" -- "$cur") ); return 0 ;;
    esac
    # --move's second value is a host port: nothing to offer.
    [ "$COMP_CWORD" -ge 2 ] && [ "${COMP_WORDS[COMP_CWORD-2]}" = --move ] && return 0

    [ "$COMP_CWORD" -eq 1 ] && first=
    case "$first" in
        --status) flags="--json" ;;
        --push)   flags="--worktree --allow-default --expect" ;;
        --pull)   flags="--worktree --fetch-only" ;;
        --review) flags="--worktree --json" ;;
        *)
            op=$(_desolate_line_op --list --dinds --stop --ports --rebuild)
            case "$op" in
                --list)    flags="--json" ;;
                --dinds)   flags="" ;;
                --stop)    flags="--all --worktree" ;;
                --ports)   flags="--json --move --worktree" ;;
                --rebuild) flags="--worktree --branch" ;;
                *)         flags="--list --dinds --stop --ports --rebuild --all --json --worktree --branch"
                           [ "$COMP_CWORD" -eq 1 ] && flags="--status --push --pull --review $flags" ;;
            esac ;;
    esac

    if [[ $cur == -* ]]; then
        COMPREPLY=( $(compgen -W "$(_desolate_unused $flags)" -- "$cur") )
    elif [ -z "$(_desolate_line_project)" ]; then
        # One project at most, and none for what acts on every target.
        case "$first $op" in
            "--status "*|"--push "*|"--pull "*|"--review "*) COMPREPLY=( $(compgen -W "$(_desolate_projects)" -- "$cur") ) ;;
            *" --list"|*" --dinds") ;;
            *) _desolate_offer project _desolate_project_words ;;
        esac
    fi
}

# --- desolate-run (orchestrator: the direct runner, args.ts) ----------------
# The flags a person types; the rest of args.ts is the broker's wire form.
_desolate_complete_desolate_run() {
    local cur prev
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    COMPREPLY=()

    case "$prev" in
        --config)   COMPREPLY=( $(compgen -f -- "$cur") ); return 0 ;;
        --worktree)
            _desolate_offer worktree _desolate_worktrees "$(_desolate_line_project)"
            return 0 ;;
    esac

    if [[ $cur == -* ]]; then
        COMPREPLY=( $(compgen -W "$(_desolate_unused --config --worktree --list --dinds --stop --all --ports --move --json --purge --rebuild --no-cache)" -- "$cur") )
    elif [ -z "$(_desolate_line_project)" ]; then
        _desolate_offer project _desolate_project_words
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
        2) _desolate_offer project _desolate_projects ;;
        3) # `remove` names an existing worktree; `add` invents one.
           [ "$sub" = remove ] && \
             _desolate_offer worktree _desolate_worktrees "${COMP_WORDS[2]}" ;;
        4) [ "$sub" = add ] && \
             _desolate_offer branch _desolate_branches "${COMP_WORDS[2]}" ;;
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
