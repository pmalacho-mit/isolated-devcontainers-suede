# desolate v3: tests

```bash
tests/v3/run.sh t1     # static and unit: seconds, anywhere                    (make test)
tests/v3/run.sh t2     # end to end on the fake backend: minutes; needs Docker (make e2e-fast)
tests/v3/run.sh t3     # end to end on real VMs: tens of minutes under emulation (make e2e-slow)
```

A tier whose needs are not met fails and says what to install. It never skips.

| Tier | Backend | Proves | Does not prove |
|---|---|---|---|
| **T1** `t1/` | none | names, the name sniffer, the root's reading of an outbox; types; shell syntax | |
| **T2** `t2/` | `fake`: each "VM" is a container | everything but the hypervisor boundary: bootstrap, the keyring and the push gate, mirrors and LFS, domains and checkouts, the port router, offers and pushes, the proxy and its rules | **any boundary a VM gives.** A T2 test is never taken as proof of one |
| **T3** `t3/` | `qemu`: real VMs through Lima (KVM, or software emulation) | read-only shares against root in the VM, forced egress against root in the VM, no path between domains | anything about a Mac |
| **T4** | `vz` on a Mac | not written yet: see `docs/v3/HANDOFF.md` | |

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
  host; `docs/v3/decisions.md` says why that approver cannot tell this from a real person,
  and why the Mac's (Touch ID) can.
- **The editor is the real one**: the pinned VSCodium server in the base image. `t2/06`
  drives it over HTTP and WebSocket, and from headless Chrome.

## What a machine needs

- **T1:** node >= 22.18, `npm install` (for TypeScript). `shellcheck` if you have it.
- **T2:** also Docker, an ordinary user who can use it (not root), `git-lfs`, `python3`,
  Chrome or Chromium (`DESOLATE_CHROME=<path>` if it is not in a usual place), and
  the base image `desolate/base:latest`:
  - on Linux: `sudo release/image/build.sh --out <dir>` (from the Ubuntu archive; imports it);
  - where Docker Hub is reachable: `docker build -t desolate/base:latest -f release/image/Dockerfile release` (untested).
- **T3:** also Lima >= 2.0 (`limactl` on PATH), `qemu-system-<arch>`, `socat`, `uidmap`, and
  `DESOLATE_IMAGE_DIR=<dir>` pointing at what `build.sh` wrote.

## Debugging a failure

`DESOLATE_KEEP=1` leaves the test's stack up and writes its environment to
`/tmp/desolate-kept.env`; source it and run `release/cli.sh` by hand. Remove it afterwards
with `release/cli.sh destroy --all` and `docker rm -f` of the forge container.
