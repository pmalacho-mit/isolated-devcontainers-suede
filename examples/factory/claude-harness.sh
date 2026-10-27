#!/usr/bin/env bash
# examples/factory/claude-harness.sh -- Claude Code in a desolate target, on your subscription.
#
#   examples/factory/claude-harness.sh auth   <project> [--unscoped]
#   examples/factory/claude-harness.sh start  <project> [--worktree w] [--session s] [--task text | --task-file f] [-- claude args...]
#   examples/factory/claude-harness.sh attach <project> [--worktree w] [--session s]
#   examples/factory/claude-harness.sh stop   <project> [--worktree w] [--session s]
#   examples/factory/claude-harness.sh verify <project> [n]
#
# Runs on your Mac. Built on desolate's primitives (docs/agents.md): a secret,
# `cli.sh exec`, the status through `.git`, and the proxy's audit.
#
# auth   Makes sure the VM holds a subscription token for this project: the
#        placeholder DESOLATE-CLAUDE-<project>-OAUTH, substituted only toward
#        api.anthropic.com and, unless --unscoped, only for requests from this
#        project's own daemon. If it is missing, runs `claude setup-token` here
#        (a browser; a Pro, Max, Team or Enterprise plan) and asks you to paste
#        what it prints -- into `cli.sh secret add`, never into a file or argv.
#        The real token never enters a container.
#
# start  Starts `claude` in a detached tmux session in the running target, as
#        its user, in its workspace folder, with the task as its first prompt.
#        Its process gets CLAUDE_CODE_OAUTH_TOKEN=<the placeholder> and nothing
#        that outranks it -- measured on Claude Code 2.1.311:
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
#        events become the target's status: a failure (authentication, say)
#        red, a permission prompt orange, waiting on you orange unless the
#        agent already said green.
#
# attach Opens the session here (detach again: ctrl-b d). From the target's
#        own editor terminal it is `tmux attach -t claude`.
#
# verify Which secret each recent request from this project to
#        api.anthropic.com carried, from the proxy's audit. Every one should be
#        this project's OAuth placeholder.
#
# Environment: DESOLATE_CLI (path to cli.sh; default: this checkout's),
# DESOLATE_STATUS_HELPER (the helper's path inside the target).
set -euo pipefail

usage() { sed -n '4,8p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI=${DESOLATE_CLI:-$HERE/../../release/cli.sh}
STATUS_HELPER=${DESOLATE_STATUS_HELPER:-/desolate-ca/desolate-status}   # where it is inside the target
die() { echo "claude-harness: $*" >&2; exit 1; }

[ $# -ge 2 ] || usage
CMD=$1 PROJECT=$2; shift 2
WT=() SESSION=claude TASK="" HAS_TASK="" UNSCOPED="" N=200 CLAUDE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WT=(--worktree "${2:?--worktree takes a name}"); shift 2 ;;
    --session) SESSION=${2:?}; shift 2 ;;
    --task) TASK=${2?}; HAS_TASK=1; shift 2 ;;
    --task-file) TASK=$(cat "${2:?}"); HAS_TASK=1; shift 2 ;;
    --unscoped) UNSCOPED=1; shift ;;
    --) shift; CLAUDE_ARGS=("$@"); break ;;
    [0-9]*) N=$1; shift ;;
    *) usage ;;
  esac
done
case "$SESSION" in *[!A-Za-z0-9_-]*|"") die "a session name is [A-Za-z0-9_-]" ;; esac

# The placeholder: one per project, so each can be revoked and audited on its
# own -- and spelled so no project's contains another's (the proxy substitutes
# by plain string replace, and cli.sh refuses overlapping names).
NAME="DESOLATE-CLAUDE-${PROJECT//\//__}-OAUTH"

# `secret list` lines: "  NAME  ->  host, host   (only for: p, q)"
secret_line() { "$CLI" secret list | awk -v n="$1" '$1 == n'; }
scoped_to_project() { case "$1" in *"(only for: "*) printf '%s' "${1#*(only for: }" | tr -d ')' | tr ',' '\n' | sed 's/^ *//' | grep -qxF "$PROJECT" ;; *) return 1 ;; esac; }

