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

  # Position 2: this verb's subcommands, if it has any. `desolate` and
  # `worktree list` take a project here instead.
  if [ "$COMP_CWORD" -eq 2 ]; then
    case "$verb" in
      desolate) COMPREPLY=( $(compgen -W "$(_desolate_cli_projects)" -- "$cur") ) ;;
      logs)     COMPREPLY=( $(compgen -W "$(_desolate_cli_services)" -- "$cur") ) ;;
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
      # `secret add NAME --hosts a,b`: the name is new (nothing to offer), but
      # --hosts is required and is the flag people forget.
      [ "$COMP_CWORD" -eq 4 ] && COMPREPLY=( $(compgen -W "--hosts" -- "$cur") ) ;;
    "worktree list"|"worktree add"|"worktree remove")
      if [ "$COMP_CWORD" -eq 3 ]; then
        COMPREPLY=( $(compgen -W "$(_desolate_cli_projects)" -- "$cur") )
      elif [ "$COMP_CWORD" -eq 4 ] && [ "$sub" = remove ]; then
        COMPREPLY=( $(compgen -W "$(_desolate_cli_worktrees "${COMP_WORDS[3]}")" -- "$cur") )
      fi ;;
    "vm install")       COMPREPLY=( $(compgen -W "--proxy-only" -- "$cur") ) ;;
    "repo add")         : ;;   # owner/repo is remote; nothing local to offer
    *)
      # `cli.sh desolate <project> [flags]` -- desolate-run's grammar, which
      # lives in args.ts. Kept in sync by tests/unit/desolate/args.test.ts.
      [ "$verb" = desolate ] && \
        COMPREPLY=( $(compgen -W "--stop --ports --purge --rebuild --no-cache --worktree --config" -- "$cur") )
      ;;
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
