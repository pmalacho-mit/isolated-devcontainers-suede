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
| `vz` | Lima's host process under `sandbox-exec` | one loopback port on the Mac | measured, ICMP included (Lima 2.3.0) |

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
3. **ICMP: closed (round 3, Lima 2.3.0).** Round 2 (Lima 2.1.2) saw a confined guest's
   ping to 1.1.1.1 and to the LAN router answered under all four profiles, and could not
   tell whether the echoes left the Mac. Round 3 (`phase0-mac-egress3.sh`,
   `docs/v3/phase0/mac-m1-egress3-2026-11-11.md`) pinged documentation addresses as well:

   | | 1.1.1.1 | 192.0.2.1, 203.0.113.77 |
   |---|---|---|
   | the Mac itself | answered, 27.7 ms | no reply |
   | guest, host process unconfined (control) | answered, 20.0 ms | no reply |
   | guest, host process under the workspace profile | **no reply** | no reply |

   So on 2.3.0 Lima's user-mode stack does **not** answer echoes itself: an unconfined
   guest's ping really leaves the Mac (a channel, if it were allowed), and the profile's
   `(deny network-outbound)` stops it, as it stops TCP and UDP. Why 2.1.2 differed is not
   known (it may have answered locally, or its ICMP path may have escaped the profile), so
   the vz backend requires Lima 2.3.0 or newer (`doctor` fails older), and tier T4's
   boundary test pings from root in a workspace with the root VM's ping as the control,
   so a Lima that changes this again fails a test rather than a probe nobody reruns.

A flaw in round 2's own probe, recorded because it is the kind this project exists to catch:
its "query straight to 1.1.1.1" and "to 192.168.5.3" rows tested for any output from `dig`,
and `dig` prints its timeout to stdout, so those rows say "ok" whatever happened. They are
not evidence either way. Round 1's row for the same check printed the text and shows a
timeout. Round 3 requires an address in the answer.

**Status of the vz backend's network boundary:** TCP and UDP egress, the Mac's loopback and
the LAN over TCP: closed, measured, root in the guest included. DNS through the system
resolver: closed, measured. ICMP: closed, measured on Lima 2.3.0 (round 3), and asserted by
tier T4 on every run.

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

## Section 5.3. A push is approved on the host, outside every VM (decided; the terminal approver is the default)

