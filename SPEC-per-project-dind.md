# Spec: one dind per privileged project

**Status:** proposal. Nothing below is implemented.

**Motivation.** Two independent problems have the same answer.

1. *Security.* `tests/probes/nested-sysbox.sh` asked whether sysbox nests, so that
   every devcontainer could be user-namespaced relative to dind. The answer was
   no on this kernel. Its failure branch already names the alternative:

   > you do NOT need sysbox to NEST. Give each privileged/untrusted project its
   > OWN dind (a sysbox container on the VM daemon). Siblings then sit in
   > separate dinds, isolated by the level-1 sysbox boundary that every run above
   > confirmed WORKS -- no nesting required.

2. *Reliability.* One devcontainer whose mount namespace cannot be torn down
   wedges the shared inner daemon for every project (see
   `DAEMON-WEDGE-RUNBOOK.md`). Blast radius today is the whole stack.

Both reduce to: the inner daemon is a shared fate boundary, and privileged
projects are what make sharing it unsafe.

---

## Goals

- A privileged project's devcontainer runs on a daemon **only that project uses**.
- A wedged daemon costs one project, and is recovered by destroying one container
  rather than `./cli.sh down && ./cli.sh up`.
- The orchestrator still holds no VM Docker socket, and the editor still reaches
  nothing but the broker.
- Ports, overlays, egress interception, and the `desolate` CLI surface are
  unchanged from the user's point of view.

## Non-goals

