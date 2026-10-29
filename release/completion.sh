#!/usr/bin/env bash
# completion.sh -- tab completion for cli.sh, on the Mac.
#
# Install by sourcing it from ~/.zshrc (or ~/.bashrc):
#
#   source /path/to/isolated-devcontainers-suede/release/completion.sh
#
# WHY THE COMMAND LIST IS NOT WRITTEN DOWN HERE
#
# It is read out of cli.sh's own dispatch, the same way tests/static/05 pulls
# SECRET_LIST_JQ out rather than retyping it. A hand-kept copy of the verb list
# is a second grammar: adding a subcommand to cli.sh would leave completion
# offering yesterday's, and nothing would fail. Extraction cannot drift.
#
# LATENCY IS THE DESIGN CONSTRAINT
#
# Everything a completion callback does happens between the user's TAB and the
# terminal responding. `docker exec` (~100ms) is affordable; `colima ssh`
# (~1s) is not, so secret names are cached below rather than fetched per press.
# Every dynamic lookup is also silenced and time-bounded: a completion that
# prints an error, or blocks on an unreachable VM, is worse than none.

_desolate_cli_root() {
  # Where cli.sh lives, resolved once at source time from THIS file's path
  # (they are siblings in release/).
  printf '%s' "${_DESOLATE_CLI_ROOT:?completion.sh: root not resolved}"
}

# ---------------------------------------------------------------------------
# Grammar, extracted from cli.sh
# ---------------------------------------------------------------------------

# Top-level verbs are the case labels at indent 2 in the dispatch; each
# subcommand is a label indented further, belonging to the last verb seen.
# `*)` (the catch-all that runs arbitrary commands in the editor) is skipped:
# it is not a name anyone completes toward.
#
# Emits lines:  CMD<TAB>up          /  SUB<TAB>secret<TAB>add
_desolate_cli_grammar() {
  awk '
    {
      if (match($0, /^ +[a-z|_*-]+\)/) == 0) next
      label = substr($0, 1, RLENGTH)
      sub(/\)$/, "", label)
      indent = match(label, /[^ ]/) - 1
      name = substr(label, indent + 1)
      if (name ~ /\*/) next
      # `shell|bash)` and `list|add)` are several names for one branch. Split
      # here rather than downstream, or the alternates lose their CMD/SUB tag.
      n = split(name, part, "|")
      if (indent == 2) {
        top = part[1]
        for (i = 1; i <= n; i++) print "CMD\t" part[i]
      } else if (top != "") {
        for (i = 1; i <= n; i++) print "SUB\t" top "\t" part[i]
      }
    }
  ' "$(_desolate_cli_root)/cli.sh" 2>/dev/null
}

_desolate_cli_verbs() {
  _desolate_cli_grammar | awk -F'\t' '$1=="CMD"{print $2}'
}

_desolate_cli_subs() {
  _desolate_cli_grammar | awk -F'\t' -v v="$1" '$1=="SUB" && $2==v {print $3}'
}

# ---------------------------------------------------------------------------
# Dynamic candidates
# ---------------------------------------------------------------------------

_desolate_cli_up() {
  docker inspect -f '{{.State.Status}}' desolate-vscode 2>/dev/null \
    | grep -qx running
}

# Startable projects, enumerated in the CONTAINER but in plain shell -- going
# through `desolate --list` would pay tsx's cold start on every TAB.
#
# This mirrors projects.ts: a directory one or two levels under /workspaces
# carrying .devcontainer/devcontainer.json or .devcontainer.json. Globs skip
# dot-prefixed names for free, which is the rule projects.ts spells out.
# tests/static should diff this against list.startable() on a fixture tree --
# it is a second copy of that rule, and the only one here worth having.
_desolate_cli_projects() {
  _desolate_cli_up || return 0
  docker exec desolate-vscode sh -c '
    cd /workspaces 2>/dev/null || exit 0
    for c in */.devcontainer/devcontainer.json */.devcontainer.json \
             */*/.devcontainer/devcontainer.json */*/.devcontainer.json; do
      [ -e "$c" ] || continue
      d=${c%/.devcontainer/devcontainer.json}
      d=${d%/.devcontainer.json}
      printf "%s\n" "$d"
    done' 2>/dev/null | sort -u
}

