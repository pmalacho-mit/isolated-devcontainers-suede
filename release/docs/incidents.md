# Incidents, and what each taught

Each entry is a way desolate was wrong: what happened, how it was found, what
changed, and the test that keeps it changed. Most of them have the same shape
-- **something reported success while having done nothing** -- which is why
the rules at the bottom exist.

The design rationale for each control is in [the README](../README.md); this
is the history that rationale was earned from.

## Found while building v3 (2026-11), by its own tests

These were caught before any of v3 shipped. They are here because each has the shape this
page is about, and because three of them were mistakes in the *tests*.

- **An LFS upload went into the mirror, and the commit went to the remote.** The root clone
  set `lfs.url` to the mirror and the push endpoint as `remote.origin.lfspushurl`; git-lfs
  lets `lfs.url` outrank the per-remote setting, so `git lfs push` "succeeded" into the
  mirror and the remote received a pointer with no object. Found by the test that asks the
  forge whether it holds the object after a push. Now `lfs.pushurl`.
  (`tests/v3/t2/04-offers.test.ts`)
- **`git push` in a clone the root cannot push wrote a branch into the mirror.** With no
  push URL, a push goes to the fetch URL, which is the mirror, which the root can write. The
  test expected a refusal and got exit 0. Now such a clone's push URLs lead nowhere, and
  every mirror refuses every push with a hook only root can change.
- **A read-only share that root in the VM could write.** Lima on Linux starts `virtiofsd`
  with no read-only option, so a share marked read-only was read-only by the guest's mount
  flag alone: `mount -o remount,rw`, then a file created in the guest appeared on the host.
  Found by hand before the backend was written, then pinned by tier T3. The qemu backend
  uses 9p, whose read-only is QEMU's. (On a Mac the host refuses the write: measured.)
- **A probe that said "ok" whatever happened.** The second egress probe for the Mac tested
  whether `dig` printed anything; `dig` prints its timeout. Two rows of that probe's results
  are not evidence, and `docs/v3/decisions.md` says so beside them.
- **Controls that could not pass.** Tier T3's first run failed twice, both times in a
  control: one assumed a share can be mounted a second time (9p allows one mount), the other
  gave a slow emulated VM six seconds. The negative checks beside them had passed. A control
  that fails is the suite working; a suite with no controls would have been green.
- **Tests that closed their own connection.** Requests written straight to a workspace's link
  with `printf ... | socat` got no answer, because the proxy hangs up on a client that closes
  its side before the answer is ready. The proxy was right. The test now holds the
  connection open.
- **A confirmation that could never have been asked.** v3's first cut asked the person to
  confirm a raw `git push origin` from the pre-push hook. git authenticates to the remote,
  which takes the write key's signature, before it runs pre-push; with no approval on file
  the signature was refused and the hook never ran. The test only asserted that the push
  failed, which it did, for the wrong reason. Found when the approval moved to the host and
  the test asserted the message. A raw push now goes through a remote helper, which git
  runs before it connects to anything.
- **A terminal is not a person.** The same first cut filed an approval when the branch name
  was typed on a terminal, and the tests typed it from a script on a pseudo-terminal. That
  was written down as a residual; with an agent harness running on the same Mac it was the
  ordinary case. An approval is now a signature by a key on the host, asked for on the
  host's terminal. (For one pass the Mac's default was a Secure Enclave key behind Touch
  ID. It is opt-in now: the rule is that untrusted code never runs on the Mac, and under
  that rule the gate is against work going out unread, which the terminal does.)
- **A killed process that still had a pid.** In the fake backend nothing reaps a detached
  child, so a secrets proxy that had been killed still answered `kill -0`, was taken for
  running, and its hosts were refused for ever. "Running" now means "listening".
- **An answer that had arrived, waited for.** The host's daemon talked to the root's state
  service and waited for the connection to close before believing the answer. What carries
  a connection into a VM does not close until the caller does, so every call "timed out"
  with its answer already in hand, and the first hand-off of a dashboard request gave the
  request to a caller that then threw it away. Two fixes, both kept: an answer is complete
  at its Content-Length, and a request stays queued until the host reports on it.
- **A check that did not apply to the one route that mattered.** The root set
  `fetch.fsckObjects`, so "git checks every object a domain sends" was written down as
  done. Every object a domain sends arrives in a bundle, and on the image's git (2.43) a
  fetch from a bundle is not checked: a tree containing `.git` was imported and offered.
  Found by the first test that sent one (`tests/v3/t2/10-hostile-content.test.ts`), not by
  reading the config. A bundle's pack is now indexed strictly into a throwaway object
  directory before any of it enters a root clone, whichever git the image has.
