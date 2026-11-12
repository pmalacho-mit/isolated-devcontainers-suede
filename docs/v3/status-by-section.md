# desolate v3: where each point of `move-to-vms.md` stands

Written 2026-11-11 after the third pass; revised 2026-11-12 after the fourth (no editor in the root, the diff as text, the terminal approver as the default, and the audit of what the root takes from a domain). One row per point of the spec, in the spec's
order. **Done** means implemented and exercised by a test that is named. **Partly** says
which part. **Not done** says so, and where to start. "Unrun" means written and never
executed (everything that needs a Mac).

Tiers: T1 unit, T2 the fake backend (containers standing in for VMs; not isolated), T3 real
VMs under QEMU on Linux, T4 the Mac (`vz`), which has never run.

## 1. Principles

| | State | Evidence, or what is missing |
|---|---|---|
| P1. The editor is inside the boundary | **Done** | VSCodium's server runs in each workspace VM (in the project's devcontainer when it can), used from a browser tab. T2 `06-editor`, `08-devcontainer`; T3. Nothing of a workspace runs in a desktop editor. |
| P2. Every push goes through a human | **Done** | An approval is a signature by a key on the host, over a challenge naming repository, branch and commit, asked for on the host's terminal (the default approver everywhere). T2 `04-offers` tries every automation path from inside the VMs. The opt-in Touch ID approver is written and unrun. What the gate is for, and what is left, is in `decisions.md` section 5.3 (the write key is a file in the root VM; code running as you on the Mac is trusted, by the rule in the README). |
| P3. No credential in a workspace | **Done** | Deploy keys never leave the keyring (T2 `01-root`); a secret's value never leaves the root (T2 `07-secrets`, T3). |
| P4. One owner per `.git`; the root never runs git in a domain clone | **Done** | `root/git.ts` refuses; T2 `04-offers` plants a booby-trapped clone and a lying outbox. **What crosses as data is checked before it is the root's** (`decisions.md`, "What the root takes from a domain"): T2 `10-hostile-content`, T1 `outbox`, `status`, and on real VMs T3 (an offer, a tree with `.git` in it, an outbox linked into the root's state). That audit found two holes in the previous cut (bundles were not fsck'd on git 2.43; the root removed a file through a link in an outbox); both are closed and in `release/docs/incidents.md`. |
| P5. Boundaries enforced outside the VM | **Done on Linux; unrun on the Mac** | Read-only shares and forced egress against root in the VM: T3. On the Mac both were measured by hand in Phase 0; the backend that applies them is unrun; ICMP was measured closed on Lima 2.3.0 (`decisions.md`, 4.3), and vz now requires that version. |
| P6. Fail closed; a control beside every negative check | **Done, as a practice** | `doctor` fails what it could not ask; a secrets proxy that is down refuses its hosts; every negative test has a control. Not a thing that finishes. |

## 2 and 3. Vocabulary and trust model

Domains, workspaces, the root, mirrors, root clones and domain clones exist as specified.
The trust table's rows: domain and root git (P4, done), domain and the remote (no key in the
domain: done), browser (one hostname per surface, the forwarder's name check, the gate: done,
T2 `03-ports`, `06-editor`, `09-ui`).

## 4. Architecture