**What it was.** The write key is held by an ssh-agent that runs a check before every
signature, and the check passes only against an approval on file. In the first v3 cut the
approval was filed by a program in the root VM that asked on a terminal. A program in the
root VM that fabricated a terminal could answer it, and so could a harness on the host that
ran `desolate push` on a pseudo-terminal (the tests' `person.py` is exactly that).

**What it is now.** An approval is a signature made on the host:

1. the keyring issues a challenge: a short text naming the repository, branch and commit,
   with a nonce of its own (`release/shared/approval.ts`);
2. the host's approver shows that text's contents to the person and signs it
   (`release/host/approver.ts`);
3. the keyring files the approval only if the signature verifies against the approver's
   public key, which the host installed as root at `/etc/desolate/approver.pub`, and only
   for a challenge it issued, once, within two minutes.

Nothing in the root VM holds the private key, so nothing in it can approve: there is no
sudo rule and no confirmation program there any more. `desolate push` does the three steps
itself. A raw `git push origin <branch>` in the root's terminal goes to
`git-remote-desolate-push`, which leaves the challenge where the host can read it and waits
for `desolate approve`, run by the person on the host. It is a remote helper and not the
pre-push hook because git authenticates to the remote, which takes the write key's
signature, before it runs pre-push (measured: the first cut's hook could never have asked).

**What the gate is for.** The Mac and the root VM both hold sensitive things (the Mac
controls every VM; the root holds the write keys). Code that is not trusted is never run in
either: that is a rule the person follows, not one desolate can enforce. Given the rule,
the approval is not there to stop a hostile program on the host. It is there so that
nothing in a workspace, and no well-meaning automation (an agent harness driving
`desolate` on the host), turns an offer into a push without a person having read which
commit goes where.

**The two approvers.**

- `terminal` (the default everywhere): a key file in `~/.desolate/approver`, used after
  the branch name is typed on the controlling terminal. It needs nothing compiled and has
  run on every tier that has run.
- `touchid` (`DESOLATE_APPROVER=touchid`, macOS only, opt-in): a P-256 key made in the
  Secure Enclave with `userPresence` access control
  (`release/host/approver/touchid.swift`, compiled by bootstrap with `swiftc`). It signs
  only after Touch ID or the login password, so a program running as the person cannot make
  it sign or copy it. **This file has never been compiled or run** (it was written on
  Linux). It was the macOS default for one pass; it is opt-in now because, under the rule
  above, what it adds over the terminal is small (next paragraph, second point), and an
  unrun Swift file should not stand between a new user and their first bootstrap.

**What is left, said plainly.**

- With the `terminal` approver, a program running as the person on the host can read the
  key file or fabricate the terminal. It stops everything in the VMs; it does not stop the
  host's own processes.
- With either approver, a program running as the person on the host controls the VMs: it
  can enter the root VM as root (by ssh as root with Lima's key, which is a file in
  `~/.desolate/lima/_config`) and read the write key itself.
  The approval gate is then beside the point. Closing that means the write key must not be
  in a file anywhere: the next step is a write key that is itself a Secure Enclave key (GitHub
  accepts `ecdsa-sha2-nistp256` deploy keys), served to the root's ssh by an agent on the
  host, so every push signature is a Touch ID. Not done; it changes the keyring's shape.
- An approval names a commit, but ssh authentication cannot be bound to what is then sent.
  While an approval is live (it is revoked when its push ends; at most two minutes, eight
  signatures), a process in the root VM that pushes straight to the remote with
  `--no-verify` could send another commit to that repository. The pre-push hook refuses
  that for everything that does not skip hooks.
- No prompt appears by itself: an approval is always started by the person, from the host
  (`desolate push`, `desolate approve`). A process in the root VM can leave a request; it
  cannot make a dialog appear.

## The root has no editor (decided; reverses the first cut)

The first cuts ran an editor in the root VM, in Restricted Mode, for reviewing offers. It
is gone (`release/root/editor.sh` and its settings are deleted). An editor is a large
program whose job is to interpret a tree: tasks, launch configurations, language servers,
extensions that activate on a file's presence. Restricted Mode is the editor's promise to
hold all of that back, and the root is the one place where the tree being looked at was
written by an agent and the keys are next door. What the person needs in the root is
smaller:

- **the dashboard**: what needs them, and for an offer the commits, the files, the
  warnings, and the diff;
- **a diff that is text**: `git diff --no-ext-diff --no-textconv`, capped at 1 MiB, put on
  the page as text nodes (`release/root/ui/dashboard.js`, `diffView`) and on the terminal
  by `desolate review <domain> <repo> <branch> --diff` with control characters replaced.
  Nothing in it is parsed as markup, and it is shown only if it is of the commit the Push
  button names;
- **a terminal** (`desolate root shell`), for people who prefer git's own commands. The
  root's git settings (next section) are what make that safe to do on a tree an agent wrote.

Editing happens in workspaces, where every workspace has an editor.

## What the root takes from a domain, and how (audited; two holes found and closed)

The root reads four kinds of thing a domain wrote: bundles, the list of refs, LFS objects,
and small JSON files (requests, statuses). A domain's VM has the outbox mounted read-write,
so everything in it, the directory entries included, is the domain's to shape. An audit by
test (`tests/v3/t2/10-hostile-content.test.ts`, and the same route over a real VM's share in
`tests/v3/t3/`) found two holes in the previous cut, both
closed here; `release/docs/incidents.md` has them as incidents.

**1. The directory is checked once, and then held.** (`release/root/outbox.ts`.) The root
opens an outbox directory with `O_DIRECTORY|O_NOFOLLOW`, and takes it only if the kernel's
own name for the open descriptor is the path under the root's `domains/` it meant to open.
Files are opened by name relative to that descriptor, `O_NOFOLLOW`, regular files only,
within a size limit (JSON 1 MiB, a bundle 2 GiB, an LFS object 5 GiB). Removal is of a
name in that checked directory and nothing else. *The hole this closed:* with the sync
directory replaced by a symlink into the root's own state, the root removed a file of its
own through it.

**2. git is never given a path a domain controls.** A bundle is copied, through the open
descriptor, to a directory only the root can write (`/var/lib/desolate/incoming`), under a
name the root made, and git reads the copy. One at a time: copy, check, fetch, delete, so
the root's own disk holds one bundle of a domain's at once.

**3. Every object is checked before any enters a root clone.** The copy's pack is indexed
with `git index-pack --strict` into a throwaway object directory that borrows the clone's
objects (`refusedBy` in `release/root/git-remote-desolate.ts`); only a bundle that passes
is fetched. Only a v2 bundle is looked at (what a workspace's git writes; v3 exists to
carry a filter that leaves objects out, or another hash), and a check that runs longer
than eight minutes is a refusal. `--strict` is git's fsck with its errors fatal: a tree with `.git` in it (in
any case, or in a form macOS or Windows would fold to it), a `.gitmodules` that is a
symlink or names an option or a climbing path, a malformed object. *The hole this closed:*
`fetch.fsckObjects` does not apply to a fetch from a bundle on the image's git (2.43): a
tree containing `.git` was imported and offered.

A domain's bundle carries all its branches, so one branch with such an object gets the
whole bundle refused. That is deliberate (a bundle is taken whole or not at all), and it
is said three times: to the workspace that offered, on the dashboard, and in `desolate
offers`. It clears when the branch is deleted in the domain and the next bundle is taken.

**4. An LFS object is the bytes that were hashed.** It is copied from one open descriptor
while being hashed, and the copy becomes the root's only if the hash is its name and the
size is the pointer's. (Before: verify, then copy by path, which a domain could have
swapped between the two.)

