#!/usr/bin/env bash
# examples/factory/claude/claude-helper.sh -- Claude Code in a desolate target, on your subscription.
#
#   claude-helper.sh auth   <project> [--scoped] [--renew]
#   claude-helper.sh start  <project> [--worktree w] [--session s] [--task text | --task-file f] [-- claude args...]
#   claude-helper.sh resume <project> [--worktree w] [--session s] [--task text]
#   claude-helper.sh attach <project> [--worktree w] [--session s]
#   claude-helper.sh stop   <project> [--worktree w] [--session s]
#   claude-helper.sh nudge  <project> [--worktree w] [--session s] --ref origin/<branch>
#   claude-helper.sh verify <project> [n]
#   claude-helper.sh events <project> [--worktree w] [--session s]
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
#        On Opus (`--model opus`; `-- --model <alias|name>` for another) at
#        xhigh effort, and -- with a task -- a standing instruction appended to
#        its system prompt (AGENT_PROMPT): do not end a turn with work still
#        owed, "done" means seen to work, install what is missing.
#        In auto permission mode (a classifier judges what is safe, and it
#        asks for the rest), unless `-- --permission-mode <mode>` says
#        otherwise; /desolate is readable without asking (--add-dir), and
#        git add, git commit and /desolate/status are allowed outright.
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
#        own editor terminal it is `tmux attach -t claude`. The mouse is left
#        to your terminal, so select and paste as usual; if a client still
#        grabs it, hold shift (option on a Mac) while dragging.
#
# nudge  Types one fixed sentence into the session's prompt, telling the agent
#        that origin/<branch> moved and to bring its branch up to date with it.
#        Only <branch>, checked to be plain characters, varies; nothing else
#        from outside is typed. Refused unless the agent's status is blue
#        (working): at a permission prompt a typed line could answer it.
#
# verify Which secret each recent request from this project to
#        api.anthropic.com carried, from the proxy's audit. Every one should be
#        the subscription placeholder.
#
# events Prints, as JSON lines {"t": epoch ms, "kind": ..., "tool": ...}, what
#        Claude did in the session: its start, each prompt, each tool call's
#        start and end, each stop. Written by the hooks below into the user's
#        state dir in the target; the dispatcher pulls them into the factory's
#        telemetry log (docs/factory-telemetry.md). start and resume are also
#        timed there ("op" events), phase by phase.
#
# Environment: DESOLATE_CLI (path to cli.sh; default: this checkout's),
# DESOLATE_STATUS_HELPER (the helper's path inside the target),
# CLAUDE_VERSION (what the native installer installs; default: its latest).
set -euo pipefail

usage() { sed -n '4,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI=${DESOLATE_CLI:-$HERE/../../../release/cli.sh}
STATUS_HELPER=${DESOLATE_STATUS_HELPER:-/desolate/status}   # where it is inside the target
# shellcheck source=../lib/telemetry.sh
. "$HERE/../lib/telemetry.sh"
die() { echo "claude-helper: $*" >&2; exit 1; }
say() { echo "claude-helper: $*"; }

[ $# -ge 2 ] || usage
CMD=$1 PROJECT=$2; shift 2
WT=() SESSION=claude TASK="" HAS_TASK="" SCOPED="" REF="" RENEW="" RESUME="" N=200 CLAUDE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WT=(--worktree "${2:?--worktree takes a name}"); shift 2 ;;
    --session) SESSION=${2:?}; shift 2 ;;
    --task) TASK=${2?}; HAS_TASK=1; shift 2 ;;
    --task-file) TASK=$(cat "${2:?}"); HAS_TASK=1; shift 2 ;;
    --scoped) SCOPED=1; shift ;;
    --renew) RENEW=1; shift ;;
    --ref) REF=${2:?--ref takes origin/<branch>}; shift 2 ;;
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
export PATH="$HOME/.local/bin:$HOME/.local/share/git-subrepo/lib:$PATH"
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
# git-subrepo, for a suede dependency's sync (docs/suede-factory.md): where a
# devcontainer feature put it, or installed for this session, pinned as suede's
# own workflows pin it. Not fatal: most tasks never need it.
if ! git subrepo --version >/dev/null 2>&1 && ! { [ -f "${GIT_SUBREPO_ROOT:-/nonexistent}/.rc" ] && . "$GIT_SUBREPO_ROOT/.rc" >/dev/null 2>&1 && git subrepo --version >/dev/null 2>&1; }; then
  say "no git-subrepo in this devcontainer; installing it (0.4.9)"
  if git clone --quiet --depth 1 --branch 0.4.9 https://github.com/ingydotnet/git-subrepo "$HOME/.local/share/git-subrepo" >>"$log" 2>&1 \
     && git subrepo --version >/dev/null 2>&1; then
    installed="$installed git-subrepo"
  else
    say "could not install git-subrepo (see $log); a task that syncs a suede dependency will fail"
  fi