| Section | State | Evidence, or what is missing |
|---|---|---|
| 4.1 Storage on the host, shared; the host never runs git there | **Done** | `~/.desolate/`; the CLI reads status files and plans as data. The root VM can be destroyed and rebuilt without losing mirrors, clones or domain work: not tested as such (`destroy` without `--all` keeps the home; a test that rebuilds the root over an existing home is missing). |
| 4.2 Shape A: the devcontainer CLI runs in the VM, on the project's own spec | **Done for single-container specs; partly for compose** | T2 `08-devcontainer`: an image spec, a Dockerfile spec built from the project's context, a failing spec, no spec, a changed spec. `privileged` and anything else in a spec is allowed: there is no spec policy. **Compose specs** are started as written, but their services' ports are not forwarded and the editor stays in the VM; untested. **Features** need a registry, which the sandbox does not have: untested. |
| 4.2 The base image carries git's `safe.directory` and git-lfs | **Done** | `image/provision.sh`. |
| 4.3 One link per workspace, reaching only its proxy; enforced outside | **Done on Linux; unrun on the Mac** | T3 (`restrict=on`, `guestfwd`). The request channel is a file spool in the shares, not a socket (`decisions.md`). |
| 4.3 The proxy: domain's rules, audit by link | **Done** | T2 `05-egress`, T3. |
| 4.3 Everything `addon.py` did | **Mostly** | Done: internal-address refusal, SNI-proven destinations, header confinement, scrubbing, on/off and TTL, per-workspace attribution (T2 `07-secrets`). **Missing:** the self-test fixture; "learn then enforce" as a timed mode (there is `open`, `net recommend`, `enforce`); a kernel backstop under the internal-address refusal (the proxies run in the root VM, whose own egress is open). |
| 4.3 A proxy per workspace | **Done** | `root/proxy/manage.ts`. The secrets proxy is per domain. |
| 4.4 Same port number, nothing declared, routed by name | **Done** | T2 `03-ports`; in a devcontainer, T2 `08`. `forwardPorts` and `customizations.desolate.ports` as labels: not read. |
| 4.4 Reservations for what has no name; nothing below 1024; loopback only | **Done** | T2 `03-ports`. |
| 4.4 One hostname per surface | **Done** | Dev, editor and dashboard each have their own (T2 `06`, `09`). |
| 4.4 The editor maps `localhost` URLs to the workspace's hostname | **Not done** | It is the workspace-side desolate extension (`carryover/editor/extension`), not ported. Ctrl-clicking `http://localhost:5173` in the editor's terminal opens the wrong page today; `desolate ports` and the dashboard give the right one. |
| 4.5 `devcontainer.json` is the environment | **Done** | As 4.2. |
| 4.5 Way 1: one repository's spec, `--env` | **Done** | `desolate domain <d> env --from <owner/repo>`; T2 `02-domains`. The default is the first checkout with a spec. |
| 4.5 Way 2: a composed spec, as a published tool | **Not done** | `env compose` refuses and says so. |
| 4.5 The environment frozen per workspace; features resolved to digests once | **Not done** | The spec is read from the checkout at every start (a changed spec makes a new container: T2 `08`). `carryover/devcontainer/feature-pins.ts` is v2's pinning; its security reason (a spec policy that could be told one thing and `up` another) is gone in v3, its start-up reason arrives with templates. |
| 4.6 The root runs the keyring, mirrors, clones, proxies, the admin UI, a terminal | **Done** | `desolate root shell`; the dashboard. |
| 4.6 The root clones are safe for ordinary git | **Done** | Config by desolate, bundles only and strictly checked, pinned `lfs.url`, a root-owned hooks path, `safe.bareRepository=explicit`, `core.protectHFS/NTFS`, no fsmonitor, no submodule recursion, protocols limited: T2 `01`, `04`, `10` (a person checks out a tree that plants a repository, attributes, a hook and a link, walks it and runs git everywhere: nothing runs; with the setting off for one command, it does). **Not safe, and cannot be made so:** running the tree's code there. |
| 4.6 The root has an editor, in Restricted Mode, for review | **Reversed, on purpose** | There is no editor in the root (`decisions.md`, "The root has no editor"). Review is the dashboard's diff, `desolate review --diff`, or git in the root's terminal. T2 `09-ui` checks that nothing listens where it was. |
| 4.7 The start-up breakdown line | **Done** | Every `up` prints it; the dashboard shows the phases live. |
| 4.7 C1 base image, CoW clones | **Done on Linux by copy; unrun on the Mac** | The M1 measured `limactl clone` at 0.0 s by hand. |
| 4.7 C2 pull-through registry; C3 domain templates; C4 package caches; C7 | **Not done** | Every workspace builds its environment itself. This is the largest gap against the start-up targets for projects with real toolchains. |
| 4.7 C5 mirrors; C6 the editor server | **Done** | C6 differs: the server is in the base image, not a host share. |
| 4.7 Resume a stopped workspace; the targets (15 s, 5 s) | **Not done / unmeasured** | No suspend; no measurement on the Mac. On the fake backend a start is 2 to 3 s. |
| 4.7 Where checkouts live (question 14) | **Decided: on the share** | From the M1's Phase 0 numbers (`decisions.md`). |
| 4.8 One state service in the root, which pushes | **Done** | `root/stated.ts`; T2 `09-ui`. It watches the root's own directories, each by itself (a watched tree ended it on real VMs: `release/docs/incidents.md`), and it and `rootd` are started again if they end (T2 `09-ui` ends it and waits for the dashboard to answer). A VM gets no file events for a share, so the host's daemon watches the status files and nudges it, and there is a look every second as a net. |
| 4.8 The extension renders from the service; budgets held by a browser test | **Done as a dashboard page, not as an editor extension** | See "the root UI" below. The three budgets (300 ms, 1 s, 100 ms) are asserted in T2 `09-ui`, on the fake backend; on the Mac they are unmeasured. |
| 4.8 A dashboard: cards, status colours, Needs you | **Done** | `docs/v3/dashboard.png` is a screenshot from the test. |
| 4.8 One click: open an editor, start, stop | **Done** | T2 `09-ui`. Resume: no. |
| 4.8 One click: review an offer in the native diff editor | **Done differently** | One click on an offer shows what a push would send (commits, files, warnings) and its diff, as text made by git in the root with external diff and textconv off, capped at 1 MiB, shown only if it is of the commit the Push button names. Unified, not side by side; no syntax colouring. T2 `09-ui` (a branch whose content is markup and escape sequences arrives as text). |
| 4.8 One click: push, raising the confirmation | **Done, with a difference** | Push starts in the dashboard and then waits for `desolate approve` on the host. No prompt is raised by the dashboard itself: nothing in a VM may make an approval dialog appear (`decisions.md`). |
| 4.8 One click: `upstream` | **Not done** | There is no `desolate upstream`. |
| 4.8 A first-run path that shows the commands | **Done** | Create a domain, add a repository, start a workspace run from the dashboard and show their commands. Cloning is shown as a command: adding deploy keys at GitHub is the person's. Choosing the environment is not in the path. |
| 4.8 Safety: own code, strict CSP, content as text, no tokens in labels | **Done** | T2 `09-ui`, in a real browser. |

