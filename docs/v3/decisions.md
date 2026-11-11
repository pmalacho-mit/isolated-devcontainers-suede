# desolate v3: decisions, and the evidence for each

move-to-vms.md asks the implementing agent to decide its open questions "by research and
measurement", recording the evidence and the choice here. Each entry says what was decided,
what it rests on, and how sure that is. **Measured** means a probe or test in this repository
produced the number; **read** means documentation or other projects; **unverified** means
neither, and the entry says what would settle it.

Measurements on the owner's Mac are in `docs/v3/phase0/` (M1, 64 GiB, macOS 14.5, Lima 2.1.2,
2026-11-10). Everything else was measured in the agent's cloud sandbox: x86_64, no `/dev/kvm`,
QEMU 8.2.2 under TCG, Docker 29.9, Lima 2.3.0.

## Question 15. The VM substrate: Lima/vz (provisional, measured for Lima only)

**Decision:** Lima with `vmType: vz` on a Mac; Lima with QEMU on Linux for the `qemu` backend.

Measured on the M1 (`tests/probes/v3/phase0-mac.sh`):

| | Lima/vz |
|---|---|
| create + first boot, image cached | 16.5 s |
| boot of a stopped VM, to SSH ready | 9.3 to 10.5 s |
| `limactl clone` of a stopped VM | 0.0 s, 0 MB consumed (APFS copy-on-write) |
| a clone's first boot | 9.3 s |
| idle guest memory (2 GiB VM) | 232 MB used; the host process holds 1 to 2 GiB resident |
| disk per VM | 2.2 GB actual for a 20 GB sparse disk |
| suspend to disk | **none**: `limactl snapshot` is unimplemented for vz |

Not measured: Apple Container and microsandbox were not installed on the Mac, so the
"comparison" the spec asks for has one column. Read, not measured: Apple Container's default
network is open and its custom networks need macOS 26 (the Mac is on 14.5), which rules it out
for now on this machine; microsandbox boots OCI images as the VM, which is shape B, not the
decided shape A.

Template to workspace (`phase0-mac-backend.sh`, `docs/v3/phase0/mac-m1-backend-2026-11-11.md`):
a template VM with dockerd and one built devcontainer (image + node feature: 136 s to make,
5.3 GB) was cloned **with a different set of twelve shares** (`limactl clone --set
'.mounts = [...]'`, 0.1 s), booted (9.7 s), its dockerd answered (0.3 s) and
`devcontainer up` found nothing to build (0.7 s): **11.0 s from clone to a running
devcontainer.** The template's shares were gone from the clone and the new ones present,
ten of them read-only and nested under one parent.

Consequences for section 4.7's targets:
- **A new workspace from a template in 15 s: within reach.** 11.0 s measured to a running
  devcontainer, leaving 4 s for the editor server, which was not in that measurement.
- **Resume in 5 s: not met on Lima/vz.** There is no suspend; a stopped VM takes 9.5 s. Either
  the target becomes "about 10 s", or workspaces are paused rather than stopped (SIGSTOP of
  the host process froze and thawed a VM cleanly in the probe, but frees no memory).

## Question 5. Storage on the Mac's disk, shared by virtiofs: yes (measured)

- **Read-only is enforced by the host.** As root in a VM: creating a file in a read-only share
  fails; `mount -o remount,rw` is accepted by the guest kernel and the write then fails with
  "Operation not permitted"; mounting the share's virtiofs tag afresh gives no write either.
  Control: the same writes through the writable share's tag succeed.
- Alternates and `lfs.url=file://` work through the read-only share: a `git clone --shared` had
  0 objects of its own, a 200 KB LFS object smudged with the right sha256, `git fetch origin`
  worked, and a push into the mirror was refused.
- Files appear in a VM owned by the Mac user's uid (501), and Lima's guest user has that uid.

## Question 6. One domain `.git` over virtiofs, written by several VMs: safe enough (measured)

Two VMs, one `.git`, each making 500 commits in its own worktree with a worktree added and
removed every 25 commits: 11.7 s, 1,000 commits present, `git fsck --full --strict` clean from
both. One operation of the 1,040 failed in one VM: `fatal: failed to read
.git/worktrees/ws1-t425/commondir`. That is one VM's git listing worktrees while the other VM
was halfway through creating or removing one, and reading the half-made entry. So: no
corruption, and the one hazard seen is a worktree being added or removed while another VM
runs a command that walks the worktree list. desolate makes worktrees only under a directory
lock that every workspace's init takes, sets `gc.auto=0` in every domain clone, and does not
remove worktrees while a domain has workspaces running. An agent that adds and removes
worktrees of its own in a loop can still make a neighbour's command fail once; the neighbour
retries.

