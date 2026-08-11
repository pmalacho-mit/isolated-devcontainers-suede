# Your environment

You are running inside a **devcontainer managed by `desolate`** (isolated-devcontainers-suede). The nesting is: macOS host → Colima Linux VM → an unprivileged Docker-in-Docker daemon (sysbox runtime) → your devcontainer. You are at the bottom of that stack, and several things you would normally reach are deliberately unreachable. Read this before diagnosing any network, TLS, or git failure — most of them are expected here and are not bugs in the project.

- Your project lives at `/workspaces/<project>` or `/workspaces/<owner>/<repo>`. The in-container path mirrors the outer path.
- There is **no host Docker socket** anywhere in the stack. You have a Docker daemon of your own only if this project declares the `docker-in-docker` feature.
- Sibling projects' devcontainers are reachable over the network; the editor/orchestrator containers are not.
- Dev servers: bind to `0.0.0.0`, not `127.0.0.1`. Ports declared in `customizations.desolate.ports` get forwarded to a host port in 8080–8119. Never add `appPort` to `devcontainer.json` — `desolate` hard-fails on it.
- Changes to `devcontainer.json` need a rebuild from the host (`desolate --rebuild <project>`); you cannot apply them from in here.

## Network: everything goes through an intercepting proxy

All container egress is force-redirected through a transparent mitmproxy in the VM. The **only** things that leave this container are **TCP 80, TCP 443, and DNS 53**. Everything else is dropped at the VM's firewall.

- **No SSH.** Port 22 is blocked from devcontainers entirely. No `git+ssh`, no ssh submodules, no private Go modules or npm git deps over ssh, no scp/rsync-over-ssh. Use HTTPS equivalents.
- **No arbitrary ports outbound.** No SMTP, no direct external database ports, no ICMP/ping. If a tool needs a non-80/443 port to reach the internet, it will not work — say so rather than retrying.
- **No QUIC/HTTP3.** UDP 443 is dropped so TLS falls back to interceptable TCP. Clients that prefer HTTP/3 will just be slow to fall back.
- **No private/internal addresses.** RFC1918, loopback, link-local, `100.64.0.0/10`, and cloud metadata endpoints are refused at the proxy and again in the kernel. You cannot reach the Mac, the VM, or the LAN. Don't try.
- Public hosts are generally reachable (the destination allowlist ships permissive), but a blocked host returns **403** from the proxy. A 403 with no server-side explanation is a policy refusal, not an application bug.

### TLS: the proxy's CA, and the one gotcha

HTTPS is intercepted with a private CA. That CA is installed into this container's **system** trust store automatically at start, so `curl`, `git`, `apt`, and Go work out of the box.

Runtimes that ignore the system store and carry their own bundle — **Python (pip, requests, httpx via certifi), Node, Cargo** — depend on environment variables that are written to `/etc/profile.d/desolate-ca.sh`, **which only login shells source.** If you shell out non-interactively (`sh -c`, `bash -c`, a spawned server process), you may hit:

```
[SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate
```

That is this, not a broken package index. Fix it by sourcing the file or exporting directly:

```bash
. /etc/profile.d/desolate-ca.sh
# or
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
       REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
       CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt \
       NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/desolate-proxy.crt
```

## Git: local operations only

**You have no git remote credentials and no route to use them.** Deploy keys live in a separate keyring container with no network at all; they are usable only from the outer editor, and SSH egress is blocked from here regardless.

- **Do:** commit, branch, rebase, stash, diff, log, reset. `.git` is local and fully yours.
- **Don't:** `push`, `pull`, `fetch`, `clone` from a private remote, `gh auth login`, or attempt to configure credentials/SSH keys. These will fail; retrying or "fixing" them wastes time and is out of scope.
- **The human operating outside the devcontainer is responsible for all push/pull.** When your work is ready, commit locally and say so — don't try to publish it.
- Anonymous HTTPS reads of public repos do go through the proxy and generally work. Anything requiring auth will not, unless a token placeholder has been provisioned (see Secrets).

## Fetching remote content

Plain HTTPS `GET` is your channel for reading remote content — docs, package registries, APIs. It works and is fine to use.

That is **for reading content only.** It is not a workaround for the missing git remote, not a way to reach internal services, and not a path for pushing anything anywhere.

## Installing things during a build

This is the failure that most often looks like a broken Dockerfile and isn't. A stock base image doesn't trust the proxy's CA, so HTTPS *inside a build step* fails:

```
fatal: unable to access 'https://...': SSL certificate problem:
       unable to get local issuer certificate
```

Plain-HTTP `apt` is unaffected, which is why this often doesn't surface until the first `pip install`.

