# Handoff: per-project dind (v2)

Everything needed to resume this work with no prior context. The **design** is
`SPEC-per-project-dind-v2.md`; this file is the **state of the build** — what is
done, what is next, and the traps that are not visible from the code.

Written 2026-08-17, immediately before a `cli.sh down`.

---

## 1. What this work is, in three sentences

Today a project that needs docker turns on the `docker-in-docker` feature, which
makes its devcontainer `--privileged` inside the one shared dind — root over
every other project's images, containers and, through the shared `/workspaces`
mount, every other project's source. Almost every project here needs docker, so
that is the steady state of the whole tree rather than a corner of it. v2 gives
each such project its own dind (a sysbox container on the VM daemon) and hands
the devcontainer that dind's **socket** instead of a daemon of its own, so the
agent's containers become siblings rather than children and `--privileged`
disappears.

Both of the questions the spec gated itself on have been answered by probe, on
the real VM. The sibling design **works**; the cheaper rootless alternative is
**dead**. See §7.

---

## 2. Current state

- **Branch:** `dind-per-project`, a git worktree at `.worktrees/dind-per-project`.
- **`main` is merged in** (2026-08-17, no conflicts). It carried the four cheap
  reliability fixes — see §6, which describes two ways that work and this one
  disagree that git could not see.
- **Everything is committed.** The tree was clean at handoff.
- **Nothing built so far is wired into anything.** The new modules are pure
  TypeScript that no entrypoint imports; no compose service, no new container,
  no behaviour change to a running stack. That is deliberate: the parts that
  *would* change behaviour are unsafe until the supervisor exists (§8).

### Verify you are where this file says you are

```bash
cd .worktrees/dind-per-project
npm install            # REQUIRED -- see the trap below
./tests/run.sh         # expect: ALL SUITES PASSED, 239 unit tests
```

**The type check silently skips without `npm install`.** `tests/static/09-typecheck.sh`
uses the `typescript` pinned in `package.json` and never downloads one, so on a
fresh checkout it reports `skip` and the suite still says PASSED. Node runs these
files by *stripping* types, so a type error is neither a syntax error nor a
runtime one — nothing else in the suite would catch it. Run
`bash tests/static/09-typecheck.sh` on its own and confirm it says `ok`, not
`skip`.

---

## 3. Where things run, and what that costs you

This is the thing a new session most often gets wrong.

| | where it runs | notes |
| --- | --- | --- |
| this repo's devcontainer | inside the stack, in the shared dind | so `cli.sh down` **ends the session doing the work** |
| `./tests/run.sh` | anywhere | static + unit; no daemon needed |
| the probes, properly | on the **Mac**; they re-exec into the Colima VM | needs `colima`, and sysbox for the sysbox-dependent ones |
| the probes, in a pinch | inside this devcontainer with `--runc` | see below |

`sibling-docker.sh` and `rootless-dockerd.sh` take a `--runc` flag that runs the
throwaway dind `--privileged` on whatever daemon is reachable instead of
unprivileged under sysbox, and stamps the whole run APPROXIMATION. **That mode
gave answers identical to the real sysbox run on every question in both probes**,
so it is a legitimate way to iterate on a probe without the Mac. Do not report a
`--runc` result as the answer; do use it to develop one.

`nft` is available inside this devcontainer with passwordless `sudo`, which is
how the nftables wildcard question in §7 was settled without the VM.

---

## 4. What is built

| file | what it holds |
| --- | --- |
| `release/vscode-image/dind.ts` | the identity of a project's own daemon — name, label, volumes, bridge, socket paths — and `isRequiredBy`, the provisioning rule |
| `release/vscode-image/capacity.ts` | `reapable`, `admit`, and `DEFAULT_MAX_DINDS` (8): how many daemons may run, and which gives way |
| `release/vscode-image/projects.ts` | `projectNamespace`, for what a worktree shares with its project rather than owns |
| `release/vscode-image/utils.ts` | `sha16`, moved here from `desolate.ts` so the bridge name and the spec fingerprint hash the same way |
| `release/proxy/vm/nftables-desolate.conf` + `install.sh` | the `br-d-*` interface glob — see §7, this one was a security hole |
| `tests/unit/desolate/dind.test.ts` | which specs need a daemon; which bind sources name a socket |
| `tests/unit/desolate/capacity.test.ts` | the ceiling and the eviction rules |
| `tests/unit/desolate/naming.test.ts` | dind names pinned as literals, including that a worktree shares its project's |
| `tests/unit/broker/policy.test.ts` | the marker test for step 4 — see §8 |
| `tests/static/03-nftables.sh` | that the glob is present, keeps its hyphen, and cannot drift from `install.sh` |
| `samples/sample-siblings/` | the v2-shaped test project, refused today on purpose (§9) |

