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
desolate ui                                          # the dashboard (and the root editor): in your browser
desolate editor dev/issue-12                         # the address of its editor, for your browser
desolate exec dev/issue-12 -- <an agent, or any command>     # in its devcontainer (--vm: the VM itself)
desolate domain dev secret set MYAPP-OPENAI-KEY --hosts api.openai.com --headers authorization
                                                     # the value on stdin; workspaces send the name
desolate ports                                       # each dev server's URL, at the port it has inside
desolate status dev/issue-12 --json                  # what the agent says of its work
desolate offers                                      # what workspaces have offered: needs you
desolate review dev acme/widgets issue/12            # what a push would send
desolate push dev acme/widgets issue/12 --expect <commit>   # asks you: Touch ID on a Mac
desolate root shell                                  # ordinary git on your clones: fetch --all, diff, push
desolate approve                                     # ... and this approves a `git push origin` made there
```

Inside a workspace: `git fetch` (from the mirror: no key, no network), `desolate fetch`
(ask the root to refresh the mirror first), `desolate offer` (mark a branch ready for you),
`/desolate/status set green "ready: ..."`. See [`AGENTS.md`](AGENTS.md), which is what an
agent in a workspace should read.

Everything up to a push can be scripted (`--json` on what a harness reads; exit codes 75 busy,
77 default branch, 78 no person confirmed, 79 `--expect` did not match). The one step a script
cannot take is approving a push, so a script's work ends at an offer.

**Approving a push happens on the host, outside every VM.** The root's keyring lets a write
key sign only for a push whose description (repository, branch, commit) was signed by the
host's approver key. On a Mac that key is in the Secure Enclave and signs only with Touch ID
or your login password, so no program running as you can approve a push: not a script, not
an agent harness, not anything in a VM. Elsewhere it is a key file and a prompt on your
terminal (`DESOLATE_APPROVER=terminal`), which stops everything in the VMs but not a program
running as you on the host. `desolate approve --selftest` checks it without pushing anything.

**The dashboard** (`desolate ui`) is served by the root VM: every domain as a card, each
workspace with its status colour, "Needs you" on top, one click to open an editor, start,
stop, review an offer or push it (a push still waits for your approval on the host). It
shows the command behind every button. [A screenshot](../docs/v3/dashboard.png).

**Devcontainers.** A workspace runs its project's own `devcontainer.json`, unchanged, with
the devcontainer CLI and a docker daemon inside the workspace's VM. Nothing in a spec is
refused: the VM is the boundary. A spec that does not come up leaves the workspace as the
VM itself, and `up` says why.

**Secrets.** A workspace never holds a secret's value. It holds the name
(`export OPENAI_API_KEY=MYAPP-OPENAI-KEY`), and the root puts the value in its place on the
way out, only over TLS, only toward the hosts the secret names, only in the headers it names.
Connections to those hosts are the only ones whose TLS the root terminates (the workspace
trusts its domain's CA for that); everything else stays end to end.

## What works today, and what does not

"T2" is the fake backend: containers standing in for VMs, **not isolated**, good for
everything but the hypervisor boundary. "T3" is real VMs on Linux (QEMU through Lima).
"Mac" means Lima with Virtualization.framework, the product backend.

| | Implemented | Tested | Not yet |
|---|---|---|---|
| bootstrap, doctor, destroy | yes | T2, T3 | installing the host's own tools (it checks for them and says what to install) |
| Root VM: keyring, read and write keys, mirrors with LFS, root clones | yes | T2, T3 | |
| P2: pushes only by a person (`--expect`, exit codes, LFS first, audit) | yes | T2 | the root editor's Push button |
| P2: the approval is given on the host, outside every VM (a signed challenge; `desolate approve` for a raw `git push origin`) | yes | T2 with the `terminal` approver | **the Touch ID approver (`host/approver/touchid.swift`) has never been compiled or run**: T4 |
| P3: keys never leave the keyring; a secret's value never leaves the root | yes | T2 | |
| P4: the root never runs git in a domain's clone | yes | T2 (a booby-trapped clone, a lying outbox) | |
| Domains, workspaces, checkouts, worktrees, locks, `--base`, `--fetch` | yes | T2, T3 | a domain's environment, templates, package caches |
| Offers, the root's view (`git fetch --all`), deliveries between domains | yes | T2 | `desolate upstream` (suede) |
| Ports: same number, routed by name, reservations | yes | T2 | forwarded connections on real VMs are untested |
| P5: read-only shares against root in the VM | yes | **T3** (and measured on an M1 for the Mac) | |
| P5: forced egress against root in the VM | yes | **T3**; Mac: measured for TCP, UDP, DNS; ICMP unverified | |
| Egress through each workspace's own proxy, per-domain rules, audit by link | yes | T2, T3 | |
| Secrets: per domain, substituted for the hosts and headers they name, proven by the upstream's certificate, scrubbed from responses, switched off and on (`--ttl`) | yes | T2, T3 | v2's self-test fixture; "learn" as a timed mode |
| **P1: the editor**: VSCodium's server in every workspace VM (in the project's devcontainer when it can), its own hostname, v2's gate | yes | T2 (HTTP, WebSocket, a real browser), T3 | desolate's workspace extension (`carryover/editor/extension`: mapping `localhost` URLs) is not ported |
| The project's devcontainer, from its own `devcontainer.json`, inside the workspace VM; `exec` and the editor enter it | yes | T2 (an image, a Dockerfile, a failing spec, no spec, a changed spec) | compose specs start but their ports are not forwarded; features, templates and caches (C2 to C4) are not built or untested |
| The root UI: a state service in the root that pushes changes, a dashboard at `desolate.localhost`, the root editor (Restricted Mode) | yes | T2 (the spec's three budgets, a real browser), T3 (the state reaches the dashboard) | the dashboard is a page beside the root editor, not yet an extension inside it; `upstream` |
| The Mac backend (`vz`) | written from the M1's measurements | **never run** | `docs/v3/HANDOFF.md` says how to bring it up |

## Layout

```
cli.sh             the launcher: finds node >= 22.18, runs host/cli.ts
pins.env           every tool desolate downloads, by version and sha256
host/              runs on the host: the CLI, the daemon (forwarder, links), the VM layer
  vm/              one interface, three backends: fake, qemu, vz
  approver.ts      the key that approves pushes (approver/touchid.swift: the Mac's Secure Enclave)
root/              runs in the root VM: keyring, mirrors, clones, offers, push, proxies
  proxy/           each workspace's proxy; each domain's secrets and its secrets proxy
  stated.ts, ui/   the state service and the dashboard it serves; editor.sh: the root editor
workspace/         runs in each workspace VM: its init, its daemon, its network, its
                   devcontainer (devcontainer.ts, enter.sh), its editor
completion.bash    tab completion: source <(desolate completion)
shared/            names, exit codes, the name sniffer: used on more than one side
image/             what a VM image contains (provision.sh) and how it is built
docs/incidents.md  ways desolate has been wrong, and what each taught
```

The code runs straight from this tree: every VM mounts it read-only at `/desolate/release`.
