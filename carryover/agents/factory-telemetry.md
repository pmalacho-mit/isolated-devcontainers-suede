# Factory telemetry

The example factory (`examples/factory`) writes a timing log, so that after a few days of running you can ask a coding agent to diagnose and improve the stack's performance from evidence.

```sh
examples/factory/telemetry.sh report            # where the time went
examples/factory/telemetry.sh prompt --since 3  # the same, as a prompt to paste into a coding agent
examples/factory/telemetry.sh path              # the raw log
```

The log is JSON lines at `~/.local/state/desolate-factory/telemetry.jsonl` (`FACTORY_TELEMETRY=<path>` moves it, `=off` disables it). Nothing is rotated; delete it when you like. It holds issue titles and the agent's status messages (cut at 200 characters), so read it before sharing it.

Every line has `ts` (UTC), `run` (one dispatcher process) and `event`:

| event | fields | what it answers |
| --- | --- | --- |
| `run_start` | dispatcher, project, interval, max_agents | what ran with which settings |
| `tick` | project, ms | how long a polling pass takes |
| `op` | op, ms, exit, project, issue | one call into the stack or GitHub: `cli_status`, `cli_list`, `cli_fetch`, `cli_worktree_add`, `cli_start` (container up), `cli_exec_probe`, `agent_start`, `helper_target_start`, `helper_remote` (installs, tmux, claude), `cli_stop`, `cli_worktree_remove`, `gh_issue_list`, `gh_ref`, `gh_pr_list`, `gh_pr_create` |
| `issue_seen` | project, issue, title | when an issue first appeared |
| `agent_started` | since_issue_ms | issue to a running agent: worktree + container + install |
| `status` | color, message, since_agent_ms, since_issue_ms | each status the agent set, and when |
| `pr` | since_agent_ms, since_issue_ms | the draft PR |
| `worktree_gone` | since_issue_ms | issue closed to worktree removed |
| `agent_event` | kind (`session_start`, `prompt`, `tool_start`, `tool_end`, `stop`), tool, t_ms | what Claude did inside the container, from its hooks; pulled in when its status changes and when the worktree is removed |

`since_*_ms` are measured by the dispatcher's clock from the first time it saw the issue / started the agent, so they include up to one `--interval` of polling delay; `op` times are exact. `agent_event` times are the container's clock. A failed `op` has `exit` other than 0.
