# Security audit notes from the Mac bring-up (2026-11-11 and 12)

Kept by the agent on the M1 as the vz backend came up. Each item is **fixed** (with the
branch and pull request), **open**, or **accepted** (with why). The settled ones are also
in `decisions.md` and `release/docs/incidents.md`; this page is the index.

## Fixed

1. **The root VM's ordinary user had passwordless sudo** (`mac/root-no-sudo`, #69). Lima's
   cloud-init gives its login user `NOPASSWD: ALL` at every boot, and that user runs
   everything in the root VM that parses what a domain wrote. The keyring's own user
   separated nothing. Now a sudoers rule of desolate's denies it, the host reaches root by
   ssh as root, and doctor asks.
2. **Root's start-up followed links its ordinary user could plant** (#69): `install -d -o
   <user>` on names in that user's directory gave it any directory a link named. What root
   and the keyring rely on moved to `/var/lib/desolate-root`; the user's directories are
   made by the user.
3. **node and `/usr/local/bin` belonged to uid 1001** (#69): `tar` as root kept the
   archive's owner. `--no-same-owner`, a repair in start.sh, a doctor row.
4. **The dashboard answered any local program and handed it every editor's token**
   (`mac/dashboard-credential`, #71). Now a cookie given only for the address `desolate ui`
   prints.
5. **Fixes did not take effect until a reboot** (#71): services kept running old code.
   start.sh now restarts them when their code changes.
6. **mitmproxy's and the devcontainer CLI's dependencies were not pinned** (`mac/hashed-tools`,
   #68): locks with every package's hash.
7. **A deploy key's title carried the Mac's hostname** (often its owner's name) (#67).
8. **The proxies ran as rootd's user, and on vz any user who reaches a share can write it**
   (`mac/proxy-user`, #72). The proxies run as their own user: no group of the root's user (so
   not the keyring), and `/desolate` is closed to it (so no share). Measured before the
   fix: the proxies' user appended to a root clone's file on the Mac.
9. **One proxies' user read every domain's secrets, and any root VM user could use any
   domain's secrets proxy** (`mac/proxy-per-domain`). A user per domain, its secrets in a
   directory only its group reads, and a handoff token every secrets proxy requires.

10. **What the independent audit found** (`mac/audit-fixes`): a workspace proxy as a confused
    deputy for another domain's secrets; a secrets proxy's port taken first; the vz link's
    token sent to whatever held the port; workspaces making the host bind desolate's own
    ports; ten ssh sessions per VM; proxies, the daemon and relays keeping old code. Each in
    `release/docs/incidents.md`.

11b. **The root VM reached the Mac's loopback** (`mac/root-loopback`): the gateway Lima
    gives every VM is the Mac's loopback, and from the root the approval page answered.
    Walled off (root/wall.sh); doctor and T4 ask by trying.

## Open

0. **The root's ordinary user both parses what domains send and pushes** (the audit's F6),
   worked through in five steps, each reviewed by an independent agent before it merged:
   - **Pushing: fixed** (#81): the pusher, a user of its own, is the only one that reaches
     the write agent; it parses nothing it is sent and asks the forge for the one update the
     approval names, from the `onto` it names (`decisions.md`, "The pusher").
   - **What a person is asked to approve: narrowed** (#82): the approval page shows the
     text that is signed, parsed on the host, and the reviewer's account of the commit (a
     user of its own, told commit ids by the host, reading the remote from the forge).
   - **The person's git: moved out of the root** (#83): `desolate git` is a shell in a VM of
     its own, with no network and no way to write what the root reads.
   - **The Mac's loopback: walled off from the root** (#84).
   - **What happened, from whom** (#85): `desolate events`.
   **Still open:** that user still reads every share and holds every editor's token; a bug
   in git's own parsing that compromises it could mislead the reviewer (not the pusher); the
   terminal prompt (`desolate push`) shows that user's summary, not the reviewer's;
   approvals given at the terminal are not events; an offered branch's new LFS objects check
   out as pointers in the git VM. None has been tried against github.com itself: the pusher
   speaks receive-pack, tested against a stand-in forge and a local git; the first real push
   is a person's to approve.

11. **A domain can fill the disk** (from HANDOFF): no quota on an outbox or a share.
12. **The write key is a file in the root VM** (from HANDOFF, `decisions.md` 5.3): accepted
    under the rule that nothing untrusted runs on the Mac or in the root.
13. **The Touch ID approver has never been run.** Opt-in; the terminal approver is the
    default. It compiles on the M1 (Swift 5.10, `swiftc -O`, 2026-11-12) and its key is
    `.privateKeyUsage` + `.userPresence`, this device only. Running it makes a Secure
    Enclave key and asks for Touch ID: a person's to do (`DESOLATE_APPROVER=touchid` at a
    first bootstrap, then check that cancelling the dialog approves nothing).

## Accepted, with why

- **Workspace VMs keep sudo for their login user, and `safe.directory=*`.** Everything in a
  workspace VM is the domain's; the VM is the boundary (P5).
- **The root VM's egress is open.** It fetches from the remotes and runs the proxies; it
  runs no untrusted code (the rule).
- **The base image is `FROM ubuntu:24.04` by tag, not digest** (the fake backend's image
  and the stand-in forge only; the vz base VM is Lima's digest-pinned Ubuntu image).