- Removing `allowPrivileged`. Privilege inside a project's own dind is still
  privilege; what changes is what it is privilege *over*. The flag's meaning is
  restated, not deleted (see [policy](#policyts)).
- Per-project dinds for *unprivileged* projects. Possible later; out of scope for
  phase 1 (see [phasing](#phasing)).
- Fixing the teardown bug itself. This bounds the blast radius; it does not
  remove the class. Fix #1 from the runbook (quiesce level 3 before stopping
  level 2) is still worth doing and is **complementary, not superseded** — see
  [risks](#risks-and-honest-limits).

---

## Architecture

### Today

```
VM daemon
└── desolate-dind (sysbox)         ── ONE daemon, shared fate
      ├── project A devcontainer   (privileged)
      ├── project B devcontainer
      └── desolate-relay-*         socat, publishes into dind's netns
    dind publishes 127.0.0.1:8080-8119 to the Mac
```

### Proposed

```
VM daemon
├── desolate-supervisor            NEW: creates/destroys project dinds only
├── desolate-portal                NEW: holds the published range, socats onward
├── desolate-dind (sysbox)         unchanged; unprivileged projects stay here
│     └── project B devcontainer
└── desolate-dind-<ns> (sysbox)    NEW: one per privileged project
      ├── project A devcontainer   (privileged, but only over its own dind)
      └── desolate-relay-*         publishes into THIS dind's netns
```

`desolate-dind-<ns>` uses the same `<ns>` encoding as everything else
(`volumeNamespace` in `projects.ts`: `owner/repo` → `owner__repo`,
`owner/repo@wip` → `owner__repo--wt--wip`).

---

## The hard part: who creates the project dinds

The orchestrator drives the *inner* daemon and deliberately cannot reach the VM
daemon — `docker-compose.yml` states it as the first invariant: *the HOST docker
socket is never mounted anywhere.* Creating a sibling sysbox container on the VM
daemon is, by construction, a thing the orchestrator must not be able to do
freely.

**Rejected:** mounting the VM socket into the orchestrator. That is VM root, and
it hands a compromised orchestrator the ability to start a privileged container
outside sysbox. It would trade the entire stack's outermost boundary for an
inner one.

**Proposed: `desolate-supervisor`.** A second narrow-vocabulary service, built
the same way `broker.ts` is built, standing in the same relation to the VM daemon
that the broker stands in to the inner one.

- Runs on the VM daemon with `/var/run/docker.sock` mounted (the *only* container
  that has it).
- Listens on a unix socket in a new `supervisor-run` volume, mounted into the
  orchestrator and **nowhere else** — in particular not into `vscode`.
- Vocabulary, complete and closed:

  | op | argument | effect |
  | --- | --- | --- |
  | `ensure` | `namespace` | project dind exists and is healthy; returns its bridge IP |
  | `destroy` | `namespace` | `docker rm -f` it, with escalation (below) |
  | `list` | — | namespaces with a live dind |
  | `attach` | `namespace`, `port` | connect the portal to that dind's network, forward `port` |
  | `detach` | `namespace`, `port` | tear that forward down |

- **The caller supplies a namespace and nothing else.** Image, runtime, mounts,
  ulimits, network, and labels come from a template compiled into the supervisor.
  There is no field through which the orchestrator can express image, flags,
  mounts, or privilege. This is the security argument, and it is the same one
  `broker.ts` makes: a fixed vocabulary over a validated identifier.
- The namespace is re-validated against `projects.ts`'s `volumeNamespace.supports`
  **inside the supervisor**, not trusted from the wire.
- Fail closed: an `ensure` that cannot verify the dind answers `docker info`
  within a timeout destroys what it made and errors, rather than returning a
  half-built dind that `desolate` will then try to use.

### Project dind template

```
docker run -d
  --name         desolate-dind-<ns>
  --runtime      sysbox-runc
  --label        desolate.dind=<ns>
  --network      desolate-dindnet-<ns>          # per-project, see networking
  --restart      unless-stopped
  --memory       <DESOLATE_DIND_MEM>            # NEW: bounded, see limits
  --pids-limit   <DESOLATE_DIND_PIDS>
  --ulimit       nofile=524288:524288
  -e DOCKER_TLS_CERTDIR=""
  -v desolate-dind-data-<ns>:/var/lib/docker    # per-project, must not be overlayfs
  -v /var/lib/desolate-proxy/public:/desolate-ca:ro
  -v desolate_server-dist:/server-dist:ro
  --mount type=volume,source=desolate_workspaces,target=/workspaces,volume-subpath=<project path>,readonly=false
  docker:29-dind
  dockerd --host=unix:///run/inner-<ns>/docker.sock --group=1000 --icc=true
          --default-ulimit=nofile=65536:524288
```

Two things to call out:

- **`volume-subpath` is a genuine security gain.** Today every devcontainer's
  dind mounts the whole `/workspaces` volume, so a privileged project can read
  every other project's source through its own daemon. A per-project dind can be
  given only its own subtree. Requires Docker ≥ 26 on the VM daemon; verify
  before relying on it, and fall back to the full mount (no worse than today)
  if unavailable.
- **The inner socket path is namespaced** (`/run/inner-<ns>`) so the orchestrator
  can hold several at once without ambiguity. Each is its own volume,
  `inner-run-<ns>`, mounted into the orchestrator on `ensure`… which it cannot
  be, for a running container. See [open question 1](#open-questions).

---

## Component-by-component changes

### `docker.ts`

`createDocker` currently closes over one `DOCKER_HOST`. It becomes a factory
keyed by target: `dockerFor(target)` returns a `Runner` pointed at that target's
daemon — the shared dind for unprivileged projects, `desolate-dind-<ns>` for
privileged ones. Every call site already goes through this module, so the change
is mostly mechanical.

Add, regardless of this spec: a `stop` with a timeout, and a pre-stop quiesce
hook for containers where `hasDockerCli(cid)` is true.

### `desolate.ts`

- Before `devcontainerUp`, read the frozen spec: if the project is privileged,
  `supervisor.ensure(namespace)` and point `DOCKER_HOST` at the returned socket
  for the rest of the run.
- `--stop`: unchanged for the devcontainer, then `supervisor.destroy(namespace)`
  once the last target of that project is down.
- `--purge`: also destroys `desolate-dind-data-<ns>` and the per-project network.
- The `HELPER_IMAGE`, `relay.IMAGE`, and `caTrustingImage` pulls now happen
  per-dind. Each new project dind pulls `alpine:3` and `alpine/socat` on first
  start. Cheap, but it is N× and it crosses the proxy.

### `broker.ts`

No vocabulary change. `start` / `stop` / `rebuild` / `purge` already carry a
project; the supervisor call happens downstream in `desolate.ts`. `stop-all`
must additionally sweep project dinds.

### `policy.ts`

`privilegeMustBeExplicit` keeps the opt-in but its message changes, because the
claim it currently makes stops being true:

> Privileged containers can reach sibling projects' data on the inner daemon.

Under this design that is false for a privileged project — it has no siblings.
The revised check should say what privilege now buys: root over its own dind,
which is a sysbox container, so the boundary to the VM is the one that already
protects the whole stack. Keep the opt-in as a signal (it changes provisioning:
a dedicated dind, more memory, slower first start), not as a warning about
siblings.

`mountsStayInOwnNamespace` and the `dind-var-lib-docker-<id>` allowances are
unchanged — those are the *nested* feature's volumes, one level below.

### `ports.ts` / `relays.ts`

The allocator is unchanged: it allocates from one host range, and relay names
still encode the host port. What changes is the path from the Mac.

Today `dind` publishes `127.0.0.1:MIN-MAX` in compose. With N dinds that publish
cannot be repeated. Introduce **`desolate-portal`**: one container on the VM
daemon that publishes the whole range once, and internally socats each allocated
port to the owning project dind's bridge IP. `supervisor.attach(ns, port)` adds a
forward; `detach` removes it. Chain becomes:

```
Mac 127.0.0.1:8081 -> portal netns:8081 -> socat -> desolate-dind-<ns>:8081
                   -> (relay inside that dind) -> devcontainer IP:5173
```

One more hop than today, same number of moving parts as today plus the portal.
Stable URLs and the existing `PortMap` state files survive untouched.

### Networking

Each project dind gets its own bridge network, `desolate-dindnet-<ns>`, with a
pinned bridge name — the same pinning rationale as `br-desolate` /
`br-desolate-in` in compose: nftables matches `iifname`, and an unpinned name
changes on every recreate and silently turns interception off.

Bridge names cap at 15 characters (`IFNAMSIZ-1`), which `br-desolate-in` already
sits at. `br-desolate-<ns>` will not fit. **Use a short stable hash:**
`br-dsl-<8 hex of sha256(ns)>` = 15 chars exactly. The supervisor owns the
mapping and can report it; nothing else should recompute it.

The proxy's nftables ruleset must gain a rule per bridge, or better, a named set
of interfaces the install script populates and the supervisor updates. **This is
the piece most likely to fail silently** — a project dind on an unmatched bridge
egresses without interception, which is exactly the failure the README's
"Why `up` re-checks the proxy" section exists to prevent. `preflight.sh` must
assert that every live `desolate.dind=*` container's bridge is in the set, and
`cli.sh up` must repair it, on the same fail-closed footing as the existing
check.

The portal joins each project network via `docker network connect` at `attach`
time — no restart needed. Nothing else bridges the per-project networks, so
project dinds cannot reach each other.

### `observe.sh` / `cli.sh`

- `observe` needs a target: `./cli.sh observe --project <p> ps`. Default to the
  shared dind, as today.
- `cli.sh down` must sweep `desolate.dind=*` containers. **Compose does not know
  about them**, so without this they survive `down` and are orphaned — with
  `restart: unless-stopped` they come back after a VM reboot pointing at volumes
  a fresh stack may have recreated. Add the sweep and a static test for it.
- `cli.sh ps` should list project dinds alongside the compose services.

### Limits (new, and load-bearing)

The current stack sets `pids_limit` on the orchestrator, vscode, and keyring, but
**dind has no memory limit, no pids limit, and no CPU limit**, and neither do
devcontainers. With N dinds this stops being a footgun and becomes an
availability bug: one agent can starve the VM and take out every project,
defeating the entire point of the split.

Add `--memory`, `--pids-limit`, `--cpus` to the project dind template, defaulted
from `.env` (`DESOLATE_DIND_MEM`, etc.), and have `policy.ts` inject per-container
limits into the derived spec. This should ship *with* the split, not after.

---

## Phasing

**Phase 1 — privileged projects only.** The shared dind stays and keeps every
unprivileged project. Smallest diff, and it targets exactly the projects that
cause both problems. Ship this.

**Phase 2 — limits and the portal hardening.** Per-dind resource ceilings,
nftables interface set with preflight enforcement, `down` sweep.

**Phase 3 — every project gets a dind (optional).** Only worth it if the disk and
startup costs below prove acceptable, or if a pull-through cache lands. Phase 1's
structure makes this a configuration change rather than a redesign.

---

## Costs

- **Disk.** N image stores instead of one. A base image shared by five projects
  is stored five times. Mitigation: a registry pull-through cache container on
  the VM, which also cuts proxy traffic. Track `desolate-dind-data-*` volume
  sizes in `preflight.sh`.
- **First-start latency.** Booting a dockerd, plus pulling `alpine:3`,
  `alpine/socat`, and the project's base image into a cold store. Seconds to
  minutes. Warn in the CLI output the way `shadowImages` already does.
- **Memory.** Each dind is a dockerd + containerd (~150–250 MB idle before any
  workload). Five privileged projects is a real fraction of a default Colima VM.
  Document a VM sizing recommendation in the README.
- **Surface area.** One more privileged component (`desolate-supervisor`, holding
  the VM socket) and one more network component (`desolate-portal`). The
  supervisor is the single most security-sensitive file in the tree once it
  exists and should be reviewed as such.

---

## Acceptance tests

The whole design is justified by one property, so test it directly.

**`tests/integration/blast-radius/`** — the load-bearing test:

1. Start privileged project A and project B.
2. Wedge A deliberately: inside A's devcontainer, `kill -STOP` a nested
   `containerd-shim`, then attempt `desolate --stop A`.
3. Assert `desolate --stop A` fails or times out (it is allowed to).
4. **Assert project B can still start, stop, and rebuild** — this is the entire
   point, and it fails on `main` today.
5. Assert `supervisor.destroy(A)` recovers A without touching B.
6. Assert no `./cli.sh down` was required.

**Static tests**, in the style of the existing `tests/static/`:

- The supervisor's request type admits no field other than an op and a namespace
  (mirrors `05-cli-queries.sh`'s approach to the broker).
- `supervisor-run` appears in exactly two services' mount lists: supervisor and
  orchestrator. Never `vscode`. (Mirrors `07-keyring.sh`, which asserts the same
  shape for `keyring-keys`.)
- `/var/run/docker.sock` appears in exactly one service's mount list.
- `cli.sh down` contains a `desolate.dind=*` sweep.
- Every project dind bridge name is ≤ 15 characters.

**Probe update:** `nested-sysbox.sh`'s failure-branch advice becomes implemented
rather than hypothetical; add a note pointing here.

---

## Risks and honest limits

- **This bounds the blast radius; it does not fix the bug.** The untearable mount
  namespace now lives inside a project dind. Destroying that dind is a
  `docker rm -f` on the *VM* daemon — which can hit the same problem one level
  up, and a wedged VM daemon is worse than a wedged inner one. Sysbox helps
  (tearing down the userns reaps more reliably than plain runc does) but does not
  guarantee it. **Keep the quiesce-before-stop fix.** The two together are the
  design; either alone is half of it.
- **The supervisor is a new crown jewel.** It holds the VM socket. Its template
  being data rather than parameters is what makes it safe; any future "just let
  the caller pass one more field" is the whole design failing open.
- **nftables coverage is the silent failure.** A project dind whose bridge is not
  in the interception set has unproxied egress and no symptom. Preflight must
  assert it, and it must fail closed, per the convention the README already
  states.
- **`volume-subpath` availability is unverified** on the VM's Docker. Check
  before writing the code that depends on it.

---

## Open questions

1. **Socket delivery.** Volumes cannot be added to a running container, so the
   orchestrator cannot receive `inner-run-<ns>` on demand. Options: (a) mount one
   parent volume `inner-sockets:/run/inner/` and have each dind bind its socket
   at `/run/inner/<ns>.sock` within it — simplest, and probably right;
   (b) the supervisor proxies daemon traffic, which makes it a bottleneck and a
   much larger attack surface; (c) recreate the orchestrator per project, which
   is absurd. **Recommend (a)**; it needs the shared parent volume to be mounted
   into every project dind, which is a small widening worth stating explicitly.
2. **Worktree granularity.** Does `owner/repo@wip` share `owner/repo`'s dind or
   get its own? Sharing is cheaper; separating is consistent with how
   `overlay.ts` already reasons ("a worktree gets its own pair… a shared writable
   view would let one worktree overwrite the binary its siblings run"). Leaning
   separate, at real cost.
3. **Lifecycle.** Destroy a project dind on `--stop`, or keep it warm and reap on
   idle? Warm is much better UX (first start is the expensive one); idle reaping
   needs a timer somewhere, and the supervisor is the only thing positioned to
   own it.
4. **Does the shared dind survive at all in phase 3?** Something still needs to
   host cross-project infrastructure, or that infrastructure moves to the VM.