`samples/` is a fixture directory and is **not shipped**. `release/` is the
shipped tree; everything else is dev and test harness. That split is prescribed
by the suede workflow — see the repo README before adding files.

---

## 5. Decisions already made, and why

Do not silently reverse any of these. Each has a reason that is not obvious from
the code alone.

- **One daemon per project, shared by its worktrees.** A worktree's `.git` is a
  *file* pointing into its project's, whose `commondir` points elsewhere again,
  so a daemon that saw only the worktree could not run git at all. Everything in
  `dind.ts` keys on `projectNamespace`, not on `target.namespace`. This was the
  user's explicit call.
- **The socket reaches the devcontainer as a BIND, not a volume.** Measured: a
  volume name does not cross a daemon boundary — naming `dind-sock-<ns>` on the
  dind's own daemon yields a **new empty volume**, silently, and the container
  starts without a socket. The spec originally said otherwise.
- **The provisioning rule and the socket permission are ONE function**
  (`dind.isRequiredBy`). Two spellings of it would drift into a devcontainer
  holding a socket nobody provisioned — which is the shared daemon, and every
  project on it.
- **A busy daemon is never evicted.** `capacity.admit` refuses and names what is
  in the way rather than killing a running build to start another.
- **`DESOLATE_MAX_DINDS` is 8**, from the user's stated 5–8 concurrent projects.
  Memory is not the constraint (§7); the 8-core CPU count is.
- **The rootless alternative is dead.** Do not re-open it without reading the
  header of `tests/probes/rootless-dockerd.sh`.

---

## 6. Traps from the `main` merge

Both are **correct today** and become wrong at step 3. Git merged cleanly; these
are semantic, not textual.

**`quiesce` will stop far more than it means to.** `shutdown.ts` gates on
`docker.container.hasDockerCli`, a sound proxy for "has a daemon of its own"
precisely because `docker-in-docker` is what installs a CLI. v2 breaks that
equivalence on purpose: a `docker-outside-of-docker` devcontainer has the CLI and
**no** daemon. Its `docker ps -q` is then the *project dind's* container list, so
`QUIESCE.containers` would stop the devcontainer's siblings, any other worktree's
devcontainer on that same daemon, the relays, and the container running the
command. (`QUIESCE.daemon` is harmless there — `pkill dockerd` finds nothing and
exits cleanly.) The predicate must become "runs its own dockerd", which is
`docker-in-docker` specifically — deliberately narrower than `dind.isRequiredBy`,
which covers both features.

**Quiescing is relocated by v2, not retired.** An earlier draft of the spec
claimed v2 makes that fix unnecessary. Half right: nothing *inside* the
devcontainer needs quiescing once no daemon lives there, but `capacity.reapable`
stops whole **dinds**, and a dind stopped mid-build has exactly the problem
`shutdown.ts` was written for, one level out. Reuse it against the dind rather
than deleting it.

The reliability work itself lived in `SPEC-dind-reliability.md`, was built by a
different agent, and is merged. That file was deleted here on purpose so two
copies could not drift.

---

## 7. What the probes settled

| probe | question | answer |
| --- | --- | --- |
| `sibling-docker.sh` | can an unprivileged devcontainer with only a socket build, `compose up`, and bind-mount from `/workspaces`? | **YES**, on the VM under sysbox. Four of its answers changed the spec |
| `rootless-dockerd.sh` | can a devcontainer run rootless dockerd in the shared dind instead? | **NO**, at its first question. `kernel.apparmor_restrict_unprivileged_userns=1` |
| `v2-baseline.sh` | five numbers the spec was guessing at | see below |
| `nft-bridge-wildcard.sh` | can one rule cover every future per-project bridge? | **YES**, both bare and in a set |

Each probe's header carries its own `ANSWERED` block with the detail. Read those
before re-running anything.

### The numbers

- `volume-subpath` **works** (engine 29.2.1). The containment mechanism is
  available, and it is load-bearing — see §8 step 3.
