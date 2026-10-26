# The forge: GitHub issues in, draft PRs out

`./cli.sh forge` connects a project's factory to its GitHub repository.

- **Issues to worktrees.** Label an issue, and the factory opens a worktree for it.
- **Pushes to draft PRs.** When the worktree's branch is pushed, a draft PR that closes the issue is opened.
- **Merges to closes.** When the PR is merged, or the issue closed, the worktree is closed.

It is built on the factory (README, "A factory"); read that first if you haven't.

The one design decision to review is **where GitHub is reached from**. It's your Mac, with your own `gh` login. Nothing inside the stack (the VM, the proxy, the editor, any devcontainer) ever holds a GitHub credential or calls GitHub's API for this.

## The pieces, and where each runs

| Piece | Runs in | Does | Holds |
| --- | --- | --- | --- |
| `./cli.sh forge run` (`release/forge.sh`) | your Mac, in a terminal you leave open | polls GitHub, feeds the editor, opens PRs, comments | your `gh` login, nothing else |
| `work github <project> …` (`work.ts`) | the editor container, via `docker exec` | stores what the Mac saw; reports each item's state back | nothing new |
| the `github` adapter (`work-forge.ts`) | the editor's watcher, every tick | turns open issues into `open` requests, and finished ones into `close` requests | nothing new |
| the watcher (`work-watcher.ts`) | the editor | opens, pushes and closes worktrees under your policy, as for any request | the deploy-key agent, as before |
| an agent | the worktree's devcontainer | does the work, then `desolate-work done` | its own placeholder token, if you gave it one |

The Mac and the editor exchange **data only**:
- the Mac hands over a JSON snapshot on stdin: open issues by number and title, plus the numbers of finished ones;
- the editor answers with a tab-separated status line per item.

Nothing either side sends is run as a command.

## One issue, start to finish

Say `acme/widgets` has a factory, and issue **#42 "Fix the login redirect"** gets the label `desolate:run`.

1. **The Mac sees it.** Each `forge run` tick (every 60 s by default) lists the repository's open issues carrying the label. It hands them to the editor with `work github acme/widgets sync`.
2. **A request is written.** At the watcher's next tick, the adapter writes one `open` request:
   - from `forge/github`;
   - for worktree `issue-42`, on branch `<prefix>issue-42` (`factory/issue-42` with the default prefix);
   - with the issue's title as its title and brief.

   It also records the item on its own outbox (`refs/desolate/forge/github/outbox`). That record is what keeps #42 from ever being requested twice.
3. **Your policy decides.** The watcher treats it as any request: `forge/github` must be among the requesters (`forge add` puts it there), and the open-worktree cap applies.
   - If the cap is reached, the request **waits**.
   - If the repository has hooks and the policy doesn't allow them, it's **refused**; `./cli.sh work approve` overrides that.
   - Otherwise the worktree is created and started, and its checkout and hooks run in the worktree's sandbox, as always.
4. **The issue is told.** The next `forge run` tick comments: *"desolate opened worktree `issue-42` for this issue, on branch `factory/issue-42`."* If the request was refused or failed, it says so instead, and points at `./cli.sh work requests`.
5. **The work happens.** The agent in `issue-42`'s devcontainer, or you, does the work, commits, and says `desolate-work done`. The project's main tree sees all of this on `refs/desolate/*` as it happens; if it isn't running, everything waits on the refs.
6. **The branch is pushed.** It's pushed only if your policy is `on_done: push`, or when you run `./cli.sh work push acme/widgets issue-42`. The push is the watcher's usual one:
   - with the project's deploy key;
   - to its own repository;
   - never `main`, never forced.

   A push does **not** close a GitHub item.
7. **A draft PR is opened.** The next `forge run` tick sees `issue-42` reported pushed with no PR yet.
   - It first looks for an existing PR from that branch, so a restart never opens a second one.
   - If there is none, it opens a **draft** PR into the repository's default branch, titled after the issue, with a body that ends `Closes #42`.
   - It records the PR's URL in the editor.
8. **It's finished on GitHub.** That happens when the PR is merged, the PR is closed, or the issue is closed (by the merge, or by hand). The next tick tells the editor, and the adapter writes a `close` request.
9. **The worktree is closed.** It's stopped, purged and removed, **refused** if it still holds uncommitted work, as every close is. The issue gets a last comment: *"desolate closed worktree `issue-42`."*

If `forge run` isn't running, steps 1, 4, 7 and 8 wait for it. Nothing is lost: it reads GitHub as it is when it starts. Comments are posted once per issue and state; the markers that remember this are in `~/.local/state/desolate-forge/`.

## Setting it up

