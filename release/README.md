# desolate: coding agents in VMs of their own, on your Mac

**desolate** (dev + isolate) lets you work alongside coding agents without handing them your
machine, your credentials or your remotes. Each agent works in a **workspace**: a VM with
its own checkouts, the project's devcontainer and an editor in a browser tab, no keys, and
no network but its own proxy. It commits freely and offers its work; you review it in the
root VM's dashboard, and a push happens only when you approve the exact commit, with one
click.

![The dashboard: what needs you on top, then each domain's workspaces and their live branches](docs/assets/dashboard.png)

**Start here: [docs/getting-started.md](docs/getting-started.md)**: from nothing to an agent
working on your repository, in under half an hour (most of it the first download). Below:
the one rule to keep, the shape of the stack, the commands, and the principles; the details
are in [docs/reference.md](docs/reference.md). The design and its
reasons are in [`move-to-vms.md`](https://github.com/pmalacho-mit/isolated-devcontainers-suede/blob/main/move-to-vms.md); the security decisions and their
audits in [`docs/v3/decisions.md`](https://github.com/pmalacho-mit/isolated-devcontainers-suede/blob/main/docs/v3/decisions.md).

## The one rule you keep

**Your Mac and the root VM hold things worth stealing. Never run untrusted code in either.**

That is the state of computing, not something desolate can remove: your Mac controls every
VM, and the root VM holds the keys that write to your remotes. So:

- code an agent wrote, or a dependency you have not read, runs **in a workspace**: that is
  what workspaces are for;
- in the root you **look and decide**. The root gives you a dashboard, a diff that is plain
  text, and a terminal with ordinary git (`fetch`, `log`, `diff`, `checkout`, `merge`,
  `push`). All of that is safe on a tree an agent wrote, and desolate's tests attack it
  ([`tests/v3/t2/10-hostile-content.test.ts`](https://github.com/pmalacho-mit/isolated-devcontainers-suede/blob/main/tests/v3/t2/10-hostile-content.test.ts));
- in the root you do **not** build, install, test or open the tree in a tool that runs
  tasks. `git checkout dev/some-branch` is fine; `npm install` after it is running an
  agent's code beside your keys. There is no editor in the root, on purpose.

Keep that rule, and what an agent can reach is its own VM and the hosts you allowed.

## The shape of it

```
host (your Mac)      the desolate CLI and one daemon: the port forwarder and each workspace's link.
                     No keys. Runs no git on desolate's repositories.
  ~/.desolate/       mirrors/ (what each remote published), root/ (your own clones),
                     domains/<d>/ (each domain's clones, outbox and inbox)
root VM              every deploy key, the mirrors, your clones, one proxy per workspace.
                     Runs no workspace code. Pushes start here, and only from you.
workspace VMs        one per workspace, in a domain. Its checkouts, its agent. One link out:
                     to its own proxy.
```

A **domain** is a trust boundary: a set of repositories and network rules shared by every
workspace in it. Anything one workspace in a domain can do, assume every workspace in it can.
Two domains share nothing but read-only mirrors.

## Using it

```bash
desolate bootstrap                                   # from nothing to a working stack; ends with doctor
desolate clone acme/widgets                          # a read key, a write key, the mirror, your clone
desolate clone acme/consumer --no-push               # a read key only: never written through desolate
desolate domain create dev --title "widgets work" --repo acme/widgets --repo acme/consumer
desolate up dev --name issue-12 --branch issue/12 --fetch   # a worktree on issue/12 in each repository
                                                     # (or per repository: --checkout acme/widgets=worktree:issue/12)
desolate domain dev size --cpus 4 --memory 12g       # its workspaces' size (default: from your Mac)
desolate ui --open                                   # the dashboard, in Chrome or Firefox (not Safari)
desolate editor dev/issue-12 --open                  # its editor (VSCodium, in its VM), in a tab:
                                                     # every checkout of the workspace in one window
desolate exec dev/issue-12 -- <an agent, or any command>     # in its devcontainer (--vm: the VM itself)
desolate domain dev secret set MYAPP-OPENAI-KEY --hosts api.openai.com --headers authorization
                                                     # the value on stdin; workspaces send the name
desolate ports                                       # each dev server's URL, at the port it has inside
desolate status dev/issue-12 --json                  # what the agent says of its work
desolate list                                        # each workspace, and the branch each checkout is on now
desolate offers                                      # what workspaces have offered: needs you
desolate branches dev                                # every branch the domain has, offered or not;
                                                     # "merged into main" once its pull request is
desolate review dev acme/widgets issue/12 --diff     # what a push would send, and its diff as text
desolate review dev acme/widgets issue/12 --against domain   # ... or beside the domain's own main
desolate push dev acme/widgets issue/12 --expect <commit>   # asks you, on your terminal
desolate git acme/widgets --open                     # git in your browser: a shell in the git VM (below)
desolate upstream acme/consumer lib acme/lib --from dev/fix   # a vendored suede dependency's change, proposed to it
                                                     # (suede's own upstream, pinned; you approve the push)
desolate events                                      # what happens, as JSON lines, for your own scripts
desolate notify                                      # ... or as notifications: a push waiting, an agent asking
desolate root shell                                  # ordinary git on your clones: fetch --all, diff, push
desolate approve                                     # ... and this approves a `git push origin` made there
desolate approve --web                               # or: the approval page's address, for one click
```

Inside a workspace: `git fetch` (from the mirror: no key, no network), `desolate fetch`
(ask the root to refresh the mirror first), `desolate offer` (mark a branch ready for you;
`--base <branch>` names the branch its pull request goes into). After the push, desolate
gives GitHub's page for opening that pull request, filled in, for you to create as yourself.
Offering is not how work reaches the root: every commit on every branch is written out as
the agent makes it, and the root imports it within seconds (`desolate branches`, the
dashboard's Branches, `git fetch <domain>` in the git VM). An offer says "this is ready", and
brings the branch's new LFS objects with it. And `desolate status set green "ready: ..."`
says how the work is going. See [`AGENTS.md`](AGENTS.md), which is what an
agent in a workspace should read.

Everything up to a push can be scripted (`--json` on what a harness reads; exit codes 75 busy,
77 default branch, 78 no person confirmed, 79 `--expect` did not match). The one step a script
cannot take is approving a push, so a script's work ends at an offer.

## More

- [docs/getting-started.md](docs/getting-started.md): the whole loop, step by step, with pictures.
- [docs/reference.md](docs/reference.md): how approval works, the git terminal, `desolate events`,
  what the root takes from a workspace, devcontainers, secrets, the macOS firewall dialog, what
  is and is not done, and where the code is.
- [docs/agents.md](docs/agents.md): agents kept running and attached to (no tmux), Claude Code,
  and the factories: GitHub issues to agents in parallel, and suede upstreaming.
- [docs/suede.md](docs/suede.md): a vendored suede dependency changed in a consumer, proposed
  back to the dependency: `desolate upstream`, and the suede factory.
- [docs/developing-desolate.md](docs/developing-desolate.md): desolate developed from a desolate
  workspace: its tests there, an inner stack, and pushing, pulling and restarting on the change.
  An agent doing that reads the repository's own [`AGENTS.md`](../AGENTS.md).
- [AGENTS.md](AGENTS.md): what an agent in a workspace reads.
- [docs/incidents.md](docs/incidents.md): ways desolate has been wrong, and what each taught.

## Principles

Every design choice serves these, and each is proved by a test that tries to break it, beside
a control showing the test would have noticed.

- **P1. The editor is inside the boundary.** A workspace's editor runs in its VM and is used
  from a browser tab. Nothing from a workspace runs in a desktop editor on your Mac.
- **P2. Every push goes through a human.** A push to any remote happens only as the direct
  result of a person's action in the root, naming the repository, the branch and the exact
  commit they reviewed. No agent, workspace or automation can push.
- **P3. No credential enters a workspace.** Deploy keys live only in the root VM, behind an
  agent that signs but never exports. API secrets are placeholders inside workspaces.
- **P4. Every `.git` has exactly one owner, and git runs only under its owner.** The root
  never runs git in a domain's repository. Work crosses between owners only as data: a bundle
  file, LFS objects checked against their ids, or a read-only mirror.
- **P5. A boundary is enforced outside what it contains.** Assume an agent is root inside its
  VM. Its network path, its mounts and its view of other domains are decided by the host and
  the root, never by anything inside the VM.
- **P6. Fail closed, and say so.** A step that cannot be checked refuses rather than
  proceeding. Every refusal names what to do. A probe that failed to run is not a probe that
  found nothing.