- One dind costs **~490 MiB** with 15 images, roughly double the spec's guess.
  `docker stats` counts active page cache, so treat it as an upper bound rather
  than an RSS. The editor is bigger still at 657 MiB.
- Sizing is **not** a constraint: 8 dinds ≈ 4 GB against a ~200 GB machine
  (40 GB is the low band for other users).

### The security hole B5 found, and the fix

`install.sh` wrote the interception interface list as a **two-element literal,
once, at install time**, and *every* rule in `nftables-desolate.conf` matches
`iifname $DESOLATE_IFS` — the prerouting redirect, the four lateral-containment
drops, and the forward chain's closing `counter drop`. A per-project bridge
created later matched **none** of them, so such a dind would have had no proxy
interception, a route to the editor bridge where the deploy keys live, and
unfiltered egress. All three at once, silently, on the one interface whose whole
job is to carry a project's traffic.

The supervisor cannot fix this at runtime — it is a container and `nft` is on the
VM — so the rule is written once, in advance, matching bridges that do not exist
yet: `br-d-*`, the shape `dind.bridge()` produces.

**The hyphen is the entire safety margin.** nftables merges set elements a
wildcard subsumes:

```
{ "br-desolate", "br-desolate-in", "br-d*"  }  ->  stored as { "br-d*" }
{ "br-desolate", "br-desolate-in", "br-d-*" }  ->  all three survive
```

One character shorter and both named bridges vanish into the wildcard, dragging
every unrelated `br-d…` interface on the VM under desolate's default-deny.
`tests/static/03-nftables.sh` asserts the glob, the hyphen, and that
`install.sh`'s rewrite carries the same one — a wildcard living only in the conf
is one the installed ruleset never sees, because that sed replaces the line.

**Still owed:** a preflight assertion that every `br-*` interface on the VM is
matched by some rule in the `inet desolate` table, refusing if one is not. The
glob makes coverage correct by construction; the assertion is what makes a future
gap loud instead of silent, which is this stack's whole discipline.

**Worth running once on the VM:** `tests/probes/nft-bridge-wildcard.sh`. W1/W2
were settled on this devcontainer's nftables v1.0.9, not the VM's; W3 also
demonstrates the bypass off the live ruleset's own counters. It adds `counter`
rules only, in a table of its own, and drops nothing.

---

## 8. What is next, in order

The order is not a preference — each step is unsafe before the one above it.

### Step 2 — the supervisor

A new entrypoint in the same image, like `broker.ts` and `keyring.ts`.

- Holds the **VM** docker socket. This is the one place it is ever mounted, and
  the spec calls it the cost that actually matters — budget the review, not the
  megabytes.
- Fixed vocabulary over a unix socket shared with the orchestrator only, never
  the editor: `ensure`, `stop`, `purge`, `status`. Model it on `broker.ts`'s
  `Request` type — a caller names a target, never a docker flag.
- The create argv belongs in `docker.ts` under a `dind` key beside `relay`,
  built from `dind.ts` names plus the ceilings (`--memory`, `--pids-limit`,
  `--cpus`) and **no restart policy** (a restart policy is what turns a VM reboot
  into the reconciliation storm this stack has already been bitten by — the same
  reasoning the relay fix in `main` records).
- `capacity.admit` gates `ensure`; `capacity.reapable` drives the idle timer.
- Quiesce a dind before stopping it — see §6.

**This step flips a documented invariant.** `tests/static/02-compose-invariants.sh`
asserts that no service mounts `/var/run/docker.sock`. Rewrite it as *only the
supervisor mounts it* — keep the assertion, give it one named exception.
Deleting it removes the thing that notices when a **second** service gains the
socket.

**This is also the step that requires a stack restart**, because the stack gains
a container.

### Step 3 — `desolate.ts` starts projects on their own daemon

Its `dockerRunner` is hardwired to the inner socket. A target that
`dind.isRequiredBy` must be started against its own daemon instead, and **refuse
to start at all** if that daemon is not up. This is the fail-closed step that
makes step 4 safe.

Also here:

- **The `/workspaces` mount must be a `volume-subpath` of that project alone.**
  This is not a nicety: the socket is root over its dind, so a devcontainer
  holding it can bind *any* path that daemon can see. `sibling-docker.sh` Q6
  measured a devcontainer reading a second project out of a shared `/workspaces`.
  Containment comes from one project per dind, not from the socket. Treat a
  failure to build the subpath mount the way `desolate` already treats a failed
  overlay view: refuse to start.
