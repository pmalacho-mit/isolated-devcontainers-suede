#!/usr/bin/env bash
# examples/factory/claude/claude-helper.sh -- Claude Code in a desolate target, on your subscription.
#
#   claude-helper.sh auth   <project> [--scoped] [--renew]
#   claude-helper.sh start  <project> [--worktree w] [--session s] [--task text | --task-file f] [-- claude args...]
#   claude-helper.sh resume <project> [--worktree w] [--session s] [--task text]
#   claude-helper.sh attach <project> [--worktree w] [--session s]
#   claude-helper.sh stop   <project> [--worktree w] [--session s]
#   claude-helper.sh verify <project> [n]
#
# Runs on your Mac. Built on desolate's primitives (docs/agents.md): a secret,
# `cli.sh exec`, the status through `.git`, and the proxy's audit. Used by
# claude-dispatcher.sh beside it; usable on its own.
#
# auth   Makes sure the VM holds a subscription token: the placeholder
#        DESOLATE-CLAUDE-OAUTH, substituted only toward api.anthropic.com, and
#        only in a request's Authorization header -- never a body, where the
#        model could be asked to hand the real value back transformed (addon.py
#        "A SECRET CONFINED TO HEADERS"). For any source -- or, with --scoped,
#        DESOLATE-CLAUDE-<project>-OAUTH, only for requests from that project's
#        own daemon (which it then needs). A token stored without the
#        confinement is not used: auth --renew stores a new one, confined.
#        Missing, or with --renew, it runs `claude setup-token` here (a
#        browser; a Pro, Max, Team or Enterprise plan) and asks you to paste
#        what it prints -- into `cli.sh secret add`, never into a file or argv.
#        The real token never enters a container.
#
# start  Starts `claude` in a detached tmux session in the running target, as
#        its user, in its workspace folder, with the task as its first prompt.
#        No tmux or claude there: installs them (tmux with the image's package
#        manager, as root or through passwordless sudo; claude with its native
#        installer, into ~/.local/bin), and tells the agent, in its task, that
#        the devcontainer config should carry them -- a rebuild loses them.
#        Claude's process gets CLAUDE_CODE_OAUTH_TOKEN=<the placeholder> and
#        nothing that outranks it -- measured on Claude Code 2.1.311:
#          * ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, apiKeyHelper and the cloud
#            provider switches all beat the OAuth token, so they are unset in
#            its environment, and blanked through --settings, which beats what
#            the repository's own .claude/settings.json says (a committed
#            apiKeyHelper or env.ANTHROPIC_AUTH_TOKEN otherwise wins silently);
#          * the token goes out as `Authorization: Bearer <placeholder>`, which
#            the proxy swaps for the real one.
#        A project's own ANTHROPIC_API_KEY is not lost: Claude's shell commands
#        get it back (a SessionStart hook writes it to CLAUDE_ENV_FILE), so the
#        code under test still has it; only Claude's own auth never sees it.
#        Onboarding and the folder's trust dialog are pre-answered in
#        ~/.claude.json (undocumented keys; if a later Claude ignores them,
#        you will find the question waiting when you attach). Claude's own
#        events become the target's status: a failed login red ("claude:
#        authentication failed"), another failure red, a permission prompt
#        orange, waiting on you orange unless the agent already said green.
#
# resume Ends the session and starts it again on the same conversation
#        (`claude -c`), told to carry on -- after `auth --renew`, say.
#
# attach Opens the session here (detach again: ctrl-b d). From the target's
#        own editor terminal it is `tmux attach -t claude`.
#
# verify Which secret each recent request from this project to
#        api.anthropic.com carried, from the proxy's audit. Every one should be
#        the subscription placeholder.
#
# Environment: DESOLATE_CLI (path to cli.sh; default: this checkout's),
# DESOLATE_STATUS_HELPER (the helper's path inside the target),
# CLAUDE_VERSION (what the native installer installs; default: its latest).
set -euo pipefail