# Worktrees of one project: directories under <project>/.worktrees.
_desolate_cli_worktrees() {
  local project="$1"
  [ -n "$project" ] || return 0
  _desolate_cli_up || return 0
  docker exec desolate-vscode sh -c '
    cd "/workspaces/$1/.worktrees" 2>/dev/null || exit 0
    for d in */; do [ -d "$d" ] && printf "%s\n" "${d%/}"; done' _ "$project" 2>/dev/null
}

# Secret NAMES only -- never values, which is also why this is safe to cache.
# One `colima ssh` is ~1s, which is a visibly stuck TAB, so it is fetched at
# most once every 30s and served from a file in between.
_desolate_cli_secrets() {
  local cache="${TMPDIR:-/tmp}/.desolate-secret-names.$UID"
  local now age
  now=$(date +%s)
  if [ -f "$cache" ]; then
    age=$(( now - $(stat -f %m "$cache" 2>/dev/null || echo 0) ))
    [ "$age" -lt 30 ] && { cat "$cache"; return 0; }
  fi
  colima ssh -p "${COLIMA_PROFILE:-desolate}" -- \
    sudo jq -r '(.secrets//{})|keys[]' /etc/desolate-proxy/settings.json \
    2>/dev/null > "$cache" || : > "$cache"
  cat "$cache"
}

_desolate_cli_services() {
  local root; root=$(_desolate_cli_root)
  docker compose --project-directory "$root" -f "$root/docker-compose.yml" \
    config --services 2>/dev/null
}

# ---------------------------------------------------------------------------
# Reading the line
# ---------------------------------------------------------------------------
#
# Index loops rather than slices: under zsh's bashcompinit these run with
# KSH_ARRAYS (0-based, as in bash), and a plain loop means the same in both.

# The project on the line from <index> on: its first word that is neither a
# flag nor a flag's value, wherever it sits -- before the cursor or after it.
_desolate_cli_line_project() {
  local i=$1 skip=0 w
  while [ "$i" -lt "${#COMP_WORDS[@]}" ]; do
    w=${COMP_WORDS[i]}
    if [ "$skip" -gt 0 ]; then skip=$((skip - 1))   # a flag's value, the cursor's word too
    elif [ "$i" -eq "$COMP_CWORD" ]; then :
    else
      case "$w" in
        --worktree|--branch|--config|--ref|--hosts|--projects|--headers) skip=1 ;;
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
_desolate_cli_unused() {
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

# The first of <ops> on the line, if any.
_desolate_cli_line_op() {
  local i=1 op
  while [ "$i" -lt "${#COMP_WORDS[@]}" ]; do
    if [ "$i" -ne "$COMP_CWORD" ]; then
      for op in "$@"; do [ "${COMP_WORDS[i]}" = "$op" ] && { printf '%s' "$op"; return 0; }; done
    fi
    i=$((i + 1))
  done
}

# The flags <verb> takes at this point of the line. `desolate` is desolate-run's
# grammar (args.ts) -- the flags a person types, not the broker's wire form --
# except `--status`, which cli.sh hands to the editor's client. `push` and
# `pull` are the editor's `desolate --push/--pull` (desolate-client.ts).
# tests/static/17-completion.sh checks these against both parsers.
_desolate_cli_flags() {
  case "$1" in
    desolate)
      if [ "$COMP_CWORD" -gt 2 ] && [ "${COMP_WORDS[2]}" = --status ]; then echo "--json"; return; fi
      case "$(_desolate_cli_line_op --list --dinds --stop --ports --purge)" in
        --list)  echo "--json" ;;
        --dinds) ;;
        --stop)  echo "--all --worktree" ;;
        --ports) echo "--json --move --worktree" ;;
        --purge) echo "--worktree" ;;
        *)       [ "$COMP_CWORD" -eq 2 ] && printf '%s ' --status
                 echo "--list --dinds --stop --ports --purge --all --json --rebuild --no-cache --worktree --config" ;;
      esac ;;
    push) echo "--worktree --allow-default" ;;
    pull) echo "--worktree --fetch-only" ;;
    exec) echo "--worktree" ;;
  esac
}

