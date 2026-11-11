# desolate v3: a VM per workspace

**Status:** spec, revised 2026-11-11. Decisions marked **(decided)** are settled by the owner. Ones marked **(proposed)** are the default, and an implementing agent may change them **with evidence**: measure, record what was found and why in `docs/v3/decisions.md`, and go on. [Section 14](#14-open-questions) lists which questions the owner settled and which the agent decides that way. Stop and ask only when evidence would break a principle (section 1) or a decided item.

## 0. Summary

v2 isolates each project as a devcontainer on a sysbox Docker daemon inside one Colima VM, with relays, overlay volumes, a supervisor and a broker holding it together. v3 makes the **VM** the unit of isolation: one VM per **workspace**, workspaces collected into **domains** that share repositories and secrets, and one **root VM** that holds every key and is the only place a push can start.

Why VMs:

- A VM is built to isolate; a container needed sysbox, a policy engine and many careful rules (most of `policy.ts`) to approximate it.
- A VM has its own network link, so each workspace gets its own proxy, attributed by link rather than by mapping dind addresses.
- Docker inside a workspace becomes ordinary `dockerd` in that VM: no sysbox, no shared daemon, no "own daemon" feature.

The landscape has moved toward this too: [devvm](https://devvm.dev/) (one Lima VM per project, an allowlisting proxy that inserts credentials, `.git` hook and config locking on macOS), [microsandbox](https://github.com/microsandbox/microsandbox) (libkrun microVMs from OCI images, secrets that never enter the VM), and [squirrelsoft-dev/sandbox](https://github.com/squirrelsoft-dev/sandbox) (Apple Container VMs, a worktree per agent). What desolate keeps that none of them have is section 1.

## 1. Principles (decided)

These are what desolate got right that others don't. Every design choice below serves them, and the test plan (section 13) proves each one with a negative check that has a positive control.

- **P1. The editor is inside the boundary.** Each workspace's editor runs in its workspace VM and is used from a browser tab. Nothing from a workspace runs in a desktop editor on the Mac, so the attack surface in the Red Guild post (host-side VS Code, its extensions, its workspace-trust logic) is not present.
- **P2. Every push goes through a human.** A push to any remote happens only as the direct result of a person's action in the root, naming the repository, the branch and the exact commit they reviewed (v2's `--expect`). No agent, workspace or automation can push. This is desolate's strongest idea and should be stated in the README as a principle, not just implemented.
- **P3. No credential enters a workspace.** Deploy keys live only in the root VM, behind an agent that signs but never exports. API secrets are placeholders inside workspaces, substituted by a proxy outside them.
- **P4. Every `.git` has exactly one owner, and git runs only under its owner.** The owners are the root, each domain, and the mirrors (the root's, holding only what the remote published). No owner runs git against another's `.git`: not its config, hooks, filters, `.lfsconfig` or upload-pack. Work crosses between owners only as **data**: a bundle file, LFS objects checked against their sha256 ids, or a read-only mirror whose contents came only from the remote.
- **P5. A boundary is enforced outside what it contains.** Assume an agent is root inside its VM. Its network path, its mounts and its view of other domains are decided by the host and the root, never by anything inside the VM.
- **P6. Fail closed, and say so.** A step that cannot be checked refuses rather than proceeding. Every refusal names what to do. A probe that failed to run is not a probe that found nothing.

## 2. Vocabulary

A **domain** is desolate's own term (decided, question 1): the trust boundary agents and people work inside. Where the text means a DNS name it says *hostname*, never *domain*.

| Term | Meaning |
|---|---|
| **root VM** | The one administration VM. It holds every deploy key, the mirrors, its own clone of every repository, the secrets, the proxies and the admin UI. It runs no workspace code and no IDE. |
| **domain** | A trust boundary: a set of repositories, plus a set of secrets and network rules, shared by every workspace in it. **Anything one workspace in a domain can do, every workspace in it can be assumed to do.** |
| **workspace** | A place for someone to do their work: one VM in one domain, with its editor attached. That someone may be a coding agent, a person, or both together. It sees every repository of its domain, each as a checkout (decided, question 2). |
| **mirror** | Per repository, a bare repository holding exactly what the remote has published, plus its LFS objects. Written only by the root, from the remote, with the read key. Read-only everywhere else. |
| **root clone** | Per repository, the root's own clone: where the person does "typical git things", reviews what domains offer, and pushes from. Never shared with any domain. |
| **domain clone** | Per repository per domain, that domain's own clone. Two domains with one repository have two domain clones. Its objects are borrowed from the mirror, so it holds only its own work. |
| **checkout** | A repository's working tree in a workspace: either the domain clone's **main checkout**, or a **worktree** on its own branch. |
| **pushable** | Per repository, in the root: whether the root holds a write key for it. A domain has no access level of its own: **every domain reads, and only the root writes** (section 5.3). |
| **slug** | A domain's or workspace's machine name: `[a-z0-9][a-z0-9-]{0,39}`. Free text goes in a separate title. Slugs become VM names, hostnames and paths, so they must have one spelling (a v2 lesson: `owner/repo` as `owner__repo` needed a whole rule set). |

## 3. Trust model

| Boundary | Holds because | v2 equivalent |
|---|---|---|
| Workspace and other domains | Separate VMs; separate domain clones; no shared writable storage; no network path between them | sysbox dinds, overlay views |
| Workspace and others in its domain | **Not a boundary.** Shared domain clones and secrets; agents can coordinate through the shared `.git`. Documented, not defended. | (shared daemon, `icc=true`) |
| Workspace and root | Root's clones and keys never mounted into a workspace; the mirror mounted read-only, enforced by the host; one narrow request channel (`desolate fetch`, `desolate offer`) | broker, keyring isolation |
| Domain and root git | P4: the root reads a domain's offers as bundle files and LFS objects verified by id, never by running git in the domain's `.git` | transfer.ts bundles, editor cache |
| Domain and the remote | No key in the domain. Fetches come from the mirror; pushes only through the root | push and pull through the editor |
| Workspace and the Mac | VM boundary; the only shared storage is its domain's directory and the read-only mirrors; no route to the Mac or LAN | sysbox, nftables |
| Workspace and the internet | Its only egress is its proxy, outside the VM | nftables REDIRECT, forced |
| Keys | In the root's keyring: sign, never export; per repository a read key, and a write key if it is pushable; no domain holds any | keyring container |
| Pushes | Only from a person's action in the root, pinned to a reviewed commit | `--expect`, panel Review & Push |
| Browser | One hostname per surface; each forward answers only its own name; the admin UI behind a gate | `hosts.ts`, ingress host check, `editor-gate.ts` |

Why secrets are shared per domain, not per workspace: agents in a domain can talk through the shared `.git`, so per-workspace secrets cannot stop one agent from having another spend a key on its behalf. Pretending otherwise would be a boundary that does not hold, so a secret is the domain's.

Why the root never fetches *from* a domain clone, even read-only: git's local transport runs `upload-pack` inside the source repository and honours parts of its config. Cloning a crafted local repository has been remote code execution before (CVE-2024-32004). A bundle is a file with no config, so it is the only way domain work enters the root.

## 4. Architecture

```
Mac
├── desolate CLI (./cli.sh successor)          drives everything; no keys; runs no git on desolate's repos
├── forwarder   one listener per port on 127.0.0.1, routing by Host/SNI to the workspace named
├── browser ── <domain>-<workspace>-editor-<hex>.localhost:P ──▶ a workspace's editor
│          ├── <domain>-<workspace>-<hex>.localhost:5173 ──────▶ its dev server, same port as inside
│          └── desolate.localhost:P ──────────────────────────▶ root UI or root editor (gated)
│
├── ~/.desolate/
│   ├── mirrors/<owner>/<repo>.git     root: rw         every domain with that repo: READ-ONLY
│   ├── root/<owner>/<repo>/           root only        (the root clones)
│   └── domains/<domain>/
│       ├── repos/<owner>/<repo>/      that domain: rw   root: read-only, read as data only
│       ├── outbox/                    that domain: rw   root: rw (takes its bundles and offers, clears them)
│       └── inbox/                     root: rw         that domain: read-only (deliveries from the root)
│
├── root VM
│   ├── keyring        per repo: a read key; a write key if it is pushable (it asks before signing)
│   ├── mirrors        refreshed from the remote with the read key, LFS objects included
│   ├── root clones    the person's git; every domain's branches as <domain>/*; pushes start here
│   ├── secrets        per domain; 0600
│   ├── proxy          one instance (or listener) per running workspace
│   └── root UI or root editor, CLI endpoint, the request channel from workspaces
│
└── workspace VMs (per domain)
    ├── its devcontainer, its editor (codium-server), its terminal, its agent
    ├── desolate's daemon: port detection and reservation; bundles of its domain's branches
    ├── /workspaces/<owner>/<repo>           the domain clone: main checkout or a worktree
    ├── /desolate/mirrors/<owner>/<repo>.git read-only; the domain clone's `origin`
    └── network: one link, to its proxy
```

### 4.1 Storage (proposed)

Everything lives on the Mac's disk under `~/.desolate/`, shared into VMs by virtiofs with the access shown above. Read-only is enforced by the host's share, not by anything in the VM (P5).

- The root VM can be rebuilt without losing a mirror, a root clone or any domain's work.
- **The Mac never runs git in there** (P4). The CLI reads it as data: status files, `domain.json`. This trades v2's "no checkout on the Mac at all" for files on the Mac that nothing on the Mac executes. If that trade is wrong, the alternative is storage inside the root VM, exported to workspaces over a network filesystem, through a boundary that otherwise has none ([question 5](#14-open-questions)).

### 4.2 The workspace VM (decided: a VM that hosts the devcontainer)

Two shapes are possible:

- **A. A VM that runs the project's devcontainer inside it.** The VM boots a desolate base image with `dockerd`; the devcontainer CLI runs inside the VM against the project's `devcontainer.json`, unchanged. Features, lifecycle commands, `remoteUser` and compose all work as the ecosystem expects, and docker-in-docker inside the project is ordinary.
- **B. The devcontainer image booted as the VM.** Faster and lighter (microsandbox, Apple Container), but every `devcontainer.json` behaviour must be reimplemented, and a project that needs docker still needs a daemon in its VM.

**A, for v3** (decided, question 3). B stays a possible later optimisation; Phase 0 still measures boot time, idle memory and disk on each candidate substrate, for A.

For comparison, devvm takes B's road: it boots the spec's `image` as the VM, maps four common features (node, python, rust, go) onto its own toolchains, refuses every other feature, and refuses `build` and compose. A keeps all of `devcontainer.json`, which is the point of keeping it.

With A, **v2's spec policy (`policy.ts`) goes away**. Everything a `devcontainer.json` can ask for (privileged, capabilities, mounts, docker-in-docker, a Dockerfile, compose, even `initializeCommand`) happens inside the workspace VM, because the devcontainer CLI itself runs there. The VM is the boundary, and nothing in the spec can reach past it. What stays outside the spec's reach, by construction rather than by checking:

- the VM's shares (its domain's storage, the read-only mirrors);
- its network link;
- its forwarded ports (section 4.4).

*Start-up:* with A, the expensive part (building the environment) happens once per domain, in its template (section 4.7, C3). Every later workspace boots a copy-on-write clone of a disk that already has it.

The base image carries the git settings a domain clone needs that only system or global config may set: `safe.directory` for `/desolate/mirrors/*` (the mirror is owned by another uid), and git-lfs installed.

### 4.3 Network (decided requirements, proposed mechanism)

Requirements:

- A workspace VM has one network link, and it reaches only its proxy and DNS. This is enforced outside the VM (P5): it does not route to the root's other services, other VMs, the Mac or the LAN. The exceptions are not network paths. Each is a vsock or socket with a fixed, validated vocabulary:
  - the request channel to the root (section 6.4);
  - the port daemon's channel to the Mac-side forwarder (section 4.4): port numbers in, taken ports out, nothing else;
  - forwarded connections, which the forwarder opens into the VM, never the other way.
- The proxy substitutes the **domain's** secrets, enforces the domain's network rules, and audits every request with `domain=<g> workspace=<w>`. Attribution is by which link the request arrived on, not by address.
- Everything v2's `addon.py` does carries over: the internal-address refusal plus a kernel backstop, SNI-proven destinations, header confinement, scrubbing, the self-test fixture, secret on/off and TTL, learn then enforce, and per-workspace attribution.

Mechanism (to be chosen in Phase 0): each workspace VM on its own host-only link, user-space network or vsock path to a proxy instance in the root. The proxy is per workspace, so a stuck or flooded workspace is not everyone's problem.

### 4.4 Ports and browser access

v2 made a project declare its ports ahead of time (`customizations.desolate.ports`), then remapped each to another number on the Mac, so the URL a dev server printed was never the one to open. v3 drops both.

**Same port number, forwarded on its own (decided):**

- A desolate daemon in each workspace VM sees every TCP listener as it appears, as VS Code's own port detection does, and asks the Mac-side forwarder to publish it. A port is published under the number it has inside the VM. Nothing is declared. `customizations.desolate.ports` and `forwardPorts` survive only as optional labels and pre-forwards.
- **Several workspaces share a port number by name.** The forwarder holds one listener per port on the Mac's `127.0.0.1`, and routes each connection by its HTTP `Host` or TLS SNI to the workspace that name belongs to. Vite on 5173 in five workspaces is five URLs: `http://<domain>-<workspace>-<hex>.localhost:5173`, one each. WebSocket upgrades (HMR) carry `Host`, so they route the same way. This is v2's ingress host check (`ingress.py` "WHOSE NAME") turned from a filter into a router: a request naming no workspace gets 421 and reaches nothing.
- **What cannot be routed by name is reserved instead.** These are the cases where the user's idea of telling a VM which ports are taken applies:
  - a port a program on the Mac already holds (the forwarder cannot listen there; Lima's L6 lesson);
  - a raw TCP port (Postgres, Redis) that another workspace already has. With no name in the protocol, one port reaches one workspace.

  For these, the daemon in every other VM **binds the port itself** and refuses connections on it, so a dev server configured to move on (Vite without `--strictPort`) sees 5173 taken and picks 5174. The reservation is cooperative, for convenience only: an agent that is root in its VM can unbind it, and the forwarder, which is the authority, still forwards nothing it should not.
- Ports below 1024 are never forwarded (Lima forwards those onto the LAN: v2's L3).
- The forwarder listens on `127.0.0.1` only, on the Mac, outside every VM (P5).

**One hostname per surface (decided):**

- A workspace's **editor** gets a hostname of its own, separate from its dev servers': `<domain>-<workspace>-editor-<hex>.localhost`. Two sites, two cookie jars, so a workspace's own dev-server page cannot read its editor's token either. That is stronger than v2, where a project's dev server shared its editor's jar.
- The root UI is `desolate.localhost`, behind the equivalent of `editor-gate.ts`: its own Host only, no cross-site requests, nothing served from repository content as a document.

**The editor knows the URLs (proposed):** inside a workspace, the in-VM port and the Mac port are the same number, and only the host differs. desolate's built-in extension in the workspace editor maps `localhost`, `127.0.0.1` and `0.0.0.0` URLs to the workspace's hostname. Ctrl-clicking `http://localhost:5173` in a terminal, and "Open in Browser" in the Ports view, then open the right page. The hook is VS Code's `resolveExternalUri` / tunnel-provider API, enabled for a built-in extension through the server's `product.json`. Phase 0 proves it works in VSCodium's web server.

### 4.5 The environment: `devcontainer.json`, and domains with several (proposed)

`devcontainer.json` stays the way a project says what it needs (decided), and with A it means everything it means elsewhere. A domain can hold several repositories, each with its own spec, so each domain has one **environment** its workspaces are built from. It is chosen when the domain is made, stored in `domain.json` (written by the root, outside every repository), and frozen per workspace when the workspace is created, as v2 snapshotted a spec. There are three ways to have one:

1. **One repository's spec** (the default). With one repository, or with `--env <owner/repo>`, that repository's `devcontainer.json` is the environment. The domain's other repositories are checked out beside it under `/workspaces/`; their own specs are not run.
2. **A composed spec.** `desolate domain <g> env compose` reads every repository's spec and proposes one, asking about each conflict, and stores the result as the domain's own `devcontainer.json`:
   - one base: an `image`, or the one Dockerfile-based spec. Two Dockerfiles cannot be merged, so with two, one is chosen;
   - features: the union by id, asking when one id has two option sets;
   - lifecycle commands: each repository's, run in its own folder, in a stated order;
   - `containerEnv` and `remoteEnv`: merged, asking on conflict;
   - extensions: the union; settings: merged, asking on conflict;
   - where the devcontainer spec already defines a merge (its metadata rules: `capAdd` union, `init` OR, `forwardPorts` union), that rule.
3. **One container per repository, in one workspace VM:** each repository's spec exactly as written, each with its own editor. It is exact, but two editors per workspace, and it does not help a task that spans repositories. Not proposed for v3.

Prior art for 2: none found. The devcontainer spec defines how image and feature metadata merge into a spec, but not how specs merge with each other, and an `extends` has long been asked for upstream. Composer's monorepo-tools does the same job for `composer.json`. **Proposed:** build the merge as a standalone, published tool (a suede repository, e.g. `suede.devcontainer-compose`): `devcontainer.json` files in, one merged spec and a conflict report out. desolate's `env compose` is its interactive front end.

*Start-up:* the frozen environment is also the key of the domain's template (section 4.7, C3), and its features are resolved to digests once, when it is frozen. v2 re-resolved them on every start, which was half of a measured restart.

### 4.6 The root VM

What it runs: the keyring, the mirrors, the root clones, the proxies, the admin UI and a terminal.

**Its terminal is for ordinary git on the root clones** (decided): `log`, `diff`, `show`, `branch`, `checkout`, `merge` and `rebase`, the person's way. This is safe because the root clones are the root's own (P4):

- their config is written by desolate;
- domain work arrives only as bundle objects, under each domain's remote-tracking refs (section 6.5), and a bundle carries no hooks or config;
- `lfs.url` is pinned in each root clone's own config, which outranks any `.lfsconfig` in the content (measured: a content `.lfsconfig` does redirect git-lfs to another repository's key alias; a setting outside the content overrides it);
- `core.hooksPath` is set to an empty, root-owned directory.

What the root must never do: run git in a domain clone, or fetch from one; execute a repository's content (no `npm install`, no build, no test); render repository content as HTML in its UI; or install project packages. The terminal can't prevent a person running a project's script there, so the README and the root's prompt say not to.

**The root has an editor** (decided, question 10; its extension in section 4.8). v2's outer editor had the git extension removed because the editor ran git on project repositories, under their config. A root clone's config is the root's, so VSCodium in the root with the git extension (Source Control, the diff editor, every domain's branches; section 6.5) is safe on the git side. What it must still leave out is everything that executes or renders content:
- language servers and their plugins;
- tasks and debuggers;
- extensions a workspace recommends;
- webviews of repository files.

It stays in Restricted Mode for content, and is used for review, not for development.

### 4.7 Start-up time, and caches that cannot be poisoned (proposed)

Fast starts are a priority for v3, and caching is how they come. A cache is safe exactly when **whoever can write it is trusted by everyone who reads it**. That gives one rule, and every cache below follows from it:

> **A cache shared across domains is filled only by the root or the host, from an upstream source, and is read-only to every VM. Its contents are addressed by digest and verified when used. Anything a domain's code wrote, whether built images, package caches, build caches or disk snapshots, is shared within that domain only.**

Within a domain, sharing poisons nothing: anything one workspace can do, every workspace in it can (section 2). Across domains, a cache a domain can write is a channel to every other domain. v2's per-project build caches stayed per project for this reason, and the idea of sharing them was dropped.

**Where a new workspace's time goes, and what removes it.** v2's start printed a breakdown (`the start took 23.6s: ... features pinned 12.0s, up 6.2s, ...`); v3 keeps that line, and Phase 0 fills in this table with measurements.

| Step | Cold (first time anywhere) | With the caches | Cache, and who writes it |
|---|---|---|---|
| Boot the VM | the substrate's boot | a **copy-on-write clone** of a ready disk: per domain template (below), or desolate's base | **C1** desolate's base VM image: built and checksummed by a desolate release; read-only; each VM's disk a CoW clone (APFS `clonefile`) |
| Resolve the spec's features to digests | network round trips (v2 measured **12.0 s of a 23.6 s restart** doing this on every start) | none: resolved once, when the domain's environment is frozen | the frozen environment in `domain.json`, written by the root |
| Pull the base image, features, compose images | the network, per VM: every new VM starts with an empty image store | from the Mac's disk | **C2** a root-run pull-through registry for every registry a domain uses, filled by the root from upstream by digest, read-only to VMs; each VM's `dockerd` verifies every blob against its digest as it pulls. The v2 probe found `registry-mirrors` covers Docker Hub only, so Phase 0 must find a mechanism (containerd's per-host `hosts.toml`) that covers `ghcr.io` and `mcr.microsoft.com` too |
| Build the environment (Dockerfile, features) and run `onCreateCommand` | minutes (rust, node, toolchains) | none for a domain's second and later workspaces | **C3** a **domain template**: one VM disk with the environment built, `onCreateCommand` run, and the editor's extensions installed, made once per frozen environment by a builder VM with the domain's trust. Each new workspace in the domain boots a CoW clone of it. Keyed by the environment's hash, so a changed spec builds a new one. **Domain-only**: it is the domain's code's output |
| `updateContentCommand` / `postCreateCommand` (`npm ci`, `pip install`) | the network | mostly local | **C4** the domain's package caches (`~/.npm`, `~/.cache/pip`, cargo's registry, Open VSX downloads), one per domain, shared by its workspaces. **Domain-only** |
| Check out the repositories | a full clone | instant: alternates to the mirror; LFS from the mirror | **C5** the mirrors (section 6.2): written by the root from the remote; read-only to VMs |
| Start the editor | seconds | seconds | **C6** the editor server, shared read-only from the host: v2's server-dist, with a host-enforced read-only share instead of an overlay |
| Restart a stopped workspace | a boot | a **resume**, where the substrate can suspend to disk | its own disk |

**One optional cross-domain cache, with strict rules (C7, [question 13](#14-open-questions)).** The root's proxy already sees every download. It could keep immutable artifacts (npm tarballs, PyPI files, crates, GitHub release assets, signed apt `.deb`s) and serve them to any domain. Safe only if all of these hold:
- the proxy fetched them itself from upstream over verified TLS;
- only `GET`, and only with no `Authorization`, cookie or substituted secret, so one domain's private package is never served to another;
- only on URL patterns that name an immutable version;
- the client still verifies what it can (npm `integrity`, `Cargo.lock` checksums).

C4 gets most of the benefit within a domain without any of this, so C7 is a later step, if measurements say cross-domain misses matter.

**What would undo all of this: checkouts on a shared filesystem.** Working trees under `/workspaces` live on the host share (section 4.1), and virtiofs is slow at the many small files `node_modules`, `target/` and `.venv` hold. Every Docker-on-Mac user has met this as bind-mount slowness. Options, measured in Phase 0:
- keep checkouts on the share;
- put each workspace's worktrees on its VM's own disk, with only the domain `.git` shared. The worktree is locked against pruning by other VMs (v2 already locks worktrees);
- keep checkouts shared, and put dependency and build directories on VM-local volumes.

([question 14](#14-open-questions))

**Targets** (proposed; Phase 0 confirms them or says what is possible):
- a new workspace in a domain whose template exists: editor ready in **≤ 15 s**;
- resuming a stopped workspace: **≤ 5 s**;
- the first workspace of a new environment: one build, paid once per domain per spec change.

### 4.8 The desolate extension in the root editor (decided: rework it)

v2's panel is where the owner does most of their work. It needs to be more visual, more approachable, and much faster. v3 rebuilds it rather than porting it, keeping `model.mts`'s logic (what needs you, what a push would send) and replacing how it gets its data and how it looks.

**Why v2's is slow, so v3 does not repeat it.** Every refresh spawns `desolate --list --json` (and `--status --json`, `--dinds`) through the broker. Each spawn starts a TypeScript process, which asks the daemons, on timers and after every action. The panel waits on process start-up, not on data.

**Snappy: requirements (decided):**
- **One state service in the root**, long-running, which holds the current state in memory: domains, workspaces and their status, boards, offers, ports, start-up progress. It **pushes changes** to its subscribers as they happen: the extension, the CLI's `watch`, `--json` readers. It learns of them from file watches (status files, outboxes) and from the VM layer's events, not by polling.
- **The extension renders from that service**: no process spawned to draw anything.
  - The view paints from the last known state at once, then applies updates.
  - Actions acknowledge immediately (the item shows "starting…") and report progress as it streams.
- **Budgets**, held by a browser test like v2's extension test:
  - the panel shows current state ≤ 300 ms after it opens;
  - a status change in a workspace reaches the panel ≤ 1 s later;
  - clicking an action shows it acknowledged ≤ 100 ms later.

**Visual and approachable (proposed; the agent designs it, the owner reviews screenshots):**
- **A dashboard, not only trees.** A webview with each domain as a card, its repositories and its workspaces, and a status colour you can see from across the room. "Needs you" sits on top: offers, orange and red, each with its one-line reason.
- **One click for the common things:**
  - open a workspace's editor (its URL is known; no token copying);
  - start, stop and resume;
  - review an offer: the native diff editor over the root clone, with the commit list beside it;
  - push, which raises the write key's confirmation with the repository, branch and commit;
  - `upstream` for a suede consumer.
- **A first-run path:** with nothing set up, the dashboard walks through it: clone a repository, create a domain, add it, choose the environment, start a workspace. Each step shows the CLI command it ran, so the panel teaches the CLI.
- **Progress you can read:** a start shows its phases live (section 4.7's breakdown) instead of a spinner.

**Safety rules that carry over:**
- the webview is desolate's own code, with a strict CSP and no remote resources;
- repository content (branch names, commit messages, agent notes and statuses) is rendered as text, never as HTML or markdown that could run;
- tokens are never shown in labels (v2's `redactTokens`).

## 5. Domains

### 5.1 What a domain shares (decided)

- Its repositories: one **domain clone** per repository, in `repos/<owner>/<repo>`, with one `.git` shared by every workspace in the domain. Two domains with the same repository have two domain clones; they share only the read-only mirror.
- Its secrets and network rules, enforced by each workspace's proxy.
- Its board: each checkout's status and note, kept in the domain clone's `.git` (v2's `desolate-status`, unchanged). The root and the Mac read these as JSON files, never through git.

### 5.2 Checkouts (decided)

- The domain clone's main checkout stays on the repository's default branch in practice. Other branches are worktrees under `.worktrees/<name>`.
- **One workspace holds a given checkout at a time**, the main checkout included. A second workspace asking for it is refused with who holds it; it can take a worktree instead. (Two editors and two agents in one working tree is a corruption, not a feature.)
- Worktree bases: `--base <ref>` takes a local branch (`main`) or a remote-tracking one (`origin/main`). `--fetch` first refreshes the mirror from the remote (section 6.4), then the domain clone's `origin/*` from the mirror. So "fetch, then start from the remote's main" is `--base origin/main --fetch` (your `fetch:origin/main`, as two flags that compose).
- git's own housekeeping must not race across VMs on the shared domain `.git`: `gc.auto=0` in the domain clone, with gc run by a domain sandbox VM while no workspace holds a checkout. Phase 0 proves worktree creation, concurrent commits and lock files are safe over virtiofs ([question 6](#14-open-questions)).

### 5.3 Keys: every domain reads, only the root writes (decided)

**Every domain reads; only the root writes** (decided). A domain never holds a key and never reaches a remote. It fetches from the mirror, and its work leaves only through the root. So there is no per-domain `readonly`/`readwrite`: what was "readonly" for a domain is now simply true of every domain. Whether a repository can be pushed at all is the root's, per repository:

- **Every repository** gets a **read** deploy key in the root, used for every fetch into the mirror, git and LFS. It signs with no prompt, so fetches, refreshes and LFS downloads are automatic.
- **A pushable repository** also gets a **write** deploy key, used only for pushes, git and LFS. `desolate clone <repo>` makes it pushable by default; `--no-push` doesn't. The latter is for a repository you only consume, or one you don't administer and so can't add a write key to. A public repository you can't add any key to is fetched anonymously over HTTPS.
- **Why two keys rather than one:** the write key asks before it signs (next point), and fetches must not ask. One key would mean prompts on every fetch, or no prompt on pushes. Two keys keep fetches automatic and pushes gated. They also keep a confused fetch path from ever being able to push: the key it holds can't.
- **P2 is enforced by the keyring, not by convention.** The write key signs only after an interactive confirmation that names the repository, the branch and the commit: a button in the root UI, or a prompt on a terminal (ssh-agent's confirm-before-use, extended with what is being pushed). `git push origin` in the root terminal gets the same prompt. A harness driving the CLI from the Mac has no terminal and no button, so it cannot push even when it asks to. The prompt shows the commit `desolate push --expect` pinned. For a raw `git push`, desolate's pre-push step reads the commit from the refs being pushed.
- A domain clone is writable locally (agents commit, branch, experiment), and fetch-only remotely, through the mirror. "An agent may inspect a repository without being able to publish to it" is every domain's case.

### 5.4 Multiple repositories, and suede

A domain can hold several repositories, which is what makes suede development direct. One domain:

- `pmalacho-mit/consumer`: the consumer with changes to a vendored dependency;
- `pmalacho-mit/suede.nests`: the dependency.

An agent works in the consumer, where the dependency is vendored, decides whether its changes there are worth upstreaming, and if so offers the consumer branch that carries them. In the root, a person runs suede's `upstream` on that branch (section 5.5). That pushes the change to suede.nests as a `downstream/...` branch with suede.nests' write key, after the key's confirmation, and the dependency's own Action opens the PR. The consumer can be `--no-push` in the root, so it is never written, by anyone, through desolate. The same flow runs unattended from a script on the Mac, up to the offer (section 9.2).

### 5.5 Running suede's `upstream` from the root (decided requirement)

**It must work from the root**, since that is where a person pushes. What `upstream` does (pmalacho-mit/suede README):
- in the consumer, it requires a clean tree;
- it splits the dependency's commits out with git-subrepo;
- it pushes them to the dependency's remote as `downstream/<owner>/<repo>-<commit>`, one proposal per commit;
- it restores local state;
- it waits, through GitHub's public API, for the PR the dependency's `suede-downstream-to-main` Action opens.

Two facts decide how the root may run it:

1. **The script is repository content.** Every installed dependency vendors it at `<dependency>/.suede/core/upstream`, and the copy the root would run arrives on the branch an agent offered. Running it would be the root executing a file an agent could have edited, next to the write keys (P4). The write key's confirmation would still stand between it and a push, but not between it and everything else the root can reach.
2. **It pushes to the remote in the dependency's `.gitrepo`**, a file the project controls. This is the first audit's H1: a project could name another repository in it and have that repository's key push its branch.

So (proposed): **`desolate upstream <consumer> <dependency-dir> <owner/repo>`**, in the root terminal or the root editor:
- it runs **suede's own `upstream`, from a copy desolate pins by commit** from pmalacho-mit/suede (as v2's CI pinned suede's scripts after audit L8), against the root clone of the consumer, checked out at the offered branch;
- it ignores the vendored copy. If an agent's branch changed the vendored `.suede/core/`, the review says so in red: a proposal that rewrites suede's own machinery is worth a second look;
- **you name the dependency**, it must match the `.gitrepo`, and it must be a pushable repository in the root (v2's H1 fix, kept);
- the push goes through the write key's confirmation, which names the repository, the `downstream/...` branch and the commit;
- v2's rule for dependency pushes stays: a proposal that changes the dependency's `.github/` is refused, because a pushed branch's workflows run with that repository's secrets;
- the root has `git-subrepo` and `jq` installed, desolate's own pinned copies, and reaches GitHub's API for the wait;
- suede's flags pass through: `--no-wait`, `--remote` (still checked against the dependency you named).

When a new suede release changes `upstream`, desolate moves its pin, the same way v2 moves any pinned tool. Typing `.suede/core/upstream` in the root terminal is the one thing to never do: the README and the root's prompt say so, as they do for running any repository content in the root.

## 6. Git: three repositories per repository, and what crosses between them

### 6.1 The three (decided)

| | mirror | root clone | domain clone |
|---|---|---|---|
| Where | `~/.desolate/mirrors/` | `~/.desolate/root/` | `~/.desolate/domains/<g>/repos/` |
| Written by | the root, from the remote only | the root: the person and desolate | that domain's workspaces and sandbox |
| Readable by | the root; every domain with the repository, read-only | the root only | that domain; the root reads its status files as data |
| Holds | what the remote published, and its LFS objects | the person's work, and every domain's branches as `<domain>/*` | that domain's work |
| Its objects | its own | borrowed from the mirror (alternates) | borrowed from the mirror (alternates) |

Why the mirror is safe to share between domains: it contains nothing a domain could not fetch from the remote with read access, and no domain can write it. Why the root clone is never shared: it holds every domain's branches, none of them published.

### 6.2 Space (proposed: alternates to the mirror)

A domain clone and a root clone are made with `git clone --shared` from the mirror. They borrow its objects through `objects/info/alternates`, and hold only objects created in them. Measured here (containers, not yet virtiofs):

- a domain clone of a repository had 0 objects of its own until its first commit;
- that commit stayed in the domain clone, and the read-only mirror was unchanged;
- `git fetch origin` from the read-only mirror worked, and a push to it was refused.

What this requires:

- **The mirror is never pruned.** An object a clone borrows must not vanish, even after a force-push upstream.
- **Every VM mounts the mirror at the same path** (`/desolate/mirrors/<owner>/<repo>.git`), because the alternates file names it.

The alternative, if alternates over virtiofs prove fragile in Phase 0: copy-on-write file clones (APFS `clonefile`) of the mirror's packs at clone time. That shares space at creation but not for later fetches.

*Start-up:* a new domain clone, or a new worktree in one, costs no download and almost no disk, because the history is already in the mirror (section 4.7, C5).

### 6.3 Git LFS (decided: it must work)

- **Into the mirror:** when the root fetches a repository, it also fetches the LFS objects its branch tips need, with the read key and `lfs.url` pinned. Older objects are fetched on request (section 6.4).
- **Into a domain clone:** the domain clone's `lfs.url` is `file:///desolate/mirrors/<owner>/<repo>.git`, so checkout and smudge read LFS objects straight from the read-only mirror, offline. Measured here: a 200 KB LFS object smudged into a domain clone from a read-only mirror this way.
- **New LFS objects made in a domain** stay in the domain clone's own `.git/lfs/objects` until offered.
- **Out to the remote:** an offer carries the LFS objects its commits reference (section 6.4). The root verifies each one's sha256 against its oid and its size against the pointer, imports it into the root clone, and pushes LFS objects with the write key before pushing the commit. GitHub never has a pointer without its object. Routine syncs (section 6.5) carry no LFS objects, only pointers, so a domain's large files cost nothing until a branch is offered.
- **Keys are scoped by GitHub, not by desolate:** the read key authenticates LFS downloads, and the write key authenticates uploads. Phase 0's probe confirms both, plus that the read key is refused for upload. The probe for the write key exists already (`tests/probes/lfs-deploy-key.sh`); v3 adds the read key's cases.

### 6.4 What crosses between them (decided)

- **Remote → mirror:** `desolate fetch <repo>` in the root, or the request channel. The root fetches with the read key, LFS objects included.
- **Mirror → domain clone:** `git fetch origin` inside the domain, by anyone in it, any time. It reads the read-only mirror; no key, no network.
- **Mirror → root clone:** `git fetch origin` in the root (section 6.5).
- **Domain clone → root clone, every branch:** synced as bundles (section 6.5), so the root always sees every domain's branches.
- **Domain clone → root clone, the offer:** `desolate offer <repo> [<branch>]` inside a workspace marks a branch ready. It syncs that branch now, adds the LFS objects its new commits reference, and records the offer, so the root UI shows it under "Needs you". Offering is not pushing.
- **Root clone → domain clone, a delivery:** `git push <domain> <branch>` in the root (section 6.5) writes a bundle to the domain's inbox. The domain side imports it as `root/<branch>`, never over a branch of the domain's own. This is how a person moves work between domains (a fix from one into another) through the root. It is a local transfer, not a push to any remote, and only the person can start it.
- **Root clone → remote, the push:** the person reviews the branch in the root clone (with the root UI, the root editor, or git in the root terminal) and pushes it with the write key, which asks for confirmation (section 5.3). The push uses `--expect <commit>`, allows the default branch only with `--allow-default` (exit 77), refuses `.github/` changes to a dependency, and sends LFS objects first. Exit 75 when busy.
- **The request channel:** a workspace may ask the root for a fixed set of things. Each request is validated against the workspace's domain (only its domain's repositories) and rate-limited:
  - `fetch <repo>`: refresh the mirror;
  - `lfs <repo> <oid>...`: fetch older LFS objects into the mirror;
  - `offer <repo> <branch>`: a bundle is waiting in the outbox.

  The answer is whether it was done. Nothing else crosses this channel, and nothing on it can name a key, a host or a path.

### 6.5 The root's view of every domain (proposed)

In the root, each repository's root clone has one remote per domain that holds it, beside `origin`:

```
$ git -C ~/root/pmalacho-mit/suede.nests remote -v
origin       /desolate/mirrors/pmalacho-mit/suede.nests.git (fetch)
origin       git@github.com-pmalacho-mit__suede.nests:pmalacho-mit/suede.nests.git (push)
nests-dev    desolate::nests-dev (fetch)
nests-dev    desolate::nests-dev (push)
consumer-up  desolate::consumer-up (fetch)
consumer-up  desolate::consumer-up (push)
```

- **`origin`** fetches from the mirror, so it is instant, and `desolate fetch` refreshes the mirror from GitHub first. It pushes to GitHub with the write key, which asks for confirmation (section 5.3).
- **Each domain is a remote**, through desolate's git remote helper (`git-remote-desolate`), so ordinary git works in the root terminal and the root editor's Source Control:
  - `git fetch nests-dev` brings in that domain's branches as `nests-dev/*`;
  - `git fetch --all` brings in every domain and the mirror;
  - `git log nests-dev/issue/12`, `git diff origin/main...nests-dev/issue/12` and `git cherry-pick` all work, across domains;
  - `git push nests-dev mybranch` delivers to that domain (section 6.4).
- **How a domain's branches arrive (proposed):** a desolate daemon in each running workspace VM watches its domain clones' refs. On a change (debounced), it writes an incremental bundle, less what the root has said it holds (v2's `.haves`), and a refs list to the domain's `outbox/`. The helper imports these into `refs/remotes/<domain>/*`:
  - by a fixed refspec;
  - every ref name checked with `check-ref-format`;
  - deleted branches deleted;
  - LFS objects left out (section 6.3).

  When no workspace of a domain is running, nothing in it changes, so the root's view stays current. `git fetch <domain>` with nothing new is instant.
- **Nothing here runs git in a domain clone from the root (P4).** The daemon that makes bundles runs inside the domain's VM, with the domain's trust. What it writes is data the helper reads as a bundle. If an agent that is root in its VM tampers with the daemon, it can only lie about its own domain's branches, which it could already write anything to.
- In the root editor, this gives the person a Source Control view of every domain's work, a diff editor between any two of them, and one place to push from.

## 7. Secrets and network policy

- **Decided:** secrets are per domain, stored in the root, 0600, never in a workspace. A workspace sees placeholders.
- Everything from v2 carries over per domain: `--hosts`, `--headers`, `on|off --ttl`, `learn --for --then` / `enforce` / `recommend` / `allow`. A project-level `--projects` scope becomes unnecessary, because the domain is the scope.
- Adding one prompts for the value, hidden, never in argv:
  ```bash
  desolate domain nests-dev add --secret DUMMY_OPENAI_KEY --hosts api.openai.com --headers authorization
  ```

## 8. CLI (proposed)

The verbs from this document's first draft, with slugs instead of free-text identifiers:

```bash
# on the Mac (or in the root terminal)
desolate clone pmalacho-mit/suede.nests                       # keys, mirror (with LFS), root clone
desolate fetch pmalacho-mit/suede.nests                       # remote -> mirror
desolate domain create nests-dev --title "suede.nests agentic development"
desolate clone pmalacho-mit/consumer --no-push                # a read key only
desolate domain nests-dev add --repo pmalacho-mit/suede.nests
desolate domain nests-dev add --repo pmalacho-mit/consumer
desolate domain nests-dev add --secret CLAUDE_OAUTH --hosts api.anthropic.com --headers authorization
desolate domain nests-dev env [--from pmalacho-mit/consumer | compose]   # the domain's environment (4.5)
desolate up nests-dev [--name issue-12] \
    [--checkout pmalacho-mit/suede.nests=worktree:issue/12 --base origin/main --fetch]
                                                              # a workspace; prints its URL
desolate list | status [--json] | board <domain>
desolate ports [<domain>/<workspace>]                          # what is forwarded, at which URL; what is reserved
desolate offers [<domain>]                                     # what domains have offered
desolate review <domain> <repo> <branch>                       # what a push would send
desolate push   <domain> <repo> <branch> --expect <commit> [--allow-default]
desolate upstream <consumer> <dependency-dir> <owner/repo> [--no-wait]  # suede's upstream, pinned (5.5)
desolate exec <domain>/<workspace> [--checkout <repo>] -- <cmd>...   # a command or an agent, in its devcontainer
desolate stop | rm <domain>/<workspace>
desolate rm <domain>                                           # the domain, its clones and caches; not the root's
desolate secret ... | proxy ... | watch                       # as in v2, per domain

# in the root terminal (or the root editor's Source Control), on a root clone
git fetch --all                                               # the mirror, and every domain's branches
git diff origin/main...nests-dev/issue/12                     # review, across domains
git push nests-dev fix-from-elsewhere                         # deliver to a domain (a local transfer)
git push origin nests-dev/issue/12:issue/12                   # to GitHub: the write key asks first

# inside a workspace
git fetch                                                     # from the mirror: no key, no network
desolate fetch [<repo>]                                       # ask the root to refresh the mirror, then git fetch
desolate offer <repo> [<branch>]                              # bundle it for the root; a person pushes it
/desolate/status set green "ready: ..."                       # as in v2
```

- A workspace gets every domain repository. Repositories not named in `--checkout` get the main checkout if it is free, and otherwise a fresh worktree named for the workspace on a new branch from the default branch.
- `--json` everywhere a harness reads, and exit codes as in v2.

## 9. Agents and automation

### 9.1 What a script outside the stack can do (decided)

P2 forbids automated **pushes**, not automation. desolate stays a set of primitives that a harness on the Mac drives: v2's dispatchers and suede factory live outside the stack, and v3 keeps that. **Everything up to a push can be scripted**:
- cloning (`clone`, registering keys with your `gh`);
- creating domains and adding repositories and secrets (a secret's value on stdin);
- choosing a domain's environment (`env --from <repo>`; `env compose --answers <file>` without a prompt);
- starting and stopping workspaces;
- running commands and agents in them (`exec`);
- reading status and the board;
- listing offers;
- `review`, which shows what a push would send.

The one step a script cannot take is the write key's confirmation (section 5.3), so a script's work ends at an **offer**, and a person pushes.

What a harness can rely on, as in v2:
- `--json` on everything it reads;
- exit codes: 75 busy, 77 default branch refused, and the others documented;
- no prompts when stdin is not a terminal: a command that would ask fails, saying which flag answers it;
- nothing an agent writes reaches GitHub through desolate (v2's rule for the dispatcher: an agent's words go to you, never to the forge as you).

- The dispatcher and its contract carry over: a workspace per issue in a domain; status through `.git` (shown, never acted on); notifications through `DESOLATE_NOTIFY`; `--max-agents` across domains.
- An agent finishing a task runs `desolate offer` and sets its status green, or sets gray to withdraw, with its reason. Offering is not pushing.
- A domain is the natural unit for "agents on one repository": they share the board, the secrets and the domain clone, as v2's worktrees of one project did.

### 9.2 Example: should this consumer's change go upstream?

A script on the Mac, run when a consumer's vendored copy of a suede dependency has drifted from upstream:

```bash
G=upstream-nests-$(date +%Y%m%d%H%M)
desolate domain create "$G" --title "should consumer's suede.nests changes go upstream?"
desolate domain "$G" add --repo pmalacho-mit/consumer         # cloned --no-push: never writable
desolate domain "$G" add --repo pmalacho-mit/suede.nests      # pushable, by a person, from the root
desolate domain "$G" add --secret CLAUDE_OAUTH --from-domain agents   # copy a secret the root already holds
desolate domain "$G" env --from pmalacho-mit/consumer
desolate up "$G" --name review --fetch \
    --checkout pmalacho-mit/consumer=worktree:suede/nests-changes --base origin/main --json
desolate exec "$G/review" -- claude -p "Compare the consumer's vendored suede.nests (./suede.nests) with
  upstream (the suede.nests checkout beside it). Are its changes worth upstreaming? If so, make
  sure they are committed on this branch, run 'desolate offer pmalacho-mit/consumer', and set
  green with a one-line case for them. If not, set gray with why."
until desolate status "$G/review" --json | jq -e '.status.color | IN("green","gray","red","orange")'; do sleep 30; done
desolate status "$G/review" --json | jq -r .status.message   # -> notify the person
```

- The script uses only primitives, and every one can be scripted.
- The agent only judges and offers. On green, the person reads its case and the diff in the root, then:
  ```bash
  git fetch "$G" && git checkout "$G/suede/nests-changes"
  desolate upstream pmalacho-mit/consumer suede.nests pmalacho-mit/suede.nests
  ```
  The `downstream/...` push asks for the write key's confirmation, and the dependency's Action opens the PR. Or the person does nothing.
- When it is done, `desolate rm "$G"` removes the domain. The root clone keeps the branch as long as it is wanted.

`--from-domain` copies a secret the root holds into a new domain without its value passing through the script. It is the root's, and is proposed so that a scripted domain need not ask for values.

## 10. What goes away, what carries over

**Goes away:**
- sysbox and the inner daemons; the supervisor; per-project daemons; `dind-sockets`; `reset-inner`; `dind gc`;
- the broker's spec policy (`policy.ts`, `dockerfile-build.ts`, the snapshot as a policy input), because the spec runs inside the VM (section 4.2);
- relays, port allocation and remapping (`ports.ts`, `DESOLATE_EXTERNAL_*`), because ports keep their numbers (section 4.4);
- overlay volumes for `/vscode-server` and `/desolate`;
- `shadowImages` and CA derivation inside daemons (the CA is installed in the workspace VM's own trust store at boot).

**Carries over, mostly as code:**

| Component | v2 file |
|---|---|
| the proxy | `addon.py` |
| keyring | `keyring.ts` |
| transfer: bundles, review, `--expect`, exit codes | `transfer.ts`, `docker.ts` scripts; the editor's per-repository cache becomes the root clone |
| status and board | `status.ts`, `desolate-status` |
| hostnames, browser gate and ingress host check | `hosts.ts`, `editor-gate.ts`, `ingress.py` |
| editor settings held | `editor-settings.ts` |
| completion hardening | `completion.*` |
| feature pinning | `feature-pins.ts` |
| the panel's model | `extension/model.mts`, rehomed as the root UI |
| preflight's false-pass discipline | |
| `docs/incidents.md` | |

## 11. Migration from v2 (proposed)

v3 installs beside v2: a different VM and different ports. Projects move one at a time by re-cloning from GitHub. Unpushed work is pushed (or exported) from v2 first. No in-place conversion: v2's `/workspaces` volume is not mounted into v3.

## 12. Non-goals for v3

- Linux and Windows as hosts people use. A Linux `qemu` backend does exist, for testing and CI (section 13.2), and keeps the VM layer honest about being one interface; making Linux a supported host is later work.
- More than one human.
- Remote hosting.
- Microsoft marketplace extensions.
- Network paths between workspaces of a domain (compose stacks live inside one workspace).

## 13. Bootstrapping, testing, and phases

**A priority for v3 (decided): an agent can bring the stack up from nothing and test it end to end, for correctness and for ergonomics.** v2's integration tests needed a live stack on the owner's Mac, so an agent could only check a slice, and the owner found the rest in daily use: the missing panel and the cookie jar, for two. v3 is built so that the agent finds them first.

### 13.1 Bootstrapping (decided)

- **One command from a clean machine to a working stack:** `desolate bootstrap [--backend <name>]`. It checks and installs desolate's pinned tools (checksummed, as v2's image downloads are), fetches or builds the base VM image (checksummed), creates the root VM, its keyring and its state service, and ends with `desolate doctor`. It is idempotent: run twice, the second run changes nothing and says so.
- **`desolate doctor`** succeeds v2's `preflight`, with its false-pass discipline: run with nothing reachable, nothing passes (v2's `20-preflight-degraded` test, kept). Every failure names the command that fixes it.
- **`desolate destroy --all`** puts the machine back as it was. A test checks nothing is left: no VMs, shares, listeners or files outside `~/.desolate`.
- **Every end-to-end test starts from `bootstrap`**, never from a state set up by hand, so bootstrapping is itself tested every time.

### 13.2 Backends, and four test tiers (decided)

The VM layer is one interface: create, boot, stop, suspend, resume, destroy, clone a disk, attach a share read-write or read-only, attach the network link to a proxy, report listening ports, exec, logs. It has three kinds of backend:

- **`fake`:** each "VM" is a container (or a process namespace) on any Docker host, implementing the whole interface: read-only shares as read-only binds, the network link as a container network whose only route is the proxy, exec, port events. It gives **no hypervisor isolation**, and says so: it runs only when `DESOLATE_BACKEND=fake` is set explicitly; every workspace on it is labelled `not isolated` in the CLI and the dashboard; and `doctor` fails on it outside a test run.
- **`qemu`:** a Linux backend on QEMU (through Lima's QEMU driver, or QEMU directly), with KVM where the host has `/dev/kvm` (GitHub's Ubuntu runners do: foldyard's CI boots Lima VMs there), and software emulation (TCG) where it does not. TCG is slow (minutes to boot, everything inside crawls) but it is a real hypervisor boundary.
- **The product backend**, Lima/vz or Apple Container (Phase 0 decides), on a Mac.

On the owner's M1: the product backend's VMs are started by the Mac itself, so they run at full speed; the M1's lack of nested virtualization matters only for running v3 *inside* something (a sandbox, a desolate v2 workspace, Colima), which means TCG there.

| Tier | Backend | Runs where | Time | What it proves |
|---|---|---|---|---|
| **T1** static and unit | none | anywhere | seconds | as in v2 |
| **T2** e2e-fast | `fake` | any Docker host: the agent's sandbox, the Mac | minutes | everything but the hypervisor boundary: root services, the proxy and its policy, the keyring and the push gate, mirrors and domain clones, offers, pushes and `upstream`, the port router (Vite in two "VMs" at one number), caches, the state service and the dashboard (Playwright), the CLI's transcripts |
| **T3** e2e-slow | `qemu` (KVM or TCG) | CI on Linux with KVM; the agent's sandbox under TCG | tens of minutes | the boundaries that need a real VM: forced egress with root inside the VM, read-only shares against root inside the VM, the hostile-repository scenario, the cross-domain poisoning test. Run as `make e2e-slow` whenever something structural changes |
| **T4** acceptance | the product backend | the owner's Mac (or any Mac the agent is given) | as long as it takes | section 13.4's scenarios for real, timed against section 4.7's targets |

**Every boundary claim has a T3 test, and a T2 test is never taken as proof of one.** Test names carry their tier.

**Two architectures.** The agent's cloud sessions (Claude Code on the web) are Ubuntu 24.04 on **x86_64**, with Docker, 4 vCPUs, 16 GB of RAM and 30 GB of disk. The owner's Mac is **arm64**. T1 and T2 must pass on both. Base images, pinned tools and their checksums are per architecture, as v2's already are. The cloud documentation says nothing about `/dev/kvm`, so T3 there is under KVM if a session has it, and under TCG if not.

**A stand-in GitHub, so no test needs the real one** (proposed: the agent chooses, e.g. gitolite with an LFS server):
- a local git server where keys are per repository, read-only or read-write, as deploy keys are;
- it serves LFS;
- it runs an `on: push` hook standing in for the dependency's Action, for `upstream`.

The push gate, read versus write keys, the LFS round trip and suede's `upstream` then run offline in T2 and T3. Only Phase 0's deploy-key probe talks to GitHub itself.

### 13.3 Testing ergonomics, not only correctness (decided)

The end-to-end tests drive desolate the way a person does, through the CLI and through the dashboard in a browser, and record:
- **every command's output, as a transcript** reviewed like a snapshot: a changed message is a reviewed change, and every error in it names the command or flag that fixes it;
- **wall-clock time per step**, against section 4.7's start-up targets and section 4.8's dashboard budgets; a step that blows its budget fails;
- **screenshots of the dashboard** at each step of the first-run path, for the owner to look at;
- **a fresh-eyes run:** the first-run path (clone a repository, create a domain, start a workspace, run Vite, offer, push to the stand-in GitHub) completed using only what desolate prints and shows, with no docs and no knowledge of the code. The agent runs this as a separate subagent with only the CLI and the browser, and reports where it got stuck.

### 13.4 Phases, each with exit criteria

Each phase ends with its tests green, and each negative test beside a control that shows it would have caught the failure (P6). From Phase 1 on, each phase's exit criteria run in T2. The boundary criteria also run in T3, and section 13.4's acceptance scenarios run in T4.

0. **Probes, before any design is built on them.** For the VM substrate (Lima/vz, Apple Container, microsandbox):
   - boot time, cold and warm;
   - idle memory and per-VM disk;
   - virtiofs sharing of one domain `.git` between two VMs: worktree add, concurrent commits, lock contention, no corruption across 1,000 operations;
   - **a read-only virtiofs mirror:** host-enforced read-only (root in the VM cannot write it); alternates and `lfs.url=file://` working through it (measured in containers; to be measured over virtiofs);
   - egress forced through a proxy outside the VM, with root inside the VM unable to bypass it;
   - port forwarding to the Mac's loopback, **routed by name**: Vite on 5173 in two VMs at once, each at its own hostname, HMR (WebSocket) included; a raw TCP port; a port the Mac holds, reserved inside the VMs so Vite moves to 5174;
   - in VSCodium's web server, a built-in extension mapping `localhost:<port>` links and the Ports view to a workspace's hostname;
   - `dockerd` and the devcontainer CLI inside the VM: a Dockerfile spec, features, compose;
   - **GitHub LFS with deploy keys:** the write key downloads and uploads; the read key downloads and is refused for upload; neither works for another repository;
   - **start-up (section 4.7):**
     - a CoW-cloned VM disk's boot (C1, C3);
     - a pull-through registry that serves Docker Hub, `ghcr.io` and `mcr.microsoft.com` to a VM's `dockerd` (C2);
     - `npm ci` on a mid-sized project with and without a warm domain cache (C4);
     - the same with its checkout on the virtiofs share versus the VM's own disk;
     - suspend and resume.

   Exit: a one-page measured comparison, a substrate decision, and section 4.7's table filled in.
1. **Root VM:** keyring (read keys, and write keys that ask before signing), mirrors with LFS, root clones, `clone [--no-push]` and `fetch`, the CLI channel from the Mac. Exit:
   - keys never readable from outside the keyring, with a test that tries;
   - a fetch works with the read key alone;
   - the root terminal's git on a root clone ignores a hostile `.lfsconfig` and a hostile hooks directory in content.
2. **One workspace:** one domain, one repository, its domain clone borrowing from the read-only mirror, its devcontainer, its editor in the browser by hostname, forced egress through its own proxy, ports forwarded as they open, caches C1, C2, C5 and C6, the start-up breakdown line. Exit:
   - the editor works;
   - `git fetch` works from the mirror, and LFS files check out;
   - a dev server started in its terminal opens at the URL its link shows, with nothing declared;
   - its hostnames are the only ones its ports answer, and its editor's cookie is not readable from its dev server's page;
   - nothing reaches the root, the Mac or the LAN;
   - root inside the VM cannot write the mirror or change any of that.
3. **Domains:** several repositories, the shared domain `.git`, worktrees, `--base`/`--fetch`, checkout locks, the board, the domain's environment (one repository's spec, or composed), its template and package caches (C3, C4); two domains with one repository; the root's view (section 6.5). Exit:
   - two workspaces on one repository in different worktrees, with commits from both and no corruption;
   - the main checkout refused to a second workspace;
   - each domain sees none of the other's work;
   - in the root, `git fetch --all` shows both domains' branches, and `git push <domain>` delivers between them;
   - Vite on 5173 in two workspaces of one domain, each at its own URL;
   - a second workspace in a domain starts within section 4.7's target;
   - **no cross-domain poisoning:** a workspace in domain A writes into every cache it can reach (its template, its package cache, `/desolate/mirrors`, the registry), and a workspace in domain B sees none of it. The control is the same write showing up for a second workspace in domain A.
4. **Secrets and policy per domain:** everything in section 7, audited per workspace. Exit: v2's proxy tests, plus attribution by link.
5. **Offers and pushes:** `offer`, the request channel, import by bundle, review in the root clone, push with the write key and its confirmation, `--expect`, exit codes, LFS uploads first. Exit:
   - an LFS file made in a workspace reaches the remote, and its object with it;
   - `desolate upstream` on an offered consumer branch pushes a `downstream/...` branch to a test dependency with suede's pinned script, and the dependency's Action opens its PR;
   - a push is impossible without a person's action: the test tries every automation path, and the write key's every use is audited;
   - the root never fetches from a domain clone path. The test plants a crafted domain repository whose `upload-pack` config would run a command, and checks it never runs.
6. **Root UI and agents:** the panel's model as the root UI (Needs you, domains, offers, review and push), the root editor if chosen ([question 10](#14-open-questions)), the dispatcher ported. Exit: the extension browser test's scenarios, rewritten for the root UI.
7. **Hardening:** a degraded-preflight run (nothing may pass when nothing can be asked), the incidents page, and the README with P1–P6 stated as principles.

Acceptance scenarios, run end to end (T4, and in T2/T3 with the stand-in GitHub) before calling v3 done:

- **Suede, scripted:** section 9.2's script, run unattended from the Mac. It creates the domain, starts the workspace and runs the agent, which offers. The script cannot push, even when it tries: the test has it call `desolate push`, `desolate upstream` and `git push origin` in the root, and each is refused for want of the confirmation. A person runs `desolate upstream` on the offer. The dependency gets its `downstream/...` branch and its Action's PR, and the consumer's remote is never written.
- **Suede, tampered:** the agent's offered branch also edits the vendored `.suede/core/upstream` to push elsewhere, and its `.gitrepo` to name another pushable repository. `desolate upstream` runs its pinned copy, so the edit never runs, flags the change in the review, and refuses the `.gitrepo` mismatch.
- **Inspect only:** a domain with one repository cloned `--no-push`. An agent clones, builds and reports; no write key exists for it anywhere.
- **Two agents, one repository:** separate worktrees; the board shows both.
- **Two domains, one repository:** separate domain clones; neither sees the other's branches; both borrow one mirror.
- **LFS round trip:** an LFS file checked out in a workspace, changed, offered, pushed; the remote serves the new object.
- **A hostile repository:** its `postinstall` tries each of these, and each is refused, with the refusal attributed:
  - read a key;
  - reach the root UI, the Mac, the LAN, or another domain's workspace;
  - write the mirror;
  - plant a hook or `.lfsconfig` that the root runs;
  - exfiltrate a secret toward a host it is not for;
  - push.

## 14. Open questions

**Settled by the owner (2026-11-11):**

1. **The name:** *domain* (section 2).
2. **A workspace's unit:** the VM with its editor attached. It is a place for someone to work: a coding agent, a person, or both together.
3. **The VM shape:** A, a VM that hosts the devcontainer (section 4.2).
4. **The suede factory:** it automates up to the offer, and a person pushes (sections 5.5, 9.2). No unattended proposal pushes in v3.
10. **The root UI:** a root editor, with the desolate extension reworked to be visual, approachable and fast (sections 4.6, 4.8).

**For the implementing agent to decide, by research and measurement.** For each, record the evidence and the choice in `docs/v3/decisions.md`. The proposal is the default if the evidence doesn't point elsewhere.

5. **Where storage lives:** the Mac's disk, shared by virtiofs (proposed), or the root VM, exported over a network filesystem.
6. **Is one domain `.git` over virtiofs, written by several VMs, safe enough?** If not, each workspace gets its own clone (still borrowing from the mirror) and the domain shares work through bundles between them.
7. **How fresh is the mirror?** Refreshed on request only (proposed), or also on a timer.
8. **How much LFS history the mirror holds:** branch tips plus on request (proposed), or everything.
9. **Resource limits:** per workspace, with a domain default (proposed).
11. **A domain's environment:**
    - one repository's spec by default, a composed spec as the option (proposed);
    - the merge built as a published tool, `suede.devcontainer-compose` (proposed).
12. **Raw TCP ports shared by number:** first come, with the others reserving the port (proposed), or always remap.
13. **A cross-domain artifact cache in the proxy (C7):** later, and only if measured misses matter (proposed).
14. **Where checkouts live, for speed:** decided by Phase 0's `npm ci` numbers: the host share, each VM's own disk, or shared with dependency and build directories on VM-local volumes.
15. **The VM substrate:** Lima/vz, Apple Container or microsandbox, decided by Phase 0 (section 13). It sits behind one interface, so the choice can change.