- **`docker network connect` for compose networks.** Sibling services sit on the
  compose bridge, which docker isolates from the devcontainer's, so
  `wget http://web:8000` stops working unless something joins them. Measured as
  Q5b. This will hit nearly every project here.
- **The relay retarget.** Under v2 the app publishes on the *dind*, not on the
  devcontainer, so what a relay dials changes.
- **`mustMirrorItsOwnPath` must stop being conditional** for a target with its
  own daemon. It currently defers to a nested project that declared
  `workspaceFolder` or `workspaceMount`. A mismatch now makes `docker run -v
  $(pwd)` hand the daemon a path it does not have, and docker **creates it as an
  empty directory rather than failing** — the build runs and builds nothing.

### Step 4 — the policy exception

**Not before step 3.** `policy.ts` should take the target's actual daemon as a
*required* parameter and grant nothing when it is the shared one. Then
`mountsStayInOwnNamespace` gains a predicate over the whole mount — type `bind`,
source `dind.socket.isNamedBy(...)`, fixed target — by equality, never a prefix,
the way `workspaceMountIsOwnFolder` already does it.

Granting this before provisioning exists would let a `docker-outside-of-docker`
project bind the **shared** daemon's socket, handing it every other project.
That is why `policy.ts` is deliberately untouched so far.

`tests/unit/broker/policy.test.ts` carries the marker: *"sample-siblings is
refused until a project daemon exists"*. **When that test inverts, step 4 is
done.**

### Step 5 — the portal, then stop and re-read

The published port range moves off dind. Then re-read the spec's assessment
before going further: the registry cache is explicitly gated on its own probe and
is only a latency optimisation, while **digest pinning is cheap and worth doing
regardless of whether the cache is ever built**.

---

## 9. The test project

`samples/sample-siblings/` is the same application shape as `sample-fastapi`
built the v2 way: `docker-outside-of-docker`, a real build, a compose service
with a bind mount and a published port, and **no `allowPrivileged` anywhere**.

It deliberately declares no `workspaceFolder`/`workspaceMount`, so it stays
portable — the CLI's default handles a top-level project and desolate's mirror
handles a nested one or a worktree.

```bash
cp -r samples/sample-siblings /path/to/workspaces/
# then, from the editor:   desolate sample-siblings
```

**Today it is refused, and that is the expected baseline** — the feature declares
a bind of the docker socket and policy refuses binds categorically. Capture the
message; it is the "before".

Once it starts, from its terminal:

```bash
bash diagnose.sh
```

It reports privilege, which daemon it reached, what that daemon can see of
`/workspaces` (the containment question), whether build / bind-paths / compose
work, whether the service is reachable by name, where the port landed, and
whether the container accrued overlay mounts. It leaves the compose stack up so
ports can be checked afterwards.

A correct v2 run looks like:

| line | expected |
| --- | --- |
| privilege | `unprivileged (CapEff 0)` |
| daemon's workspaces | `only sample-siblings` |
| build / bind path identity / compose up | `YES` |
| service reachable | by name — if it needs a manual join, step 3's network-connect is missing |
| overlay mounts here | unchanged, e.g. `1 -> 1` |

---

## 10. House rules

The user holds these firmly, and reviews against them:

- **Readable code over comments.** Long functions get split into well-named
  small ones; wherever a comment wants to introduce a block, put a *name*
  instead. Group related functions on one namespace object rather than prefixing
  names. Two spellings of the same rule must call the same function.
- **Fail closed, and say so.** A step that reports success while having done
  nothing is the failure mode this stack is most prone to, and several real bugs
  have had exactly that shape. The skipping type check in §2 is a live example.
- **Measure, do not read.** Every design claim in this work that turned out to be
  wrong — the socket volume, the nftables wildcard, the compose network, the
  `/workspaces` reach — was wrong in a way that only running it revealed. Write a
  probe.

Read next, in this order: `SPEC-per-project-dind-v2.md` (the design, with probe
results folded in), the header of `tests/probes/sibling-docker.sh` (what was
measured and what it changed), then `release/vscode-image/dind.ts` (the
vocabulary everything else names things through).