**5. The root's git does not act on what a tree says.** In the root's global git config
(`release/root/start.sh`): `transfer`/`fetch`/`receive.fsckObjects`; `core.protectHFS` and
`protectNTFS` (the Mac's and Windows' ways of spelling `.git`, refused on Linux too);
`core.fsmonitor=false`; `safe.bareRepository=explicit`, so a directory in a checked-out
tree that is shaped like a repository is not one, whatever its config names; `protocol.allow
=never` with only `file`, `ssh`, `https` and desolate's two helpers allowed;
`submodule.recurse=false` and `fetch.recurseSubmodules=false`. Diffs desolate itself makes
use `--no-ext-diff --no-textconv`. Hooks, filters, diff drivers and aliases need config,
and a tree cannot supply config: `.gitattributes` can name a driver, only the root's own
config can define one, and it defines none. The test has a control for this: the same
planted repository does run its program with `safe.bareRepository=all` given for one
command.

**What is left, by nature.** These are surfaces that cannot be removed, only kept small:

- **git's own parsers** read a pack an agent wrote (`index-pack`, then `fetch`, `diff`,
  `log`). A memory-safety bug in git's pack or object parsing would be reachable. Keeping
  the image's git current is the mitigation; desolate runs that parsing as the root's
  ordinary user, never as root, and never as the keyring's user.
- **JSON.parse** on files up to 1 MiB, then field-by-field validation
  (`release/shared/names.ts`).
- **The proxies** parse what workspaces send (HTTP CONNECT, TLS ClientHello in
  `release/root/proxy/proxy.ts`; full HTTP in mitmproxy, for secret hosts only), and the
  root's resolver answers their DNS.
- **Size.** A domain can fill its own outbox and its own share, and what it commits ends
  up in the root clone when it is taken. Each file the root reads is bounded (counted
  while reading, not trusted from its size), a bundle is at most 2 GiB and is handled one
  at a time, and a slow pack is cut off. What is not bounded is the total: there is no
  quota on a domain's share, and a pack built to expand can still use a great deal of
  memory in `index-pack`. That costs availability, not integrity.
- **The person.** `git checkout dev/branch` in the root's terminal writes an agent's files
  into the root clone's work tree. Looking at them, diffing them and committing on top of
  them is safe under the settings above. *Running* them (`npm install`, `make`, a script,
  opening the folder in a tool that runs tasks) is running untrusted code in the root, and
  nothing can make that safe. The README says so first.
- **Your terminal.** `desolate exec` and the root shell show you a VM's output as it is:
  you asked for it, as with ssh. Everything else desolate prints that began in a workspace
  (a status, a branch name, a commit subject, a diff, why a devcontainer failed, why a
  bundle was refused) has its control characters replaced first, and the dashboard puts
  all of it on the page as text.
- **Status files and notes** (`release/shared/status.ts`) live in the domain's clone, and
  the root and the host both show them. They are opened without following a link, checked
  on the open descriptor (a regular file, a bounded size), and refused unless the file
  that was opened is the one that was meant. In the root VM that last check is asked of
  the kernel about the open descriptor, so nothing can be swapped. On the Mac, node has no
  such question to ask: the path is resolved a second time and must name the same device
  and inode. A domain that wins that race (a directory swapped for a link and back within
  one read) gets text from a file the person can read shown to that same person. It is
  never acted on, and never returned to a domain.

## The root VM's ordinary user is not root (decided on the Mac; measured)

Lima's cloud-init gives its login user `NOPASSWD: ALL`, and writes that rule again at every
boot (measured: removed, rebooted, back). In the root VM that user runs everything that
parses what a domain wrote: git on its packs (rootd), each workspace's proxy and each
domain's secrets proxy, and the state service. With sudo, the keyring's own user (which
holds the keys, 0700) separated nothing from a bug in any of those.