fi

if tmux has-session -t "=$session" 2>/dev/null; then
  [ "$resume" = 1 ] || { say "session '$session' is already running here; attach to it, or stop it first"; exit 4; }
  tmux kill-session -t "=$session"
fi
[ "$resume" != 1 ] || set -- -c "$@"
if [ "$has_task" = 1 ]; then cat > "$dir/task"; else : > "$dir/task"; fi
if [ -n "$installed" ] && [ -s "$dir/task" ]; then
  cat >> "$dir/task" <<NOTE

A note from the harness that started you: this devcontainer did not have$installed, so it installed them for this session; a rebuild loses them. Consider updating the devcontainer config so they are there from the start -- the feature "ghcr.io/anthropics/devcontainer-features/claude-code:1" for claude, "ghcr.io/pmalacho-mit/devcontainer-features/git-subrepo:latest" for git-subrepo, tmux in the image -- or, if that change is not yours to make, say so in your status or your PR.
NOTE
fi
[ -z "$installed" ] || say "installed$installed for this session (a rebuild loses them; the agent was told)"

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
  event)  # one line per Claude event, for the factory's telemetry (the time is the target's clock)
          ms=\$(date +%s%3N 2>/dev/null); case "\$ms" in ""|*[!0-9]*) ms=\$((\$(date +%s) * 1000)) ;; esac
          printf '{"t":%s,"kind":"%s","tool":"%s"}\\n' "\$ms" "\$2" "\$(printf '%s' "\$input" | field tool_name)" >> "$dir/events.jsonl" ;;
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
  "effortLevel": "xhigh",
  "permissions": {
    "additionalDirectories": ["/desolate"],
    "allow": ["Read(//desolate/**)", "Bash(git add *)", "Bash(git commit *)", "Bash(/desolate/status *)"]
  },
  "env": { "ANTHROPIC_API_KEY": "", "ANTHROPIC_AUTH_TOKEN": "", "CLAUDE_CODE_USE_BEDROCK": "",
           "CLAUDE_CODE_USE_VERTEX": "", "CLAUDE_CODE_USE_FOUNDRY": "" },
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "$dir/hook start" }, { "type": "command", "command": "$dir/hook event session_start" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "$dir/hook event prompt" }] }],
    "PreToolUse":   [{ "hooks": [{ "type": "command", "command": "$dir/hook event tool_start" }] }],
    "PostToolUse":  [{ "hooks": [{ "type": "command", "command": "$dir/hook event tool_end" }] }],
    "Stop":         [{ "hooks": [{ "type": "command", "command": "$dir/hook event stop" }] }],
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
  echo 'export PATH="$HOME/.local/bin:$HOME/.local/share/git-subrepo/lib:$PATH"'
  echo 'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_PROFILE ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_IDENTITY_TOKEN_FILE'
  echo 'unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY'
  printf 'export CLAUDE_CODE_OAUTH_TOKEN=%q CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n' "$placeholder"
  # Claude asks the terminal to report the mouse, which takes drag-to-select and
  # right-click paste away from whoever attaches. Not asking leaves them to the terminal.
  echo 'export CLAUDE_CODE_DISABLE_MOUSE=1'
  printf 'args=(--settings %q' "$dir/settings.json"; [ $# -eq 0 ] || printf ' %q' "$@"; echo ')'
  printf 'task=$(cat %q)\n' "$dir/task"
  echo 'if [ -n "$task" ]; then claude "${args[@]}" "$task"; else claude "${args[@]}"; fi'
  echo 'echo; echo "claude exited ($?). This shell is the session'"'"'s; claude again here keeps the same auth. exit ends it."'
  echo 'exec bash -l'
} > "$dir/run"
chmod +x "$dir/run"

