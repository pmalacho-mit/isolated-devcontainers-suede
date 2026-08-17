# Spec v2: one dind per privileged project — sibling containers, not nested

**Supersedes** `SPEC-per-project-dind.md`. The security argument is unchanged.
The topology is different, and the difference is what makes the costs
acceptable. Read [the assessment](#assessment-is-this-worth-it) first if you want
the verdict before the design.

---

## What v1 got wrong

v1 kept the devcontainer privileged and running its own `dockerd`, and moved it
into a dedicated dind. That means **two daemons per project**:

```
desolate-dind-<ns> (sysbox)         dockerd + containerd     ~200 MB
└── devcontainer (--privileged)     dockerd + containerd     ~200 MB
      └── the agent's containers
```

Against today's *one* shared dind amortised across every project, that is the
memory blowup you are right to be wary of — and it buys nothing, because the
inner daemon is doing the same job as the outer one, one level down.

## v2: give the devcontainer a socket, not a daemon

Drop the `docker-in-docker` feature. Use `docker-outside-of-docker` (CLI only,
no daemon) and bind the project dind's own socket into the devcontainer.
Containers the agent builds and runs become **siblings** of the devcontainer
inside that dind, rather than nested inside it.

```
VM daemon
├── desolate-supervisor              creates/destroys project dinds only
├── desolate-portal                  holds the published port range
├── desolate-registry                pull-through cache (read-only)
├── desolate-dind (sysbox)           unprivileged projects, unchanged
└── desolate-dind-<ns> (sysbox)      ONE daemon
      ├── devcontainer               UNPRIVILEGED, mounts .../docker.sock
      ├── agent's containers         siblings
      └── desolate-relay-*
```

This is strictly better than v1 on every axis that matters:

| | today | v1 | v2 |
| --- | --- | --- | --- |
| daemons per privileged project | 1 nested (+ shared) | 2 | **1** |
| image stores per project | 2 | 2 | **1** |
| devcontainer privileged? | yes | yes | **no** |
| nested mount namespaces | yes | yes | **none** |
| blast radius of a wedge | all projects | one | one |

Two consequences worth stating separately, because they are the point:

**`--privileged` disappears.** The devcontainer is an ordinary container. It has
root over its own dind — via the socket — but that dind is a sysbox container, so
the boundary is the one already protecting the whole stack. `allowPrivileged`
stops being a grant of host-adjacent privilege and becomes a provisioning flag.

**The nested-mount failure class disappears with it.** No `dockerd` inside the
devcontainer means no overlay mounts inside its mount namespace, which is
precisely the thing that could not be torn down in your `shadowBaseImages`
comment. v2 does not contain that bug; it removes the structure that produces it.

### The socket mount

The project dind publishes its socket into a per-project volume:

```
dockerd --host=unix:///run/dind-sock/docker.sock --group=1000
```

`dind-sock-<ns>` is a volume on the **VM** daemon, mounted into the dind at
`/run/dind-sock`. It cannot also be mounted into the devcontainer, and an
earlier draft of this section said it could. The devcontainer is created by the
*dind's* daemon, which has its own volume namespace and has never heard of that
name — so naming it one level in produces a **new, empty volume**, silently. The
container starts and the socket is simply not there.
(`tests/probes/sibling-docker.sh`, Q1.)

The devcontainer's half is therefore a **bind** of `/run/dind-sock` out of the
dind's own filesystem — the same shape `/workspaces/<project>` already uses, and
for the same reason. Two placements work; prefer the narrower:

| in the devcontainer | works | cost |
| --- | --- | --- |
| bind the socket **file** at `/var/run/docker.sock` | yes | nothing else is touched — and it is where `docker-outside-of-docker` looks |
| bind the **directory** over `/var/run` | yes | `/var/run` is a symlink to `/run`, so the mount lands on `/run` and hides whatever the image keeps there |

This changes which `policy.ts` rule needs the exception, and it is the harder
one. The refusal to reach is not a volume-name check but
`mountsStayInOwnNamespace`'s categorical `mount type '<t>' is not allowed
(volumes only — a bind mount reaches the inner daemon's filesystem, where every
other project lives)`. The exception must therefore be a predicate over the
*whole* mount — type `bind`, source exactly `/run/dind-sock` (or
`/run/dind-sock/docker.sock`), target fixed, and only for a target the
supervisor has actually provisioned a dedicated dind for. Equality, never a
prefix, exactly as `workspaceMountIsOwnFolder` already does it. Every other bind
stays refused.

Bind-mount paths resolve correctly because the devcontainer is created *by* that
same dind — `/workspaces/<project>` means the same thing on both sides, exactly
as it does today. Measured, not assumed: a sibling started by the devcontainer
with `-v /workspaces/<project>:/x` reads what the devcontainer just wrote there
(same probe, Q4), and `docker compose` — which computes an absolute path from
the *client's* working directory — resolves its relative binds the same way
(Q5).

### Where the workspace is mounted stops being cosmetic

`desolate.ts`'s `mustMirrorItsOwnPath` forces the workspace to be mounted at the
path it has outside — but only for a worktree, or for a nested project that
declared **neither** `workspaceFolder` nor `workspaceMount`. A nested project
that declares either one is taken at its word and gets no rewrite.

That deference was harmless while the daemon lived inside the devcontainer,
because `$(pwd)` meant the same thing on both sides by construction. It is not
harmless now. A project at `/workspaces/acme/widgets` that declares
`"workspaceFolder": "/workspaces/widgets"` — which is what
`${localWorkspaceFolderBasename}` expands to, so it is the natural thing to
write — gets a devcontainer whose source is at `/workspaces/widgets` while its
dind holds the project at `/workspaces/acme/widgets`. Then `docker run -v
$(pwd):/app` hands the daemon a path it does not have, and docker **creates it
as an empty directory** rather than failing. The build runs. It just builds
nothing.

So for any target with a daemon of its own, mirroring stops being conditional:
the daemon's filesystem decides where the source is, and the project does not
get a say. Either make `mustMirrorItsOwnPath` unconditional for those targets,
or refuse a declared `workspaceFolder`/`workspaceMount` that does not already
equal the target's own path — `workspaceMountIsOwnFolder` already knows how to
ask that question, and already answers it by equality rather than by prefix.

### One daemon per project, shared by its worktrees

Every other docker object a worktree touches is keyed on its own namespace —
its containers, volumes, relays and state files all read
`acme__widgets--wt--feature123`. The daemon is the exception, and it is keyed on
the **project**: `desolate-dind-acme__widgets` serves `acme/widgets` and every
`acme/widgets@*` alongside it.

Keying it the consistent way would be wrong in a way that looks right. A
worktree's `.git` is a *file* naming its project's, whose `commondir` names
another path again, so a daemon that could see only the worktree's directory
could not run git in it at all. And bind sources resolve on the daemon that
starts the container — so the daemon has to see the whole project regardless of
which of its trees is being opened.

What this shares between worktrees of one repo is an image store and a view of
each other's containers. That is the same trust domain (one repo, one
developer's branches), and it is still strictly better than today, where every
project shares one dind. What it saves is a daemon per open branch, which for
this tree's working style is the difference between a bounded system and an
unbounded one.

### The devcontainer must join its own compose networks

Under `docker-in-docker` a composed service was a *child* on the devcontainer's
own bridge, so `wget http://web:8000` worked. As a sibling it sits on the
compose bridge, and docker isolates bridges from each other — so by default the
devcontainer cannot reach what it just started. Restoring it takes one call the
devcontainer can make itself through the socket:

```
docker network connect <project>_default <devcontainer>
```

Something has to actually make it. This is the one place v2 is a behaviour
*change* rather than a relocation, and given how many projects here run compose,
it is day-one work rather than a follow-up. (Same probe, Q5b.)

---

## Performance and memory

### The lever that matters most: idle dinds should not be running

Reap on idle, and **stop rather than destroy**. A stopped dind costs zero RAM and
keeps its data volume, so the next start is a warm dockerd boot (~1–3 s) with
every image already unpacked. Destroying it throws away the image store and makes
the next start a cold pull.

- `supervisor.ensure(ns)` starts a stopped dind if one exists.
- An idle timer stops a dind whose devcontainer has been down for
  `DESOLATE_DIND_IDLE` (suggest 30 min).
- `--purge` is the only thing that destroys the data volume.

With this, steady-state memory is a function of *active* projects, not
configured ones. Two agents working means two dinds, whatever the repo count.

### Bounded concurrency

`DESOLATE_MAX_DINDS` (**8**, measured rather than suggested — see below),
LRU-stop the oldest idle one when a new `ensure` would exceed it. This is the
difference between a bounded system and one where a busy week silently consumes
the VM. A daemon whose devcontainer is UP is never the one evicted:
`capacity.admit` refuses and names what is in the way, because stopping it would
kill a running build to start another.

### Measured on the VM, 2026-08-17

`tests/probes/v2-baseline.sh`:

| | measured | the spec had guessed |
| --- | --- | --- |
| `volume-subpath` | works, engine 29.2.1 | needs ≥ 26 — confirmed available |
| one dind | **~490 MiB** with 15 images | 150–250 MB |
| the editor | 657 MiB | not costed |
| concurrent projects | 5–8 | unknown; `MAX_DINDS` guessed at 4 |

The daemon figure is `docker stats`, which counts active page cache, so it is an
upper bound rather than an RSS — but it is the number to budget with, and it is
roughly double what this document assumed. It does not change the conclusion:
against a 200 GB machine (40 GB being the low band for other users), eight dinds
is ~4 GB, which is 2% of the former and 10% of the latter. **Memory was never
the constraint.** The 8-core CPU count is tighter, which is what the per-dind
`--cpus` ceiling is for.

### Per-dind ceilings

Ship these *with* the split, not after — with N daemons, an unbounded one is an
availability bug rather than a footgun:

```
--memory <DESOLATE_DIND_MEM>   --pids-limit <...>   --cpus <...>
```

And a BuildKit GC policy per dind (`/etc/buildkit/buildkitd.toml`, `keepBytes`),
or build caches grow without limit in N places instead of one.

### Measured expectations

`dockerd` + `containerd` idle is roughly 150–250 MB RSS combined; BuildKit adds
more while building. So v2's per-project cost is **approximately what a DinD
project costs you today** — you are relocating the nested daemon, not adding one.
The genuinely new resident costs are the supervisor, the portal, and the registry
cache: three small containers, once, not per project.

Confirm the RSS figure on your own VM before trusting it; it varies with image
count.

---

## The shared image cache

Most of your devcontainers reuse the same base image, so this is worth doing —
but be precise about what it saves.

**A pull-through registry cache saves network and time. It does not save disk.**
Each dind still unpacks its own copy of every layer. There is no supported way to
share a read-only image store between two dockerds — no `additionalimagestores`
equivalent in Docker, with or without the containerd snapshotter. Do not design
around one.

It also does not save page cache: identical layer files at different paths are
different inodes, so N running dinds hold N copies of the same binaries in RAM.
That is a real cost and the reason idle-reaping matters more than caching does.

### Design

`desolate-registry`: a `registry:2` container on the VM in **proxy (pull-through)
mode**, attached to the dind bridge network(s).

```yaml
REGISTRY_PROXY_REMOTEURL: https://registry-1.docker.io
REGISTRY_STORAGE_DELETE_ENABLED: "true"
# no auth configured, no push route
```

Each project dind gets `--registry-mirror http://desolate-registry:5000` in its
`daemon.json`.

### The gotcha that decides whether this is useful at all

**`registry-mirrors` applies to Docker Hub only.** Your devcontainer base images
come from `mcr.microsoft.com` and `ghcr.io`, and Docker will not route those
through the mirror. As specified above, the cache would be close to decorative.

To mirror arbitrary registries you need the **containerd image store**
(`"features": {"containerd-snapshotter": true}` in each dind's `daemon.json`)
plus per-registry `hosts.toml`:

```toml
# /etc/containerd/certs.d/mcr.microsoft.com/hosts.toml
server = "https://mcr.microsoft.com"
[host."http://desolate-registry:5001"]
  capabilities = ["pull", "resolve"]
```

with one `registry:2` instance per upstream (each proxy instance has a single
`remoteurl`). Three instances — Hub, MCR, GHCR — is the realistic shape.

**Probe this before building it.** The containerd snapshotter changes the graph
driver under every dind, which is a much larger change than it sounds like, and
`dind-overlay-volume.sh` exists because storage assumptions in this stack have
bitten before. Write `tests/probes/registry-mirror.sh` and answer: does a dind
with the containerd snapshotter still start on the volume-backed data root, and
does a `mcr.microsoft.com` pull actually transit the mirror (check the registry's
own logs, not the pull's timing)?

If the answer is awkward, **skip the cache entirely.** Idle-reaping and bounded
concurrency deliver most of the resource win; the cache is a latency
optimisation.

### Poisoning: why it cannot happen, in three layers

You are right to ask, and the answer is structural rather than hopeful.

**Layer 1 — the cache has no write path.** `registry:2` in proxy mode does not
accept pushes. A container can only `GET`. Assert it with a static test that the
config carries `REGISTRY_PROXY_REMOTEURL` and no `REGISTRY_AUTH`, and with an
integration test that a `docker push` to it fails.

**Layer 2 — project builds never land there.** The tempting next step is "let
projects push built images to the shared registry so they can share them." That
is the poisonable design, and it is the one thing to rule out explicitly. The
cache mirrors *upstream* and nothing else. Put this in a comment at the top of
the service definition, because it will be proposed again.

**Layer 3 — digest pinning makes it moot.** This is the real answer. When an
image is pulled by digest (`image@sha256:...`), the client verifies the manifest
against the digest it asked for. A fully compromised mirror cannot substitute
content — the pull fails. Have `policy.ts` resolve and pin base images to digests
at freeze time, the way it already freezes the rest of the derived spec. Then
cache integrity stops being a trust question.

Digest pinning is worth doing **whether or not you build the cache**, and it is
cheap. If you take one thing from this section, take that.

Two smaller points: the registry's own egress must be bounded by the existing
nftables output chain like every other VM-side process, and pull-through caches
serve tags from cache, so set a TTL or a `latest` tag will stick.

---

## Everything else carries over from v1

The supervisor (narrow vocabulary over the VM socket, template compiled in, no
caller-supplied fields), the portal (holds the published range, socats to project
dinds, `docker network connect` on attach), per-project bridges with a hashed
15-char name, the nftables interface set with a preflight assertion, `cli.sh
down` sweeping `desolate.dind=*`, and the `blast-radius` acceptance test. See v1
for those sections; none of them change.

### Except `volume-subpath`, which is not a carry-over but the containment

The `volume-subpath` mount for `/workspaces/<project>` was listed above as a
nice-to-have. It is not. It is the whole of v2's containment claim, and the
probe made that concrete: the socket is root over its dind, so a devcontainer
holding it can bind **any** path that dind can see. Asked to read a second
project out of the same `/workspaces`, it did (Q6).

So the boundary is not the socket and never was — it is that a project dind's
`/workspaces` holds **one project**. Mount the shared `workspaces` volume into
project dinds the way `docker-compose.yml` mounts it into the current dind, and
v2 hands straight back the cross-project read it exists to remove. Verify
Docker ≥ 26 on the VM first, and treat a failure to build the subpath mount the
way `desolate` already treats a failure to build an overlay view: refuse to
start the project rather than fall back to the whole directory.

---

## Assessment: is this worth it?

**Short version: yes with v2, no with v1 — but not next, and one probe should
gate it.**

*Updated 2026-08-17: the probe has run and it passes; the alternative it was
weighed against does not run here at all. The count in step 3 came back "almost
every project", which strengthens the case rather than shrinking it. The
"not next" still stands — the reliability fixes go first.*

### What I got wrong earlier

I sold this partly as the fix for your wedge. That was over-attribution, and the
evidence since says so. The incident you actually hit was **startup
reconciliation over poisoned on-disk state** in dind's data root — cured by
deleting `desolate_dind-sysbox-data`, which per-project dinds do not prevent.
They multiply the number of data roots that can end up in that state. What they
give you is a smaller blast radius per incident, not fewer incidents.

The cheap fixes remain the high-value ones, and none of them need this spec:
relays with `restart: no`, quiesce-before-stop, `cli.sh reset-inner`, a
healthcheck that distinguishes booting from wedged. They were written up
separately as `SPEC-dind-reliability.md`, built without waiting on any of this,
and merged on 2026-08-17.

An earlier draft of this paragraph said v2 *retires* the quiesce among them,
since a devcontainer with no daemon has no nested mount namespace to tear down.
That is half right, and the wrong half matters: reaping stops whole **dinds**,
and a dind stopped mid-build has precisely the problem `shutdown.ts` was written
for, one level further out. The fix is relocated by this spec, not retired by
it — and `shutdown.ts`'s own gate (`hasDockerCli`, a sound proxy for "has its
own daemon" only while docker-in-docker is what installs a CLI) is one this spec
deliberately invalidates. See `HANDOFF.md`.

### What survives, and it is the stronger argument

The security case never depended on the wedge. Today a privileged devcontainer in
the shared dind has root over every project's images, containers, and — through
the full `/workspaces` mount — every project's source. Your own `nested-sysbox.sh`
reached this conclusion before I did. That is real, it is not hypothetical for a
tree explicitly built to run agents, and nothing cheaper fixes it.

v2 makes the trade clearly favourable in a way v1 did not:

- **Roughly memory-neutral versus today** for a DinD project. One daemon becomes
  one daemon; it moves out of the devcontainer and into a sysbox sibling.
- **Halves image storage** for those projects (one store, not two).
- **Eliminates `--privileged`** from devcontainers entirely.
- **Removes the nested-mount failure class**, which is a reliability win that v1
  did not offer and that I incorrectly credited to v1.

### The cost that actually matters

It is not RAM and it is not disk. It is that `desolate-supervisor` holds the VM
Docker socket, and the portal and per-bridge nftables set become new places
interception can be silently absent. This tree's whole discipline is that
security-critical steps fail closed and say so; you would be adding surface in
exactly the layer where that discipline is expensive to maintain. Budget the
review, not the megabytes.

### Recommendation

1. **Ship the cheap reliability fixes first** and run for a few weeks. They are
   nearly free and they address what has actually cost you time. Split out as
   `SPEC-dind-reliability.md`; it depends on nothing here.
2. ~~**Probe v2's core assumption before building anything**~~ — **done
   2026-08-17, and it passes.** `tests/probes/sibling-docker.sh` on the VM under
   sysbox: build, `compose up` and bind-mounts from `/workspaces` all work from
   an unprivileged devcontainer holding nothing but the socket. Four of its
   answers changed this document rather than confirming it; they are folded in
   above.
3. ~~**Count how many projects still need it.**~~ **Answered: almost all of
   them.** That was the question meant to make this spec unnecessary, and it did
   the opposite — see below.
4. **Then decide.** The count is in. See "What the count changed".

### What the count changed

Step 3 was written expecting a small number, and hoping for zero. The real
answer is that nearly every project here containerises its own application or
utilities, so nearly every project turns on `docker-in-docker` today. Four
consequences, and only one of them is bad:

**The security case stops being about a corner of the system.** "A privileged
devcontainer in the shared dind has root over every project's images,
containers and source" was written as the risk carried by the projects that opt
in. If nearly all of them opt in, that is not a corner — it is the steady state
of the whole tree. Almost every project already has root over almost every
other. That is the argument for doing this, and the count strengthens it rather
than weakening it.

**RAM is close to a wash, because you are already paying it.** A project on
`docker-in-docker` runs its own `dockerd` *today*, inside its privileged
devcontainer, and gets its own image store (`dind-var-lib-docker-<id>` — the
volume `policy.ts` already allowlists). v2 does not add a daemon to those
projects; it moves the one they have out into a sysbox sibling and deletes the
second. Per active project: one daemon becomes one daemon, two image stores
become one.

**The shared dind becomes the exception rather than the rule.** It ends up
serving only the projects that need no docker at all. Keep it — a project that
needs no daemon should not pay for one — but stop treating "dedicated dind" as
the unusual path. In particular, `allowPrivileged` is the wrong switch to hang
provisioning off: set on almost everything, it signals nothing. Provision a dind
when the project's spec asks for docker, and let `allowPrivileged` finish
disappearing rather than get repurposed.

**Idle reaping and `DESOLATE_MAX_DINDS` stop being optimisations.** With a
handful of projects the difference between reaping and not is a preference.
With most of the tree eligible, an unreaped dind per project is the thing that
consumes the VM on a busy week. Ship them *with* the split, alongside the
per-dind ceilings — not after.

The concurrency number is still the one to watch, and it is smaller than the
project count: it is how many projects are *running at once*, which for one
developer and their agents is realistically two or three. Measure it before
setting `DESOLATE_MAX_DINDS` to 4 on faith.

### The alternative worth pricing alongside it

**Rootless dockerd inside an unprivileged devcontainer**, keeping the single
shared dind. Same "no `--privileged`" outcome, zero new stack components, no
supervisor, no portal, no nftables changes — and it does not contain the blast
radius at all, since everything still shares one daemon.

**Probed 2026-08-17, and it is dead.** `tests/probes/rootless-dockerd.sh` on the
VM under sysbox: an unprivileged process inside the devcontainer cannot create a
user namespace at all, so nothing rootless can start and the remaining questions
were never reached. The blocker is the one predicted —
`kernel.apparmor_restrict_unprivileged_userns=1`, Ubuntu 24.04's default.

Worth recording precisely, because it will be re-opened: this is a *policy*
refusal, not an exhausted budget. `user.max_user_namespaces` is 159944 on the VM
and 2147483647 inside the devcontainer. The unblock is `--security-opt
apparmor=unconfined` on every such devcontainer, which `policy.ts` refuses by
name and should, or clearing the sysctl VM-wide. Neither is worth buying for an
option that leaves every project sharing one daemon regardless.

So the comparison resolves the way this section guessed it might: prefer the
sibling-socket approach. It gets the same privilege reduction *and* the
blast-radius containment, and it is the only one of the two that runs here.