## Question 14. Where checkouts live: on the share (measured)

`npm ci` of a 187-package project (5,180 files, 109 MB), warm cache: 2.0 s on the VM's disk,
3.1 s on the virtiofs share. Walking the tree is 20x slower on the share (0.18 s against
0.009 s) and removing it 16x (0.98 s against 0.06 s), but in absolute terms these are a second.
The proposal stands: checkouts on the share, where the root and other workspaces of the domain
can see them. Revisit for a tree of 100,000 files; the escape hatch is section 4.7's third
option (dependency and build directories on VM-local volumes).

## Section 4.3. The network link: no route out, enforced outside the VM (partly measured)

**Decision:** a workspace's only way out is a stream to its own proxy, and what cuts every
other path is on the host, per backend:

| backend | what cuts egress, outside the VM | the link to the proxy | status |
|---|---|---|---|
| `fake` | `--network none` | a unix socket, bind-mounted | T2 only: not a boundary |
| `qemu` | QEMU's user network with `restrict=on` | `guestfwd` to the host's socket | see T3 |
| `vz` | Lima's host process under `sandbox-exec` | one loopback port on the Mac | measured; ICMP open |

Why this shape. Lima always attaches its user-mode network, and offers no setting that
removes it or filters it (read: Lima's network docs; `networkOpts.hostLoopback: false`, new in
2.3, closes only the Mac's loopback). But on vz that network is a user-space stack inside
Lima's own host process, so every connection a guest makes is a socket that process opens.
Confine the process and the guest is confined, by the Mac's kernel, whatever root in the
guest does. devvm's documentation describes the same idea ("runs on its confined process",
re-checked at every launch).

Measured on the M1 (`phase0-mac-egress.sh`): with the host process under a profile that
allows one loopback port, the guest reached that port and was refused another loopback port,
the internet by name and by address, and the LAN router over TCP; root in the guest, after
rewriting routes and flushing every firewall rule, was refused too. The control (the same VM
started without the sandbox) reached all of them.

Round 2 (`phase0-mac-egress2.sh`, `docs/v3/phase0/mac-m1-egress2-2026-11-11.txt`) took the
three gaps round 1 found:

1. **Closed.** With the VM's forwarded ssh port also allowed, `limactl start` under the
   sandbox exits 0 in 8.4 s. (That port leads only to the guest's own sshd.)
2. **Closed for the system resolver.** With the profile also denying the Mac resolver's
   socket (`/var/run/mDNSResponder`), `getent hosts example.com` in the guest fails, where
   under the profile without that line it resolved. So the profile is: one proxy port, the
   ssh port, unix sockets except the resolver's.
3. **ICMP: open question, probably a false alarm.** Under all four profiles a ping to
   1.1.1.1 and to the LAN router was answered, including two profiles written to stop it.
   The likely reason is that Lima's user-mode stack answers every echo request itself (it
   treats every address as its own), in which case nothing leaves the Mac. Round 2 cannot
   tell: it never pinged an address that cannot answer. `phase0-mac-egress3.sh` does (two
   minutes): it pings a documentation address from the guest and from the Mac.

A flaw in round 2's own probe, recorded because it is the kind this project exists to catch:
its "query straight to 1.1.1.1" and "to 192.168.5.3" rows tested for any output from `dig`,
and `dig` prints its timeout to stdout, so those rows say "ok" whatever happened. They are
not evidence either way. Round 1's row for the same check printed the text and shows a
timeout. Round 3 requires an address in the answer.

**Status of the vz backend's network boundary:** TCP and UDP egress, the Mac's loopback and
the LAN over TCP: closed, measured, root in the guest included. DNS through the system
resolver: closed, measured. ICMP: not yet shown either way. `doctor` on vz reports the ICMP
row as unverified until round 3 has been run and recorded here.

Inside the VM, all of this is made transparent to programs (they need no proxy settings) by a
resolver that answers every name with a placeholder address and a redirect of ports 80 and
443 to a small relay that reads the name from the TLS SNI or the HTTP Host and asks the proxy
for it. None of that is a boundary: with all of it removed, the VM still has no way out.

## The forwarder's way into a VM: a session, not ssh's stdio forwarding (measured)

