#!/usr/bin/env bash
# Tab completion, asked the way bash asks it: the editor's `desolate`
# (release/vscode-image/completion.bash) and the Mac's cli.sh
# (release/completion.sh) offer what their parsers accept, where they accept
# it. And every flag a person can type is offered somewhere: a flag added to
# desolate-client.ts or args.ts without completion fails here.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

WS=$(mktemp -d)
trap 'rm -rf "$WS"' EXIT
mkdir -p "$WS/acme/app/.devcontainer" "$WS/acme/app/.worktrees/wip" "$WS/solo"
echo '{}' > "$WS/acme/app/.devcontainer/devcontainer.json"
echo '{}' > "$WS/solo/.devcontainer.json"

# shellcheck source=../../release/vscode-image/completion.bash
DESOLATE_WORKSPACES=$WS . "$ROOT/release/vscode-image/completion.bash"
# shellcheck source=../../release/completion.sh
. "$ROOT/release/completion.sh"
# The Mac's asks the editor container for these; here, the same fixture.
_desolate_cli_projects() { _desolate_projects; }
_desolate_cli_worktrees() { _desolate_worktrees "$1"; }

# What TAB offers, sorted, one line: <function> <cursor word index> <words...>.
offers_at() {
  local fn=$1 at=$2; shift 2
  COMP_WORDS=("$@"); COMP_CWORD=$at; COMPREPLY=()
  "$fn"
  [ "${#COMPREPLY[@]}" -gt 0 ] && printf '%s\n' "${COMPREPLY[@]}" | sort | tr '\n' ' ' | sed 's/ $//'
}
# ... with the cursor on the last word.
offers() { local fn=$1; shift; offers_at "$fn" $(( $# - 1 )) "$@"; }
editor() { offers _desolate_complete_desolate desolate "$@"; }
mac() { offers _desolate_cli cli.sh "$@"; }

group "the editor's desolate: what the client accepts, where"
assert_eq "--p: --ports, --push and --pull" "$(editor --p)" "--ports --pull --push"
assert_eq "--review's own flags" "$(editor --review --)" "--json --worktree"
assert_eq "--push --al: --allow-default, not --all" "$(editor --push --al)" "--allow-default"
assert_eq "--pull's own flags" "$(editor --pull --)" "--fetch-only --worktree"
assert_eq "--status takes --json alone" "$(editor --status --)" "--json"
assert_eq "--status, --push, --pull only as the first word" "$(editor acme/app --pu)" ""
assert_eq "beside --stop: --all and --worktree" "$(editor --stop --)" "--all --worktree"
assert_eq "beside --ports: --json, --move, --worktree" "$(editor --ports acme/app --)" "--json --move --worktree"
assert_eq "a flag on the line already is not offered again" "$(editor --push --worktree wip --)" "--allow-default"
assert_eq "--worktree: the project's worktrees" "$(editor acme/app --worktree "")" "wip"
assert_eq "  the project may come after the cursor" \
  "$(offers_at _desolate_complete_desolate 3 desolate --push --worktree "" acme/app)" "wip"
assert_eq "a project, once" "$(editor --push "")" "acme/app solo"
assert_eq "  and not a second" "$(editor --push acme/app "")" ""
assert_eq "--list takes none" "$(editor --list "")" ""
assert_eq "--move: a label, then a port" "$(editor --ports acme/app --move "")" "editor"

group "the Mac's cli.sh: the same, and its own verbs"
assert_contains "cli.sh desolate --s: --status, from the Mac too" "$(mac desolate --s)" "--status"
assert_eq "cli.sh desolate --status takes --json alone" "$(mac desolate --status --)" "--json"
assert_eq "cli.sh desolate beside --stop" "$(mac desolate --stop --)" "--all --worktree"
assert_eq "cli.sh push --al: --allow-default" "$(mac push acme/app --al)" "--allow-default"
assert_eq "cli.sh pull: its own flags" "$(mac pull acme/app --)" "--fetch-only --worktree"
assert_eq "cli.sh push --worktree: the project's worktrees" "$(mac push acme/app --worktree "")" "wip"
assert_eq "cli.sh exec: --worktree" "$(mac exec acme/app --)" "--worktree"
assert_eq "  and nothing after its --" "$(mac exec acme/app -- --)" ""
assert_eq "cli.sh secret add: its three flags" "$(mac secret add NAME --)" "--headers --hosts --projects"
assert_eq "  --headers: authorization" "$(mac secret add NAME --hosts x --headers "")" "authorization"
assert_eq "cli.sh suede report: --ref" "$(mac suede report acme/app --)" "--ref"
assert_eq "cli.sh suede deliver: the dependency is a project" "$(mac suede deliver acme/app "")" "acme/app solo"
assert_eq "cli.sh worktree remove: --force" "$(mac worktree remove acme/app wip --)" "--force"

group "every flag a person types is offered somewhere"
# The client's: every quoted --flag in desolate-client.ts.
offered=" $(editor --) $(editor --push --) $(editor --pull --) $(editor --status --) $(editor --review --) $(editor acme/app --) \
$(editor --stop --) $(editor --ports --) $(editor --list --) $(editor --rebuild --) "
missing=""
for flag in $(grep -o '"--[a-z-]*"' "$ROOT/release/vscode-image/desolate-client.ts" | tr -d '"' | sort -u); do
  [ "$flag" = --help ] && continue
  case "$offered" in *" $flag "*) ;; *) missing="$missing $flag" ;; esac
done
assert_eq "desolate-client.ts's flags, by the editor's completion" "${missing# }" ""
# The runner's: every `case "--flag":` in args.ts, offered by `cli.sh desolate`
# -- or the broker's and cli.sh's own wire form, typed by no one.
WIRE="--populate --uncommitted --create-worktree --remove-worktree --branch --from --force --reclaim --path
      --exec --bundle --pull --fetch-only --suede-report --suede-build --transfer --ref --review"
offered=" $(mac desolate --) $(mac desolate acme/app --) $(mac desolate --stop --) $(mac desolate --ports --) $(mac desolate --list --) "
missing=""
for flag in $(sed -n 's/^ *case "\(--[a-z-]*\)":.*/\1/p' "$ROOT/release/vscode-image/args.ts" | sort -u); do
  case " $(echo $WIRE) " in *" $flag "*) continue ;; esac
  case "$offered" in *" $flag "*) ;; *) missing="$missing $flag" ;; esac
done
assert_eq "args.ts's flags, by cli.sh desolate's completion" "${missing# }" ""
assert_contains "  (and the extraction found them)" "$offered" "--no-cache"

summary