- **The root deleted a file of its own because a domain asked.** The root tidied a
  domain's outbox by path: read a directory, then remove what it had read. The directory is
  the domain's to replace, and replaced by a link into the root's state, the tidy removed
  a file there. Opening files had been made careful (no links followed); *removing* had not
  been thought of as an operation on untrusted input at all. Now a directory is opened
  once, checked to be the one meant, and everything (list, open, remove) is by name inside
  that open directory. `release/root/outbox.ts` is the only code that touches an outbox.
- **Verified, then copied by name.** An LFS object's hash was checked, and then the file at
  that path was copied. Between the two the path is the domain's. The bytes that are hashed
  are now the bytes that are kept.
- **One refused branch, and silence.** With bundles refused, a domain holding one bad
  branch had every later offer fail with "the root received nothing": true, and useless.
  The refusal is now recorded and said in three places (the offering workspace, the
  dashboard, `desolate offers`), with what to do, and it clears itself when the branch is
  gone.
- **The dashboard died the first time a domain sent work, on real VMs only.** The state
  service watched its state directory as a tree. Checking a bundle makes a quarantine
  directory under that tree and removes it seconds later; node's recursive watch on Linux
  scans each new directory, found this one already gone, and raised an error on a watcher
  nobody listened to, which ends a node process. Nothing restarted it. On the fake backend
  the timing never allowed it, so ninety-odd green tests said the dashboard worked. Found
  only because this pass added an offer to the real-VM tier, after which the next test
  asked the dashboard a question and got no answer. Three changes: each directory is
  watched by itself with a listener for its errors; the state service and `rootd` are
  started again if they end, and say so in their logs; and the tests that send hostile
  content end by checking those logs.
- **Four attacks, one tested.** The first version of that test offered four dangerous
  branches in a row and saw four refusals. After the first, the other three were refused
  because the first was still there. Each is now offered alone.
- **A count that counted itself.** "No editor runs in the root" used `pgrep -f` with the
  pattern on its own command line, and found one.
- **A test that read a socket.** "No file on the host holds a private key" read every file
  under the home, and failed when the host's daemon began to run from bootstrap and left a
  socket there. The check now reads files.

## Found bringing v3 up on a Mac (2026-11), first contact with the vz backend

- **A setting that matched nothing.** The image set `safe.directory '/desolate/mirrors/*'`
  so that a workspace's git would read the read-only mirrors. The image's git is 2.43, and
  the `<dir>/*` form arrived in git 2.46: the line was accepted and did nothing. It had
  never mattered because on Linux the mirror's owner and the guest user agree. On vz, a
  virtiofs share's root can report uid 0 for a while after it is mounted, and the first
  workspace failed with "dubious ownership". The dead line is gone from
  `image/provision.sh`. (First each mirror was listed by exact path; then T4 showed that on
  vz a file root makes or chowns in a share reports uid 0 in the guest from then on, so a
  devcontainer running as root turns the user's own clone "dubious" too. A workspace VM
  has no second user for the check to protect, so it is `*` there: `workspace/start.sh`.) (Measured in the root VM: `/tmp/sd/*` refused, the exact path and
  `*` accepted.)
- **A VM used before its shares were there.** `limactl start` returns when ssh answers, not
  when the last virtiofs share is mounted. Nothing checked, so a command could see a
  share's bare mount point: an empty directory that looks like a repository with nothing
  in it. The backend now waits for every share in the spec to be in the guest's
  `/proc/mounts`, and on vz refuses (and stops the VM) if a share is mounted read-write
  that the spec says is read-only, or the reverse. (`tests/v3/t1/lima.test.ts`)
- **The root's ordinary user could become root, so the keyring's user separated nothing.**
  HANDOFF said keys were "safe from the root's unprivileged processes". Those processes
  run as Lima's login user, which Lima gives `NOPASSWD: ALL` at every boot, and they
  include every workspace's proxy and every secrets proxy, which parse what workspaces
  send. A test in T2 ("sudo to root ... must fail") had passed only because the fake
  backend's container user has no sudo rule: on a real VM it would have succeeded. Found
  by reading `start.sh` beside `sudo -l` in the first real root VM. Now a sudoers rule of
  desolate's takes it away at every start, the host reaches root by ssh as root, and
  `doctor` asks. (`docs/v3/decisions.md`, "The root VM's ordinary user is not root".)
