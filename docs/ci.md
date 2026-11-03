# CI, and tests in a clean environment (issue #31)

**Decision: do not build a CI/test-environment facility into the stack.** Keep
the project's own devcontainer as the place tests run, add a thin hosted CI
run for the one thing a devcontainer cannot prove, and write down what each
layer does and does not prove.

## What the issue asks, and what answers each part

| Concern | Answer |
|---|---|
| An agent's green run can depend on something it installed or configured in its own environment | The agent's environment is not a clean room, so its green is evidence, not proof. A **fresh** environment is. That is `tests/run.sh environments` (Dockerfiles built from nothing, no daemon in `runtime`) and a hosted CI job, which starts from a clean checkout every time. |
| Parameterise tests at the system level | Already how the suite is built: one directory under `tests/environments/` per runtime, each a Dockerfile. A new axis (another node version, no `mitmproxy`) is one more directory or a build arg, not a framework. |
| Other OSes (macOS, Windows) | Out of reach from this stack, as the issue notes. The Mac-only suites (`integration/stack`, the probes) stay a human's run on the Mac, and say so (they skip rather than fake). |
| A customisable runner is redundant with "hop into the devcontainer" | Agreed. The project's suite is project-specific; the stack should not own it. |

## What to do

1. **Agents** run `./tests/run.sh` (static + unit) in the devcontainer while
   working, and `./tests/run.sh environments` before declaring done when they
   touched anything the shipped images depend on (the `COPY` list, pinned
   toolchain). Say in the PR which layers ran and which skipped.
2. **Hosted CI** (`.github/workflows/tests.yml`) runs `npm ci` then
   `./tests/run.sh` on a clean `ubuntu-latest`. `npm ci` matters: the type check
   skips without `typescript`, and a skipped check is green for the wrong
   reason. The proxy tests need `mitmproxy==11.0.2` and pytest in a venv; the
   workflow installs them for the same reason.
3. **Review** treats "passed in the agent's environment" as weaker than "passed
   in CI". A reviewer who wants the clean-room answer reads the CI result; it
   needs no new machinery.

## Deliberately not done

- No per-project "run my tests in a fresh container" command in `desolate`.
  Projects that want it already have `docker compose` / a `Dockerfile` and can
  call it from their own test script; the stack's value is isolation, not
  test orchestration.
- No attempt at OS matrices beyond what GitHub's runners offer. Add a
  `macos-latest` leg to the workflow only if a unit-level portability bug
  actually bites; the shipped runtime is Linux.
- `environments` and `integration` are not in hosted CI: they need a docker
  daemon with (for the latter) sysbox, which `ubuntu-latest` lacks. `environments`
  could be added as a second job later; it is the cheapest next step if
  environment drift shows up.

## Revisit if

An environmental change makes a test pass that fails on a fresh install and CI
did not catch it (then the gap is in CI's coverage, extend the workflow), or a
downstream project asks the stack for a clean-room runner (then it is a
feature request with a real user, not a speculative one).
