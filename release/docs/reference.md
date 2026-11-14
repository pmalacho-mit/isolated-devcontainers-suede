# desolate: reference

The details behind [the README](../README.md) and [getting started](getting-started.md).

## Approving, pushing, and the pages desolate serves

**Approving a push happens on the host, outside every VM.** The root's keyring lets a write
key sign only for a push whose description (repository, branch, commit) was signed by the
host's approver key, and that key signs only after you type the branch name on your
terminal. Nothing in any VM can approve, and a script or agent harness driving `desolate`
on your Mac stops there too, because the prompt is on the terminal and not on its input.
It is a gate against work being pushed without you having looked, not a defence against
hostile code on your Mac (see the rule above). If you want that as well, on a Mac
`DESOLATE_APPROVER=touchid desolate bootstrap` keeps the approver key in the Secure Enclave
behind Touch ID; that path is written and has never been run. `desolate approve --selftest`
checks whichever you have without pushing anything.

**Use Chrome or Firefox for desolate's pages** (the dashboard, the approval page, the git
terminal, the editors): they are at names under `localhost`, which those browsers resolve
themselves. Safari asks macOS, which resolves `localhost` alone, and says it cannot find
the server.

**Or approve with one click.** `desolate approve --web` (and `desolate ui`) prints the
approval page's address, `http://desolate-approve.localhost:<port>/?tkn=...`: open it once in
your browser, keep the tab, and every push waiting for you shows there, with what it would
send, as desolate's reviewer in the root worked it out (its commits and files, and whether
it builds on the remote's branch or replaces it). The page is the host's, not a VM's, and it
signs only for a request from its own tab: a cookie only that address gives, its own origin
(a page an agent wrote, on a workspace's name, is another), a token per push, a JSON body.
It cannot be framed, and its Approve button arms only after the tab has had your attention
for a second and the pointer then moves onto it, so a click aimed at something else when a
window opened under it lands on nothing. Treat the address like a password: anyone with it,
on your Mac, can approve. In the git terminal (`desolate git`) the same page opens beside the
shell when a push waits: `git push`, then Approve, in one tab. Only the git terminal's own
origin may frame it; there the pointer over the frame counts as your attention, and in Chrome
Approve arms only while the browser reports the button visible and uncovered.

**After a push: its pull request, and noticing the merge.** A branch offered with
`desolate offer --base <branch>` is for that branch; otherwise for the repository's default.
When its push lands, desolate gives GitHub's page for opening the pull request, filled in:
"Open pull request" in the dashboard's activity, a line after `desolate push`, and one in a
raw `git push origin`'s output. It opens in your browser, where you are signed in as
yourself, and you create the pull request there: desolate holds no forge token, and this
needs none. The root keeps a record of what it pushed (`/var/lib/desolate/pushed.json`, kept
across `destroy`). When the mirror shows a pushed commit's changes in the branch it was for,
`desolate branches` and the dashboard say "merged into <base>" for as long as the domain's
branch is still at that commit. The root fetches a repository with a push waiting to land
every 15 minutes, for 30 days. The test is conservative: every file the branch changed is, in
the base, exactly as the branch left it (so a merge commit, a squash and a rebase all count).
A base that has since changed one of those files again is not recognised, and the branch is
then just not marked.

**Git in your browser.** `desolate git <owner/repo>` prints the address of a terminal the host
serves in a browser tab: bash, in the git VM, in a clone of your own at `/git/<owner>/<repo>`.
It is git as you use it anywhere: `git fetch` (from the mirror), `git fetch <domain>` (every
branch that domain's workspaces made, as `<domain>/<branch>`; `git fetch root` has all
domains', as `root/<domain>/<branch>`), diff, log, rebase, commit, and `git push origin
<branch>`, which waits for you on the approval page and then goes out through the root.
`git push <domain> <branch>` delivers a branch to a domain instead (its workspaces see
`root/<branch>`; nothing leaves the machine, so nothing is asked), and `desolate fetch` has
the root refresh the mirror from the remote first, then fetches every remote. Your commits
there carry the Mac's own `git config --global user.name`/`user.email`, if it has
them and the git VM has none yet. The
git VM has no network, no key, and nothing of a project's that runs: no devcontainer, no
direnv, no clone's hooks; `less` shows colour and nothing else raw, and vim reads no
modelines. The root's clones and the mirrors are read-only to it. What it pushes, the root
takes in like a domain's work: every object checked first. The terminal's address carries
this stack's token, like the approval page's: treat it like a password. Once you have opened
it, the dashboard's "Open in git" on an offer opens a shell at that repository's clone
(made on the way if it is not there yet). (`desolate root
shell` is still there, a shell in the root VM itself, for what only the root can do.)

**Your own scripts: `desolate events`.** A JSON object per line, as things happen, until you
stop it (`--replay <n>` first repeats the last ones the host holds). Each says where it comes
from, which is how far to believe it:

| `source` | types | believe it as |
|---|---|---|
| `pusher` | `pushed`, `push-failed`, `push-uncertain` | the remote's own answer: `pushed` means the branch is at that commit |
| `host` | `approved`, `refused`, `workspace-up`, `workspace-down`, `git-push-handed` | the host's own doing |
| `root` | `offered`, `offer-gone`, `bundle-refused`, `status`, `head` (a checkout switched branch or its branch moved), `approval-waiting` | an agent's word, relayed: safe to print, not to trust |

For example, a pull request for every branch pushed (the `gh` here is yours, on the Mac; no
VM has it):

```bash
desolate events | while read -r line; do
  [ "$(jq -r '.source + " " + .type' <<<"$line")" = "pusher pushed" ] || continue
  repo=$(jq -r .repo <<<"$line"); branch=$(jq -r .branch <<<"$line"); commit=$(jq -r .commit <<<"$line")
  title=$(gh api "repos/$repo/commits/$commit" --jq '.commit.message' | head -1)
  gh pr create --repo "$repo" --head "$branch" --title "$title" --body "Pushed through desolate at $commit." || true
done
```

Act only on `pusher` and `host` events when what you do matters: a `root` event's fields
(a status message, an offered branch's name) are what an agent wrote, with control
characters taken out (and a name desolate would not make is `null`). Pass a field to a
program as an argument, never into the text of a script: `osascript -e 'on run argv' -e
'display notification (item 1 of argv)' -e 'end run' -- "$message"`, not
`osascript -e "display notification \"$message\""`, which runs what the message says.
Approvals given at the terminal (`desolate push`, `desolate approve`) are not events yet;
the page's are.

**What a push is, exactly.** The push goes out through the root's pusher, the one program
that can use a write key, and it asks the remote for one change: the branch moves from the
commit it was at when you approved (`onto`) to the commit you approved, or nothing happens.

**The dashboard** (`desolate ui`) is served by the root VM: every domain as a card, each
workspace with its status colour, "Needs you" on top, one click to open a workspace's
editor, start, stop, review an offer or push it (a push still waits for your approval on
the host). Reviewing an offer shows its commits, its files, warnings, and the diff, as text
git made in the root: nothing in it is run or rendered. It shows the command behind every
button.

![Reviewing an offer: commits, files, and the diff as text](assets/review.png)

**What the root takes from a workspace** is data, and it is checked before it is the
root's: a bundle is copied out of the domain's reach and every object in it passes git's
strict checks before any enters your clone (a tree that hides a `.git`, a `.gitmodules`
that names a command, a malformed object: the whole bundle is refused, and you and the
workspace are told why); LFS objects must hash to their names; the small JSON files are
size-limited and validated; nothing in the outbox is followed if it is a link. The root's
git is configured so that a checked-out tree cannot make it run anything.
[`docs/v3/decisions.md`](https://github.com/pmalacho-mit/isolated-devcontainers-suede/blob/main/docs/v3/decisions.md) has the audit, and what is left by
nature.

**Devcontainers.** A workspace runs its project's own `devcontainer.json`, unchanged, with
the devcontainer CLI and a docker daemon inside the workspace's VM. Nothing in a spec is
refused: the VM is the boundary. A spec that does not come up leaves the workspace as the
VM itself, and `up` says why. A compose spec runs as written; its primary service (`service`)
is where `desolate exec`, the editor and desolate's mounts are, on the VM's paths, and what
listens in it, and each `forwardPorts` entry written `service:port`, is forwarded at the
workspace's hostname like a single container's. For Docker inside the devcontainer, prefer
the `docker-outside-of-docker` feature: the VM is the boundary, so sharing its daemon costs
nothing, and it shares the VM's images. `docker-in-docker` works in a compose service
(privileged, with a store of its own); avoid it in a single-container spec, where it shares
the VM's network and its `docker0` with the VM's own daemon, and both hand out the same
addresses.

**Secrets.** A workspace never holds a secret's value. It holds the name
(`export OPENAI_API_KEY=MYAPP-OPENAI-KEY`), and the root puts the value in its place on the
way out, only over TLS, only toward the hosts the secret names, only in the headers it names.
Connections to those hosts are the only ones whose TLS the root terminates (the workspace
trusts its domain's CA for that); everything else stays end to end.

## On a Mac: if macOS asks about `limactl` and incoming connections

With the macOS firewall on, you may see this dialog (the wording on macOS 14.5, from the
Application Firewall's own strings):

> **Do you want the application “limactl” to accept incoming network connections?**
>
> Clicking Deny may limit the application’s behavior. This setting can be changed in the
> Firewall pane of Network Settings.
>
> [ Deny ] [ Allow ]

**Click Deny.** desolate never needs another machine to connect to it:

- Everything desolate listens on is your Mac's loopback (`127.0.0.1`): the dashboard, the
  editors, dev servers, each workspace's link. The macOS firewall does not apply to loopback,
  so Deny changes nothing for desolate.
- desolate's VMs forward nothing onto your Mac by themselves: every desolate VM refuses
  Lima's own port forwarding, on every address, TCP and UDP, and `desolate doctor` checks
  it ("VMs forward nothing by themselves").
- What raises this dialog is a `limactl` binding a port on *all* interfaces, which
  desolate's VMs were shown not to do (on the M1, every kind of listener in a workspace
  was tried). Another Lima instance does: Colima, which the tests use for Docker,
  forwards a container port published without an address (`docker run -p 8080:80`) to
  every interface of the Mac, and that is the likely source of the dialog seen on the M1
  (which process it was could not be read back without an administrator). Allowing it
  would let other machines on your network reach that container; if you need a published
  port, publish it on loopback (`-p 127.0.0.1:8080:80`).

`limactl` is one binary for every Lima instance, so the answer covers all of them, and macOS
asks again after Homebrew updates Lima (the path changes). To change it later: **System
Settings → Network → Firewall → Options…**, find `limactl` and set it to "Block incoming
connections" (or remove it). From a terminal, as an administrator:

```bash
/usr/libexec/ApplicationFirewall/socketfilterfw --listapps        # what is allowed
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --blockapp "$(realpath "$(command -v limactl)")"
```

## What works today, and what does not

"T2" is the fake backend: containers standing in for VMs, **not isolated**, good for
everything but the hypervisor boundary. "T3" is real VMs on Linux (QEMU through Lima).
"Mac" means Lima with Virtualization.framework, the product backend.

| | Implemented | Tested | Not yet |
|---|---|---|---|
| bootstrap, doctor, destroy | yes | T2, T3 | installing the host's own tools (it checks for them and says what to install) |
| Root VM: keyring, read and write keys, mirrors with LFS, root clones | yes | T2, T3 | |
| P2: pushes only by a person (`--expect`, exit codes, LFS first, audit) | yes | T2 | |
| P2: the approval is given on the host, outside every VM (a signed challenge; `desolate approve` for a raw `git push origin`) | yes | T2, with the `terminal` approver, which is the default | the opt-in Touch ID approver (`host/approver/touchid.swift`) has never been compiled or run |
| P3: keys never leave the keyring; a secret's value never leaves the root | yes | T2 | |
| P4: the root never runs git in a domain's clone | yes | T2 (a booby-trapped clone, a lying outbox) | |
| What the root takes from a domain is checked data: bundles strictly checked in quarantine, a held and checked outbox directory, verified LFS, git settings that ignore what a tree asks for | yes | T1, T2 (`10-hostile-content`: dangerous objects, a planted repository, links in the outbox, hostile names; each beside a control), T3 (an offer, a dangerous tree and a linked outbox over a real VM's share) | a size quota for a domain's outbox; on the Mac, status files are checked by a second look, not by the kernel |
| Domains, workspaces, checkouts, worktrees, locks, `--base`, `--fetch`, `--branch`; a domain's environment built once (templates) and its package caches | yes | T2, T3, T4 | |
| Offers, the root's view (`git fetch --all`), deliveries between domains | yes | T2 | |
| `desolate upstream`: a consumer's change to a vendored suede dependency, split by suede's own upstream (pinned) in the git VM, pushed as `downstream/...` after your approval ([suede.md](suede.md)) | yes | T1, T2; against github.com | LFS files in the dependency |
| Ports: same number, routed by name, reservations | yes | T2 | forwarded connections on real VMs are untested |
| P5: read-only shares against root in the VM | yes | **T3** (and measured on an M1 for the Mac) | |
| P5: forced egress against root in the VM | yes | **T3**; Mac: measured for TCP, UDP, DNS and ICMP (Lima 2.3.0 or newer required) | |
| Egress through each workspace's own proxy, per-domain rules, audit by link | yes | T2, T3 | |
| Secrets: per domain, substituted for the hosts and headers they name, proven by the upstream's certificate, scrubbed from responses, switched off and on (`--ttl`) | yes | T2, T3 | v2's self-test fixture; "learn" as a timed mode |
| **P1: the editor**: VSCodium's server in every workspace VM (in the project's devcontainer when it can), its own hostname, v2's gate | yes | T2 (HTTP, WebSocket, a real browser), T3 | desolate's workspace extension ([`carryover/editor/extension`](https://github.com/pmalacho-mit/isolated-devcontainers-suede/blob/main/carryover/editor/extension): mapping `localhost` URLs) is not ported |
| The project's devcontainer, from its own `devcontainer.json` (features included), inside the workspace VM; `exec` and the editor enter it | yes | T2 (an image, a Dockerfile, a failing spec, no spec, a changed spec, a compose spec and its ports); on the M1, a public image with a feature, compose with Docker outside and inside | a compose service that is not glibc gets no port relay and no editor |
| The root UI: a state service in the root that pushes changes, a dashboard at `desolate.localhost` with the diff of an offer as text; no editor in the root | yes | T2 (the spec's three budgets, a real browser), T3 (the state reaches the dashboard) | a side-by-side diff |
| The Mac backend (`vz`) | yes | **T4 on an M1**: read-only shares and forced egress against root in the VM (TCP, UDP, DNS, ICMP), no path between domains, an offer over a real share, the editor, a secret | |
| Pushes by the pusher alone (it speaks receive-pack; compare-and-swap from the commit you saw) | yes | T1, T2; against github.com | |
| One-click approval in the browser, beside the git terminal | yes | T1, T2, and in Chrome | Firefox and Safari cannot say whether Approve is covered (Chrome can) |
| The git VM: your git in a browser tab, no network or keys; a remote per domain; LFS | yes | T2 | |
| `desolate events` and `desolate notify` | yes | T1, T2 | |
| After a push: the pull request's page on GitHub; "merged into <base>" once the mirror shows it | yes | T1 (the link; a merge, a squash, a rebase), T2 (a squash on the stand-in forge) | the link has not been opened on github.com; the 15-minute fetch not watched in real use |

## Layout

```
cli.sh             the launcher: finds node >= 22.18, runs host/cli.ts
pins.env           every tool desolate downloads, by version and sha256
host/              runs on the host: the CLI, the daemon (forwarder, links), the VM layer
  vm/              one interface, three backends: fake, qemu, vz
  approver.ts      the key that approves pushes (approver/touchid.swift: opt-in, the Mac's Secure Enclave)
root/              runs in the root VM: keyring, mirrors, clones, offers, push, proxies
  proxy/           each workspace's proxy; each domain's secrets and its secrets proxy
  stated.ts, ui/   the state service and the dashboard it serves
  outbox.ts        the only code that touches what a domain wrote: how, and why, is at its top
workspace/         runs in each workspace VM: its init, its daemon, its network, its
                   devcontainer (devcontainer.ts, enter.sh), its editor
completion.bash    tab completion: source <(desolate completion)
shared/            names, exit codes, the name sniffer: used on more than one side
image/             what a VM image contains (provision.sh) and how it is built
docs/incidents.md  ways desolate has been wrong, and what each taught
```

The code runs straight from this tree: every VM mounts it read-only at `/desolate/release`.