- **The rule.** `root/start.sh` writes `/etc/sudoers.d/99-desolate` (`<user> ALL=(ALL)
  !ALL`). It sorts after cloud-init's `90-cloud-init-users`, and in sudoers the last match
  wins, so it holds across boots without fighting cloud-init (measured: after a reboot
  `sudo -n true` is refused, and Lima still starts the VM, in 9 s). `start.sh` tries sudo as
  the user and refuses to start any service if it works; `doctor` asks the same.
- **The host's way in** is ssh as root with Lima's key for desolate's home, on a control
  socket of its own (`host/vm/lima.ts`, `rootSshArgs`). The key goes into root's
  `authorized_keys` once, through the login user's sudo, at the first bootstrap, before
  `start.sh` has ever run. It is taken from the host's own copy of the public key, never
  from the user's `~/.ssh` in the VM (which that user could add a key of its own to).
- **What root and the keyring rely on is root's.** `/var/lib/desolate` belongs to the user
  (rootd writes its registry there by rename). Anything in it, the user can replace with a
  link, so the keys, the hooks, the mirrors' hooks and git's settings moved to
  `/var/lib/desolate-root`, and `start.sh` makes the user's directories as the user. Before,
  `install -d -o <user> /var/lib/desolate/secrets` as root followed a link the user
  planted there and handed it the directory the link named (T2 `01-root` plants three).
- **Workspaces are unchanged**: their login user keeps sudo, because root in a workspace is
  already the workspace's (P5: nothing inside a workspace VM is a boundary).
- **Not yet:** the proxies run as the same user as rootd, and a domain's secret values are
  that user's files. A bug in mitmproxy reached through one workspace could read every
  domain's secrets, and write root clones. The next step is a user for the proxies, with
  each domain's secrets readable by that domain's secrets proxy only.

## A domain's template (C3): built in a workspace-shaped VM, cloned for the rest (measured)

`release/host/templates.ts`. On `up`, before the workspace takes its checkouts, the host asks
the root for the domain's environment as published (`domain.env-key`: the git id of
`.devcontainer/` or `.devcontainer.json` on the environment repository's default branch,
read in the mirror). If no template has that key, one is built: a VM made exactly like a
workspace of the domain (its shares, its proxy, its rules), which runs the spec, then has
what is one workspace's removed (its editor's token, its identity, logs, containers) and is
stopped. Every workspace of the domain is then a `limactl clone` of it.

Measured on the M1 with microsoft/vscode-remote-try-node (an mcr.microsoft.com image, an
npm install after create):

| | total | of which |
|---|---|---|
| a workspace from the base, no template | 54.0 s | VM 9.0 s; pull, build, install, editor 44.4 s |
| the first workspace with a template (built now) | 71.6 s | template 53.8 s; VM 9.3 s; the rest 8.2 s |
| every later workspace | **18.8 s** | template 0.5 s; VM 9.4 s; the rest 8.5 s |

The spec's target is 15 s: the VM's boot is now half of it, and has no cache (vz has no
suspend). Two clones' editors had different tokens.

Why this is safe (section 4.7's rule): the template is the domain's code's output, built
with the domain's trust and nothing more, and cloned only for that domain. The key covers
the spec and what made the VM (`provision.sh`, `pins.env`, `devcontainer.ts`, `editor.sh`), so
a change to either builds a new one; a domain's other templates are removed then.

Not done: `onCreateCommand`'s results are not carried (each workspace makes its own
container from the template's images); C2 (a pull-through registry) and C4 (package
caches) are not built, so a template's first build and each workspace's `npm install`
still go to the network. Not on the fake backend (its clone carries no docker images).
Not covered by a test that builds one: the tiers have no registry. T1 covers the key and
the name.

## Each domain's proxies run as a user of that domain's own (decided on the Mac; measured)

Each workspace's `proxy.ts` and each domain's mitmproxy parse everything a workspace sends.
They ran as the root's ordinary user, so a bug in either reached what that user reaches:
the keyring's sockets (every read key signs for it), the root clones and mirrors (a hook or
an `fsmonitor` in a clone's config runs as the user at its next git command), and every
domain's secrets. A first step gave all proxies one user of their own; that still let a bug
reached from one domain read every domain's secrets. Now:

- **`dsp-<10 hex>`, one per domain** (`root/proxy-user.sh`, run by root: by start.sh for
  every domain there is, and by the host, through its own way in, when a domain's proxies
  are first wanted). Each is in the group `desolate-proxies` and in no group of the root's
  user, so the keyring's sockets refuse it. The root's user may run programs as any member
  of that group (`<user> ALL=(%desolate-proxies) NOPASSWD: ALL`, the last line of
  `99-desolate`): safe in that direction, since the root's user holds all any of them holds.