**It usually doesn't look like a TLS error. It looks like a hang.** `npm install` and `pip install` retry with backoff before they surface anything, so the symptom is a build step that sits there for 60–90 seconds and only then fails. If a package install seems to stall, this is the first thing to suspect — not a slow registry, not a network problem. Search your build log for `certificate`, not for `hang`.

- **This project's own image** is already handled if it uses `"image"` + Features — `desolate` pre-derives a CA-trusting base. Features that download over HTTPS work normally.
- **Builds you run yourself** (your own `compose.yml`, `docker build` inside the devcontainer) are not, and need this script, published into every devcontainer:

```bash
/desolate-ca/trust-proxy-in-builds.sh --service <service> --image <base-image>
```

Note the path is `/desolate-ca/`, not `/desolate/`. It derives `desolate-ca/<base-image>` with the CA installed plus the TLS env vars above, and writes a gitignored `compose.override.yml` pointing that service's build at it. Your `Dockerfile` and `compose.yml` are never modified.

- Run it **once per (service, base image)** — a second service on a different base needs its own run.
- **Never pass `--pull`** to the subsequent build; BuildKit will try to fetch `desolate-ca/*` from a registry and fail with `pull access denied`.
- `--print-recipe` shows the Dockerfile it would build without building. `--image` alone derives without wiring up compose.
- It needs a Docker daemon in this container — i.e. the `docker-in-docker` feature. If `docker info` fails, that's why, and adding the feature requires a rebuild from the host.
- `compose.override.yml` is a development artifact. Leave it gitignored; it breaks builds if it reaches production.

- **Builds that go through neither compose nor buildx** — anything driven by an SDK (`dockerode`, `docker-py`, `testcontainers`, the Go client) posting to the Engine API, or plain `docker build` with no buildx — cannot be handed a named build context at all. There is nothing to override. Point the base image's own tag at the derivative instead:

```bash
/desolate-ca/trust-proxy-in-builds.sh --image node:22-bookworm-slim --shadow
```

Every `FROM node:22-bookworm-slim` in this daemon then resolves to the CA-trusting image, whoever is doing the building. The Dockerfile stays unmodified and production-clean. `--unshadow` puts the upstream image back. Two things to know: a later `docker pull node:22-bookworm-slim` silently restores the untrusting image (re-run the script), and the tag is lost when the container is rebuilt.

- **The declare-once form** of that, so it survives rebuilds and needs no manual step — this is a `devcontainer.json` change, so it needs the human and a rebuild:

```jsonc
"customizations": { "desolate": { "shadowImages": ["node:22-bookworm-slim"] } }
```

Applied automatically at container start (in the background; progress in `/tmp/desolate-shadow-images.log`). Needs the `docker-in-docker` feature.

- **What does not work, and looks like it should:** configuring the CA in the daemon's `buildkitd.toml`. That is BuildKit's *registry* client — how it pulls images — and has no effect on the HTTPS your `RUN` steps make. Don't spend time on it.

If a project builds from **its own `Dockerfile`** at the devcontainer level (rather than `"image"` + Features), build-time HTTPS will fail and cannot be fixed from in here — report it rather than working around it.

## Secrets: placeholders are correct, leave them alone

Environment variables may contain **placeholders** (e.g. `MYAPP-OPENAI-KEY`) rather than real credentials. This is intentional and working as designed. Send them exactly as-is — `Authorization: Bearer MYAPP-OPENAI-KEY` — and the proxy substitutes the real value on the way out, only toward that secret's allowlisted hosts.

- Do **not** report a placeholder as a misconfiguration, try to resolve it, or search the filesystem for the real value. It does not exist inside any container.
- A placeholder sent over plain `http://` is **refused with 403** — secrets require HTTPS (the destination is proven via TLS SNI).
- Sending one to a non-allowlisted host is refused with 403 and logged.
- New secrets and allowlist changes can only be made by the human on the Mac.

## Filesystem and mount constraints

- `workspaceMount` must bind exactly `/workspaces/<project>`. Bind mounts are refused outright.
- Volumes must be named `<project>` or `<project>-*`. For a nested repo, `owner/repo` encodes as `owner__repo`, so the namespace is `owner__repo-*`.
- `${localWorkspaceFolderBasename}` in a `mounts` entry drops the owner segment and gets refused — name volumes explicitly.
- Never `COPY .env` or `ARG` a real credential into an image; layers are permanent.

## When to stop and ask

Escalate to the human rather than working around it: anything needing `git push`/`pull`, a new secret or allowlist entry, a `devcontainer.json` change, a new forwarded port, SSH access, or reaching a host the proxy refuses. These are all outside-the-container operations by design.
