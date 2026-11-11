# desolate v3: handoff

Written 2026-11-11 by an agent in a cloud sandbox (x86_64 Linux, no `/dev/kvm`, no Mac), in
two passes: the overnight one, and a second that added the editor, secrets, and push
approval on the host (section 2a says what the second changed). It is for the owner and for an agent working **directly
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
start a project's devcontainer and has never run on a Mac (section 3). v2 is untouched in history and on `release`.

## 2. Where it stands

Phases are move-to-vms.md section 13.4's. "T2" is the fake backend (containers; not
isolated). "T3" is real VMs under QEMU, in the sandbox under software emulation.

| Phase | State | Evidence |
|---|---|---|
| 0. Probes | **Partly done.** Lima/vz measured on the M1: boot, clone, shares, a shared `.git`, read-only shares, the egress cut, devcontainers, the template flow. Apple Container and microsandbox not measured (not installed). One question open: ICMP. | `docs/v3/phase0/`, `decisions.md` |
| 1. Root VM | **Done.** Keyring (read keys; write keys that sign only against a person's approval), mirrors with LFS, root clones, `clone [--no-push]`, `fetch`, the CLI channel. | T2 `01-root` (13 tests), T3 |
| 2. One workspace | **Mostly.** Domain clone from the read-only mirror, forced egress through its own proxy, ports forwarded as they open, **the editor (VSCodium's server in the VM, its own hostname, v2's gate)**, the start-up breakdown line. **Missing: the devcontainer, caches C1, C2, C6.** | T2 `02`, `03`, `05`, `06`; T3 |
| 3. Domains | **Mostly.** Several repositories, the shared `.git`, worktrees, `--base`/`--fetch`, checkout locks, the board, two domains with one repository, the root's view, the poisoning test for storage. **Missing: the environment (4.5), templates and package caches (C3, C4).** | T2 `02`, `04`; T3 |
| 4. Secrets and policy | **Done but for two v2 features.** Per-domain open/enforce, allowlist, internal-address refusal, audit by link; **per-domain secrets, substituted by a secrets proxy in the root for the hosts and headers each names, proven by the upstream's certificate, scrubbed from responses.** Missing: switching a secret off for a while; the CA inside a devcontainer. | T2 `05`, `07`; T3 |
| 5. Offers and pushes | **Done except `upstream`.** `offer`, the request channel, import by bundle, review, push, `--expect`, exit codes, LFS first, the hostile domain repository; **approval given on the host, outside every VM, by a signed challenge (Touch ID on a Mac: written, never run)**; a raw `git push origin` in the root shell, approved with `desolate approve`. | T2 `04` (11 tests) |
| 6. Root UI and agents | **Not started.** `status` and `board` exist on the CLI. | |
| 7. Hardening | **Partly.** P1 to P6 are in the README; doctor's false-pass rule holds for the root's checks; the incidents page has v3's findings. | |

Test counts at this commit, in the sandbox: **T1 25, T2 68, T3 10; all passing** (T2 twice, the second time against the recorded transcripts; T3 twice).
T2 takes about 5 minutes. T3 takes about 21 minutes under software emulation (each VM takes about 3 minutes to boot there).

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

### What has never been run

- **The `vz` backend.** `release/host/vm/lima.ts` was written from the M1's Phase 0 results
  and from the `qemu` backend that does run. Expect to fix things on first contact
  (section 4).
- **Anything on arm64.**
- **The Touch ID approver.** `release/host/approver/touchid.swift` was written on Linux and
  has never been compiled. Everything around it (the challenge, the keyring's check, the
  CLI) is tested with the `terminal` approver, which makes the same kind of signature.
- **The editor on arm64**, and in a browser other than headless Chrome.
- **GitHub.** Every test uses the stand-in forge. `desolate clone` against GitHub (registering
  deploy keys with `gh`) is written and untested.
- **`release/image/Dockerfile`.** The sandbox cannot pull `ubuntu:24.04`.

## 3. What is missing that matters most

1. **The project's devcontainer is not started.** A workspace has its editor and its
   terminal, and both are the VM itself with what the base image has. A project that needs
   its own toolchain needs `devcontainer up` in the VM (section 5, item 1).
2. **The write key is still a file in the root VM.** Approval is now outside the VMs, and on
   a Mac it needs your finger. But a program running as you on the Mac can still enter the
   root VM as root and read the key file. `decisions.md` section 5.3 says what closes that:
   a write key held by the Secure Enclave. Until then, an agent harness running directly on
   the Mac is trusted not to do that.
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
   - **first, the approver.** It compiles `release/host/approver/touchid.swift` with `swiftc`
     (Xcode's command line tools) and asks the Secure Enclave for a key. This has never run.
     If it fails, bootstrap stops there and prints the compiler's or the enclave's last
     lines: fix the Swift (it is 60 lines; the API is CryptoKit's
     `SecureEnclave.P256.Signing.PrivateKey` with an `LAContext`), or get going with
     `DESOLATE_APPROVER=terminal release/cli.sh bootstrap` and come back to it. Once
     bootstrap passes: `release/cli.sh approve --selftest` must show the Touch ID dialog
     with the reason text, and print that the signature verifies. Things to check by hand:
     that cancelling the dialog approves nothing; that the dialog appears when the command
     is run with no terminal (`release/cli.sh approve --selftest </dev/null >/tmp/out 2>&1`);
     and whether an unsigned binary may use the enclave on this macOS (if not, the error
     says so, and the binary needs an ad-hoc signature: `codesign -s - <binary>`).
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

1. **The devcontainer in a workspace (Phase 2's other half).**
   - `release/workspace/start.sh` does not start `dockerd`; the image has it disabled at boot
     on purpose (the root VM runs no containers). Start it there for workspaces.
   - Run `devcontainer up` inside the VM against the checkout (`carryover/devcontainer/`).
     The editor already runs in the VM (`release/workspace/editor.sh`); the choice to make is
     whether it stays there, with its terminal entering the container, or moves into the
     container as in v2 (`carryover/editor/editor.ts` is v2's launch script for that).
   - Containers in the VM: their traffic must reach the relay too. `release/workspace/net/up.sh`
     already redirects in `prerouting`; the stub resolver must listen on the docker bridge, and
     `exec` should run in the devcontainer (`devcontainer exec`), not the VM. The domain's CA
     must be trusted inside the container and its builds (`carryover/proxy/install-ca.sh`,
     `trust-proxy-in-builds.sh`): `release/workspace/net/trust-ca.sh` does the VM only.
   - Dev servers inside the devcontainer are not VM listeners. Either run the devcontainer on
     the VM's network (`--network=host` through an override config) or have the workspace
     daemon list and dial into the container. The first is far simpler; compose specs need
     the second or a published port.
   - Templates (C3): `Backend.clone` exists and the M1 measured it. Build the template with
     the domain's trust, never the root's.
2. **The write key into the Secure Enclave** (`decisions.md`, section 5.3, "what is left").
   Then finish Phase 4's remainder: `desolate domain <d> secret off|on <NAME> [--ttl]`
   (v2's `off`/`until`, in `carryover/proxy/addon.py`), and desolate's extension in the
   workspace editor (`carryover/editor/extension`), which is what maps `localhost` URLs to
   the workspace's hostname (section 4.4).
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
- **The vz link is a loopback port on the Mac** (the guest's confinement allows it that one
  port). Any process on the Mac can connect to a loopback port, and behind this one is a
  workspace's proxy, which substitutes its domain's secrets. So a connection must open with
  a token the host made for that workspace and passed into its VM (`release/shared/link.ts`,
  unit-tested over a real socket in `tests/v3/t1/link.test.ts`); the daemon closes one that
  does not. The token is in the VM's metadata under `~/.desolate`, so this keeps out other
  users and sandboxed programs, not a program running as you. **Like the rest of the vz
  backend, the wiring of it has never run.**
- **Push approval** is outside the VMs, and what is left is in `decisions.md` section 5.3:
  the `terminal` approver does not stop a program running as you on the host; and with
  either approver the write key is still a file in the root VM, which a program running as
  you on the host can reach through the VM layer.
- **Keys and `sudo`:** in a Lima VM the login user can `sudo`. Keys and secrets are safe
  from the root's unprivileged processes and from every workspace; not from a person, or a
  program, that runs `sudo` in the root VM.
- **A secret can be USED by whatever can reach its domain's proxy**, though never read:
  every workspace of the domain (by design), and anything on the host that can run
  `desolate exec` in one.
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
- One tool in an image built by the sandbox differs from the pins: node (22.23.4, staged from
  the builder, not the pinned 24.18.0). The editor is the pinned one (its sha256 matched).
  An image built where the network is open gets the pinned node too.
- The editor's token is in the address `desolate up` and `desolate editor` print, so it is
  in the terminal's scrollback. It is the second lock; the first is that the port answers
  only on loopback and only to the editor's own hostname.

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
release/host/workspaces.ts     up, list, start, stop, rm, exec, editor
release/host/domains.ts        domain create, add, net, secret
release/host/push.ts           offers, review, push (challenge, approve, run), approve
release/host/approver.ts       the key that approves pushes; approver/touchid.swift for the Mac
release/host/daemon.ts         the forwarder (ports by name; editors on one port) and each workspace's link
release/host/vm/types.ts       THE interface every backend implements; read this first
release/host/vm/fake.ts        containers                    lima.ts  qemu and vz
release/host/vm/qemu-wrapper.sh  restrict=on and guestfwd for a workspace's QEMU

release/root/ops.ts            every operation the host can ask of the root: a fixed table
release/root/keyring.ts        two agents behind filtering relays; challenges, signed approvals; no export
release/root/repos.ts          keys, the mirror (with LFS), the root clone and its config
release/root/git.ts            how the root runs git, and the check that it is in its own repo
release/root/domains.ts        domains, workspaces, who holds which checkout
release/root/outbox.ts         reading a domain's outbox as data
release/root/git-remote-desolate.ts  a domain as a git remote: fetch (bundles), push (deliver)
release/root/offers.ts         taking an offer, LFS verification, review
release/root/push.ts           `desolate push` in the root: prepare (refusals, challenge), run
release/root/git-remote-desolate-push.ts  `git push origin` in the root shell: waits for `desolate approve`
release/root/send.ts           LFS first, then the commit: the one place commits leave from
release/root/pre-push.ts       only the commit that was approved goes to the remote's address
release/root/rootd.ts          the request channel (and where a state service would grow)
release/root/proxy/            proxy.ts, manage.ts: a workspace's proxy, one per workspace
                               secrets.ts, secrets_addon.py: a domain's secrets and its secrets proxy

release/workspace/init.ts      the domain's own git: clones and worktrees
release/workspace/wsd.ts       ports, reservations, bundles of branches, deliveries
release/workspace/sync.ts      bundles, LFS staging, the request channel's client
release/workspace/desolate.ts  `desolate fetch | offer | sync` inside a workspace
release/workspace/net/         the stub resolver, the redirect, the egress relay, trust-ca.sh
release/workspace/editor.sh    the editor: codium-server and editor-gate.ts in front of it
release/shared/approval.ts     the text a person approves      link.ts  the token that opens a vz link
release/workspace/status       /desolate/status (v2's, unchanged)
```

Conventions worth keeping: TypeScript that node runs by stripping types (no enums, no
parameter properties; `tsc -p .` is the only thing that checks it); every external program by
argv, never a shell string; every refusal a `Refusal` with a `fix`; comments that say why.
