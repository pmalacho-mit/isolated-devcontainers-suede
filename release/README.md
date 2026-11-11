# desolate v3: a VM per workspace

**desolate** (dev + isolate) lets you work alongside coding agents without handing them your
machine, your credentials or your remotes. v2 did it with containers; v3 makes the **VM** the
unit of isolation. The design, and the reasons for it, are in
[`move-to-vms.md`](../move-to-vms.md).

> **v3 is being built.** This tree is not yet a replacement for v2 (which is in history at
> `4f32c77` and on the `release` branch). The [status table](#what-works-today-and-what-does-not)
> below says exactly what is implemented, and what each claim rests on.

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
desolate domain create dev --title "widgets work"
desolate domain dev add --repo acme/widgets
desolate up dev --name issue-12 --fetch \
    --checkout acme/widgets=worktree:issue/12 --base origin/main
desolate exec dev/issue-12 -- <an agent, or any command>
desolate ports                                       # each dev server's URL, at the port it has inside
desolate status dev/issue-12 --json                  # what the agent says of its work
desolate offers                                      # what workspaces have offered: needs you
desolate review dev acme/widgets issue/12            # what a push would send
desolate push dev acme/widgets issue/12 --expect <commit>   # asks you, on a terminal
desolate root shell                                  # ordinary git on your clones: fetch --all, diff, push
```

Inside a workspace: `git fetch` (from the mirror: no key, no network), `desolate fetch`
(ask the root to refresh the mirror first), `desolate offer` (mark a branch ready for you),
`/desolate/status set green "ready: ..."`. See [`AGENTS.md`](AGENTS.md), which is what an
agent in a workspace should read.

Everything up to a push can be scripted (`--json` on what a harness reads; exit codes 75 busy,
77 default branch, 78 no person confirmed, 79 `--expect` did not match). The one step a script
cannot take is the write key's confirmation, so a script's work ends at an offer.

## What works today, and what does not

"T2" is the fake backend: containers standing in for VMs, **not isolated**, good for
everything but the hypervisor boundary. "T3" is real VMs on Linux (QEMU through Lima).
"Mac" means Lima with Virtualization.framework, the product backend.

| | Implemented | Tested | Not yet |
|---|---|---|---|
| bootstrap, doctor, destroy | yes | T2, T3 | installing the host's own tools (it checks for them and says what to install) |
| Root VM: keyring, read and write keys, mirrors with LFS, root clones | yes | T2, T3 | |
| P2: pushes only by a person (`--expect`, exit codes, LFS first, audit) | yes | T2 | the root editor's Push button; see the residual in `docs/v3/decisions.md` |
| P3: keys never leave the keyring | yes | T2 | secrets: none are stored or substituted yet |
| P4: the root never runs git in a domain's clone | yes | T2 (a booby-trapped clone, a lying outbox) | |
| Domains, workspaces, checkouts, worktrees, locks, `--base`, `--fetch` | yes | T2, T3 | a domain's environment, templates, package caches |
| Offers, the root's view (`git fetch --all`), deliveries between domains | yes | T2 | `desolate upstream` (suede) |
| Ports: same number, routed by name, reservations | yes | T2 | forwarded connections on real VMs are untested |
| P5: read-only shares against root in the VM | yes | **T3** (and measured on an M1 for the Mac) | |
| P5: forced egress against root in the VM | yes | **T3**; Mac: measured for TCP, UDP, DNS; ICMP unverified | |
| Egress through each workspace's own proxy, per-domain rules, audit by link | yes | T2, T3 | **TLS is not terminated, so no secret is substituted** (Phase 4) |
| **P1: the editor** | **no** | | no workspace has an editor yet; nor is the project's devcontainer started |
| The root UI (dashboard), the state service | no | | |
| The Mac backend (`vz`) | written from the M1's measurements | **never run** | `docs/v3/HANDOFF.md` says how to bring it up |

## Layout

```
cli.sh             the launcher: finds node >= 22.18, runs host/cli.ts
pins.env           every tool desolate downloads, by version and sha256
host/              runs on the host: the CLI, the daemon (forwarder, links), the VM layer
  vm/              one interface, three backends: fake, qemu, vz
root/              runs in the root VM: keyring, mirrors, clones, offers, push, proxies
workspace/         runs in each workspace VM: its init, its daemon, its network, `desolate`
shared/            names, exit codes, the name sniffer: used on more than one side
image/             what a VM image contains (provision.sh) and how it is built
docs/incidents.md  ways desolate has been wrong, and what each taught
```

The code runs straight from this tree: every VM mounts it read-only at `/desolate/release`.