if [ "$resume" = 1 ]; then $status set blue "claude: carrying on" || true; else $status set blue "claude: starting" || true; fi
tmux new-session -d -s "$session" -c "$folder" "$dir/run"
# tmux must not take the mouse either, and should hand copies to the attaching terminal's clipboard.
tmux set-option -t "=$session" mouse off \; set-option -t "=$session" set-clipboard on || true
echo "claude-helper: claude is running in tmux session '$session'"
REMOTE

# Appended to Claude's system prompt when it starts with a task. The first
# paragraph is Anthropic's own wording for unattended runs, from "Prompting
# Claude Opus 5.5" (Unattended agentic runs), changed in its last two
# sentences to name the stops this harness does want: the statuses. The
# system prompt, not the task, because it holds for the whole conversation and
# a mid-conversation change would invalidate the earlier thinking. The other two
# are the sandbox's: what "done" means, and that installing is expected.
read -r -d '' AGENT_PROMPT <<'PROMPT' || true
A standing instruction from the user, the person you are working for. It is about how your turns end. A message with no tool call in it ends your turn, and the work stops there until you are asked to continue, which may be hours. The user has seen you end turns in four ways while work they asked for was still owed, and does not want any of them. One: a long summary of what was done that closes by announcing the next step and has no tool call, so the next thing never starts. Two: an offer to carry on with something unless the user would prefer otherwise, which stops to wait for an answer the user was not going to give. Three: a list of decisions for the user when, by your own account, none of them blocks the rest of the work. Four: deciding that this is a good place to report, because the turn has been long or a milestone is done. Status notes are welcome, and so are your recommendations on open decisions, but put them in the same message as your next tool call and carry on with whatever does not depend on the user's answer. If you notice yourself inviting the user to redirect you or offering to wait, delete it and do the next thing. The stops the user does want are the ones where the task is finished and verified and committed, or nothing can move without a human (the orange, red and gray statuses the task describes), or the thing blocking you is deliberately protected from you. This does not override the need for confirmation on risky or destructive actions.

"Done" means you have seen it work, not that you expect it to. Run the code, the command or the test with real inputs and read what it printed. Do not stop at the first passing run: try the edge cases, and the callers and neighbouring code the change could break. When a check fails, find the cause; do not weaken the check or route around it.

