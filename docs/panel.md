# The desolate panel

The outer editor's activity bar has a desolate icon. Its panel is where you see every project and worktree, what their agents are saying, and what a push would send. It is built into the outer editor (`release/vscode-image/extension/`), and holds no power of its own: everything it does is a command the editor's terminal already has.

## The views

### Needs you

Every target whose agent asked something of a person, newest first, with its whole message:
- **orange:** a question;
- **red:** stuck;
- **green:** ready for review;
- **gray:** withdrawn: it recommends the branch not be merged.

The activity bar's icon counts them, and so does a bell in the status bar. When one arrives, a notification says so, with the obvious next step (**Review & Push** for green). `desolate.notifications: false` in the settings turns notifications off.

Each row can be:
- **marked as seen** (the check mark): it stays out of the list until its agent says something new. The view's **…** menu brings back everything marked as seen;
- **shown in Projects** (a click);
- **reviewed** (green), or its editor **opened** (when it runs).

### Projects

Every project, under its owner, with its worktrees. A row:

```
▾ acme
  ▾ ▶ widgets           main · needs a human: which API version? · 2.0 / 6.0 GiB
        editor          :8092
        vite (5173)     :8093
        note            taking the parser; issue-42 has the tests
      ○ issue-42        issue/42 ↑ not on GitHub · ready for a PR
```

- **The icon's shape** says whether it runs (filled) or not (outline). **Its colour** is the agent's status. While an action runs on it, the icon spins and says what it is doing.
- **The branch** checked out. A worktree on a branch of its own name doesn't repeat it, and a long branch is shortened in the middle.
- **Whether GitHub has it**, as desolate last saw GitHub (its last push or pull of that project):
  - nothing: GitHub has this commit;
  - `↑ not on GitHub`: GitHub has no such branch yet;
  - `≠ GitHub`: GitHub's branch is at another commit;
  - `↑2 ↓1`: the exact counts, once you've reviewed this commit.
- **The agent's message**, and for a running project **its dind's memory**, used and its ceiling.
- **Under a running target:** its ports, labelled from `portsAttributes` in its devcontainer.json, each with **Open**. Below them the agent's **note**: a click opens all of it.

The tooltip has all of it, with the status's age.

**Actions.** On the row itself:
- **Open editor**, and **Start** or **Stop**;
- **Review & Push**, when GitHub doesn't have the commit.

Everything else is in its right-click menu:
- copy the editor URL;
- **GitHub:** the issue (a worktree named `issue-<n>`), the pull requests from its branch, the branch, the repository;
- Review & Push, **Push without review**, Pull;
- Start, Stop, Rebuild;
- add or remove a worktree.

The view's title has:
- **Go to a target**;
- the **running only** filter;
- refresh;
- in its **…** menu, **Clone a repository** and **Show log**.

The view's subtitle is how many targets run, and what memory the VM has left.

### Review

What a push of a target's branch would send, before it does (`desolate --review`, `docs/agents.md`):
- what it is compared with;
- **pull first** when GitHub's branch has commits it lacks (the push would be refused);
- how many uncommitted changes the push would leave behind;
- the commits;
- the files: a click opens a file's two sides in the diff editor.

The view's title has **Push**, which asks once more, with the counts. It also has review again, and close.

The diff is read-only. Its two sides are what the target's sandbox read out of git, kept in the editor's cache. A binary file, a submodule, or one past the size limits is listed, and says so, without its content.

### Dinds

Each project dind: health, idle time, memory of its ceiling, image store; and the VM's headroom. Collapsed by default: Projects shows the memory that matters.

## From the keyboard

`ctrl+alt+d` (**desolate: Go to a target…**) picks a target, then what to do with it. Every action is also in the command palette, under `desolate:`. Run from there, it asks which target.

## A first project

With nothing in `/workspaces`, Projects offers **Clone a repository…**:
1. You name `owner/repo`.
2. desolate makes the repository's deploy key (`newrepo key`) and shows it.
3. You add it on GitHub, with write access. **Copy key and open GitHub** opens the page.
4. **Clone**: `newrepo clone`.

From the Mac, `./cli.sh repo add owner/repo` does all of it with your `gh`.

## What it may do

It runs only the editor's own commands: `desolate` (through the broker), `worktree`, and `newrepo`. Each runs with `execFile`, never through a shell. It runs no git and no docker of its own, and reaches no network. A GitHub link is opened by your browser.

It reads files the editor already mounts:
- each target's status, note and `HEAD`;
- its refs;
- its devcontainer.json's port labels;
- the editor's own caches: GitHub's branches as the last push or pull saw them, and the last review's file sides;
- the editor's git config, for the repository a project pushes to.

Every read of a project's file is contained to that project and bounded. A link out of the project is not followed.

**Words from a project stay plain text.** A status message, a note, a commit subject or a path is shown as itself, never as markdown: an image link in a note is not fetched, and a link is not made clickable. The same goes for the notifications.

`tests/static/08-editor-hardening.sh` holds the extension to the commands it may run. `tests/unit/extension/model.test.ts` holds it to what each view shows. `tests/environments/extension/run.sh` drives it in a browser against the real editor.