### The root UI, said plainly

The spec decided a root **editor** with the desolate **extension** reworked. What exists is
the reworked panel as a **web page served by the root VM** (`http://desolate.localhost:31581/`)
and **no editor in the root at all**. The second pass had a root editor beside the page;
it was removed in the fourth, with the owner's agreement, for the reason in `decisions.md`:
the root is where an agent's tree and the write keys are closest, and an editor is the
largest program that could be pointed at that tree. Everything the spec asks of the panel
is in the page, the diff included. `model.mts` was not carried over: the state service
does its work (what needs you, what a push would send) in the root.

## 5. Domains

| Section | State | Evidence, or what is missing |
|---|---|---|
| 5.1 One domain clone per repository, one `.git`; secrets and rules; the board | **Done** | T2 `02-domains`, `05`, `07`. |
| 5.2 Main checkout and worktrees; one workspace per checkout; `--base`, `--fetch` | **Done** | T2 `02-domains`. |
| 5.2 `gc.auto=0`, with gc run by a sandbox VM when nobody holds a checkout | **Half** | `gc.auto=0` is set. Nothing ever runs gc. |
| 5.3 A read key for every repository; a write key for pushable ones; `--no-push` | **Done** | T2 `01-root`, `04-offers`. Against GitHub itself: unrun (the tests use a stand-in forge). |
| 5.3 P2 enforced by the keyring | **Done** | As P2. |
| 5.4 Several repositories in a domain | **Done** | T2 `02-domains`. |
| 5.5 `desolate upstream`, suede's own script pinned | **Not done** | `SUEDE_COMMIT` in `pins.env` is empty. `carryover/transfer/` holds v2's rules (the dependency named by the person, `.github/` refused). The stand-in forge already opens a pull request for a `downstream/...` branch. |

## 6. Git

| Section | State | Evidence, or what is missing |
|---|---|---|
| 6.1 Mirror, root clone, domain clone | **Done** | T2 `01`, `02`. |
| 6.2 Alternates to the mirror; the mirror never pruned | **Done** | T2 `01`, `02`. |
| 6.3 LFS works: fetch from the mirror, upload first on push | **Done** | T2 `01`, `04`. A workspace asking the root for an LFS object the mirror lacks (the `lfs` request): not done. |
| 6.4 What crosses: fetch, offer by bundle, push with `--expect` | **Done** | T2 `04-offers`. Bundles are not fsck'd beyond what a fetch checks: unmeasured. |
| 6.5 Each domain a remote of the root clone; deliveries | **Done** | T2 `04-offers`. |

## 7. Secrets and network policy