`ssh -W host:port` through Lima's ssh config fails on the Mac with "Stdio forwarding request
failed: Session open refused by peer": Lima's control master refuses that kind of channel.
Ordinary sessions through the same master work (that is what `limactl shell` is, 0.1 s a
round trip). So a backend's `dial` runs `socat STDIO TCP:127.0.0.1:<port>` in the guest over
a session, as the fake backend does over `docker exec`. The base image carries socat.

The egress path's throughput, guest to a listener on the Mac's loopback: 366 MB/s for one
download, about 50 to 70 MB/s each for six at once (two of eight failed to connect in that
burst; not investigated).

## Section 4.4. Ports: Lima's own forwarding is turned off (measured)

Lima forwards a guest's listeners onto the Mac by itself: `127.0.0.1:5173` appeared in 0.3 s;
with the same port in two VMs the first VM wins; and **a guest listening on port 80 was
published on `*:80`**, every interface of the Mac (v2's L3 again). So every desolate VM has
`portForwards: [{guestPortRange: [1, 65535], ignore: true}]`, and desolate's forwarder is the
only way in.

## Section 4.2. dockerd and the devcontainer CLI inside the VM: work (measured)

On the M1, in a Lima/vz VM: an image with two features (node, docker-in-docker) 87 s cold and
0.3 s when already built; a Dockerfile spec 19 s; a compose spec 7 s; `docker run` inside the
docker-in-docker devcontainer worked. The 87 s is what a domain template (C3) saves every
workspace after the first.

## Section 5.3. The push confirmation, and what it does not stop

The write key is held by an ssh-agent that runs a check before every signature; the check
passes only against an approval on file; approvals are filed through a socket only the
keyring's user can open; and the one program that files them asks on a terminal and requires
the branch name typed back. A caller with no terminal (the CLI channel from the host, a
script) cannot push.

What this does not stop: a program inside the root VM that fabricates a terminal and types the
answer. That is deliberate impersonation of the person, from the one VM where no workspace
code runs; the same program could as well drive a browser at the root UI's button. It is
recorded here rather than claimed away. A stronger gate needs something outside the root VM
that only a person can operate (Touch ID on the Mac, for example): a candidate for later.

Also: in a Lima VM the login user has passwordless sudo, so inside the root VM the keys are
protected from the root's unprivileged processes (git, node) by file mode and by the agent
relay's filter, not from a person who types `sudo`. Nothing outside the root VM has a path to
them at all.

## ssh-agent needs a relay in front of it (measured)

ssh-agent refuses any peer whose uid is not its own. The keyring runs as its own user so the
root's git cannot read a key, which means the root's git also cannot talk to the agent
directly. The keyring therefore relays each agent on a second socket, and filters while it is
there: a client may list identities and ask for a signature, and nothing else (no adding a
key that skips confirmation, no removing or locking keys). v2's keyring avoided a relay; v3
needs one, and uses it.

## The request channel is a spool in the shares, not a socket

Section 4.3 allows "a vsock or socket with a fixed, validated vocabulary" from a workspace to
the root. v3 uses neither: a workspace writes a request file into its domain's outbox, and the
root answers in the inbox, which the domain cannot write. Both shares exist already, so the
channel adds no network path and no device, works the same on every backend, and is enforced
by the host's shares. The cost: the root polls outboxes (virtiofs delivers no inotify events
across VMs), so a request is noticed within the poll interval rather than at once.

## Storage: the root mounts `domains/` whole, read-write

The spec's table gives the root read-only access to a domain's `repos/`. The root VM instead
mounts `~/.desolate/domains` once, read-write, so that a new domain needs no restart of the
root VM (a share cannot be added to a running VM). What keeps the root out of a domain's
repositories is `root/git.ts`, which refuses to run git anywhere but a mirror or a root clone,
and a test that plants a hostile domain repository. A read-only mount would be defence in
depth on top; it costs a root restart per new domain.

## A domain's new repository reaches new workspaces only

A share cannot be added to a running VM, and each mirror is a share. `desolate domain <d> add
--repo` therefore says that existing workspaces do not see the new repository until they are
removed and made again.

## Base image: one provisioning script, two routes

`release/image/provision.sh` defines what a desolate VM contains. On Linux,
`release/image/build.sh` runs it in a debootstrap chroot and writes a root filesystem, a disk
and a kernel (the sandbox has no route to Ubuntu's cloud images or Docker Hub, only to the
package archive). On a Mac, the Lima backend runs the same script on the first boot of a
digest-pinned Ubuntu cloud image and clones the result. Root and workspace VMs boot the same
image.