- **Root's start-up followed links its ordinary user could plant.** Moot while that user
  had sudo, and the way to root once it did not: `start.sh` ran `install -d -o <user>` and
  `cat >` as root on names inside the user's own directory, so a link there handed the
  user `/usr/local/bin` (on root's PATH). And the keyring's key directory was itself a name
  in that directory: the user could have put a directory of its own there before any key
  was made. What root and the keyring rely on is in `/var/lib/desolate-root` now, the
  user's directories are made by the user, and the keyring refuses a key directory that is
  not its own all the way up. (T2 `01-root` plants three links and checks.)
- **What root runs belonged to nobody in particular.** The image unpacked node with `tar`
  as root, which keeps the archive's owner: `/usr/local/bin`, `node` and npm belonged to
  uid 1001, a uid no account had yet and the next account made could get. Root runs that
  node (start.sh, the keyring). Found by the control of the T2 test above ("/usr/local/bin
  is root's") failing on the fake backend's image, then seen in the root VM too. Now
  `tar --no-same-owner`, start.sh gives existing images' files back to root, and `doctor`
  asks.
- **A restarted root VM left every running workspace without a way out.** A workspace's
  proxy runs in the root VM; after the root VM's restart, `list` said "running" and every
  connection from the workspace was refused. Bootstrap now gives each running workspace
  its proxy and its link again.
- **Logs that went nowhere.** After the layout changed, a root-owned leftover log made the
  services' `exec >>log` fail, and bash carried on with output to `/dev/null`: the
  services ran, and said nothing. The log open is now fatal, and the leftovers are taken
  over by the user.
- **An honest offer refused right after its outbox changed.** T4's control at the end of
  the outbox test: the workspace put its sync directory back (a link it had planted
  became a directory again) and offered, and the root "received nothing". On vz the root
  VM saw the old link for about a second. The root now looks again for about three
  seconds before refusing (`root/offers.ts`; `docs/v3/decisions.md`, "On vz, a share is
  the host's files seen through each guest's own cache").
- **The dashboard answered any program on the machine, and handed it every editor's
  token.** It checked the name and the origin, which keeps other web pages out; a local
  program (another user of the Mac, a sandboxed app allowed to reach localhost) sends any
  Host and no Origin. `curl -H 'Host: desolate.localhost:31581' .../state` returned each
  workspace's editor address with its token: a terminal in that workspace. Now the
  dashboard takes a cookie it gives only for the address `desolate ui` prints.
  (T2 `09-ui`: every surface without it.)
- **A fix that did not take effect.** After that change and a bootstrap, the dashboard
  still answered without the cookie: start.sh leaves running services alone, so the root
  ran the old code until the VM restarted. Services (and proxies) are now restarted when
  the code they run has changed; the editor's gate likewise.
- **"Open editor" could never open the editor.** Each `*.localhost` name is a site of its
  own, so the dashboard's link arrived at the editor's gate as a request another site
  started, and was refused. The test read the link's address and never followed it; a
  real browser on the M1 did. The gate now lets in that one navigation when it carries
  the editor's own token.
- **Every devcontainer failed on the Mac: "the VM's docker daemon is not answering".** The
  daemon was fine. Lima runs every command over one ssh connection per VM, and a command
  keeps the groups that connection logged in with; start.sh adds the user to `docker`
  after the connection exists, so every later command the host ran was refused by the
  socket (`id -Gn` in a session: no docker; in a fresh login: docker). The same held for
  the root's user and the proxies' group. The backend now starts a new connection when a
  session's groups are not the user's. Found with the first real project on the M1
  (microsoft/vscode-remote-try-node: image pulled through the workspace's proxy, its
  `npm install` too, its dev server at the workspace's own hostname).
- **Lima forwarded a workspace's loopback listeners onto the Mac.** desolate told Lima to
  forward nothing from a guest's `0.0.0.0`, and that was all it told it: Lima's own rule for
  `127.0.0.1` (and `::1`) still applied, so whatever a workspace ran on its own loopback
  appeared on the Mac's `127.0.0.1`, the editor server's port among them, around
  desolate's forwarder, its hostnames and the editor's gate; and a workspace could take any
  free loopback port of the Mac. Found while working out which `limactl` had made macOS's
  firewall ask about incoming connections (it was not this: these are loopback). Now every
  forward is refused, on every address, TCP and UDP; an older VM gets the rules at its next
  start; `doctor` names a running VM that still has the old ones; T4 tries all three kinds
  of listener against the host.
- **What an independent audit found after all of the above** (a reviewer given the code and
  the threat model, not these notes; 2026-11-12). Each was then checked on the live stack:
  - *One domain's proxies could use another's secrets through that domain's workspace
    proxy.* Workspace proxies listened on loopback ports in the root VM, asked their client
    for nothing, and added their domain's handoff token to whatever they were asked; as
    `node`'s proxies, `CONNECT` to `hello`'s workspace proxy got 200. The handoff token had
    been tested against the secrets proxy directly, not through the workspace proxy, which
    was the confused deputy. Now a workspace proxy is a unix socket in its domain's `out/`,
    which only that domain's proxies and the root's user reach (as `node`'s: permission
    denied; as the root's user: 200). T4 asserts both.
  - *A secrets proxy's port could be taken first* by another domain's proxies while it
    started; the root recorded whatever listened. Now the root, and each workspace proxy on
    every connection, checks in `/proc/net/tcp` that the listener is the domain's own user.
  - *The vz link sent its token to whatever held the port.* A freed port is any local
    user's to take. The link now proves knowledge of the token both ways, host first, and
    the token never crosses (`shared/link.ts`; T1 has both impostors). A workspace's VM is
    stopped before its port is let go, and a port the daemon cannot bind is retried.
  - *A workspace could have the host bind any loopback port*, a VM's ssh or link port
    included, by listening on it. Ports desolate itself uses are never forwarded.
  - *sshd allowed ten sessions per connection*, and every link connection, dashboard
    request and forward is one, all on one connection per VM: raised to 1000, and a link
    takes at most 64 connections at once; a proxy client that does not finish asking in ten
    seconds is dropped.
  - *Updated proxies kept running old code*: start.sh matched them by a path they no longer
    run from. And the host daemon and each workspace's relay also kept old code after an
    update: both now restart when their code changes.
  - *The root's ordinary user both parsed what domains send and pushed* (F6). It no
    longer pushes: the pusher, a user of its own, is the only one that reaches the write
    agent. Its first version ran git on a bundle the root's user made, and a second audit
    pointed out that a git bug that compromised one could be replayed on the other. The
    pusher now parses nothing it is sent: it speaks receive-pack itself, asks for the one
    approved update from the approved `onto`, and forwards the pack unread. T1 runs it
    against a real receive-pack; T2 `04-offers` hands it another commit's pack under a real
    approval: nothing moved. It reads the forge's address from root's copy, not the root's
    user's (`docs/v3/decisions.md`, "The pusher").
- **A deploy key named its owner.** A key's title carried the Mac's hostname, which on a
  Mac is usually its owner's name, and a deploy key's title is shown to everyone who
  administers the repository. It is a hash of the hostname now.

## Found by the 2026 security audits

**Tab completion ran commands a project named.** `compgen -W` expands its
word list, and the lists held names a project controls: its `.worktrees/`
directories, its branch names, a spec under a one-segment project. A
directory called `$(...)` ran on TAB, in the editor and on the Mac. Found by
the first audit (C1) and, for two lists left over, by working its follow-up
(R1): a one-segment project can delete its own spec and plant
`solo/$(cmd)/.devcontainer.json`. Now every stack-sourced word is matched
against the name rules and never expanded. `tests/static/17-completion.sh`,
which also requires every `compgen -W` producer to be one whose words come
from this repo -- and whose original fixture had a `/` in its payload, so
`mkdir -p` made nested directories and the test could not have failed. It now
has a control that shows the payload runs.

**A project chose which repository its proposals went to.** `suede upstream`
read the dependency from the project's own `.gitrepo`, so project A could push
a branch into repository B with B's deploy key -- and B's push workflows ran
from it. The caller now names the dependency and the factory approves each
consumer-and-dependency pair; proposals that touch `.github/` are refused (H1).

**Feature metadata was checked once and applied later.** The policy read a
feature's metadata, then `devcontainer up` fetched it again; a server could
answer harmlessly the first time and `privileged` the second. Features are
pinned to digests before the policy reads them and `up` reads no lockfile
(H2). The same class, found while fixing it: a Dockerfile's *base* image
label was merged by `up` after the policy had passed -- measured, a `FROM`
carrying `[{"privileged":true}]` started privileged. Dockerfile projects are
now built first and judged by the image they produced, named by id.

**"Restart ends the incident" was not true.** The editor's `$HOME` is a
volume a compromised editor can write, and the settings that bound it were
seeded once (M3). They are now held at every start, the code is root's, the
terminal reads no rc file -- and `./cli.sh shell` did, until the follow-up
(R2).

**A path checked, then a different path mounted.** The broker
realpath-compared a project's directory, and the daemon resolved the bind
moments later; the editor could swap in a link (M4). The container is asked
what it got, by inode -- and, since the follow-up (R3), before any lifecycle
command runs in it. `tests/static/18-start-order.sh`.

**The editor cloned with the system git-lfs filter.** Checkout in the
key-holding editor ran `git-lfs smudge` over the remote's content and its
`.lfsconfig` (M1). The editor now clones without a checkout and no system
config; the files are written in the same sandbox worktrees are checked out
in.

**Every editor's token was in one cookie jar.** Every surface was
`127.0.0.1:<port>`, and cookies ignore the port. Measured against the real
server: the token cookie is not HttpOnly, authenticates alone, and the
WebSocket takes any `Origin` -- so a project's dev-server page could read the
outer editor's token and drive it. Per-surface hostnames alone were not
enough, and both gaps were measured: a port answers any name, and the editor
serves `/workspaces` files as pages at its own origin. Fixed by
`hosts.ts`, the ingress's host check and `editor-gate.ts`; checked in
Chromium by `tests/environments/editor-gate/run.sh` -- whose own fixture was
empty at first (`docker exec` without `-i`), which made two of its checks
vacuous until a control caught it.

**Project output reached the Mac's terminal raw.** The editor's relay of a
runner's output was stripped of control characters (L5), but from the Mac
`./cli.sh desolate` printed a project's lifecycle and build output as it
came: a terminal acts on escape sequences. It now goes through the same
filter (`plain-output.ts`).

## Found in use

**A check that passed on the binding it existed to catch.** preflight's
"editor not exposed beyond loopback" read each binding's address -- and docker
records an all-interfaces publish as an empty address, which the template
printed as nothing. Found by running preflight with nothing to ask, foldyard's
method (below): six other checks passed too, each reading a failed `inspect`
as an empty answer. `tests/static/20-preflight-degraded.sh`.

**Substitution rewrote the Host header.** Assigning `flow.request.url`, to
put a secret into it, re-parsed the URL and set `Host` to the destination
*address*; the upstream answered an HTML 403 that named neither the header
nor desolate. Substitution assigns `.path` only (`addon.py`, at the loop).

**The audit trail no reader could read.** mitmdump under systemd prefixes each
line with its time, and every reader anchored on `^AUDIT`: `proxy audit`
printed nothing and preflight's leak oracle never matched. The prefix is
optional everywhere now (`AUDIT_FIELDS_SED`).

**The self-test fixture: deletable, and poisonous.** The placeholder preflight
trips to prove leak detection was a published string, so every request that
merely mentioned it was refused -- and the cure, deleting it, made preflight
report "secrets can be exfiltrated" against a healthy proxy. It is now matched
only as a complete header value (`addon.py`, "THE SELF-TEST FIXTURE").

**An installer that said "installed".** `install-ca.sh` skipped the trust
store on images without its directory and printed success anyway; the dind
then failed every pull with an x509 error that never mentioned a CA. It now
creates the directory and fails loudly when nothing was installed.

**`secret list` never worked.** Its jq program escaped quotes to survive
`colima ssh`, which made it invalid jq. It emits TSV with nothing to re-parse
now, and `tests/static/05-cli-queries.sh` runs it.

## The rules these left

- **A negative check needs a positive control.** A probe that failed to run is
  not a probe that found nothing (foldyard's "verify false-pass" study, which
  found the same shape in theirs). Before trusting "nothing happened", show
  the same probe makes something happen when it should.
- **Run every check with nothing to ask.** No daemon, no network, no images:
  nothing may pass.
- **Measure the claim against the real thing.** The CLI's merge order, the
  server's cookie, Chrome's preconnect -- each was measured before a fix was
  built on it, and two fixes changed shape because of what was measured.
- **The input a safe command reads is the boundary, not the command.**
  Completion words, a `.gitrepo`, a lockfile beside the spec, a base image's
  label, a content's `.lfsconfig`: each was a file a project could write,
  read by something that trusted it.
