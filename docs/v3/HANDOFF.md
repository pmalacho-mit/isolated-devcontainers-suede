# desolate v3: handoff

Written 2026-11-11 and revised 2026-11-12 by an agent in a cloud sandbox (x86_64 Linux, no
`/dev/kvm`, no Mac), in four passes: the overnight one; a second that added the editor,
secrets, and push approval on the host (section 2a); a third that added the devcontainer,
the root UI, and what was still missing from v2 (section 2b); and a fourth that removed the
root's editor, put the diff in the dashboard, made the terminal approver the default, and
audited what the root takes from a domain (section 2c).
[`status-by-section.md`](status-by-section.md) goes
through the spec point by point. It is for the owner and for an agent working **directly
on the owner's M1**. It says where v3 stands, what each claim rests on, and what to do next,
in order.

Read with it: [`move-to-vms.md`](../../move-to-vms.md) (the spec),
[`decisions.md`](decisions.md) (what was decided, with measurements),
[`release/README.md`](../../release/README.md) (the status table),
[`tests/v3/README.md`](../../tests/v3/README.md) (the tiers).

## 1. Applying this work

The work is a branch of commits on top of `main` at `4f32c77` ("adding v3 document").

```bash
git checkout -b v3 4f32c77
git am < v3.mbox                 # or: git fetch /path/to/v3.bundle v3 && git checkout v3
git log --oneline 4f32c77..v3
git push -u origin v3
```

**Push it as a branch. Do not merge it to `main` yet.** `main`'s `release/` is pushed to the
`release` branch that users install from, and `release/` here is v3, unfinished: it does not
cache a project's environment and has never run on a Mac (section 3). v2 is untouched in history and on `release`.

## 2. Where it stands

Phases are move-to-vms.md section 13.4's. "T2" is the fake backend (containers; not
isolated). "T3" is real VMs under QEMU, in the sandbox under software emulation.