You are in a disposable sandbox, and installing things here is expected: this is what the sandbox is for. When a tool, package, compiler, runtime, browser, linter or test runner that you need to build, run or verify the work is missing, install it (sudo apt-get install, pip, npm, cargo, or the project's own installer) and carry on. Do not skip a check, or report something unverified, because a tool was not there. Only TCP 80 and 443 leave the container (/desolate/AGENTS.md). Installs are lost on a rebuild: if the project will need one again, say so in your commit message or status so the devcontainer config can carry it. Install tools globally or into a throwaway directory; change the repository's own dependency files only when the task needs it.
PROMPT

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
    tele_timed helper_target_start "$CLI" desolate "$PROJECT" ${WT[@]+"${WT[@]}"} </dev/null >/dev/null || die "could not start it"
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
  # Auto mode unless told otherwise: Claude decides what is safe to run and
  # asks for the rest. `-- --permission-mode manual` (or any other) overrides.
  local mode_given="" arg
  for arg in ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}; do case "$arg" in --permission-mode|--permission-mode=*) mode_given=1 ;; esac; done
  [ -n "$mode_given" ] || CLAUDE_ARGS=(--permission-mode auto ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"})
  # Opus unless told otherwise: the model the CLI picks by default depends on
  # the plan and the client (a setup-token login has landed on Sonnet), and
  # this is work that wants the stronger one. The flag outranks ANTHROPIC_MODEL
  # and every settings file; `-- --model <alias|name>` overrides it.
  local model_given="" prompt_given=""
  for arg in ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}; do
    case "$arg" in
      --model|--model=*) model_given=1 ;;
      --append-system-prompt|--append-system-prompt=*|--append-system-prompt-file|--append-system-prompt-file=*|--system-prompt|--system-prompt=*|--system-prompt-file|--system-prompt-file=*) prompt_given=1 ;;
    esac
  done
  [ -n "$model_given" ] || CLAUDE_ARGS=(--model opus ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"})
  # With a task, nobody is at the keyboard: how an unattended agent works here
  # (AGENT_PROMPT, above) is appended to Claude's system prompt. Without one it
  # is a person's session, and "do not stop to ask" would be wrong.
  [ -z "$HAS_TASK" ] || [ -n "$prompt_given" ] || CLAUDE_ARGS=(--append-system-prompt "$AGENT_PROMPT" ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"})
  # desolate's own directory -- AGENTS.md, the status helper -- read without
  # the first-read prompt a path outside the project otherwise gets.
  CLAUDE_ARGS=(--add-dir /desolate "${CLAUDE_ARGS[@]}")
  TELE_ISSUE=${WT[1]#issue-}
  [ "$TELEMETRY_FILE" = off ] || say "telemetry: $TELEMETRY_FILE"
  local remote=(bash -c "$REMOTE" claude-helper "$SESSION" "$name" "$STATUS_HELPER" "${HAS_TASK:-0}" "${RESUME:-0}" "${CLAUDE_VERSION:-}" ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"})
  if [ -n "$HAS_TASK" ]; then
    printf '%s' "$TASK" | tele_timed helper_remote "$CLI" exec "$PROJECT" ${WT[@]+"${WT[@]}"} -- "${remote[@]}"
  else
    tele_timed helper_remote "$CLI" exec "$PROJECT" ${WT[@]+"${WT[@]}"} -- "${remote[@]}" </dev/null
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

nudge() {
  case "$REF" in origin/*) ;; *) die "--ref is origin/<branch>" ;; esac
  case "${REF#origin/}" in ""|-*|*..*|*//*|*/|*[!A-Za-z0-9._/-]*) die "not a plain branch name: --ref" ;; esac
  local text="origin/${REF#origin/} has moved (a PR was merged) and was fetched for you; you cannot fetch yourself. When you reach a good stopping point, commit your work, then bring this branch up to date with $REF (rebase, or merge if a rebase is unsuitable), resolve any conflicts, and rerun your tests. Do not push."
  "$CLI" exec "$PROJECT" ${WT[@]+"${WT[@]}"} -- bash -c '
    session=$1 text=$2 status=$3
    tmux has-session -t "=$session" 2>/dev/null || { echo "no session $session" >&2; exit 1; }
    case "$($status show 2>/dev/null)" in *"\"color\":\"blue\""*) ;; *) echo "agent is not working (not blue); not typing at it" >&2; exit 1 ;; esac
    tmux send-keys -t "=$session:" -l -- "$text" && tmux send-keys -t "=$session:" Enter' claude-helper "$SESSION" "$text" "$STATUS_HELPER" </dev/null
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
  nudge) nudge ;;
  events) "$CLI" exec "$PROJECT" ${WT[@]+"${WT[@]}"} -- sh -c 'cat "${XDG_STATE_HOME:-$HOME/.local/state}/desolate-claude/$1/events.jsonl" 2>/dev/null || true' _ "$SESSION" </dev/null ;;
  *) usage ;;
esac