usage() { sed -n '4,9p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI=${DESOLATE_CLI:-$HERE/../../../release/cli.sh}
STATUS_HELPER=${DESOLATE_STATUS_HELPER:-/desolate/status}   # where it is inside the target
die() { echo "claude-helper: $*" >&2; exit 1; }
say() { echo "claude-helper: $*"; }

[ $# -ge 2 ] || usage
CMD=$1 PROJECT=$2; shift 2
WT=() SESSION=claude TASK="" HAS_TASK="" SCOPED="" RENEW="" RESUME="" N=200 CLAUDE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WT=(--worktree "${2:?--worktree takes a name}"); shift 2 ;;
    --session) SESSION=${2:?}; shift 2 ;;
    --task) TASK=${2?}; HAS_TASK=1; shift 2 ;;
    --task-file) TASK=$(cat "${2:?}"); HAS_TASK=1; shift 2 ;;
    --scoped) SCOPED=1; shift ;;
    --renew) RENEW=1; shift ;;
    --) shift; CLAUDE_ARGS=("$@"); break ;;
    [0-9]*) N=$1; shift ;;
    *) usage ;;
  esac
done
case "$SESSION" in *[!A-Za-z0-9_-]*|"") die "a session name is [A-Za-z0-9_-]" ;; esac

# The placeholders. One for every project by default: the token can only be
# spent toward api.anthropic.com, which bounds what any container could do
# with it to your subscription's use (docs/agents.md). One per project with
# --scoped, and then only from its own daemon. Spelled so neither contains the
# other (the proxy substitutes by plain string replace; cli.sh refuses overlaps).
SHARED=DESOLATE-CLAUDE-OAUTH
SCOPED_NAME="DESOLATE-CLAUDE-${PROJECT//\//__}-OAUTH"

# `secret list` lines: "  NAME  ->  host, host   (only for: p, q)"
# Read once per run (each read is a trip into the VM), again after a change.
SECRETS=""
load_secrets() { SECRETS=$("$CLI" secret list) || die "could not list the VM's secrets"; }
secrets() { printf '%s\n' "$SECRETS"; }
secret_line() { secrets | awk -v n="$1" '$1 == n'; }
scoped_to_project() { case "$1" in *"(only for: "*) printf '%s' "${1#*(only for: }" | tr -d ')' | tr ',' '\n' | sed 's/^ *//' | grep -qxF "$PROJECT" ;; *) return 1 ;; esac; }
reaches_project() { [[ "$1" != *"(only for: "* ]] || scoped_to_project "$1"; }
confined() { [[ "$1" == *"[headers: authorization]"* ]]; }

# The placeholder this project's Claude uses: its own, if it has one.
in_use() {
  local line
  line=$(secret_line "$SCOPED_NAME"); [ -z "$line" ] || { echo "$SCOPED_NAME"; return; }
  line=$(secret_line "$SHARED"); [ -z "$line" ] || ! reaches_project "$line" || echo "$SHARED"
}

# Anything else this project can spend at api.anthropic.com: if it is an API
# key, it is how a misconfigured Claude would bill per token instead.
others_at_anthropic() {
  secrets | awk -v a="$SHARED" -v b="$SCOPED_NAME" '$1 != a && $1 != b && $2 == "->"' | while IFS= read -r line; do
    case "$line" in *api.anthropic.com*|*'*.anthropic.com'*) ;; *) continue ;; esac
    reaches_project "$line" || continue
    awk '{print $1}' <<< "$line"
  done
}