- **Two directories per domain, in root's `/var/lib/desolate-proxies`**, where nothing of
  the root's user's is on the way: `domains/<d>` (the root's user's, group: the domain's
  proxies, 2750) holds the policy, the secret values, where the secrets proxy listens and a
  handoff token; `out/<d>` (the domain's proxies', group: the root's user's, 2750) holds
  their audit log and the domain's CA.
- **The handoff token.** A secrets proxy listens on the root VM's loopback, where any user
  can connect. It opens a tunnel only for a connection that shows its domain's token, which
  only that domain's proxies (and the root's user) can read. Measured on the M1: another
  domain's proxies' user, given the port, got 403 without the token and with a wrong one;
  the domain's own, with it, 200; reading the domain's secrets file: permission denied.
- **The shares are closed to all of them** by `/desolate` (root, the root user's group,
  0750), not a share: on vz any user that reaches a share can write it (previous
  section). Their code is a root-owned copy at `/opt/desolate/proxy-code`.
- `doctor` asks, for every domain's proxies' user: it can be started, shares no group with
  the root's user, cannot reach `/desolate/root`, and cannot reach any other domain's
  directory. T4 tries as domain a's proxies to write each share and ask the keyring, and as
  another domain's to read a's secrets and use a's secrets proxy, each beside a control.
- **Left:** a domain's proxies have the internet (they are its way out) and read its
  secrets; a bug in them reached from that domain's own workspace can leak that domain's
  secrets. That domain's workspaces can already use them.

## The pusher: the one user that reaches a write key, and it parses nothing (decided on the Mac; tested on T1 and T2)