# Anything else this project can spend at api.anthropic.com: if it is an API
# key, it is how a misconfigured Claude would bill per token instead.
others_at_anthropic() {
  "$CLI" secret list | awk -v me="$NAME" '$1 != me && $2 == "->"' | while IFS= read -r line; do
    other=$(awk '{print $1}' <<< "$line")
    case "$line" in *api.anthropic.com*|*'*.anthropic.com'*) ;; *) continue ;; esac
    case "$line" in *"(only for: "*) scoped_to_project "$line" || continue ;; esac
    echo "$other"
  done
}

auth() {
  local line
  line=$(secret_line "$NAME")
  if [ -n "$line" ]; then
    if scoped_to_project "$line"; then echo "claude-harness: $NAME is stored, for $PROJECT only"
    elif [[ "$line" != *"(only for: "* ]]; then
      [ -n "$UNSCOPED" ] || echo "claude-harness: $NAME is stored, but for ANY source -- re-run with --unscoped to keep it, or 'secret rm $NAME' and auth again" >&2
      echo "claude-harness: $NAME is stored (unscoped)"
    else die "$NAME is stored but scoped to other projects: $line"; fi
  else
    [ -t 0 ] || die "$NAME is not stored; run: $0 auth $PROJECT (in a terminal)"
    if command -v claude >/dev/null; then
      echo "claude-harness: running 'claude setup-token' -- finish it in the browser; it prints a token valid for a year."
      claude setup-token || die "claude setup-token failed"
    else
      echo "claude-harness: no claude on this Mac. Install it (https://code.claude.com), run 'claude setup-token', and paste its token here."
    fi
    printf 'paste the token (hidden): ' >&2
    local token; IFS= read -rs token; echo >&2
    token=${token//[[:space:]]/}
    [ -n "$token" ] || die "no token"
    case "$token" in sk-ant-oat*) ;; sk-ant-api*) die "that is an API key, which bills per token -- this wants the setup-token OAuth token" ;; *) echo "claude-harness: that does not look like an OAuth token (sk-ant-oat...); storing it anyway" >&2 ;; esac
    local scope=(--projects "$PROJECT"); [ -z "$UNSCOPED" ] || scope=()
    printf '%s\n' "$token" | "$CLI" secret add "$NAME" --hosts api.anthropic.com ${scope[@]+"${scope[@]}"} >/dev/null \
      || die "could not store $NAME"
    unset token
    echo "claude-harness: stored $NAME for ${UNSCOPED:+any source}${UNSCOPED:-$PROJECT}, toward api.anthropic.com"
  fi
  local others; others=$(others_at_anthropic | paste -sd, -)
  [ -z "$others" ] || echo "claude-harness: note: $PROJECT can also send $others to api.anthropic.com. start keeps Claude's auth off them; 'verify' shows what each request carried." >&2
}