auth() {
  local name line
  if [ -n "$SCOPED" ]; then name=$SCOPED_NAME; else name=$(in_use); name=${name:-$SHARED}; fi
  line=$(secret_line "$name")
  if [ -n "$line" ] && [ -z "$RENEW" ] && ! confined "$line"; then
    # Stored before the proxy could confine it: substituted into bodies too, so
    # any container that could spend it could also have recovered it.
    echo "claude-helper: $name is stored, but not confined to the Authorization header -- any container that could spend it could also recover it. Storing a NEW token, confined (revoke the old one in your Claude account)." >&2
    RENEW=1
  fi
  if [ -n "$line" ] && [ -z "$RENEW" ]; then
    reaches_project "$line" || die "$name is stored but scoped to other projects: $line"
    if [[ "$line" == *"(only for: "* ]]; then say "$name is stored, for $PROJECT only, in Authorization alone"; else say "$name is stored, for any project, in Authorization alone"; fi
  else
    if [ ! -t 0 ]; then
      if [ -n "$RENEW" ]; then die "$name needs a new token; run: $0 auth $PROJECT${SCOPED:+ --scoped} --renew (in a terminal)"; fi
      die "$name is not stored; run: $0 auth $PROJECT${SCOPED:+ --scoped} (in a terminal)"
    fi
    if command -v claude >/dev/null; then
      say "running 'claude setup-token' -- finish it in the browser; it prints a token valid for a year."
      claude setup-token || die "claude setup-token failed"
    else
      say "no claude on this Mac. Install it (https://code.claude.com), run 'claude setup-token', and paste its token here."
    fi
    printf 'paste the token (hidden): ' >&2
    local token; IFS= read -rs token; echo >&2
    token=${token//[[:space:]]/}
    [ -n "$token" ] || die "no token"
    case "$token" in sk-ant-oat*) ;; sk-ant-api*) die "that is an API key, which bills per token -- this wants the setup-token OAuth token" ;; *) echo "claude-helper: that does not look like an OAuth token (sk-ant-oat...); storing it anyway" >&2 ;; esac
    local scope=(); [ "$name" != "$SCOPED_NAME" ] || scope=(--projects "$PROJECT")
    printf '%s\n' "$token" | "$CLI" secret add "$name" --hosts api.anthropic.com --headers authorization ${scope[@]+"${scope[@]}"} >/dev/null \
      || die "could not store $name"
    unset token
    say "stored $name for ${scope[1]:-any source}, toward api.anthropic.com, in Authorization alone"
    [ -z "$RENEW" ] || say "the old token still works until you revoke it in your Claude account"
    load_secrets
  fi
  local others; others=$(others_at_anthropic | paste -sd, -)
  [ -z "$others" ] || echo "claude-helper: note: $PROJECT can also send $others to api.anthropic.com. start keeps Claude's auth off them; 'verify' shows what each request carried." >&2
}

