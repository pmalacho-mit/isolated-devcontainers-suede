# Diagnosing: the diff editor loads forever

**Symptom.** In a devcontainer's own editor (not the outer one), opening a change from the Source Control panel or its graph view shows a diff that never finishes loading. Opening the same files directly works. Reloading the window fixes it, for a while.

Collect the evidence below **while it is happening, before reloading**. A reload erases most of it.

## Background, for whoever diagnoses this

- The outer editor has no git extension. This only happens in a devcontainer's editor, which does.
- The diff's left side is a `git:` document that the git extension fills by running `git show` in the devcontainer. Plain files don't go through that path, which is why they still open.
- **Ruled out: desolate's forwarding closing idle connections.** The browser reaches the devcontainer's editor through the VM's ingress (`release/proxy/vm/ingress.py`, which pumps bytes both ways with no idle timeout) and a socat relay (`relayWithFallback` in `release/vscode-image/docker.ts`, with no `-T` inactivity timeout). Colima's own port forwarding from the Mac to the VM has not been examined.

Two likely causes:

1. **A stale provider after a reconnect.** The tab sat in the background (the browser throttles it), the Mac slept, or the network changed. The websocket dropped and the editor quietly reconnected. A `git:` request in flight at that moment never got an answer. Restarting the extension host clears it.
2. **The git extension stuck behind a git process.** It queues its git commands, so one hung `git` blocks every diff after it. Possible causes:
   - a leftover `index.lock`;
   - a command waiting on a pager, an editor or a credential prompt;
   - git running in the same repository at the same time. An agent committing in a worktree counts, because worktrees share the project's `.git`.

## Steps

### 1. In a terminal of that devcontainer's editor

```bash
ps -eo pid,etime,args | grep '[g]it '                                    # a git running for minutes?
ls -la "$(git rev-parse --git-common-dir)"/*.lock 2>/dev/null           # a leftover lock?
ls -la "$(git rev-parse --git-common-dir)"/worktrees/*/*.lock 2>/dev/null   # in a worktree's admin dir?
tmux ls 2>/dev/null                                                       # an agent session running here?
```

### 2. The editor's output channels

Open View → Output, then choose each channel from the dropdown:

- **Git:** copy the last ~30 lines. Each command is logged when it starts and again with its duration when it ends. Look for one that started and never finished.
- **Window:** look for `reconnect` or `disconnect` lines, and note their times.
- **Remote Server**, if listed: the same.

### 3. The browser console

Help → Toggle Developer Tools → Console. Copy any red errors, especially ones that mention `git:`, `vscode-remote`, a websocket, or `ECONNRESET`.

### 4. Context

- How long was the tab in the background, if it was? Did the Mac sleep?
- Did an agent commit in this project, or one of its worktrees, around that time?
- Is it one file, or every diff?

### 5. Before a full reload, try the lighter fix

Command palette → **Developer: Restart Extension Host**. Note whether the diff then loads.

## Reading the results

| What you saw | Points to |
| --- | --- |
| Restarting the extension host fixed it; reconnect lines in Window or Remote Server; nothing stuck in `ps` | cause 1, a stale provider after a reconnect |
| A long-running `git` in `ps`, or the Git log shows a command that started and never ended | cause 2. The command shows what it waits on. Killing it should unblock the diffs |
| A `*.lock` file and no git running | a leftover lock, usually from a git that was killed. Remove it only once no git is running |
| None of the above | send everything above, and the time it started |

## What to hand over

Paste the output of steps 1–3, plus the answers to step 4 and step 5's result, to whoever is diagnosing. Point them at this file.
