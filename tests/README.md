# tests

```bash
./tests/run.sh                 # static + unit -- fast, no docker daemon needed
./tests/run.sh environments    # the unit suite on the shipped toolchain
./tests/run.sh integration     # starts containers
./tests/run.sh all
```

## What is here, and why

The design has two places where a mistake is invisible: the broker's spec
policy and the egress proxy's substitution rule. Both fail *quietly* -- a
weakened policy still starts your containers, and a weakened proxy still
serves your requests. Nothing goes red. So the suite is built around
**executing the attacks** rather than asserting that the code looks right.

Every case named `E<n>` corresponds to an escape that was demonstrated against
this repo, with the real `@devcontainers/cli` or a real transparent mitmproxy.
They are regression tests. If one starts passing again, that escape is live.

Several of them turn on a disagreement between this repo's reading of a string
and someone else's -- the CLI's JSONC parser (`E4`), docker's `--mount` field
parser (`E10`, `E11`), docker's last-label-wins rule (`E12`), node's `cpSync`
(`E13`). When you add one of those, verify the OTHER side's behaviour by running
it, not by reading its documentation: `E13` exists because `{dereference: true}`
does not dereference, which the docs do not say.

Two more turn on WHERE the CLI reads, not how it parses. `--override-config`
changes which JSON is read and nothing else, so `build.context` still resolves
against the live project (`E14`: `"context": "../.."` built an image holding a
sibling project's file) and a local feature's metadata is read again at build
time, after the policy has approved the first read (`E15`: swapping it in
between produced `--privileged --mount type=bind,src=/,dst=/host` from a
snapshot that said `harmless`). Both were measured, not deduced.

| layer | needs | what it proves |
|---|---|---|
| `static/` | bash, jq, docker compose (config only) | the invariants decided by config alone: no daemon in the editor, loopback-only ports, sysbox runtime, nftables default-deny, and that the compose bridge name and `DESOLATE_IF` cannot drift apart |
| `static/09-typecheck.sh` | `typescript` (skips without it) | that the TypeScript parts still AGREE. node runs these files by *stripping* types, so a type error is neither a syntax error nor a runtime one -- `node --check` and every unit test pass straight through it. This is the only thing watching the four processes that share one grammar (`args.ts`, `broker.ts`, `desolate.ts`, `desolate-client.ts`) |
| `unit/broker/` | node >= 22.18 | the spec policy, in isolation: every refused key, the runArgs allowlist, the mount-field allowlist and its alias rule, the JSONC scanner, the spec snapshot's copying, and that the repo's own example projects still pass |
| `unit/desolate/` | node >= 22.18 | the runner's pure parts: the command line, port allocation, the docker argv, the overlay volume names, the editor script's interpolation guards, the keyring's path layout |
| `unit/proxy/` | python + mitmproxy + pytest | the addon's decisions: proven-destination vs claimed Host, allowlists, fail-closed on internal error, response scrubbing |
| `environments/` | docker daemon | the unit suite re-run inside containers that mirror the shipped runtime -- the pinned node/tsx, and the docker CLI actually accepting the argv `docker.ts` builds |
| `integration/broker/` | node >= 22.18, `devcontainer` on PATH | the real broker over its unix socket, enforcing on the real CLI's `mergedConfiguration`, with a stub runner. Also the TOCTOU snapshot |
| `integration/keyring/` | node >= 22.18, openssh-client | the real keyring process behind its real control socket: that no private key reaches the volume the editor mounts, and that a client cannot kill it |
| `integration/proxy/` | root, nft, docker, mitmproxy | the addon under a real transparent proxy with real nftables REDIRECT, checking what an attacker-controlled server actually received |
| `integration/stack/` | docker daemon with `sysbox-runc` | the whole stack, attacked from inside the editor container |

`static` and `unit` are the CI set: no daemon, no VM, no network. The type check
holds to that too -- it uses the `typescript` pinned in `package.json` (or a
`tsc` already on PATH) and never downloads one, so it SKIPS rather than
weakening the promise. `npm install` is what turns it on; CI should run that
first, or the check is green because it never ran.

## Where each suite can actually run

This matters more than it looks, because several suites cannot run in the
`.devcontainer/` you are probably reading this from.

| Suite | Runs in | Why |
|---|---|---|
| `static` | devcontainer or Mac | `docker compose config` needs **no** daemon |
| `unit` | devcontainer or Mac | pure node + python |
| `environments` | devcontainer or Mac | builds images; needs a reachable daemon |
| `integration/broker` | devcontainer or Mac | needs the `devcontainer` CLI on PATH |
| `integration/keyring` | devcontainer or Mac | needs ssh-agent/ssh-add/ssh-keygen |
| `integration/proxy` | Linux, as root | loads real nftables rules; skips elsewhere |
| `integration/stack` | **Mac only** | needs Colima + sysbox; refuses to fake it |

The devcontainer has `docker-outside-of-docker`, so `docker` there talks to
whatever daemon the Mac exposes. That is fine for rendering compose and for the
broker tests, but it is **not** the sysbox daemon -- do not expect the stack to
come up from inside it.

## Three roots -- pick the right one

`tests/lib/harness.sh` defines three, and they are not interchangeable:

```
ROOT     the repo    -- only for repo-wide concerns (git hygiene)
RELEASE  release/    -- everything under test
SAMPLES  samples/    -- example devcontainers; fixtures, not shipped
```

Conflating `ROOT` and `RELEASE` is exactly the bug that once silently disabled
21 assertions: paths resolved, files were found, every assertion passed, and
none of them was looking at the shipped tree. If you add a case, pick
deliberately.

## Setting up the optional dependencies

```bash
# proxy tests
python3 -m venv /tmp/desolate-test
/tmp/desolate-test/bin/pip install 'mitmproxy==11.0.2' pytest
export DESOLATE_PYTHON=/tmp/desolate-test/bin/python
export DESOLATE_MITMDUMP=/tmp/desolate-test/bin/mitmdump

# broker integration
npm install -g @devcontainers/cli
```

Pin mitmproxy to the version `release/proxy/vm/install.sh` installs. The addon is the
whole secrets boundary and mitmproxy responds to an addon exception by
forwarding the request unmodified, so testing against a different version than
you run is testing the wrong thing.

## The full-stack test

`integration/stack/` brings up a second, isolated copy of the stack
(project `desolate-test`, ports 3100 and 8180-8190) so it can run
beside a live one. It **skips rather than degrades** when `sysbox-runc` is
absent: running dind privileged to make the test pass would be asserting the
opposite of what the test is for.

```bash
DESOLATE_TEST_KEEP=1 ./tests/integration/stack/run.sh   # leave it up afterwards
docker compose -p desolate-test down -v            # then tear it down
```

## Adding a case

A new refusal in `release/vscode-image/policy.ts` wants two tests: one in
`unit/broker/policy.test.ts` for the reasoning, one in
`integration/broker/broker.test.ts` proving it never reaches the runner. A new
rule in `release/proxy/vm/addon.py` wants a unit case and, if it depends on how packets
actually flow, a case in `integration/proxy/run.sh` -- that distinction is
exactly where the Host-header exfiltration lived.

## probes/

Not tests. A probe answers a *capability* question about the environment so a
design decision can be made -- it asserts no invariant, gates nothing, and is
not run by `run.sh`. Run one by hand when you need its answer, and delete it
once the question is settled.

| probe | question | run it |
|---|---|---|
| `dind-overlay-volume.sh` | can each project get a private copy-on-write view of the shared editor server, instead of a read-only bind? | **answered yes; the design now depends on it.** Kept as the diagnostic for when `desolate` refuses to build one |
| `nested-sysbox.sh` | does sysbox nest inside sysbox on this kernel? If it does, every devcontainer becomes user-namespaced and `allowPrivileged` can be deleted rather than merely audited | **Mac, VM with sysbox; the stack need not be up** |
| `sibling-docker.sh` | `SPEC-per-project-dind-v2` proposes replacing the docker-in-docker feature with a bind-mounted socket of the project's own dind, so the agent's containers become siblings and the devcontainer stops being `--privileged`. Can a devcontainer with only the CLI and that socket still build, `compose up`, and bind-mount from `/workspaces`? | **answered yes 2026-08-17; four of its answers changed the spec.** Re-run it when the socket wiring or the workspace mount changes. `--runc` runs it wherever a daemon is reachable, stamped as an approximation |
| `rootless-dockerd.sh` | the alternative that same spec asks to price alongside it: keep the ONE shared dind, and run a *rootless* dockerd inside an unprivileged devcontainer. Same "no `--privileged`" outcome, no new stack components -- and no blast-radius containment | **answered no 2026-08-17**, at its first question: the VM's `apparmor_restrict_unprivileged_userns` refuses the user namespace rootless docker is built on |
| `loopback-cookie-scope.sh` | the editor and every project's dev server share `127.0.0.1`, and cookies are scoped by host and not by port -- can a page served by one devcontainer read the main editor's credential out of the shared jar? | **Mac, live stack** |
| `devnet-reachability.sh` | the nftables forward chain ends in a drop, but container-to-container traffic on the same bridge is switched rather than routed -- does the drop actually cover it? | **Mac, live stack** |

The last two are open questions, not settled ones. Each has a companion
`README-*-fixes.md` next to it: run the probe, read the row of its table that
matches what you got, and only then pick a fix. Both probes are read-only and
neither sends anything to a devcontainer.