# The target's row in `desolate --list --json`, or nothing when it is stopped.
running_row() {
  local want=$PROJECT; [ ${#WT[@]} -eq 0 ] || want="$PROJECT@${WT[1]}"
  "$CLI" desolate --list --json | sed -n '/^\[/p' | tail -n 1 | jq -c --arg t "$want" '.[]? | select(.target == $t)'
}

# What runs in the target, as its user, in its workspace folder: $1 the session,
# $2 the placeholder, $3 the status helper, $4 1 when the task is on stdin,
# $5 1 to end a running session and continue its conversation, $6 the claude
# version to install if it is missing, the rest Claude's own arguments.
# Everything it writes is under the user's state dir, outside the repository.
read -r -d '' REMOTE <<'REMOTE' || true
set -euo pipefail
session=$1 placeholder=$2 status=$3 has_task=$4 resume=$5 version=$6; shift 6
say() { echo "claude-helper: $*" >&2; }
export PATH="$HOME/.local/bin:$PATH"
dir=${XDG_STATE_HOME:-$HOME/.local/state}/desolate-claude/$session
mkdir -p "$dir"
log=$dir/install.log

# What is missing, installed for this session -- and said, since a rebuild
# loses it. tmux with the image's package manager, which needs root: this
# user's, or passwordless sudo. claude with its native installer, as this user.
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif command -v sudo >/dev/null && sudo -n true 2>/dev/null; then sudo -n "$@"
  else echo "no root here, and no passwordless sudo"; return 1; fi
}
pkg() {
  if command -v apt-get >/dev/null; then
    as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@"
  elif command -v apk >/dev/null; then as_root apk add --no-cache "$@"
  elif command -v dnf >/dev/null; then as_root dnf install -y -q "$@"
  elif command -v yum >/dev/null; then as_root yum install -y -q "$@"
  else echo "no package manager this knows"; return 1; fi
}
failed() { say "could not install $1 here (see $log):"; tail -n 5 "$log" >&2; say "$2"; exit 3; }
installed=""
if ! command -v tmux >/dev/null; then
  say "no tmux in this devcontainer; installing it"
  pkg tmux >>"$log" 2>&1 || failed tmux "Add tmux to the image, then rebuild."
  installed="$installed tmux"
fi
if ! command -v claude >/dev/null; then
  say "no claude in this devcontainer; installing it${version:+ ($version)}"
  command -v curl >/dev/null || pkg curl ca-certificates >>"$log" 2>&1 || failed curl "Add curl, or claude itself, to the image."
  curl -fsSL https://claude.ai/install.sh | bash -s -- ${version:+"$version"} >>"$log" 2>&1 && command -v claude >/dev/null \
    || failed claude "Add the feature ghcr.io/anthropics/devcontainer-features/claude-code:1 to devcontainer.json, then rebuild."
  installed="$installed claude"
fi

if tmux has-session -t "=$session" 2>/dev/null; then
  [ "$resume" = 1 ] || { say "session '$session' is already running here; attach to it, or stop it first"; exit 4; }
  tmux kill-session -t "=$session"
fi
[ "$resume" != 1 ] || set -- -c "$@"
if [ "$has_task" = 1 ]; then cat > "$dir/task"; else : > "$dir/task"; fi
if [ -n "$installed" ] && [ -s "$dir/task" ]; then
  cat >> "$dir/task" <<NOTE

A note from the harness that started you: this devcontainer did not have$installed, so it installed them for this session; a rebuild loses them. Consider updating the devcontainer config so they are there from the start -- the feature "ghcr.io/anthropics/devcontainer-features/claude-code:1" for claude, tmux in the image -- or, if that change is not yours to make, say so in your status or your PR.
NOTE
fi
[ -z "$installed" ] || say "installed$installed for this session (a rebuild loses them; the agent was told)"

# A container made before desolate's directory moved has it at /desolate-ca
# (the same files; the new names are there too). Use it, and say so.
if [ ! -e /desolate ] && [ -d /desolate-ca ]; then
  case "$status" in /desolate/*) status=/desolate-ca/${status#/desolate/} ;; esac
  [ ! -s "$dir/task" ] || printf '\n%s\n' "In this container desolate's directory is at /desolate-ca, not /desolate (it was made before the move): read every /desolate/ above as /desolate-ca/." >> "$dir/task"
  say "this devcontainer predates /desolate; using /desolate-ca (a rebuild moves it)"
fi

# Claude's events, as this target's status. Fields read with sed: no jq needed.
cat > "$dir/hook" <<HOOK
#!/bin/sh
field() { sed -n "s/.*\"\$1\":\"\\([^\"]*\\)\".*/\\1/p" | head -n 1; }
input=\$(cat)
current=\$($status show 2>/dev/null | sed -n 's/.*"color":"\\([a-z]*\\)".*/\\1/p')
case "\$1" in
  start)  # the project's own ANTHROPIC_API_KEY, back for Claude's shell commands only
          [ -z "\${CLAUDE_ENV_FILE:-}" ] || [ ! -s "$dir/project-env" ] || cat "$dir/project-env" >> "\$CLAUDE_ENV_FILE" ;;
  failed) error=\$(printf '%s' "\$input" | field error)
          case "\$error" in authentication_failed) what="authentication failed" ;; *) what="stopped: \${error:-an error}" ;; esac
          $status set red "claude: \$what" ;;
  permission) $status set orange "claude: \$(printf '%s' "\$input" | field message)" ;;
  idle)   case "\$current" in green|orange|red) ;; *) $status set orange "claude is waiting for you" ;; esac ;;
