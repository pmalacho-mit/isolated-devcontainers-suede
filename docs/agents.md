# Agents on desolate: the primitives

desolate runs git repositories, and their worktrees, in isolated devcontainers.
What an agent does inside one, and what decides when it starts, is not desolate's.
A software factory is a harness *on top*: a script on your Mac that watches a
forge, opens worktrees, starts agents in them, and acts on what they report.

This page is the contract between the two: what desolate provides so a harness
needs nothing else. `examples/factory/` holds such harnesses, as sketches.

## The primitives

| Need | Primitive | Where it runs |
| --- | --- | --- |
| a place for one piece of work | `./cli.sh worktree add <project> <name> [<branch>]`, `worktree remove` | Mac (git runs in the worktree's sandbox) |
| start, stop, rebuild it | `./cli.sh desolate <project> [--worktree <name>]`, `--stop`, `--rebuild` | Mac or editor |
| what is running, for a program | `./cli.sh desolate --list --json` | Mac or editor |
| run an agent in it | `./cli.sh exec <project> [--worktree <name>] -- <command...>` | Mac |
| hear from it | its **status**, through `.git` (below) | written inside; read anywhere |
| get its branch out | `./cli.sh bundle <project> [--worktree <name>] <file>` | Mac |
| give it a credential | `./cli.sh secret add NAME --hosts … --projects <project>` | Mac (the value stays in the VM) |
| see what it reached | `./cli.sh proxy audit --project <project>` | Mac |

### `exec`: run an agent in a target

```bash
./cli.sh exec acme/widgets --worktree issue-42 -- claude -p "Fix issue #42: ..."
```

It runs the command inside the target's devcontainer, which must be running, with `docker exec` on the daemon it runs on:
- as its remote user (from the container's devcontainer metadata);
- in its workspace folder;
- through a login shell, so the PATH its features set up is there;
- with the container's environment, including any placeholder secrets in `containerEnv`.

Not `devcontainer exec`: that finds the container by the config it was started with, and a harness's exec can come after the spec has moved on.

stdin and stdout are the caller's, and a TTY when there is one, so it works both for a one-shot `claude -p` and for an interactive shell. A harness backgrounds it however it likes.

It is the Mac's alone. The editor has no daemon access, and giving it a way into every devcontainer would make it the most powerful thing in the stack.

### Status, through `.git`

Every target has one status: a colour and a one-line message. An agent sets it from inside its devcontainer:

```bash
/desolate-ca/desolate-status set orange "needs a human: which API version?"
/desolate-ca/desolate-status set green  "ready for a PR"
/desolate-ca/desolate-status set red    "authentication failed"
/desolate-ca/desolate-status clear
```

Colours: `gray`, `blue`, `green`, `yellow`, `orange`, `red`. What they mean is the harness's to decide; desolate only shows them. A useful convention:
- `blue`: working;
- `orange`: needs a human;
- `red`: failed;
- `green`: done.

It's read in three places:
- **the editor's desolate panel**, as each project's and worktree's icon colour and message;
- **`desolate --status`** in the editor's terminal (`--json` for a program);
- **`./cli.sh desolate --status --json`** from the Mac, which is how a harness polls it. One row per target, `status` null where none is set:

  ```json
  [{ "target": "acme/widgets@issue-42", "project": "acme/widgets", "worktree": "issue-42",
     "status": { "color": "green", "message": "ready for a PR", "updated": "2026-10-27T12:00:00Z" } }]
  ```

**Where it lives:** `<git-dir>/desolate-status.json`, where `<git-dir>` is what `git rev-parse --git-dir` prints in the target. That's `.git` for a project's own tree, and `.git/worktrees/<name>` for a worktree. So each target has its own status, and it is:
- **not in the repository:** it is never committed, never in `git status`, never pushed;
- **shared with exactly the right containers:** every container of the project mounts that `.git`, and no other project's container does;
- **readable without running git:** the editor reads a file, and runs nothing.

**The file**, which the helper writes atomically:

```json
{ "color": "green", "message": "ready for a PR", "updated": "2026-10-27T12:00:00Z" }
```

**Trust.** Anything in the project can write any of its targets' statuses, because a project is one trust domain. So desolate **displays** a status and never acts on one. A harness that does act on one should treat it as the agent's claim, and check what it claims (a branch to push, say) for itself.

The reader is strict about the file. It:
- refuses a link out of the project;
- doesn't block on a FIFO;
- reads at most 4 KiB;
- shows the message as one plain line of at most 200 printable characters;
- shows a colour it doesn't know as `gray`.

### `bundle`: get a branch out

```bash
./cli.sh bundle acme/widgets --worktree issue-42 ~/work/issue-42.bundle
git -C ~/clones/widgets fetch ~/work/issue-42.bundle issue/42:issue/42
git -C ~/clones/widgets push origin issue/42      # with YOUR credentials
```

This writes a git bundle of the target's current branch to a file on the Mac. The bundle is made in a sandbox that mounts the project's root read-only and nothing else of `/workspaces`, so a ref the project made a link, or alternates pointing into another project, resolve to nothing. The editor's git is never asked to read the project. Pushing, and opening a PR, happen on the Mac, with your credentials; no forge token ever enters the stack.

### What desolate deliberately does not do

It doesn't:
- poll a forge;
- open or merge PRs;
- decide when a branch is pushed;
- carry conversations between agents;
- act on a status.

Those choices belong to the harness, which is where they can change without changing desolate.

## How a harness uses them

`examples/factory/` holds two dispatchers built on these primitives. Both share one loop, `lib/gh-dispatch.sh`:
- `gh-dispatcher.sh` runs any agent command (`FACTORY_AGENT`);
- `claude/claude-dispatcher.sh` runs Claude Code through `claude/claude-helper.sh`.

```bash
examples/factory/claude/claude-dispatcher.sh acme/widgets acme/widgets ~/clones/widgets   # project, repo, your clone
```

Per issue labelled `desolate:run`, each tick:

1. If there is no worktree `issue-<n>`: `worktree add` it, then start it.
2. If no agent was started there: start one, with the issue as its task and a pointer to `desolate-status`.
3. Read `./cli.sh desolate --status --json`:
   - **the agent's own access broken** (for Claude, `red` "claude: authentication failed"): you are told, in the terminal, with a bell, and by a macOS notification. In a terminal you are asked for a new token, and then each agent that stopped on it carries on its conversation. No new agent starts while this waits.
   - **`orange` or `red`:** a comment on the issue, once per status.
   - **`green`:** `bundle` the branch, push it from your clone (never to the default branch, never forced), then `gh pr create --draft`.
4. When the issue is closed: stop and `worktree remove` (refused while it holds uncommitted work).

Another agent is five shell functions: `agent_ready`, `agent_start`, `agent_blocked`, `agent_renew` and `agent_resume`. See the top of `lib/gh-dispatch.sh`.

### Claude Code on your subscription: `claude/claude-helper.sh`

```bash
examples/factory/claude/claude-helper.sh auth   acme/widgets                      # once: the token, into the VM
examples/factory/claude/claude-helper.sh start  acme/widgets --worktree issue-42 --task "Fix #42: ..."
examples/factory/claude/claude-helper.sh attach acme/widgets --worktree issue-42  # watch it; ctrl-b d to leave
examples/factory/claude/claude-helper.sh resume acme/widgets --worktree issue-42  # same conversation, new session
examples/factory/claude/claude-helper.sh verify acme/widgets                      # which secret each request carried
```

**`auth`** stores a `claude setup-token` token as the secret `DESOLATE-CLAUDE-OAUTH`, substituted only toward `api.anthropic.com`. By default it works for any project.

**What a container that can spend it can do.** It can use your subscription. And because the proxy substitutes inside request bodies too, it can recover the token itself, by asking the model to transform it; addon.py, "What scrubbing is, and what it is not", explains why. Once recovered, the token works anywhere until you revoke it. A `setup-token` token can only make model requests, so the damage is to your account rather than your data:
- your plan's usage limits;
- extra usage, if it is enabled on your account;
- whatever gets sent under your name.

`--scoped` limits that to one project (`DESOLATE-CLAUDE-<project>-OAUTH`), and then that project needs a daemon of its own.

**`start`** runs `claude` in a detached tmux session in the target, with `CLAUDE_CODE_OAUTH_TOKEN` set to that placeholder. If tmux or claude is missing, it installs them:
- tmux through the image's package manager, as root or with passwordless sudo;
- claude with its native installer.

It then tells the agent, in its task, that the devcontainer config should carry them.

Several things outrank the OAuth token, measured on Claude Code 2.1.311:
- `ANTHROPIC_API_KEY`;
- `ANTHROPIC_AUTH_TOKEN`;
- an `apiKeyHelper`, including one in the repository's own committed `.claude/settings.json`, which wins silently once the folder is trusted.

So the launcher:
- unsets those variables in Claude's environment;
- blanks them through `--settings`, which beats the repository's settings;
- hands the project's own `ANTHROPIC_API_KEY` back to Claude's shell commands only, so the code under test keeps it.

It also pre-answers onboarding and the folder's trust dialog. Claude's own events become the target's status:
- a failed login sets red, "claude: authentication failed", which is what the dispatcher watches for;
- another failure also sets red;
- a permission prompt, or Claude idling while it waits for you, sets orange.

**`verify`** reads the proxy's audit to check that the subscription token really was the one used.

## What changed to get here

The first factory, `cli.sh work` and `cli.sh forge`, built this workflow into desolate. It had:
- a message protocol on `refs/desolate/*`;
- a watcher in the editor;
- a policy file;
- a GitHub adapter.

That was too prescriptive, and it blurred the line between forge credentials and the stack. It is gone. These primitives replace it:
- the status replaces the message protocol;
- `exec` replaces the watcher's starts;
- `bundle` replaces its push.
