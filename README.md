# Isolated Devcontainers Suede

**desolate** (dev + isolate) is a browser-based, container-isolated VS Code
environment for macOS. Projects run as devcontainers inside an unprivileged
Docker-in-Docker daemon in a Colima VM, reached through a browser tab rather
than a desktop editor. A compromised project cannot reach your Mac, your
credentials, or another project -- and secrets never enter a container at all:
they live in the VM, and an intercepting proxy substitutes them in flight,
only toward each secret's allowlisted hosts.

Full documentation is in **[`release/README.md`](release/README.md)** --
architecture, setup, the isolation model, and what it deliberately does *not*
guarantee.

This repo is a [suede dependency](https://github.com/pmalacho-mit/suede). 

To see the installable source code, please checkout the [release branch](https://github.com/pmalacho-mit/isolated-devcontainers-suede/tree/release).

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
prescribed by the suede dependency workflow, and it is worth respecting when
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