esac
exit 0
HOOK
chmod +x "$dir/hook"

# Blank, at a precedence the repository's settings cannot beat, everything
# that would take Claude's auth off the subscription token.
cat > "$dir/settings.json" <<JSON
{
  "apiKeyHelper": "",
  "env": { "ANTHROPIC_API_KEY": "", "ANTHROPIC_AUTH_TOKEN": "", "CLAUDE_CODE_USE_BEDROCK": "",
           "CLAUDE_CODE_USE_VERTEX": "", "CLAUDE_CODE_USE_FOUNDRY": "" },
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "$dir/hook start" }] }],
    "StopFailure":  [{ "hooks": [{ "type": "command", "command": "$dir/hook failed" }] }],
    "Notification": [{ "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "$dir/hook permission" }] },
                     { "matcher": "idle_prompt", "hooks": [{ "type": "command", "command": "$dir/hook idle" }] }]
  }
}
JSON

# The project's ANTHROPIC_API_KEY (a placeholder too), for its code, not for Claude.
: > "$dir/project-env"
[ -z "${ANTHROPIC_API_KEY:-}" ] || printf 'export ANTHROPIC_API_KEY=%q\n' "$ANTHROPIC_API_KEY" > "$dir/project-env"

# Onboarding done, this folder trusted -- or Claude stops at a question before
# it reads the task. Merged into an existing ~/.claude.json with whatever can.
claude_json=$HOME/.claude.json folder=$PWD
if [ ! -s "$claude_json" ]; then
  printf '{"hasCompletedOnboarding":true,"projects":{"%s":{"hasTrustDialogAccepted":true}}}\n' "$folder" > "$claude_json"
elif command -v jq >/dev/null; then
  jq --arg f "$folder" '.hasCompletedOnboarding = true | .projects[$f].hasTrustDialogAccepted = true' "$claude_json" > "$claude_json.new" \
    && mv "$claude_json.new" "$claude_json"
elif command -v node >/dev/null; then
  node -e 'const fs=require("fs"),[p,f]=process.argv.slice(1),j=JSON.parse(fs.readFileSync(p,"utf8"));j.hasCompletedOnboarding=true;(j.projects??={})[f]={...j.projects[f],hasTrustDialogAccepted:true};fs.writeFileSync(p,JSON.stringify(j,null,2))' "$claude_json" "$folder"
else
  echo "claude-helper: could not pre-answer onboarding in $claude_json (no jq or node); attach to answer it" >&2
fi

