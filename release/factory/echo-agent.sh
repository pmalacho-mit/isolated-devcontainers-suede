#!/usr/bin/env bash
# A stand-in agent, for trying `desolate task` and the factories without an AI (and for
# testing them): it does what an agent is told to, with nothing clever in between. It writes
# its task to TASK.md on its branch, commits it, offers the branch, and goes green.
#
#   desolate task acme "Add a shout() greeting" -- bash /desolate/release/factory/echo-agent.sh
set -euo pipefail
task=${*:-"(no task given)"}
say() { printf '\033[1;36magent\033[0m %s\n' "$*"; sleep "${ECHO_AGENT_PACE:-0.6}"; }
first=$(printf '%s\n' "$task" | head -n 1)
say "task: $first"
say "on $(git branch --show-current) in $(basename "$(pwd)")"
desolate status set blue "working: $first" >/dev/null 2>&1 || true
printf '# Task\n\n%s\n' "$task" > TASK.md
say "wrote TASK.md"
git add TASK.md
git -c user.name="echo agent" -c user.email="echo-agent@desolate.invalid" commit -q -m "Task: $first"
say "committed $(git rev-parse --short HEAD)"
desolate offer | sed -n 1p
desolate status set green "ready: $first" >/dev/null 2>&1 || true
say "done: offered, and green. Waiting (Ctrl-C ends me)."
while sleep 3600; do :; done