# The target's row in `desolate --list --json`, or nothing when it is stopped.
running_row() {
  local want=$PROJECT; [ ${#WT[@]} -eq 0 ] || want="$PROJECT@${WT[1]}"
  "$CLI" desolate --list --json | sed -n '/^\[/p' | tail -n 1 | jq -c --arg t "$want" '.[]? | select(.target == $t)'
}

# What runs in the target, as its user, in its workspace folder: $1 the session,
# $2 the placeholder, $3 the status helper, $4 1 when the task is on stdin, the
# rest Claude's own arguments. Everything it writes is under the user's state
# dir, outside the repository.
read -r -d '' REMOTE <<'REMOTE' || true
set -euo pipefail
session=$1 placeholder=$2 status=$3 has_task=$4; shift 4
need() { command -v "$1" >/dev/null || { echo "claude-harness: no $1 in this devcontainer. $2" >&2; exit 3; }; }
need tmux "Install it in the image (apt-get install -y tmux), then rebuild."
need claude "Add the feature ghcr.io/anthropics/devcontainer-features/claude-code:1 to devcontainer.json (or npm install -g @anthropic-ai/claude-code), then rebuild."
if tmux has-session -t "=$session" 2>/dev/null; then
  echo "claude-harness: session '$session' is already running here; attach to it, or stop it first" >&2; exit 4
fi
dir=${XDG_STATE_HOME:-$HOME/.local/state}/desolate-claude/$session
mkdir -p "$dir"
if [ "$has_task" = 1 ]; then cat > "$dir/task"; else : > "$dir/task"; fi

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
  echo "claude-harness: could not pre-answer onboarding in $claude_json (no jq or node); attach to answer it" >&2
fi

{
  echo '#!/usr/bin/env bash'
  echo '# Claude, on the subscription token and nothing that outranks it (claude-harness.sh).'
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

$status set blue "claude: starting" || true
tmux new-session -d -s "$session" -c "$folder" "$dir/run"
echo "claude-harness: claude is running in tmux session '$session'"
REMOTE

start() {
  command -v jq >/dev/null || die "needs jq"
  local line row; line=$(secret_line "$NAME")
  [ -n "$line" ] || die "no token stored for $PROJECT; run: $0 auth $PROJECT"
  row=$(running_row)
  if [ -z "$row" ]; then
    echo "claude-harness: starting $PROJECT${WT[1]:+@${WT[1]}}"
    "$CLI" desolate "$PROJECT" ${WT[@]+"${WT[@]}"} </dev/null >/dev/null || die "could not start it"
    row=$(running_row)
  fi
  # A scoped secret is substituted only for requests from the project's own
  # daemon; from the shared one the proxy refuses them (DENY-SCOPE).
  if [[ "$line" == *"(only for: "* ]] && [ "$(jq -r .daemon <<< "$row")" != project ]; then
    die "$PROJECT runs on the shared daemon, where $NAME (scoped to $PROJECT) is refused. Give it a daemon of its own, or: secret rm $NAME; $0 auth $PROJECT --unscoped"
  fi
  local remote=(bash -c "$REMOTE" claude-harness "$SESSION" "$NAME" "$STATUS_HELPER" "${HAS_TASK:-0}" ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"})
  if [ -n "$HAS_TASK" ]; then
    printf '%s' "$TASK" | "$CLI" exec "$PROJECT" ${WT[@]+"${WT[@]}"} -- "${remote[@]}"
  else
    "$CLI" exec "$PROJECT" ${WT[@]+"${WT[@]}"} -- "${remote[@]}" </dev/null
  fi
  echo "  watch it:  $0 attach $PROJECT ${WT[1]:+--worktree ${WT[1]} }--session $SESSION    (detach: ctrl-b d)"
}

verify() {
  # AUDIT lines: verdict=... method=... host=... path=... secrets=... suspect=... project=...
  "$CLI" proxy logs --project "$PROJECT" "$N" | { grep -E ' host=api\.anthropic\.com ' || true; } \
    | sed -nE 's/.* verdict=([^ ]+) .* secrets=([^ ]+) .*/\2 \1/p' | sort | uniq -c \
    | awk -v me="$NAME" 'BEGIN { any = 0 }
        { any = 1; flag = ($2 == me) ? "" : "   <-- not the subscription token"; printf "  %5d  %-44s %s%s\n", $1, $2, $3, flag; if (flag != "") bad = 1 }
        END { if (!any) print "  no requests to api.anthropic.com from this project in the window"; exit bad }'
}

case "$CMD" in
  auth) auth ;;
  start) start ;;
  attach) exec "$CLI" exec "$PROJECT" ${WT[@]+"${WT[@]}"} -- tmux attach -t "=$SESSION" ;;
  stop) "$CLI" exec "$PROJECT" ${WT[@]+"${WT[@]}"} -- tmux kill-session -t "=$SESSION" </dev/null && echo "claude-harness: stopped '$SESSION'" ;;
  verify) verify ;;
  *) usage ;;
esac