| Phase | State | Evidence |
|---|---|---|
| 0. Probes | **Partly done.** Lima/vz measured on the M1: boot, clone, shares, a shared `.git`, read-only shares, the egress cut, devcontainers, the template flow. Apple Container and microsandbox not measured (not installed). One question open: ICMP. | `docs/v3/phase0/`, `decisions.md` |
| 1. Root VM | **Done.** Keyring (read keys; write keys that sign only against a person's approval), mirrors with LFS, root clones, `clone [--no-push]`, `fetch`, the CLI channel. | T2 `01-root` (13 tests), T3 |
| 2. One workspace | **Done but for caches.** Domain clone from the read-only mirror, forced egress through its own proxy, ports forwarded as they open, the editor, **the project's devcontainer from its own spec, inside the VM**, the start-up breakdown line. **Missing: caches C2 to C4, templates, the workspace-side extension.** | T2 `02`, `03`, `05`, `06`, `08`; T3 |
| 3. Domains | **Mostly.** Several repositories, the shared `.git`, worktrees, `--base`/`--fetch`, checkout locks, the board, two domains with one repository, the root's view, the poisoning test for storage. **The environment is one repository's spec (`env --from`). Missing: composing specs, templates and package caches (C3, C4).** | T2 `02`, `04`; T3 |
| 4. Secrets and policy | **Done but for the self-test fixture and timed learn.** Per-domain open/enforce, allowlist, `recommend`, internal-address refusal, audit by link; per-domain secrets with hosts, headers, off/on and `--ttl`. | T2 `05`, `07`; T3 |
| 5. Offers and pushes | **Done except `upstream`.** `offer`, the request channel, import by bundle (every object strictly checked before it enters a root clone), review with a diff, push, `--expect`, exit codes, LFS first, the hostile domain repository and hostile content; **approval given on the host, outside every VM, by a signed challenge, on the terminal** (Touch ID: opt-in, written, never run); a raw `git push origin` in the root shell, approved with `desolate approve`. | T2 `04` (11 tests), `10` (6 tests) |
| 6. Root UI and agents | **The UI: done as a dashboard page. Agents: not started.** A state service in the root that pushes changes; the dashboard at `desolate.localhost` (cards, Needs you, one-click actions, review with the diff as text, push, first run). No editor in the root, by decision. The dispatchers are not ported. | T2 `09` (the spec's three budgets; a real browser); T3 |
| 7. Hardening | **Partly.** P1 to P6 are in the README; doctor's false-pass rule holds for the root's checks; the incidents page has v3's findings. | |

Test counts at this commit, in the sandbox: **T1 40, T2 96, T3 11; all passing.** (T3 with workspaces at 3 GiB, `DESOLATE_WORKSPACE_MEMORY_MIB=3072`: the sandbox has 8 GB for three VMs.)
T2 takes about 9 minutes. T3 takes about 27 minutes under software emulation.

### 2a. What the second pass changed

- **Every workspace has an editor.** `desolate up` prints its address; `desolate editor
  <domain>/<workspace>` prints it again. It is the pinned VSCodium `reh-web` server, baked
  into the base image, running in the workspace VM as the workspace's user, behind v2's
  gate. The sandbox could download it this time, so it is the real server that the tests
  drive, including from headless Chrome. `release/workspace/editor.sh`, `editor-gate.ts`,
  `editor-settings.ts`; the forwarder's part is in `release/host/daemon.ts`.
- **Secrets.** `desolate domain <d> secret set NAME --hosts ... [--headers ...]` (value on
  stdin), `secret list`, `secret rm`. `release/root/proxy/secrets.ts` and
  `secrets_addon.py` (mitmproxy 11.0.2, v2's addon cut down). TLS is terminated only for
  the hosts of a domain's secrets.
- **Push approval left the root VM.** `release/host/approver.ts`,
  `release/host/approver/touchid.swift`, `release/shared/approval.ts`; the keyring verifies
  signatures instead of trusting a terminal. `desolate approve [--selftest]`.
  `release/root/keyring-confirm.ts` and its sudo rule are gone.
- **A bug the first pass shipped:** a raw `git push origin` in the root shell could never
  have asked for confirmation from the pre-push hook, because git authenticates to the
  remote before it runs that hook. It now goes through `git-remote-desolate-push`.

### 2b. What the third pass changed

- **Devcontainers.** `release/workspace/devcontainer.ts` runs the devcontainer CLI in the
  workspace VM against the checkout's own spec; `enter.sh` is how `desolate exec` and the
  editor's terminal get into it; the editor's server runs in the container when it can.
  `desolate domain <d> env --from <repo>` chooses whose spec a domain runs.
- **The root UI.** `release/root/stated.ts` (the state service), `release/root/ui/` (the
  dashboard), and the host daemon's side of it in `release/host/daemon.ts`. (This pass
  also had an editor in the root; the fourth removed it.) `desolate ui` prints the address;
  [`dashboard.png`](dashboard.png) is what it looks like.
- **From v2:** secret switches (`secret off | on --ttl`), `net recommend`, `down`, tab
  completion (`desolate completion`).
- **Two things that changed under existing behaviour:** `bootstrap` now always runs the
  root's `start.sh` (it starts what a newer desolate added) and starts the host daemon; a
  workspace VM starts a docker daemon when something asks for one (socket activation), so
  it may have a `docker0` bridge beside loopback.

### 2c. What the fourth pass changed

- **The rule, stated.** The Mac and the root VM hold sensitive things, and untrusted code
  is never run in either (`release/README.md`, "The one rule you keep"). The rest of this
  pass follows from taking that as given.
- **No editor in the root.** `release/root/editor.sh` and `editor-settings.ts` are deleted.
  The root offers the dashboard, a diff as plain text (in the dashboard, and
  `desolate review <domain> <repo> <branch> --diff`), and a terminal for git.
- **The terminal approver is the default**, on the Mac too. `DESOLATE_APPROVER=touchid`
  opts in to the Secure Enclave key. Bootstrap on the Mac no longer starts with Swift.
- **What the root takes from a domain was audited by test, and two holes were found and
  closed** (`decisions.md`, "What the root takes from a domain"; `release/docs/incidents.md`):
  bundles were not checked on import (this file's own "known gaps" had it as unmeasured;
  measured, it was open), and the root removed a file of its own through a link planted in
  an outbox. Also closed: an LFS object was verified and then copied by path; status files
  were checked by name and then read. `release/root/outbox.ts` is now the only code that
  touches an outbox, and its top says how. New tests: T2 `10-hostile-content`, T1 `status`,
  more in T1 `outbox`.
- **A bug that only real VMs showed:** the state service ended the first time a bundle
  was checked (a watched directory tree; `release/docs/incidents.md`), and nothing started
  it again. Fixed; `rootd` and the state service are now kept running by
  `release/root/start.sh`. The real-VM tier found it because this pass added an offer to
  it; T3 had never carried one. **Expect more of this kind on the Mac**: what T2 proves
  is logic, not timing.
- **A refused bundle is said out loud**: to the workspace that offered, on the dashboard,
  and in `desolate offers`, with what to do.

### 2d. What the Mac bring-up found (2026-11-12, an agent on the M1)

The branches `mac/*` and their pull requests into `v3`; `docs/v3/mac-audit-notes.md` keeps
the security findings, open and closed.

- **The vz backend runs.** Bootstrap passed on first contact; the first workspace was up in
  13 s (VM boot 10 s). **Tier T4 passes, 11 of 11** (`TMPDIR=~/t tests/v3/run.sh t4`,
  3 min 15 s including a base VM provisioned from nothing): read-only shares and forced
  egress against root in the VM, ICMP included, no path between domains, an offer and
  hostile content over a real share, the editor, a secret.
- **ICMP** is closed on Lima 2.3.0 (measured); vz requires 2.3.
- **First-contact bugs**, each in `release/docs/incidents.md`: a `safe.directory` pattern
  git 2.43 ignores; a VM used before its shares were mounted; vz's per-guest view of
  ownership and its ~1 s of staleness between VMs (`decisions.md`, "On vz, a share is the
  host's files seen through each guest's own cache").
- **Security, fixed:** the root VM's login user had `NOPASSWD: ALL` (it runs the proxies
  and the git that reads a domain's packs); start-up followed links that user could
  plant; node and `/usr/local/bin` belonged to uid 1001; the dashboard answered any local
  program and handed it every editor's token; mitmproxy's dependencies were unpinned.
- **Security, open:** the proxies run as the same user as rootd, and a domain's secrets are
  that user's files (`mac-audit-notes.md`).
- **T2 on a Mac is partial** (the fake backend's link is a host socket Colima cannot reach):
  `tests/v3/README.md`.

### What has never been run

- **The `vz` backend.** `release/host/vm/lima.ts` was written from the M1's Phase 0 results
  and from the `qemu` backend that does run. Expect to fix things on first contact
  (section 4).
- **Anything on arm64.**
- **The devcontainer with a real project.** The tests use a small image made in the VM.
  Features, compose, and anything that pulls from a registry have not run. On the Mac the
  first `up` of a real project will pull through the workspace's proxy: watch
  `desolate net log <domain>`.
- **The dashboard on the Mac.** Its budgets are met on the fake backend, where reaching
  into a VM is a `docker exec`. On the Mac it is an ssh session through Lima; measure.
- **The Touch ID approver** (opt-in: `DESOLATE_APPROVER=touchid`).
  `release/host/approver/touchid.swift` was written on Linux and has never been compiled.
  The default `terminal` approver makes the same kind of signature and is what every test
  uses.
- **The checks that need Linux's `/proc`, on the Mac.** They run in the root VM, which is
  Linux everywhere, so this is one function: `readPlain` in `release/shared/status.ts`
  takes its other branch when the *host* reads a status file. T1 `status` covers that
  branch only when it is run on a Mac: run T1 there first.
- **The editor on arm64**, and in a browser other than headless Chrome.
- **GitHub.** Every test uses the stand-in forge. `desolate clone` against GitHub (registering
  deploy keys with `gh`) is written and untested.
- **`release/image/Dockerfile`.** The sandbox cannot pull `ubuntu:24.04`.

## 3. What is missing that matters most

1. **Nothing caches an environment.** Each workspace builds its project's devcontainer
   itself, from the network, every time it is made (section 4.7's C2 to C4, and templates).
   With a real toolchain that is minutes per workspace, against a target of 15 seconds.
2. **The write key is a file in the root VM**, and a program running as you on the Mac can
   enter the root VM as root and read it. Under the rule (no untrusted code on the Mac)
   that is accepted, not open. If the rule ever needs to be weaker, `decisions.md` section
   5.3 says what would close it: a write key held by the Secure Enclave.
3. **The Mac backend is unproven.** (Its ICMP row was measured closed on Lima 2.3.0.)
4. **A domain can fill the disk.** Nothing limits the size of an outbox or of a workspace's
   share. That costs availability, not integrity.

## 4. First things to do on the M1, in order

1. **T1.** `npm install && make test`. Seconds. If this fails on macOS, fix it first: it is
   the one tier that should be identical everywhere.

2. **Close Phase 0's open question.** `bash tests/probes/v3/phase0-mac-egress3.sh` (2 minutes).
   It tells whether a workspace's ping really leaves the Mac. Record the answer in
   `decisions.md` section 4.3 and change the "vz: ICMP from a workspace" row in
   `release/host/vm/lima.ts` (`check()`) to say what was found. If echoes do leave, that is
   a real channel and needs closing before vz is called isolated; `decisions.md` lists what
   was already tried.

3. **Bring up the `vz` backend.**
   ```bash
   brew install lima node git-lfs            # Lima >= 2.3 for vz (ICMP); the Mac has 2.3.0
   release/cli.sh bootstrap                  # backend vz is the default on macOS
   ```
   What it does, and where it may stop:
   - **first, the approver**: a key file in `~/.desolate/approver`, nothing to compile.
     `release/cli.sh approve --selftest` asks you to type a word on the terminal and prints
     that the signature verifies. (Touch ID is opt-in, later, and unrun:
     `DESOLATE_APPROVER=touchid release/cli.sh bootstrap` compiles
     `release/host/approver/touchid.swift` with `swiftc`. If you try it, check by hand that
     cancelling the dialog approves nothing, and whether an unsigned binary may use the
     enclave on this macOS: if not, `codesign -s - <binary>`.)
   - makes a base VM from Lima's pinned Ubuntu image and runs `release/image/provision.sh` in
     it (several minutes; needs the network). Watch for: a tool whose checksum in
     `release/pins.env` no longer matches (it refuses, correctly; re-pin deliberately); the
     editor server's download (`/opt/desolate/EDITOR-MISSING` in the VM means it did not come).
   - clones the base into the root VM with `limactl clone --set`, starts it, and runs
     `release/root/start.sh` as root in it. Watch for: the guest user's home and group (the
     script takes the uid and looks the rest up).
   - ends with `doctor`. Every failure names a fix.
   desolate keeps its own Lima home: `LIMA_HOME=~/.desolate/lima limactl list` shows its VMs,
   and `~/.desolate/lima/<vm>/ha.stderr.log` is where a VM that will not start says why.
   Bootstrap ends by printing the dashboard's address (`http://desolate.localhost:31581/?tkn=...`;
   `desolate ui` prints it again): open it. Without its token the dashboard answers 401,
   to any program on the Mac. It should say "host connected" and walk through the first steps; if it says
   the host is not connected, `~/.desolate/logs/daemon.log` says why.
   Then: `release/cli.sh clone <a test repository>`, a domain, `up` (open the editor address
   it prints in a browser), and the checks of `tests/v3/t3/01-boundaries.test.ts` by hand.
   The editor's port on the Mac is 31581 (`DESOLATE_EDITOR_PORT`); `*.localhost` resolves to
   loopback in Chrome, Firefox and Safari without any setup.

4. **Make tier T4.** `tests/v3/t3/` runs on the Mac as it is, with `DESOLATE_TIER=T4`
   (`tests/v3/lib/harness.ts` maps T4 to the `vz` backend), **except** that it needs the
   stand-in forge, which is a container: the Mac needs Docker (Colima is installed) and the
   base image for it (`docker build -t desolate/base:latest -f release/image/Dockerfile release`).
   The two assertions that read QEMU's command line apply to `qemu` only and are skipped on
   other tiers. Record its timings against section 4.7's targets: the M1 measured 11.0 s from
   clone to a running devcontainer, by hand.

5. **T2 on the Mac**, with the same image: `make e2e-fast`. It should pass unchanged; if a
   transcript differs only by platform, that is worth knowing about too.

## 5. Then, in this order

Each item names where to start. The order is by what unblocks use.

1. **Templates and caches (section 4.7).** `Backend.clone` exists and the M1 measured it:
   build a domain's environment once in a builder VM with the domain's trust (never the
   root's), and clone workspaces from its disk (C3). Then the pull-through registry (C2)
   and the domain's package caches (C4). Freeze the environment when the domain is made
   and pin its features then (`carryover/devcontainer/feature-pins.ts`).
   Also here: compose specs (forward their services' ports; test them), and the domain's
   CA for tools that ignore the environment (`carryover/proxy/install-ca.sh`).
2. **The workspace-side extension** (`carryover/editor/extension`), which is what maps
   `localhost` URLs to the workspace's hostname (section 4.4). And v2's self-test fixture
   for secrets.
3. **A quota for a domain's outbox and share; a side-by-side diff in the dashboard** if
   the unified one proves too little for review.
4. **`desolate upstream` (section 5.5).** `SUEDE_COMMIT` in `release/pins.env` is empty on
   purpose: pin it. `carryover/transfer/` has v2's rules. The forge's push hook already opens
   a stand-in pull request for a `downstream/...` branch, for the tests.
5. **The environment (4.5) and the caches (4.7: C2, C4).**
6. **Hardening**, the list in section 6.
7. **Ergonomics (13.3):** the fresh-eyes run, screenshots, budgets as tests. The transcripts
   are in place and are the thing to read first: `tests/v3/transcripts/`.

## 6. Known gaps and sharp edges

Things that are true of the code as it is, that the next person should not have to discover.

**Boundaries**
- **vz, ICMP:** closed on Lima 2.3.0 (measured; `decisions.md` 4.3). Lima 2.1.2 behaved differently and unexplainedly, so vz requires 2.3.0.
- **The vz link is a loopback port on the Mac** (the guest's confinement allows it that one
  port). Any process on the Mac can connect to a loopback port, and behind this one is a
  workspace's proxy, which substitutes its domain's secrets. So a connection must open with
  a token the host made for that workspace and passed into its VM (`release/shared/link.ts`,
  unit-tested over a real socket in `tests/v3/t1/link.test.ts`); the daemon closes one that
  does not. The token is in the VM's metadata under `~/.desolate`, so this keeps out other
  users and sandboxed programs, not a program running as you. **Like the rest of the vz
  backend, the wiring of it has never run.**
- **Push approval** is outside the VMs. It is a gate against work going out unread, not
  against hostile code on the Mac: a program running as you there can read the approver's
  key file, and can reach the write key through the VM layer (`decisions.md` section 5.3).
  The rule is that no such program is run.
- **Keys and `sudo`:** the root VM's login user has **no sudo** (it was Lima's
  `NOPASSWD: ALL` until the Mac bring-up; `release/docs/incidents.md`). That user runs
  rootd, the state service, git on a domain's packs and every proxy, so the write keys are
  now safe from a bug in any of those. The host reaches root by ssh as root with Lima's
  key. **Secrets are not yet**: a domain's secret values are files of that same user,
  because the proxies that substitute them run as it. Giving the proxies a user of their
  own is the next step (`docs/v3/mac-audit-notes.md`).
- **A secret can be USED by whatever can reach its domain's proxy**, though never read:
  every workspace of the domain (by design), and anything on the host that can run
  `desolate exec` in one.
- **What the root takes from a domain** (bundles, refs, LFS objects, requests, statuses)
  is checked data: `decisions.md` has the audit and what is left by nature (git's parsers
  on a pack an agent wrote; size; a person running a tree's code in the root). One branch
  with a dangerous object blocks its whole domain until it is deleted there, and says so.

## 8. A map of the code

```
release/host/cli.ts            every verb; thin: each lives in a file beside it
release/host/stack.ts          which backend; the root VM's spec; rootctl (the CLI channel)
release/host/bootstrap.ts      bootstrap, doctor, destroy
release/host/workspaces.ts     up, list, start, stop, rm, exec (through enter.sh), editor
release/host/domains.ts        domain create, add, net, secret
release/host/push.ts           offers, review, push (challenge, approve, run), approve
release/host/approver.ts       the key that approves pushes (terminal by default; approver/touchid.swift is opt-in)
release/host/daemon.ts         the forwarder (ports by name; editors on one port) and each workspace's link
release/host/vm/types.ts       THE interface every backend implements; read this first
release/host/vm/fake.ts        containers                    lima.ts  qemu and vz
release/host/vm/qemu-wrapper.sh  restrict=on and guestfwd for a workspace's QEMU

release/root/ops.ts            every operation the host can ask of the root: a fixed table
release/root/keyring.ts        two agents behind filtering relays; challenges, signed approvals; no export
release/root/repos.ts          keys, the mirror (with LFS), the root clone and its config
release/root/git.ts            how the root runs git, and the check that it is in its own repo
release/root/domains.ts        domains, workspaces, who holds which checkout
release/root/outbox.ts         THE ONLY code that touches a domain's outbox: a checked, held directory; names only
release/root/git-remote-desolate.ts  a domain as a git remote: fetch (bundles, strictly checked in quarantine), push (deliver)
release/root/offers.ts         taking an offer, LFS verification, review, the diff as text
release/root/push.ts           `desolate push` in the root: prepare (refusals, challenge), run
release/root/git-remote-desolate-push.ts  `git push origin` in the root shell: waits for `desolate approve`
release/root/send.ts           LFS first, then the commit: the one place commits leave from
release/root/pre-push.ts       only the commit that was approved goes to the remote's address
release/root/rootd.ts          the request channel
release/root/stated.ts         the state service: holds the state, pushes it; ui/ is the dashboard
release/shared/actions.ts      what the dashboard may ask the host to do: a fixed list
release/root/proxy/            proxy.ts, manage.ts: a workspace's proxy, one per workspace
                               secrets.ts, secrets_addon.py: a domain's secrets and its secrets proxy

release/workspace/init.ts      the domain's own git: clones and worktrees
release/workspace/wsd.ts       ports, reservations, bundles of branches, deliveries
release/workspace/sync.ts      bundles, LFS staging, the request channel's client
release/workspace/desolate.ts  `desolate fetch | offer | sync` inside a workspace
release/workspace/devcontainer.ts  the project's devcontainer, in the VM; enter.sh enters it
release/workspace/net/         the stub resolver, the redirect, the egress relay, trust-ca.sh
release/workspace/editor.sh    the editor: codium-server and editor-gate.ts in front of it
release/shared/approval.ts     the text a person approves      link.ts  the token that opens a vz link
release/workspace/status       /desolate/status (v2's, unchanged)
```

Conventions worth keeping: TypeScript that node runs by stripping types (no enums, no
parameter properties; `tsc -p .` is the only thing that checks it); every external program by
argv, never a shell string; every refusal a `Refusal` with a `fix`; comments that say why.