{
  echo '#!/usr/bin/env bash'
  echo '# Claude, on the subscription token and nothing that outranks it (claude-helper.sh).'
  echo 'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_PROFILE ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_IDENTITY_TOKEN_FILE'
  echo 'unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY'
  printf 'export CLAUDE_CODE_OAUTH_TOKEN=%q CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n' "$placeholder"
  printf 'args=(--settings %q' "$dir/settings.json"; [ $# -eq 0 ] || printf ' %q' "$@"; echo ')'
  printf 'task=$(cat %q)\n' "$dir/task"
  echo 'if [ -n "$task" ]; then claude "${args[@]}" "$task"; else claude "${args[@]}"; fi'
  echo 'echo; echo "claude exited ($?). This shell is the session'"'"'s; claude again here keeps the same auth. exit ends it."'
  echo 'exec bash -l'
} > "$dir/run"
chmod +x "$dir/run"

if [ "$resume" = 1 ]; then $status set blue "claude: carrying on" || true; else $status set blue "claude: starting" || true; fi
tmux new-session -d -s "$session" -c "$folder" "$dir/run"
echo "claude-helper: claude is running in tmux session '$session'"
REMOTE

start() {
  command -v jq >/dev/null || die "needs jq"
  local name line row
  name=$(in_use)
  [ -n "$name" ] || die "no token stored for $PROJECT; run: $0 auth $PROJECT"
  line=$(secret_line "$name")
  confined "$line" || die "$name is not confined to the Authorization header, so a container could recover it; run: $0 auth $PROJECT --renew"
  row=$(running_row)
  if [ -z "$row" ]; then
    say "starting $PROJECT${WT[1]:+@${WT[1]}}"
    "$CLI" desolate "$PROJECT" ${WT[@]+"${WT[@]}"} </dev/null >/dev/null || die "could not start it"
    row=$(running_row)
  fi
  # A scoped secret is substituted only for requests from the project's own
  # daemon; from the shared one the proxy refuses them (DENY-SCOPE).
  if [[ "$line" == *"(only for: "* ]] && [ "$(jq -r .daemon <<< "$row")" != project ]; then
    die "$PROJECT runs on the shared daemon, where $name (scoped to $PROJECT) is refused. Give it a daemon of its own, or use the shared token: secret rm $name; $0 auth $PROJECT"
  fi
  local others; others=$(others_at_anthropic | paste -sd, -)
  [ -z "$others" ] || echo "claude-helper: note: $PROJECT can also send $others to api.anthropic.com; Claude's auth is kept off them ('verify' to see)" >&2
  if [ -n "$RESUME" ] && [ -z "$HAS_TASK" ]; then TASK="Your login was renewed; carry on where you left off."; HAS_TASK=1; fi
  local remote=(bash -c "$REMOTE" claude-helper "$SESSION" "$name" "$STATUS_HELPER" "${HAS_TASK:-0}" "${RESUME:-0}" "${CLAUDE_VERSION:-}" ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"})
  if [ -n "$HAS_TASK" ]; then
    printf '%s' "$TASK" | "$CLI" exec "$PROJECT" ${WT[@]+"${WT[@]}"} -- "${remote[@]}"
  else
    "$CLI" exec "$PROJECT" ${WT[@]+"${WT[@]}"} -- "${remote[@]}" </dev/null
  fi
  echo "  watch it:  $0 attach $PROJECT ${WT[1]:+--worktree ${WT[1]} }--session $SESSION    (detach: ctrl-b d)"
}

verify() {
  local name; name=$(in_use)
  [ -n "$name" ] || die "no token stored for $PROJECT"
  # AUDIT lines: verdict=... method=... host=... path=... secrets=... suspect=... project=...
  "$CLI" proxy logs --project "$PROJECT" "$N" | { grep -E ' host=api\.anthropic\.com ' || true; } \
    | sed -nE 's/.* verdict=([^ ]+) .* secrets=([^ ]+) .*/\2 \1/p' | sort | uniq -c \
    | awk -v me="$name" 'BEGIN { any = 0 }
        { any = 1; flag = ($2 == me) ? "" : "   <-- not the subscription token"; printf "  %5d  %-44s %s%s\n", $1, $2, $3, flag; if (flag != "") bad = 1 }
        END { if (!any) print "  no requests to api.anthropic.com from this project in the window"; exit bad }'
}

case "$CMD" in
  auth|start|resume|verify) load_secrets ;;
esac
case "$CMD" in
  auth) auth ;;
  start) start ;;
  resume) RESUME=1; start ;;
  attach) exec "$CLI" exec "$PROJECT" ${WT[@]+"${WT[@]}"} -- tmux attach -t "=$SESSION" ;;
  stop) "$CLI" exec "$PROJECT" ${WT[@]+"${WT[@]}"} -- tmux kill-session -t "=$SESSION" </dev/null && say "stopped '$SESSION'" ;;
  verify) verify ;;
  *) usage ;;
esac
