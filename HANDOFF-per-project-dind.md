# Handoff: per-project dind (v2)

State of the work on branch `dind-per-project`, written so a fresh session can
pick it up without re-deriving anything. The design is
`SPEC-per-project-dind-v2.md`; this file is where the work *is*, not what it is.

**The cheap reliability fixes are NOT here.** They were split into
`SPEC-dind-reliability.md` and handed to a different agent, and they touch
`docker.ts`, `desolate.ts` (`stopTarget`), `cli.sh` and the dind healthcheck.
Expect conflicts in those files and let that work win — none of it depends on
anything below.

---

## Do you need to restart the stack?

**No, and not yet.** Everything built so far is pure TypeScript that nothing
imports: no compose service, no new container, no change to any running
process. A `cli.sh down && cli.sh up` would take the same stack down and bring
the same stack back.

The restart becomes necessary at **step 3** below, when the supervisor gets a
compose service. At that point it is unavoidable, because the stack gains a
container.

One practical note: the devcontainer this work happens in runs *inside* the
stack, so `cli.sh down` ends the session doing the work. That is the reason
this file exists.

---

## What is done

All of it is unit-tested and type-checked. `./tests/run.sh` is green at 233
tests; run `npm install` first or the type check **skips** and reports success
without having run.

| file | what it holds |
| --- | --- |
| `release/vscode-image/dind.ts` | the identity of a project's own daemon — name, label, volumes, bridge, socket paths — and `isRequiredBy`, the provisioning rule |
| `release/vscode-image/capacity.ts` | `reapable` and `admit`: how many daemons may run, and which gives way |
| `release/vscode-image/utils.ts` | `sha16` moved here from `desolate.ts`, so the bridge name and the spec fingerprint hash the same way |
| `release/vscode-image/projects.ts` | `projectNamespace`, for the things a worktree shares with its project rather than owns |
| `tests/unit/desolate/dind.test.ts` | the two judgements: which specs need a daemon, which bind sources name a socket |
| `tests/unit/desolate/capacity.test.ts` | the ceiling and the eviction rules |
| `tests/unit/desolate/naming.test.ts` | dind names pinned as literals, including that a worktree shares its project's |
| `samples/sample-siblings/` | the v2-shaped test project, refused today on purpose |
| `tests/probes/` | `sibling-docker.sh` (answered yes), `rootless-dockerd.sh` (answered no), `v2-baseline.sh` (the numbers) |

### Decisions already made, with their reasons

- **One daemon per project, shared by its worktrees.** A worktree's `.git` is a
  file pointing into its project's, so a daemon that saw only the worktree could
  not run git. Everything in `dind.ts` keys on `projectNamespace`.
- **The socket reaches the devcontainer as a BIND, not a volume.** Measured: a
  volume name does not cross a daemon boundary, it silently yields a new empty
  volume. See `sibling-docker.sh` Q1.
- **The provisioning rule and the socket permission are ONE function**
  (`dind.isRequiredBy`). Two spellings would drift into a devcontainer holding a
  socket nobody provisioned, which is the shared daemon and every project on it.
- **A busy daemon is never evicted.** `capacity.admit` refuses and names what is
  in the way, rather than killing a running build to start another.
- **The rootless alternative is dead** — `apparmor_restrict_unprivileged_userns`
  on the VM. Do not re-open it without reading the probe header.

---

## What is next, in order

The order is not a preference. Each step is unsafe before the one above it.

### 1. Get the numbers

```bash
./cli.sh up                        # B2 and B4 read the live stack
./tests/probes/v2-baseline.sh
```

Five facts the spec currently guesses: whether `volume-subpath` works here
(containment depends on it), what a daemon actually costs, VM headroom, how many
projects run *at once* (which sizes `DESOLATE_MAX_DINDS`, not the project
count), and whether per-project bridges would be intercepted by nftables at all.

**B5 is the one to read closely.** If the ruleset names only `br-desolate`, then
every per-project bridge egresses *without* interception — failing open, and
silently. That has to be solved with the bridges, not after them.

### 2. The supervisor

A new entrypoint in the same image, like `broker.ts` and `keyring.ts`.

- Holds the **VM** docker socket. This is the one place it is ever mounted, and
  the spec calls it the cost that actually matters.