You need:
- **`gh`, logged in, on the Mac:** `brew install gh && gh auth login`. Your login needs to be able to read issues, comment, and open PRs on the repository.
- **A factory for the project:** `./cli.sh work init <project> …`. `--on-done push` lets an agent's `done` push its branch. The default, `hold`, waits for you to run `work push`, which is the safer way to start.
- **A deploy key with write access:** `./cli.sh repo add` registers one that way. The push in step 6 uses it.
- **The stack up.** `forge run` reaches the editor with `docker exec desolate-vscode`.

Then:

```bash
./cli.sh forge add acme/widgets acme/widgets     # the project, then its repository; --label to pick another label
./cli.sh forge run                               # leave it running; --interval 120, --once, --no-comments
./cli.sh forge status acme/widgets               # issue, worktree, branch, state, PR -- per item
```

`forge add` does three things:
- checks that `gh` can see the repository;
- creates the label if it's missing (an existing label is left as it is);
- records the repository and label in the project's policy, adding `github` to its adapters and `forge/github` to its requesters.

## What crosses from GitHub into the stack, and who controls it

- **Anyone who can label an issue can ask for a worktree.** That's anyone with triage access to the repository. They can only *ask*: the cap, the requesters and `on_done` in your policy decide what happens, and an open is refused for a repository with hooks unless you allow it.
- **The issue's title is the only text that crosses.** It's flattened to one line of printable characters and at most 200 of them. It's never used as a name: the worktree and branch are made from the issue number.
- **What goes back to GitHub:** comments that name worktrees and branches; draft PRs whose title is the issue's own; and branches pushed by the watcher as before. Nothing an agent wrote is posted to GitHub except its commits on the pushed branch.
- **A pushed branch runs your CI.** A draft PR from a branch in the same repository triggers `pull_request` workflows with the repository's secrets. That's why `on_done` defaults to `hold`: on `hold`, nothing reaches GitHub until you push it.

## Limits, as built

- **An agent sees only the title.** The request carries the issue's title and number, not its body or comments, and no agent can read GitHub (they hold no token). For anything longer, put it in the title or tell the agent with `./cli.sh work say`. Passing the body through would be a small change, but it's untrusted text going into an agent's instructions, so I left it for you to decide.
- **One request per issue, ever.**
  - If an item was finished and closed, re-labelling or reopening the issue doesn't open it again.
  - If an issue just loses its label, its worktree stays, and so does the item.
- **One repository per project, GitHub.com only.** No GitHub Enterprise host.
- **Polling, not webhooks.** A webhook needs something listening for it, and this stack listens only on loopback. Each tick makes two issue-list calls per project, plus a call or two per requested item that is not finished yet, well within `gh`'s rate limit.
- **The PR is a draft into the default branch.** You mark it ready and merge it on GitHub as usual.

## If something doesn't happen

| You see | Look at |
| --- | --- |
| no worktree for a labelled issue | `./cli.sh forge status <project>` (was it requested?), then `./cli.sh work requests <project>` (refused or waiting, and why) |
| no PR after a push | that the push happened (`work log <project> --type state`), and `forge run`'s own output |
| no close after a merge | that the worktree has nothing uncommitted (the close refuses otherwise, and says so in `work requests`) |
| a message from `forge run` saying the editor didn't answer | the stack is down, or the editor container isn't named `desolate-vscode` (`DESOLATE_EDITOR_CONTAINER` overrides it) |

## Trying it safely

Use a scratch repository with nothing in its CI first:

```bash
gh repo create <you>/desolate-forge-test --private --add-readme --clone=false
./cli.sh repo add <you>/desolate-forge-test                 # clones it, registers its deploy key with write access
```

A worktree starts from the devcontainer spec on its branch, so the repository needs one before the factory can open anything. In the editor's terminal:

```bash
cd /workspaces/<you>/desolate-forge-test
mkdir -p .devcontainer && echo '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu-24.04" }' > .devcontainer/devcontainer.json
git add .devcontainer && git commit -m "a devcontainer" && git push
```

Then, on the Mac:

```bash
./cli.sh work init <you>/desolate-forge-test --max 1        # on_done: hold
./cli.sh forge add <you>/desolate-forge-test <you>/desolate-forge-test
gh issue create -R <you>/desolate-forge-test --title "Try the forge" --label desolate:run --body "-"
./cli.sh forge run --once && sleep 20 && ./cli.sh forge run --once   # the watcher ticks in between
./cli.sh forge status <you>/desolate-forge-test             # issue-1 ... opened
```

Then commit something in `issue-1` and run `./cli.sh work push <you>/desolate-forge-test issue-1`. The next `forge run --once` opens the draft PR. Merge it, and two more ticks close the worktree.

Tested so far: `tests/integration/factory/github.sh`, which runs the real `forge.sh`, `work` and watcher, with a stand-in for `gh`. Nothing has run against GitHub itself yet, so this walkthrough is the first time.