Per domain, in the root, 0600, placeholders in workspaces: **done**. `--hosts`, `--headers`,
`on | off --ttl`: **done**. `recommend`, `allow`, `enforce`: **done**. `learn --for --then`
as a timed mode: **not done**. The value is read from stdin (hidden on a terminal), never
argv: **done**. Both spellings work: `domain <d> add --secret NAME ...` and
`domain <d> secret set NAME ...`.

## 8. CLI

Every verb in the spec's list exists except: `desolate upstream`; `domain <d> env compose`;
`watch` (the dashboard is the live view); `secret`/`proxy` as top-level verbs (they are
under `domain <d>`). Added beyond the list: `approve`, `editor`, `ui`, `down`, `completion`,
`keys`, `doctor`, `net log`, `domain <d> net recommend`. `--json` on what a harness reads,
and v2's exit codes: done.

## 9. Agents and automation

9.1 Everything up to an offer can be scripted; a script's work ends at an offer: **done**
(T2 `04`). The dispatchers and the suede factory (`carryover/agents/`) are **not ported** to
v3's contract (domains and workspaces instead of projects and worktrees). 9.2's example
therefore has no runnable form yet.

## 10 to 12. Carry-over, migration, non-goals

| v2 piece | State |
|---|---|
| the proxy (`addon.py`) | ported, cut down (`secrets_addon.py`) |
| the keyring | ported, and changed (two agents, signed approvals) |
| transfer, review, `--expect`, exit codes | reimplemented; `upstream` missing |
| status and board | ported (shared reader: `shared/status.ts`) |
| hostnames, the gate, the ingress host check | ported |
| editor settings held | ported, twice (workspace and root) |
| completion hardening | ported for v3's verbs (`completion.bash`, T1) |
| feature pinning | not ported (see 4.5) |
| the panel's model | not carried over; replaced by the state service |
| preflight's false-pass discipline | kept, in `doctor` |
| `docs/incidents.md` | kept, with v3's findings added |

Also from v2 and not in the spec's list: `proxy recommend` (ported as `net recommend`),
`down` (ported), secret switches (ported), appearance passing, `export`, `worktree add` on
a running workspace, `watch`: not ported.

Migration (v3 beside v2, re-clone): nothing to build; not exercised. Non-goals: unchanged.

## 13. Bootstrapping, testing, phases

13.1 One command from nothing to a working stack, ending in doctor; idempotent: **done**
(every end-to-end test starts there). It installs none of the host's own tools.
13.2 Backends and tiers: `fake`, `qemu` done; `vz` unrun; T4 not written beyond the wiring.
13.3 Ergonomics: transcripts for every tier, reviewed as diffs: done. A fresh-eyes run and
budgets as tests: the dashboard's three budgets only.

| Phase | State |
|---|---|
| 0 Probes | Partly: Lima/vz measured on the M1, ICMP included; the other substrates not measured. |
| 1 Root VM | Done. |
| 2 One workspace | Done but for caches C2 to C4 and the workspace-side extension. |
| 3 Domains | Mostly: the environment is way 1 only; no templates, no package caches, no gc. |
| 4 Secrets and policy | Done but for the self-test fixture and timed learn. |
| 5 Offers and pushes | Done except `upstream`. |
| 6 Root UI and agents | The dashboard (with the diff) and the state service: done. No root editor, by decision. The dispatchers: not. |
| 7 Hardening | Ongoing. |

## 14. Open questions

5 storage on the host: yes (measured). 6 one shared `.git`: safe enough (measured). 7 the
mirror is refreshed on request only. 8 LFS: branch tips, more on request (the request is not
built). 9 resource limits: fixed per workspace (2 CPUs, 4 GiB); no flags, no domain default.
11 the environment: one repository's spec; compose not built. 12 raw TCP: first come, others
reserve. 13 C7: not built. 14 checkouts on the share. 15 the substrate: Lima/vz,
provisionally. Each has its evidence in `decisions.md`.

## What is most worth doing next, in order

1. **Run it on the Mac.** `HANDOFF.md` section 4. The `vz` backend is the largest piece
   of unrun code. (The Touch ID approver is opt-in now and not on the path.)
2. **Templates and caches (C2 to C4)**: without them a workspace with a real toolchain
   rebuilds it every time.
3. **`desolate upstream`** (5.5).
4. **The workspace-side extension** (URL mapping).
5. **A quota on a domain's outbox**, and keeping the image's git current: the two things
   left open by the audit of what the root takes from a domain.
6. **Compose specs**: forward their services' ports; test them.
7. **The dispatchers**, on v3's contract.
