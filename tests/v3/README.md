# desolate v3: tests

```bash
tests/v3/run.sh t1     # static and unit: seconds, anywhere                    (make test)
tests/v3/run.sh t2     # end to end on the fake backend: minutes; needs Docker (make e2e-fast)
tests/v3/run.sh t3     # end to end on real VMs: tens of minutes under emulation (make e2e-slow)
```

A tier whose needs are not met fails and says what to install. It never skips.

| Tier | Backend | Proves | Does not prove |
|---|---|---|---|
| **T1** `t1/` | none | names, the name sniffer, the root's reading of an outbox and of status files (links, swapped directories, fifos); types; shell syntax | |
| **T2** `t2/` | `fake`: each "VM" is a container | everything but the hypervisor boundary: bootstrap, the keyring and the push gate, mirrors and LFS, domains and checkouts, the port router, offers and pushes, the proxy and its rules, the editor, secrets, devcontainers, the dashboard, and what a hostile domain can send the root (`10-hostile-content`) | **any boundary a VM gives.** A T2 test is never taken as proof of one |
| **T3** `t3/` | `qemu`: real VMs through Lima (KVM, or software emulation) | read-only shares against root in the VM, forced egress against root in the VM, no path between domains; an offer, a dangerous tree and a linked outbox over a real share | anything about a Mac |
| **T4** | `vz` on a Mac: the same `t3/` file, `tests/v3/run.sh t4` | as T3, on the product backend; ICMP too | the qemu-only assertions (QEMU's command line) |

How the tests are built (move-to-vms.md section 13):

- **Every end-to-end test starts from `desolate bootstrap` on an empty home**, so
  bootstrapping is tested every time.
- **Every negative check sits beside a control.** "Root cannot write the mirror" is beside
  "the same write lands in the share root may write". A check with no control can pass by
  being broken, and several of this suite's first drafts did.
- **Transcripts.** Each test records every command it ran through the CLI and what it
  printed, scrubbed of paths and ids, and compares it with `transcripts/<name>.txt`. A changed
  message is a reviewed change: read the diff, then `UPDATE_TRANSCRIPTS=1`.
- **The stand-in forge** (`forge/`): a git server over ssh where keys are per repository and
  read-only or read-write, as GitHub's deploy keys are; an LFS server; a push hook standing in
  for a dependency's Action; and a web server standing in for "a host on the internet". No
  test talks to GitHub.
- **`lib/person.py` plays the person**: it runs a command on a pseudo-terminal and types the
  answer to a prompt. The tests' stacks use the `terminal` approver, whose prompt is on the
  host. That approver is the default everywhere; `docs/v3/decisions.md` says what it is
  for, why it cannot tell this from a real person, and what the opt-in Touch ID one adds.
- **Hostile content is made with plumbing** (`t2/10`): git's own commands refuse to make a
  tree with `.git` in it, so the test builds trees with `git mktree` and commits with
  `git commit-tree`, as an attacker would. Each dangerous object is offered alone, so each
  is refused for what it is.
- **Devcontainers need no registry**: `lib/devimage.sh` makes a small image inside a
  workspace VM from the VM's own files, under a name whose registry does not exist.
- **The editor is the real one**: the pinned VSCodium server in the base image. `t2/06`
  drives it over HTTP and WebSocket, and from headless Chrome.

## What a machine needs

- **T1:** node >= 22.18, `npm install` (for TypeScript). `shellcheck` if you have it.
- **T2:** also Docker, an ordinary user who can use it (not root), `git-lfs`, `python3`,
  Chrome or Chromium (`DESOLATE_CHROME=<path>` if it is not in a usual place), and
  the base image `desolate/base:latest`:
  - on Linux: `sudo release/image/build.sh --out <dir>` (from the Ubuntu archive; imports it);
  - where Docker Hub is reachable: `docker build -t desolate/base:latest -f release/image/Dockerfile release`
    (works on an M1, arm64).
- **T3:** also Lima >= 2.0 (`limactl` on PATH), `qemu-system-<arch>`, `socat`, `uidmap`, and
  `DESOLATE_IMAGE_DIR=<dir>` pointing at what `build.sh` wrote.

- **T4:** a Mac, Lima >= 2.3, Docker for the stand-in forge (Colima works:
  `colima start --vm-type vz`), and the base image built as above. The forge publishes its
  ports on the Mac's loopback, including 80 and 443, which must be free.

### On a Mac, two things about TMPDIR

Run the end-to-end tiers with `TMPDIR` set to a **short** directory **under your home**:

```bash
mkdir -p ~/t && TMPDIR=~/t tests/v3/run.sh t4
```

- *Under home*: Colima shares only your home with its VM, so a bind mount from
  `/var/folders/...` (macOS's default `TMPDIR`) arrives in the forge's container empty, and
  every suite fails with "the stand-in forge did not start".
- *Short*: macOS limits a unix socket's path to 104 bytes, and Lima's ssh control socket
  lives under the test's home (`.../home/lima/<vm>/ssh.sock.<16 digits>`). With
  `~/tmp-desolate-tests` that was 106 bytes and Lima refused to start the base VM.

### T2 on a Mac is a partial tier

The fake backend's network link is a unix socket on the host, bind-mounted into a
`--network none` container. Colima's containers run in a Linux VM, which cannot connect to
a socket made on the Mac, so every test that sends traffic from a workspace (egress,
secrets, the devcontainer's pulls, dev servers) fails with "this workspace's proxy is not
answering". Git, offers, the root's checks and most of the dashboard do run. Use T2 on
Linux for the rest; on the Mac, the boundary tier is T4.

## Debugging a failure

`DESOLATE_KEEP=1` leaves the test's stack up and writes its environment to
`/tmp/desolate-kept.env`; source it and run `release/cli.sh` by hand. Remove it afterwards
with `release/cli.sh destroy --all` and `docker rm -f` of the forge container.