# ---------------------------------------------------------------------------
# The completion function proper
# ---------------------------------------------------------------------------
#
# COMP_WORDS is every word on the line, COMP_CWORD the index of the one being
# completed. COMP_WORDS[0] is the command itself, so the first ARGUMENT is
# index 1: `cli.sh worktree remove myproj <TAB>` is CWORD 4, verb at 1.

_desolate_cli() {
  local cur verb sub words
  cur="${COMP_WORDS[COMP_CWORD]}"
  verb="${COMP_WORDS[1]:-}"
  sub="${COMP_WORDS[2]:-}"
  COMPREPLY=()

  # Position 1: the verb itself.
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$(_desolate_cli_verbs)" -- "$cur") )
    return 0
  fi

  # A project and its flags, in any order: `desolate`, `push`, `pull`, and
  # `exec` up to its `--`.
  case "$verb" in
    desolate|push|pull|exec)
      local prev i=2
      prev="${COMP_WORDS[COMP_CWORD-1]}"
      if [ "$verb" = exec ]; then
        while [ "$i" -lt "$COMP_CWORD" ]; do [ "${COMP_WORDS[i]}" = -- ] && return 0; i=$((i + 1)); done
      fi
      case "$prev" in
        --worktree) COMPREPLY=( $(compgen -W "$(_desolate_cli_worktrees "$(_desolate_cli_line_project 2)")" -- "$cur") ); return 0 ;;
        --config)   COMPREPLY=( $(compgen -f -- "$cur") ); return 0 ;;
        --move)     COMPREPLY=( $(compgen -W "editor" -- "$cur") ); return 0 ;;
      esac
      [ "$COMP_CWORD" -ge 3 ] && [ "${COMP_WORDS[COMP_CWORD-2]}" = --move ] && return 0
      case "$cur" in
        -*) COMPREPLY=( $(compgen -W "$(_desolate_cli_unused $(_desolate_cli_flags "$verb"))" -- "$cur") ) ;;
        *)  [ -z "$(_desolate_cli_line_project 2)" ] || return 0
            case "$verb $(_desolate_cli_line_op --list --dinds)" in
              "desolate --list"|"desolate --dinds") ;;
              *) COMPREPLY=( $(compgen -W "$(_desolate_cli_projects)" -- "$cur") ) ;;
            esac ;;
      esac
      return 0 ;;
  esac

  # Position 2: this verb's subcommands, if it has any. `worktree list` takes a
  # project here instead.
  if [ "$COMP_CWORD" -eq 2 ]; then
    case "$verb" in
      logs)     COMPREPLY=( $(compgen -W "$(_desolate_cli_services)" -- "$cur") ) ;;
      # A flag rather than a subcommand, so the grammar extraction above does
      # not see it -- and it is the one flag in this CLI that deletes something.
      reset-inner) COMPREPLY=( $(compgen -W "--reset-data-root" -- "$cur") ) ;;
      *)
        local subs; subs=$(_desolate_cli_subs "$verb")
        [ -n "$subs" ] && COMPREPLY=( $(compgen -W "$subs" -- "$cur") )
        ;;
    esac
    return 0
  fi

  # Position 3+: whatever the verb+subcommand pair takes.
  case "$verb $sub" in
    "secret rm")        COMPREPLY=( $(compgen -W "$(_desolate_cli_secrets)" -- "$cur") ) ;;
    "secret add")
      # `secret add NAME --hosts a,b [--projects p,q] [--headers authorization]`:
      # the name is new (nothing to offer); --hosts is required, and is the
      # flag people forget, so it is offered whatever has been typed.
      case "${COMP_WORDS[COMP_CWORD-1]}" in
        --projects) COMPREPLY=( $(compgen -W "$(_desolate_cli_projects)" -- "$cur") ) ;;
        --headers)  COMPREPLY=( $(compgen -W "authorization" -- "$cur") ) ;;
        --hosts)    ;;
        *) [ "$COMP_CWORD" -ge 4 ] && COMPREPLY=( $(compgen -W "$(_desolate_cli_unused --hosts --projects --headers)" -- "$cur") ) ;;
      esac ;;
    "suede deliver")
      # `suede deliver <project> <owner/repo>`: the dependency is a project too.
      [ "$COMP_CWORD" -le 4 ] && COMPREPLY=( $(compgen -W "$(_desolate_cli_projects)" -- "$cur") ) ;;
    "suede report"|"suede upstream")
      # `report <project> [--ref <ref>]`, `upstream <project> <dir> [--ref <ref>]`.
      if [ "$COMP_CWORD" -eq 3 ]; then
        COMPREPLY=( $(compgen -W "$(_desolate_cli_projects)" -- "$cur") )
      elif [ "${COMP_WORDS[COMP_CWORD-1]}" != --ref ]; then
        case "$cur" in -*) COMPREPLY=( $(compgen -W "$(_desolate_cli_unused --ref)" -- "$cur") ) ;; esac
      fi ;;
    "worktree list"|"worktree add"|"worktree remove")
      if [ "$COMP_CWORD" -eq 3 ]; then
        COMPREPLY=( $(compgen -W "$(_desolate_cli_projects)" -- "$cur") )
      elif [ "$COMP_CWORD" -eq 4 ] && [ "$sub" = remove ]; then
        COMPREPLY=( $(compgen -W "$(_desolate_cli_worktrees "${COMP_WORDS[3]}")" -- "$cur") )
      elif [ "$COMP_CWORD" -eq 5 ] && [ "$sub" = remove ]; then
        COMPREPLY=( $(compgen -W "--force" -- "$cur") )
      fi ;;
    "vm install")       COMPREPLY=( $(compgen -W "--proxy-only" -- "$cur") ) ;;
    "dind reset")
      if [ "$COMP_CWORD" -eq 3 ]; then
        COMPREPLY=( $(compgen -W "$(_desolate_cli_projects)" -- "$cur") )
      elif [ "$COMP_CWORD" -eq 4 ]; then
        COMPREPLY=( $(compgen -W "--reset-data-root" -- "$cur") )
      fi ;;
    "dind gc")
      [ "$COMP_CWORD" -eq 3 ] && \
        COMPREPLY=( $(compgen -W "--all --orphans $(_desolate_cli_projects)" -- "$cur") ) ;;
    "repo add")         : ;;   # owner/repo is remote; nothing local to offer
  esac
  return 0
}

# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

# Resolve our own directory once, so the grammar extraction has a path to read.
if [ -n "${BASH_SOURCE:-}" ]; then
  _DESOLATE_CLI_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
else
  _DESOLATE_CLI_ROOT=${0:A:h}          # zsh, when sourced directly
fi

if [ -n "${ZSH_VERSION:-}" ]; then
  # zsh speaks its own completion API, but can run bash-style functions --
  # bashcompinit provides `complete` and the COMP_* globals. compinit must have
  # run first; sourcing this from ~/.zshrc AFTER any `compinit` line is enough.
  autoload -U +X compinit    && compinit -C 2>/dev/null
  autoload -U +X bashcompinit && bashcompinit
fi

# Registered under the bare name: bash (and zsh's shim) fall back to the
# portion after the final slash, so `./cli.sh` and an absolute path both hit it.
complete -F _desolate_cli cli.sh
