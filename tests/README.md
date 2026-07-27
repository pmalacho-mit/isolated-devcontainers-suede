# tests

```bash
./tests/run.sh                 # static + unit -- fast, no docker daemon needed
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

| layer | needs | what it proves |
|---|---|---|
| `static/` | bash, jq, docker compose (config only) | the invariants decided by config alone: no daemon in the editor, loopback-only ports, sysbox runtime, nftables default-deny, and that the compose bridge name and `DESOLATE_IF` cannot drift apart |
| `unit/broker/` | node >= 22.18 | the spec policy, in isolation: every refused key, the runArgs allowlist, the JSONC scanner, and that the repo's own example projects still pass |
| `unit/proxy/` | python + mitmproxy + pytest | the addon's decisions: proven-destination vs claimed Host, allowlists, fail-closed on internal error, response scrubbing |
| `integration/broker/` | node >= 22.18, `devcontainer` on PATH | the real broker over its unix socket, enforcing on the real CLI's `mergedConfiguration`, with a stub runner. Also the TOCTOU snapshot |
| `integration/proxy/` | root, nft, docker, mitmproxy | the addon under a real transparent proxy with real nftables REDIRECT, checking what an attacker-controlled server actually received |
| `integration/stack/` | docker daemon with `sysbox-runc` | the whole stack, attacked from inside the editor container |

`static` and `unit` are the CI set: no daemon, no VM, no network.

## Where each suite can actually run

This matters more than it looks, because several suites cannot run in the
`.devcontainer/` you are probably reading this from.

| Suite | Runs in | Why |
|---|---|---|
| `static` | devcontainer or Mac | `docker compose config` needs **no** daemon |
| `unit` | devcontainer or Mac | pure node + python |
| `integration/broker` | devcontainer or Mac | needs the `devcontainer` CLI on PATH |
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
