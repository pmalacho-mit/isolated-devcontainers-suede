# Getting started with desolate

From nothing to a coding agent working on one of your repositories in a VM of its own, its
work reviewed by you and pushed with one click. Under half an hour, most of it waiting for the
first VM images to download.

![The dashboard: what needs you on top, then each domain's workspaces and their live branches](assets/dashboard.png)

## What you need

- **A Mac with Apple silicon** (M1 or later). desolate runs its VMs with Apple's
  Virtualization.framework, through Lima; an Intel Mac is not supported.
- **Homebrew**, and from it: `brew install lima node gh`
  - Lima **2.3 or newer** (`limactl --version`): older versions let a confined VM's pings out.
  - node **22.18 or newer**: desolate is TypeScript that node runs directly.
  - GitHub's CLI, signed in (`gh auth login`) as someone who can add deploy keys to the
    repositories you want agents to work on: that is admin on the repository. Without it,
    see step 3: such a repository can be read and worked on, and you push its branches
    yourself, outside desolate.
- **Chrome or Firefox.** desolate's pages live at names under `localhost`
  (`desolate.localhost`, `desolate-git.localhost`, ...). Those browsers resolve them; Safari
  does not.
- About 15 GB of disk for the VM images and your repositories' mirrors.

You do **not** need Docker on your Mac: the projects' devcontainers run inside the VMs.

## 1. Install

```bash
git clone --branch release https://github.com/pmalacho-mit/isolated-devcontainers-suede ~/desolate
mkdir -p ~/.local/bin && ln -sf ~/desolate/cli.sh ~/.local/bin/desolate
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
desolate help
```

Leave the clone where it is: every VM reads desolate's code from it. For tab completion, add
`source <(desolate completion)` to `~/.zshrc`.

## 2. Bootstrap the stack

```bash
desolate bootstrap
```

This makes the **root VM**, which holds every deploy key and your repositories' mirrors and
never runs an agent's code, then starts the host daemon, then runs `desolate doctor`. The
first time it downloads a base image and takes 5 to 10 minutes; after that, seconds. It ends
with every check passed:

```
  ok   root: the Mac's loopback is walled off: the root's own user cannot reach a port that answers on the Mac's 127.0.0.1, ...
doctor: all checks passed.
```

If macOS asks whether `limactl` may accept incoming network connections, **click Deny**:
desolate listens only on your Mac's loopback ([why](../README.md#on-a-mac-if-macos-asks-about-limactl-and-incoming-connections)).

## 3. Clone a repository, and make a domain

```bash
desolate clone you/app                        # makes a read and a write deploy key, registers them with gh
desolate clone you/lib
desolate domain create acme --repo you/app --repo you/lib
```

```
  read key: registered
  write key: registered (it asks you before every push)
cloned you/app: 2 branch(es), default main, 2 LFS object(s); pushable.
```

- `clone` keeps the keys in the root VM, where nothing an agent runs can reach them, and
  mirrors the repository (with its LFS files). The keys are deploy keys on GitHub, titled
  `desolate read (host ...)` and `desolate write (host ...)`.
- Not an admin of the repository? `--no-push` registers a read key only: agents can work on
  it and you review their branches, but desolate cannot push it. `--anonymous` registers no
  key at all, for a public repository.
- A **domain** is a trust boundary: its repositories, its network rules, its secrets.
  Workspaces in one domain can see each other's branches; workspaces in different domains
  share nothing.

## 4. Start a workspace

```bash
desolate up acme --name agent-1 --branch feature/greet-by-name
```

```
workspace acme/agent-1 is up
  you/app  worktree feature/greet-by-name from main  /workspaces/you/app/.worktrees/feature-greet-by-name
  you/lib  worktree feature/greet-by-name from main  /workspaces/you/lib/.worktrees/feature-greet-by-name
  devcontainer up (mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm, user node)
  ...
the start took 81.9 s: template 63.7 s, asked the root 0.2 s, VM booted 9.6 s, services, checkouts, devcontainer and editor 8.2 s
next: desolate editor acme/agent-1 --open      its editor, in your browser
      desolate exec acme/agent-1 -- <agent>       an agent (or any command), in its devcontainer
```

A workspace is a VM with a worktree of each repository, on the branch you named. Each
repository can have its own branch: `--checkout you/lib=worktree:fix/token` for that one
(repeat it per repository), `--branch` for the rest, `--checkout you/lib=main` for a
repository's main checkout.

**Its size.** By default a workspace gets half your Mac's cores (2 to 4), a quarter of its
memory (3 to 8 GiB) and 30 GiB of disk; `desolate bootstrap` says what that comes to on your
Mac. Change it for a domain, or for one workspace:

```bash
desolate domain acme size --cpus 4 --memory 12g --disk 60g    # its new workspaces
desolate up acme --name big --memory 16g                       # this one
```

What it costs: CPUs are shares of your Mac's time (an idle VM uses almost none); memory is a
ceiling the VM fills as it uses it (and macOS is slow to take back); disk grows as it is
written. `desolate list` shows each workspace's size. A workspace keeps the size it was made
with. If the
first repository has a `devcontainer.json`, it runs inside the VM, as written. The first
workspace of a domain builds the domain's environment once (the "template" above); the
next ones start from it in about 20 seconds.

The workspace has **no credentials and no network** but its own proxy (HTTP and HTTPS to
named hosts; `desolate domain acme net enforce` limits even that to a list).

## 5. Put an agent to work

```bash
desolate editor acme/agent-1 --open          # VSCodium, running in the VM, in a browser tab
desolate exec acme/agent-1 -- <an agent CLI> # it runs in the devcontainer, in the first checkout
```

**Claude Code, for example**, kept running so you can attach to it from your own terminal
(no tmux: your terminal's scrollback and copy work):

```bash
claude setup-token        # on your Mac, once: a subscription token
desolate domain acme secret set CLAUDE-OAUTH --hosts api.anthropic.com --headers authorization   # paste it
desolate agent start acme/agent-1 --name claude -- \
  env CLAUDE_CODE_OAUTH_TOKEN=CLAUDE-OAUTH claude --permission-mode auto "Greet by name"
desolate agent attach acme/agent-1 --name claude      # Ctrl-] detaches; it keeps running
```

The token never enters the workspace: it holds the name `CLAUDE-OAUTH`, which its proxy
replaces on the way to api.anthropic.com. Claude Code must be in the project's environment
(the devcontainer feature `ghcr.io/anthropics/devcontainer-features/claude-code:1`). More,
including agents for labelled GitHub issues, in parallel: [agents.md](agents.md).

![The workspace's editor: both repositories in one window, and a terminal inside the devcontainer](assets/editor.png)

The agent reads [`AGENTS.md`](../AGENTS.md) (it is in every workspace at
`/desolate/release/AGENTS.md`): it commits freely, says how it is going with
`desolate status set <colour> "<message>"`, and when the work is ready, runs
`desolate offer`. It cannot push, and does not need to try.

## 6. Review

```bash
desolate ui --open                           # the dashboard
```

Everything an agent commits reaches the root within seconds. The dashboard shows each
checkout's branch as it changes, what needs you (offers, agents asking for help), and every
branch of every domain under **Branches**:

![Every branch a domain has, offered or not, with Review and Open in git](assets/dashboard-branches.png)

**Review** shows what a push would send: the commits, the files and the diff, made by git in
the root VM, from the objects alone (nothing in the branch runs):

![Reviewing an offer: commits, files, and the diff as text](assets/review.png)

## 7. Push it

Two ways, and both end with you approving the exact commit:

- From the dashboard: **Push exactly <commit>**, then approve it on the approval page
  (`desolate approve --web --open`; keep that tab) or with `desolate approve` in a terminal.
- From the **git terminal**, which is git as you use it anywhere, in a VM of its own with no
  network and no keys:

```bash
desolate git you/app --open
```

```bash
desolate fetch                                  # in the git terminal: refresh from GitHub, fetch every remote
git log --oneline acme/feature/greet-by-name    # each domain is a remote
git push origin acme/feature/greet-by-name:refs/heads/feature/greet-by-name
```

The push waits for you, and the approval opens beside the terminal: what the push names, and
what it would send, worked out in the root. **Approve** arms only when the pointer moves onto
it; one click, and the root pushes exactly that commit.

![A push from the git terminal, waiting for approval beside it](assets/git-approve.png)

## 8. Hear about it

```bash
desolate notify            # macOS notifications: a push waiting, an offer, an agent asking for you
desolate events            # the same, as JSON lines, for your own scripts
```

The [README](../README.md) ("Your own scripts") has a script that opens a pull request for
every branch desolate pushes.

## Day to day

| | |
|---|---|
| `desolate list` | every domain and workspace, with the branch each checkout is on now |
| `desolate branches [<domain>]` | every branch the domains have, offered or not |
| `desolate review <domain> <repo> <branch> [--diff]` | what a push would send |
| `desolate stop / start / rm <domain>/<workspace>` | a workspace's VM; `rm` removes the VM (its branches stay in the domain's clones) |
| `desolate fetch <repo>` | refresh a mirror from its remote |
| `desolate doctor` | every check, with what to do about each that fails |
| `desolate down` | stop every VM and the daemon; remove nothing |
| `desolate bootstrap`, then `desolate start <domain>/<workspace>` | bring it back after `down` or a restart of the Mac |

## Removing it

```bash
desolate rm acme/agent-1          # a workspace's VM (its branches stay)
desolate rm acme                  # a domain and its clones
desolate destroy                  # every VM; your clones and keys stay in ~/.desolate
desolate destroy --all            # and ~/.desolate: mirrors, clones, the root's keys
```

Then, on GitHub, delete the deploy keys titled `desolate read (host ...)` and
`desolate write (host ...)` from each repository you cloned.

## When something is wrong

- **`desolate doctor`** says what is wrong and what to run. Every refusal desolate prints
  ends with a `fix:` line.
- **A page "cannot be found"**: open it in Chrome or Firefox, not Safari.
- **An agent says it cannot reach something**: that is usually the point. Its requests, and
  why each was refused, are in `desolate net log acme`.
- **A push was refused at approval**, or timed out: it waits two minutes; run it again.
- What desolate has got wrong before, and how it was found: [`incidents.md`](incidents.md).