The independent audit's F6: the root's ordinary user parses everything a domain sends (git on
agent-written packs, outbox JSON, the dashboard's state) and it also pushed, with the write
agent open to it for the two minutes and eight signatures an approval lasts. A bug in any of
those parsers could push another branch of that repository, or another commit, in the window.

- **A user of its own.** `desolate-pusher` (root/pusher.ts) is the only user that can enter
  `/run/desolate/keyring-write`, where the write agent's relay is (the keyring's directory,
  the pusher's group, 0750). The root's user cannot open it (doctor asks, by trying), and
  is not in the pusher's group; the pusher is not in the root's user's group, so `/desolate`
  (every share) is closed to it. Its code is root's copy in `/opt/desolate/proxy-code`.
- **It is told an id, and it parses nothing it is sent.** The root's user hands it the
  approval's id, a pack and the LFS objects. The pusher asks the keyring what the id names:
  repository, branch, commit, and `onto`, what the remote's branch is now (or none). Then
  it speaks git's push protocol to the forge itself: it reads the forge's ref list, stops if
  the branch is not exactly `onto`, asks for the one update `<onto> <commit>
  refs/heads/<branch>`, and forwards the pack as bytes, counted and never read. The forge
  applies the update atomically or not at all, and cannot point the branch at a commit the
  pack does not hold. LFS objects are hashed as they arrive and uploaded from a repository
  with no git object in it. T1 runs this code against a real `git receive-pack`: a pack of
  another commit, a stale `onto`, and bytes that are not a pack all move nothing; T2
  `04-offers` hands it a live approval's id with another commit's pack: no ref moved.
- **Why it parses nothing.** The first version fetched a bundle from the root's user and
  ran git on it, as the pusher. The audit of that version: a bug in git's pack parsing that
  compromised the root's user could be sent straight on to the pusher, which would then
  hold any live approval's signatures for that repository. No other user in between fixes
  that, since the same bug works again on each. A process that never parses those bytes does.
- **`onto` instead of a force flag.** Every approval says what the branch moves from, so a
  push is a compare-and-swap whether it builds on the remote's branch or replaces it, and a
  remote that moved since the approval refuses it. Whether the commit builds on `onto` is
  for the person to see, from the reviewer (step 2 of this plan), not for the pusher to
  decide; the raw `git push` helper still wants a `+` for one that does not.
- **Where it pushes is root's word.** The forge's address and host key are read from
  `/var/lib/desolate-root/forge.json` and `known_hosts`, written by root from what the host
  sends at every bootstrap (root/forge-pin.ts), not from the root's user's copies.
- **One push per process, one push per approval.** The pusher exits after each push, and
  root's supervisor kills every process of its user before starting the next, which empties
  the user's home first. Asking the keyring what an approval names claims it: only a claimed
  approval lets the write key sign, a claim lasts as long as a push may take (so LFS objects
  first do not run the two minutes out), and an approval is claimed once.
- **It says what it knows.** Once the ref update is asked for, the forge may take it as soon
  as the pack is whole; a failure after that (the root's user stops sending, say) is
  reported as "may have reached the remote", with the forge's report used if it came, and
  never as "nothing was pushed" (the second review measured the update landing during such a
  stall). Asked for a push that already landed, the pusher answers that it is done.
- **What is left.** Inside one approved push, the root's user can add objects the commit
  does not need to the pack, and LFS objects it does not name: both reach the forge,
  unreferenced (on a public repository, readable by anyone who knows their hash). That is a
  way out for data only for a user that has no other, and this one has the network. It can
  withhold a push, or ask a person to approve a commit of its choosing, from an `onto` of its
  choosing: the terminal prompt shows both ids, and whether the commit builds on `onto` comes
  from that user's own review there; the approval page shows the reviewer's account instead
  (step 2). Revoking an approval is open to it too, which only cancels. The pusher reads one
  JSON line it is sent (at most 1 MiB, node's parser), and nothing else.

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

## On vz, a share is the host's files seen through each guest's own cache (measured on the M1)

Three things the first workspaces on the Mac showed, each measured by hand on Lima 2.3.0:

1. **Ownership as a guest sees it is not the host's.** A share's root can report uid 0 for
   a moment after it is mounted. A file root in the guest creates, or `chown`s, reports uid
   0 in that guest from then on, while on the Mac it stays the user's (the host writes as
   the Mac user whatever the guest asked). Mounting a share's tag a second time, as root,
   left parts of the first mount reporting uid 0.
2. **Two guests do not agree at once.** A workspace replaced a symlink in its outbox with a
   directory; the root VM went on seeing the symlink for about a second (reading through
   it gave "Invalid argument"), then saw the directory. A file replaced by rename (a refs
   list) can likewise look as it was.
3. **Any user of a guest that reaches a share can write it.** A file in a share reports as
   owned by whichever user of the guest last asked about it, so the guest's permission
   bits give that user the owner's rights: in the root VM the proxies' user (uid 995) saw
   `/desolate/root` as its own, created a file there and appended to a root clone's file,
   and both changes were on the Mac. Within a vz guest, Unix users separate nothing on a
   share; what keeps a user out is a directory that is not a share. (Workspace VMs do not
   care: everything in one is the domain's. The root VM does: next section.)
4. **What does not follow from (2):** a stale entry cannot lead the root anywhere new. A
   link is resolved by the root VM's own kernel, and only when that kernel sees a link,
   which `outbox.ts` then refuses (`O_NOFOLLOW`, and the descriptor's own path). An entry
   the root still thinks is the old directory is operated on as that old directory by the
   host, never through a link made since. Staleness costs a refusal, not a boundary.

What changed because of them: a workspace VM's git trusts every directory (`safe.directory
*`: its user, root and its devcontainer are all the domain's, and a devcontainer running as
root makes "root-owned" files in the checkouts); the root looks for an offered commit again
for about three seconds before saying it received nothing (`root/offers.ts`); a VM is used
only once every share in its spec is mounted as the spec says (`host/vm/lima.ts`).

## The qemu backend uses 9p, because Lima's virtiofs on Linux is not read-only (measured)

In the sandbox, a Lima VM on QEMU with `mountType: virtiofs` and a share marked
`writable: false`: root in the guest ran `mount -o remount,rw` on it and then created a file,
and the file appeared on the host. Lima starts `virtiofsd` with no read-only option (its
source says so: "read-only mode is not supported on the QEMU/virtiofsd side yet"), so the
read-only is only the guest's mount flag. That is exactly the boundary P5 says must not live
in the guest. With `mountType: 9p` Lima passes QEMU's `readonly` for such a share, and the
same attack fails (tests/v3/t3). So: **qemu uses 9p; vz uses virtiofs**, where the Mac
refuses the write (measured on the M1). A consequence worth knowing: 9p mounts a share once
per guest, so the "mount the tag afresh, read-write" attack does not exist there, while on
virtiofs it does and is refused by the host.

## The qemu backend's egress: QEMU's own `restrict=on` (measured)

Lima gives every QEMU VM the user-mode network and has no setting to restrict it. Lima does
run whatever `$QEMU_SYSTEM_<ARCH>` names, so desolate points that at a wrapper
(`release/host/vm/qemu-wrapper.sh`) which, for a workspace VM, appends `restrict=on` to the
user network and a `guestfwd` from one guest address to the link's socket on the host. The
wrapper refuses to start a workspace VM whose network it did not restrict, or one with a
second network, and the backend checks the running QEMU's command line after the start.
Tier T3 then tries, as root in the guest: the host by its gateway address and its other
addresses, the forge, the internet by address and by name, DNS, UDP; and again after
rewriting routes, flushing every firewall rule and choosing a resolver.

## Inside a VM with no interface, connections need somewhere to go (measured)

On the fake backend a workspace has only loopback. For a program's connection to reach the
redirect to the egress relay it must first be routable. A dummy interface would do, but the
sandbox's kernel has no dummy module; a default route through `lo` routes the connection but
the redirected connection never completes; `ip route replace local default dev lo` (every
address is local to loopback) works. Real VMs have an interface and a default route, and are
not touched. None of this is a boundary.

## git-lfs: `lfs.url` outranks `remote.<name>.lfspushurl` (measured; a bug the tests caught)

The root clone sets `lfs.url` to the mirror (so downloads are offline and a hostile
`.lfsconfig` is ignored). With the push endpoint set as `remote.origin.lfspushurl`,
`git lfs env` showed the mirror as the endpoint for uploads too, and a person's push
"uploaded" its LFS object into the mirror instead of the remote, then pushed the commit: the
remote had a pointer with no object. `lfs.pushurl` is consulted first, so the root clone sets
that. A clone that is not pushable gets a push URL and an LFS push URL that lead nowhere,
and every mirror has a `pre-receive` hook that refuses everything, in a directory only root
writes: before those, `git push` in an unpushable root clone wrote a branch into the mirror.

## Secrets: TLS is terminated only for a secret's hosts (decided; tested on T2)

v2 ran every request through mitmproxy. v3 terminates TLS only where it must:

- each workspace's proxy (`release/root/proxy/proxy.ts`) still takes `CONNECT <name>:<80|443>`,
  applies the domain's rules, resolves the name itself, refuses internal addresses, and
  audits by link;
- a connection to port 443 of a host that one of the domain's secrets names is then handed
  to the domain's **secrets proxy** (mitmproxy 11.0.2, already in the image, with
  `release/root/proxy/secrets_addon.py`), together with the name and the address that were
  checked. That proxy accepts TLS for that name only, checks the upstream's certificate for
  that name against the root VM's trust store, connects to that address (nothing is
  resolved twice), substitutes, and scrubs the response;
- every other connection stays end-to-end TLS, and the domain's CA is never used for it.

The addon is v2's `addon.py` cut down to what v3 needs: v2's network rules, project
attribution by source address and per-project modes are gone (the workspace's proxy and the
link do those), and what remains is v2's code for proving a destination, the allowlist,
header confinement, overlapping names and scrubbing. Attribution comes from the header
`proxy.ts` puts on the tunnel it opens; a workspace's own bytes begin inside the tunnel.

One secrets proxy per domain, started when the domain gets its first secret and when one of
its workspaces starts, stopped when it has none. If it is not running, connections to its
hosts are refused, not passed around it.

Not carried over from v2 yet: switching a secret off for a while (`off`, `until`), the
self-test fixture, TLS passthrough lists, and trusting the CA inside a project's
devcontainer (`carryover/proxy/install-ca.sh`, `trust-proxy-in-builds.sh`): the devcontainer
itself is not started yet.

## The editor's gate runs in the workspace VM, and that is not a P5 exception

Each workspace runs VSCodium's server (the pinned `reh-web` build, baked into the image) on
its VM's loopback, with v2's `editor-gate.ts` in front of it, also on loopback. The host's
forwarder listens on one port (31581, `DESOLATE_EDITOR_PORT`) for every editor and carries a
connection to a VM's gate only if it named that workspace's editor hostname. The editor's
two in-VM ports are never forwarded as dev-server ports.

The gate (Host, Sec-Fetch-Site, Origin, and a sandbox for checkout files opened as pages)
protects a workspace's own editor from other pages in the person's browser. A workspace
that removed its own gate would expose only itself, so the gate can live with the editor.
What separates workspaces from each other, which name reaches which VM, is decided on the
host. The connection token stays, as a second lock behind the gate; the host reads it from
the VM to print the address.

Workspace trust is off in the workspace editor: the VM is the boundary (P1), unlike v2's
outer editor, which ran on the trusted side.

## The devcontainer: the CLI in the VM, the spec unchanged, the VM's network (tested on T2)

Section 4.2's shape A. `release/workspace/devcontainer.ts` runs `devcontainer up` in the
workspace VM against the checkout's own spec, with the VM's own dockerd, and adds through
`--override-config`:

- `/workspaces` mounted at `/workspaces`, and the checkout's own path as the folder. A
  domain clone borrows the mirror's objects by absolute path and its worktrees name each
  other by absolute path, so git works in the container only if the paths are the VM's.
  The mirrors are mounted read-only at their own path for the same reason;
- `--network=host` for a single-container spec. The container's traffic then takes the
  VM's one way out with nothing more arranged (measured: the VM's docker daemon's own pulls
  go through the workspace's proxy too), and a dev server in the container is a listener in
  the VM, which is what the forwarder publishes. A container on a docker bridge of the VM
  (compose services, a plain `docker run`) also goes out the same way: the redirect is in
  `prerouting`, and the stub resolver now answers on every address of the VM;
- the trust store that holds the domain's CA, by environment (`SSL_CERT_FILE` and its
  relatives). Tools that read only their own store (Java) are not covered;
- desolate's own CLI and the VM's node, so `desolate offer` works whatever the image has.

Nothing in a spec is refused. `updateRemoteUserUID` (the CLI's default) makes the
container's user own the checkouts. The editor's server runs in the container when it is a
glibc container on the VM's network (it is a glibc program), so its terminal, tasks and
language servers see the project's toolchain; otherwise in the VM, with a terminal that
enters the container. The gate always stays in the VM.

A docker daemon runs only where one is wanted. In a real VM `docker.socket` is started, so
the first `docker` command starts the daemon; on the fake backend the host starts it when a
checkout has a spec. (Measured the hard way: with a daemon in every workspace, the real-VM
tier's third VM was killed for memory in the 8 GB sandbox.) A workspace's size is 2 CPUs
and 4 GiB, with `DESOLATE_WORKSPACE_CPUS` and `DESOLATE_WORKSPACE_MEMORY_MIB` as the one
knob so far (question 9).

Not done: the environment is not frozen and features are not pinned; no templates (C3) or
caches (C2, C4), so each workspace builds its own environment; compose specs' ports are not
forwarded. Features and compose are untested: the sandbox has no registry. The tests build
their image inside the VM from the VM's own files (`tests/v3/lib/devimage.sh`).

## The root UI: a state service that is told, and a dashboard that asks for nothing

Section 4.8's requirements, and how each came out:

- **One state service in the root** (`release/root/stated.ts`) holds the state and pushes
  it over an event stream. The dashboard draws from the stream and spawns nothing.
- **It cannot see the host, and cannot ask.** Which VMs run, forwarded ports, each editor's
  address, a start's phases: only the host knows, and no VM may open a connection to the
  host. So the host's daemon dials in (through the VM layer, as it does for a proxy) and
  tells it, with a token the host installed as root.
- **A VM gets no file events for a share** (virtiofs and 9p deliver none for another
  writer's changes). A status set in a workspace is a file changing in a share. The host
  does get events for it, so the host's daemon watches the status files' directories and
  nudges the service. The service also looks once a second, which costs a few small reads,
  so that a missed event is late and not lost. "Not by polling" is therefore true of the
  path that meets the budget, with a slow net under it.
- **Actions.** The dashboard queues a request; the host's daemon collects it and runs
  desolate's own CLI with arguments it builds itself from a fixed list
  (`release/shared/actions.ts`). The root VM never hands the host a command line. This is a
  new direction of control (root VM to host), limited to: start, stop, up, fetch, create a
  domain, add a repository. None of them can push.
- **Push.** From the dashboard it is a `git push origin` in the root clone, which waits for
  `desolate approve` on the host like any raw push. The dashboard raises no dialog.
- **Budgets** are asserted on the fake backend. Two things were needed to meet "state shown
  within 300 ms": the daemon keeps a few connections to the service open ahead of need
  (opening one costs an exec into the VM), and an answer is taken as complete at its
  Content-Length (the relay that carries a connection into a VM holds it open until the
  caller closes, half a second with socat).
- **It is a page, not an extension.** See `status-by-section.md`.
- **On the Mac (vz)**, measured on the M1 with five workspaces running: `/state` through the
  forwarder in 1.7 ms (median of 6; one of 92 ms), against the 300 ms budget; a status a
  workspace set reached the event stream 587, 55 and 46 ms after the command that set it
  returned, against 1 s.

## Timings in the sandbox (TCG, no KVM), for scale only

Tier T2 (52 tests, the fake backend): 3 minutes 15 seconds. Tier T3 under software emulation:
about 3 minutes to boot each VM, about 20 minutes for the tier. These say nothing about a
Mac, where a VM boots in under 10 seconds.
