# Isolated Devcontainers Suede (`desolate`)

**desolate** (dev + isolate) is a browser-based, container-isolated VS Code
environment for macOS[^1].

It's goal is to enable human developers to work alongside coding agents
without sacrificing developer experience nor sandbox isolation.

Whether or not you trust LLMs, supply chain attacks are on the rise.
Paired with the inherit [vulnerabilities](https://blog.theredguild.org/leveraging-vscode-internals-to-escape-containers/) of running VS Code natively[^2],
executing code has never been more dangerous.

In essence, `desolate` allows the developer to sandbox themselves along with their agent(s),
all without giving up the ergonomics key to their workflow.

[^1] The `desolate` architecture should be applicable to both Windows (with WSL2) + Linux, and could be even simpler without the need for a Linux VM. [@pmalacho-mit]() is on a mac, so contributions are welcome. [See more]().

[^2] As the Red Guild's ["Leveraging VSCode internals to escape containers."](https://blog.theredguild.org/leveraging-vscode-internals-to-escape-containers/) explains, VS Code is a ripe <ins>local</ins> attack surface even when connecting to remote development environments.

This repo is a [suede dependency](https://github.com/pmalacho-mit/suede).

To see the installable source code along with the full documentation, please checkout the [release branch](https://github.com/pmalacho-mit/isolated-devcontainers-suede/tree/release).

## At a glance

Projects run as devcontainers inside an unprivileged
Docker-in-Docker daemon in a Colima VM, reached through a browser tab rather
than a desktop editor. A compromised project cannot reach your Mac, your
credentials, or another project -- and secrets never enter a devcontainer at all:
they live in the VM, and an intercepting proxy substitutes them in flight,
only toward each secret's allowlisted hosts.

## System Requirements

- MacOS
- Colima (`colima`)
- Github CLI (`gh`)

## Installation

```bash
bash <(curl https://suede.sh/install/release) --repo pmalacho-mit/isolated-devcontainers-suede
```

<details>
<summary>
See alternative to using <a href="https://github.com/pmalacho-mit/suede#suedesh">suede.sh</a> script proxy
</summary>

```bash
bash <(curl https://raw.githubusercontent.com/pmalacho-mit/suede/refs/heads/main/scripts/install/release.sh) --repo pmalacho-mit/isolated-devcontainers-suede
```

</details>

## Working on this repo

`release/` is the **shipped tree** -- everything in it installs onto a user's
Mac. Everything else is dev and test harness and does not ship. That split is
prescribed by the suede dependency workflow, and must be respected when
adding files.

```
release/                 THE SHIPPED TREE
  cli.sh                 the only command you run on the Mac
  docker-compose.yml     the stack; heavily commented, read it first
  preflight.sh           post-start verification, incl. the containment proof
  observe.sh             host-side view of the inner daemon (no port published)
  vm/                    VM provisioning: install.sh + install-sysbox.sh
  proxy/vm/              egress+secrets layer: mitmproxy addon, nftables,
                         dnsmasq, systemd units
  vscode-image/          one image, two roles -- broker.ts (orchestrator) and
                         the editor; policy.ts is the spec policy, pure and
                         unit-tested
samples/                 example devcontainers; fixtures, NOT shipped
tests/                   static / unit / integration -- see tests/README.md
.devcontainer/           the INSECURE bootstrap container this work happens in
```

```bash
./tests/run.sh           # static + unit; fast, no docker daemon needed
```

The densest source of design rationale is the comment block at the top of
`release/docker-compose.yml`, then the header of `release/vscode-image/broker.ts`
("WHY THE POLICY CHECK MATTERS").

Two conventions the code holds to, both load-bearing:

- **Fail closed.** `broker.ts` refuses anything it cannot resolve, `cli.sh up`
  refuses to run with egress unprotected, `install-sysbox.sh` verifies against
  `docker info` rather than trusting the package. A step that reports success
  while having done nothing is the failure mode this stack is most prone to --
  several real bugs have had exactly that shape.
- **Anything that speaks TLS goes through `with-ca`.** Proxy-CA trust is granted
  by exported environment variables, and `docker exec` inherits none of what an
  entrypoint exported. Two static tests enforce this on the image's wrappers and
  the compose entrypoints.
