# Agents on desolate: the primitives

desolate runs git repositories, and their worktrees, in isolated devcontainers.
What an agent does inside one, and what decides when it starts, is not desolate's.
A software factory is a harness *on top*: a script on your Mac that watches a
forge, opens worktrees, starts agents in them, and acts on what they report.

This page is the contract between the two: what desolate provides so a harness
needs nothing else. `examples/factory/` is one such harness, as a sketch.

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

The loop `examples/factory/harness.sh` sketches, per labelled issue:

1. If there is no worktree `issue-<n>`: `worktree add` it, then start it.
2. If no agent is running there: `exec` one in the background, with the task and a pointer to `desolate-status`.
3. Each tick, read `./cli.sh desolate --status --json`:
   - `orange` or `red`: tell a human (a comment on the issue, a notification);
   - `green`: `bundle` the branch, push it from the Mac's clone, and `gh pr create --draft`.
4. When the PR is merged or the issue closed: `worktree remove` (refused while it holds uncommitted work).

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
