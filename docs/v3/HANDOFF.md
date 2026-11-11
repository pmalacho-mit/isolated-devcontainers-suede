# desolate v3: handoff

Written 2026-11-11, at the end of one overnight session by an agent in a cloud sandbox
(x86_64 Linux, no `/dev/kvm`, no Mac). It is for the owner and for an agent working **directly
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
`release` branch that users install from, and `release/` here is v3, unfinished: it has no
editor (section 3). v2 is untouched in history and on `release`.

## 2. Where it stands

Phases are move-to-vms.md section 13.4's. "T2" is the fake backend (containers; not
isolated). "T3" is real VMs under QEMU, in the sandbox under software emulation.

| Phase | State | Evidence |
|---|---|---|
| 0. Probes | **Partly done.** Lima/vz measured on the M1: boot, clone, shares, a shared `.git`, read-only shares, the egress cut, devcontainers, the template flow. Apple Container and microsandbox not measured (not installed). One question open: ICMP. | `docs/v3/phase0/`, `decisions.md` |
| 1. Root VM | **Done.** Keyring (read keys; write keys that sign only against a person's approval), mirrors with LFS, root clones, `clone [--no-push]`, `fetch`, the CLI channel. | T2 `01-root` (13 tests), T3 |
| 2. One workspace | **Half.** Domain clone from the read-only mirror, forced egress through its own proxy, ports forwarded as they open, the start-up breakdown line. **Missing: the devcontainer, the editor, caches C1, C2, C6.** | T2 `02`, `03`, `05`; T3 |
| 3. Domains | **Mostly.** Several repositories, the shared `.git`, worktrees, `--base`/`--fetch`, checkout locks, the board, two domains with one repository, the root's view, the poisoning test for storage. **Missing: the environment (4.5), templates and package caches (C3, C4).** | T2 `02`, `04`; T3 |
| 4. Secrets and policy | **Policy only.** Per-domain open/enforce, allowlist, internal-address refusal, audit by link. **No secrets: the proxy does not terminate TLS.** | T2 `05`; T3 |
| 5. Offers and pushes | **Done except `upstream`.** `offer`, the request channel, import by bundle, review, push with the confirmation, `--expect`, exit codes, LFS first, the hostile domain repository. | T2 `04` (10 tests) |
| 6. Root UI and agents | **Not started.** `status` and `board` exist on the CLI. | |
| 7. Hardening | **Partly.** P1 to P6 are in the README; doctor's false-pass rule holds for the root's checks; the incidents page has v3's findings. | |

Test counts at this commit, in the sandbox: **T1 16, T2 53, T3 8; all passing.**
T2 takes about 3 minutes. T3 takes about 17 minutes under software emulation (each VM takes about 3 minutes to boot there). T3 passed once at this commit; it has not been repeated enough to call its transcript stable.

### What has never been run

- **The `vz` backend.** `release/host/vm/lima.ts` was written from the M1's Phase 0 results
  and from the `qemu` backend that does run. Expect to fix things on first contact
  (section 4).
- **Anything on arm64.**
- **The editor server.** The sandbox cannot download it, so the image built there has none.
- **GitHub.** Every test uses the stand-in forge. `desolate clone` against GitHub (registering
  deploy keys with `gh`) is written and untested.
- **`release/image/Dockerfile`.** The sandbox cannot pull `ubuntu:24.04`.

## 3. What is missing that matters most

1. **P1 is not delivered.** No workspace has an editor, and the project's `devcontainer.json`
   is not started: `desolate exec` runs a command in the VM itself. Until this lands v3 is a
   safe place to run an agent from the command line and nothing more.
2. **No secrets** (P3's second half). A workspace's proxy carries TLS end to end, so it
   cannot substitute a placeholder. An agent that needs an API key cannot run in a v3
   workspace yet.
3. **The Mac backend is unproven**, and one row of its boundary (ICMP) is unverified.
4. **No root UI.** Review and push are CLI and the root's shell.

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
   brew install lima node git-lfs            # Lima >= 2.0; the Mac has 2.1.2
   release/cli.sh bootstrap                  # backend vz is the default on macOS
   ```
   What it does, and where it may stop:
   - makes a base VM from Lima's pinned Ubuntu image and runs `release/image/provision.sh` in
     it (several minutes; needs the network). Watch for: a tool whose checksum in
     `release/pins.env` no longer matches (it refuses, correctly; re-pin deliberately); the
     editor server's download (`/opt/desolate/EDITOR-MISSING` in the VM means it did not come).
   - clones the base into the root VM with `limactl clone --set`, starts it, and runs
     `release/root/start.sh` as root in it. Watch for: the guest user's home and group (the
     script takes the uid and looks the rest up); `sudo -u desolate-keyring`.
   - ends with `doctor`. Every failure names a fix.
   desolate keeps its own Lima home: `LIMA_HOME=~/.desolate/lima limactl list` shows its VMs,
   and `~/.desolate/lima/<vm>/ha.stderr.log` is where a VM that will not start says why.
   Then: `release/cli.sh clone <a test repository>`, a domain, `up`, and the checks of
   `tests/v3/t3/01-boundaries.test.ts` by hand.

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

1. **The devcontainer and the editor in a workspace (P1; Phase 2's other half).**
   - `release/workspace/start.sh` does not start `dockerd`; the image has it disabled at boot
     on purpose (the root VM runs no containers). Start it there for workspaces.
   - Run `devcontainer up` inside the VM against the checkout (`carryover/devcontainer/`),
     then the editor server (`carryover/editor/editor.ts`, `editor-gate.ts`,
     `editor-settings.ts`), listening on a fixed port in the VM. The forwarder already knows
     the editor's hostname (`editorHostname` in `release/shared/names.ts`) and already refuses
     it for dev-server ports; add the one port it does answer for.
   - Containers in the VM: their traffic must reach the relay too. `release/workspace/net/up.sh`
     already redirects in `prerouting`; the stub resolver must listen on the docker bridge, and
     `exec` should run in the devcontainer (`devcontainer exec`), not the VM.
   - Dev servers inside the devcontainer are not VM listeners. Either run the devcontainer on
     the VM's network (`--network=host` through an override config) or have the workspace
     daemon list and dial into the container. The first is far simpler; compose specs need
     the second or a published port.
   - Templates (C3): `Backend.clone` exists and the M1 measured it. Build the template with
     the domain's trust, never the root's.
2. **Secrets (Phase 4).** Put mitmproxy with v2's addon where `release/root/proxy/proxy.ts`
   is: `carryover/README.md` says what changes. Then the CA into each workspace's trust store
   at boot, `desolate domain <d> add --secret`, and v2's proxy tests.
3. **The root editor, the state service and the dashboard (section 4.8).** Nothing exists.
   `release/root/rootd.ts` is the long-running process to grow the state service in;
   `carryover/editor/extension/model.mts` is the logic to keep.
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
- **vz, ICMP:** unverified (section 4, step 2).
- **vz, the link's port:** on a Mac a workspace's link is a loopback TCP port. Any program on
  the Mac can connect to it and use that workspace's proxy. Harmless today (the proxy holds
  no secrets); **not** harmless once it substitutes them. Give the link a token the host
  passes into the guest, or move it off TCP, before Phase 4 ships.
- **The push confirmation** cannot tell a real terminal from a fabricated one inside the
  root VM (`decisions.md`). `tests/v3/lib/person.py` is exactly that fabrication.
- **Keys and `sudo`:** in a Lima VM the login user can `sudo`. Keys are safe from the root's
  unprivileged processes and from everything outside the root VM; not from a person, or a
  program, that runs `sudo` in the root VM.
- **Bundles are not fsck'd on import** beyond what `fetch.fsckObjects` does for a fetch from
  a bundle file in the git that is installed (2.43 in the image). Not measured whether that
  setting applies to bundles in 2.43. Worth a test with a bundle carrying a malformed object.
- **The root mounts `domains/` read-write** (`decisions.md`): what keeps it out of a domain's
  repositories is `release/root/git.ts` and a test, not a mount.

**Behaviour**
- A workspace made before `domain add --repo` does not see the new repository (a share cannot
  be added to a running VM). The command says so.
- `desolate rm <domain>/<workspace>` leaves its worktrees and branches in the domain clone.
  Nothing garbage-collects a domain clone (`gc.auto=0`, by design; the gc job is not written).
- The host daemon asks each workspace for its listeners about once a second, by exec. Fine on
  a Mac (0.1 s a round trip); under emulation the interval stretches itself.
- The request channel's `lfs <repo> <oid>...` (older LFS objects on request) is not
  implemented: `fetch` and `offer` are.
- `suspend` is not implemented for Lima backends (Lima has none for vz): section 4.7's 5 s
  resume target is a 9.5 s boot today.
- `bootstrap` checks the host's tools and says what to install; it installs nothing.
- The fake backend runs each "VM" as a **privileged** container. It is for tests.
- Two tools in an image built by the sandbox differ from the pins: node (22.23.4, staged from
  the builder, not the pinned 24.18.0) and no editor. An image built where the network is
  open gets the pinned ones.

**Tests**
- T3's "mount the share afresh" attack cannot run on 9p (one mount per share). It does run on
  virtiofs: T4 on the Mac is where it means something.
- Nothing tests the forwarder against real VMs (T3 has no dev server). `Backend.dial` for Lima
  is a session running `socat`, as measured on the M1; it is exercised in T3 only by the link
  to the proxy, which uses the same call.
- Transcripts are recorded for T2 and T3 and compared exactly. If a run's wording differs by
  platform, prefer fixing the scrub in `tests/v3/lib/harness.ts` to loosening the comparison.

## 7. What the sandbox could not do, and how that shaped the work

- **No KVM, no Mac.** Real VMs ran under QEMU's software emulation through Lima (the release
  tarball the owner uploaded). The Mac backend was designed from measurements the owner ran
  from scripts in `tests/probes/v3/`.
- **A narrow network.** Reachable: the Ubuntu archive, npm, PyPI, git reads from GitHub. Not
  reachable: Docker Hub, GitHub releases, nodejs.org, Ubuntu's cloud images. So the base image
  is built from the archive with debootstrap (`release/image/build.sh`), node was staged from
  the builder, the editor server could not be fetched, and no real devcontainer image could
  be pulled. This is why the devcontainer and the editor were left for a machine that can.
- **TLS is re-signed** by the sandbox's proxy; `build.sh --build-ca` exists for that and
  leaves nothing in the image.

To rebuild the sandbox's test environment on a Linux machine: `apt-get install debootstrap
qemu-system-x86 qemu-utils socat uidmap git-lfs shellcheck`, Lima on PATH, a Docker daemon, a
non-root user in the `docker` group with entries in `/etc/subuid` and `/etc/subgid`, then
`sudo release/image/build.sh --out <dir>` and `DESOLATE_IMAGE_DIR=<dir> make e2e-slow`.

## 8. A map of the code

```
release/host/cli.ts            every verb; thin: each lives in a file beside it
release/host/stack.ts          which backend; the root VM's spec; rootctl (the CLI channel)
release/host/bootstrap.ts      bootstrap, doctor, destroy
release/host/workspaces.ts     up, list, start, stop, rm, exec
release/host/daemon.ts         the forwarder (ports by name) and each workspace's link
release/host/vm/types.ts       THE interface every backend implements; read this first
release/host/vm/fake.ts        containers                    lima.ts  qemu and vz
release/host/vm/qemu-wrapper.sh  restrict=on and guestfwd for a workspace's QEMU

release/root/ops.ts            every operation the host can ask of the root: a fixed table
release/root/keyring.ts        two agents behind filtering relays; approvals; no export
release/root/keyring-confirm.ts  the one program that files an approval; asks on a terminal
release/root/repos.ts          keys, the mirror (with LFS), the root clone and its config
release/root/git.ts            how the root runs git, and the check that it is in its own repo
release/root/domains.ts        domains, workspaces, who holds which checkout
release/root/outbox.ts         reading a domain's outbox as data
release/root/git-remote-desolate.ts  a domain as a git remote: fetch (bundles), push (deliver)
release/root/offers.ts         taking an offer, LFS verification, review
release/root/push.ts           the push: refusals, the confirmation, LFS first
release/root/rootd.ts          the request channel (and where a state service would grow)
release/root/proxy/            a workspace's proxy, and starting one per workspace

release/workspace/init.ts      the domain's own git: clones and worktrees
release/workspace/wsd.ts       ports, reservations, bundles of branches, deliveries
release/workspace/sync.ts      bundles, LFS staging, the request channel's client
release/workspace/desolate.ts  `desolate fetch | offer | sync` inside a workspace
release/workspace/net/         the stub resolver, the redirect, the egress relay
release/workspace/status       /desolate/status (v2's, unchanged)
```

Conventions worth keeping: TypeScript that node runs by stripping types (no enums, no
parameter properties; `tsc -p .` is the only thing that checks it); every external program by
argv, never a shell string; every refusal a `Refusal` with a `fix`; comments that say why.