- Fixed vocabulary over a unix socket shared with the orchestrator only, never
  the editor: `ensure`, `stop`, `purge`, `status`. Model it on `broker.ts`'s
  `Request` type — a caller names a target, never a docker flag.
- The create argv belongs in `docker.ts` under a `dind` key, beside `relay`,
  built from `dind.ts` names plus the ceilings (`--memory`, `--pids-limit`,
  `--cpus`) and `--restart no` (a restart policy is what turns a VM reboot into
  the reconciliation storm this stack has already been bitten by).
- `capacity.admit` gates `ensure`; `capacity.reapable` drives the idle timer.

**This step flips a documented invariant.** `tests/static/02-compose-invariants.sh:41`
asserts no service mounts `/var/run/docker.sock`. Rewrite it as *only the
supervisor mounts it* — keep the assertion, give it one named exception. Deleting
it would remove the thing that notices when a second service gains the socket.

### 3. `desolate.ts` starts projects on their own daemon

Its `dockerRunner` is currently hardwired to the inner socket. A target that
`dind.isRequiredBy` has to be started against its own daemon instead, and
**refuse to start at all** if that daemon is not up. This is the fail-closed
step that makes step 4 safe.

Also here:

- the `docker network connect` for compose networks (Q5b), and the relay
  retarget — under v2 the app publishes on the *dind*, not on the devcontainer,
  so what a relay dials changes. `sample-siblings` exposes both.
- **`mustMirrorItsOwnPath` has to stop being conditional** for a target with its
  own daemon. It currently defers to a nested project that declared
  `workspaceFolder` or `workspaceMount`, which was harmless when the daemon was
  inside the devcontainer and is not now: a mismatch makes `docker run -v
  $(pwd)` hand the daemon a path it does not have, and docker creates it as an
  empty directory rather than failing. The build runs and builds nothing. See
  the spec section of the same name.

### 4. The policy exception

**Not before step 3.** `policy.ts` should take the target's actual daemon as a
required parameter and grant nothing when it is the shared one. Then
`mountsStayInOwnNamespace` gains a predicate over the whole mount — type `bind`,
source `dind.socket.isNamedBy(...)`, fixed target — by equality, never a prefix,
the way `workspaceMountIsOwnFolder` already does it.

`tests/unit/broker/policy.test.ts` has the marker: *"sample-siblings is refused
until a project daemon exists"*. When that test inverts, this step is done.

### 5. The portal, then stop

The published port range moves off dind. After that, re-read the spec's
assessment before going further: the registry cache is explicitly gated on its
own probe and is a latency optimisation, and digest pinning is worth doing on
its own regardless.

---

## The test project

`samples/sample-siblings/` is the same application shape as `sample-fastapi`,
built the v2 way: `docker-outside-of-docker`, a build, a compose service with a
bind mount and a published port, and **no `allowPrivileged` anywhere**.

Copy it into `/workspaces` and start it:

```bash
cp -r samples/sample-siblings /path/to/your/workspaces/
# then, from the editor:  desolate sample-siblings
```

**Today it is refused, and that is the expected baseline.** The
`docker-outside-of-docker` feature declares a bind of the docker socket, and the
policy refuses binds categorically. Capture the message — it is the "before".

Once it starts, run this from its terminal:

```bash
bash diagnose.sh
```

It reports privilege, which daemon it reached, **what that daemon can see of
/workspaces** (the containment question), whether build / bind-paths / compose
work, whether the service is reachable by name, where the port landed, and
whether the container accrued overlay mounts. It leaves the compose stack up so
ports can be checked afterwards.

What a correct v2 run looks like:

| line | expected |
| --- | --- |
| privilege | `unprivileged (CapEff 0)` |
| daemon's workspaces | `only sample-siblings` |
| build / bind path identity / compose up | `YES` |
| service reachable | by name — if it needs a manual join, step 3's network-connect is missing |
| overlay mounts here | unchanged, e.g. `1 -> 1` |

---

## How to resume

```bash
cd .worktrees/dind-per-project
npm install          # or the type check silently skips
./tests/run.sh       # expect 233 passing
```

Then read, in this order: `SPEC-per-project-dind-v2.md` (the design, with the
probe results folded in), the header of `tests/probes/sibling-docker.sh` (what
was measured and what it changed), and `release/vscode-image/dind.ts` (the
vocabulary everything else names things through).
