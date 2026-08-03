# Containerised test environments

Each subdirectory is one environment: a `Dockerfile` describing a runtime, and
the tests that only mean something inside it. `./tests/environments/run.sh`
builds and runs them.

```bash
./tests/environments/run.sh              # every environment
./tests/environments/run.sh runtime      # just one
./tests/environments/run.sh --keep       # leave containers for poking at
```

## Why not one container

The environments differ in what they are allowed to touch, and merging them
would mean the weakest isolation wins. `runtime` gets no docker socket at all,
so a test that quietly starts depending on a daemon fails there instead of
passing everywhere. `daemon` gets one, and is the only place that can.

Splitting them also keeps each Dockerfile short enough to read, and lets the
slow one be skipped when its prerequisites are missing.

## The environments

| directory  | mirrors                            | needs           |
|------------|------------------------------------|-----------------|
| `runtime`  | the vscode-image node/tsx toolchain | nothing         |
| `daemon`   | the orchestrator's docker CLI       | a docker socket |

### `runtime`

The shipped image pins `NODE_VERSION` and installs `tsx` at a pinned version;
this repo's own devcontainer has whatever node it has. Those differ, and the
difference is invisible until the image is built. This environment runs the
unit suite on the pinned toolchain, with no daemon reachable.

It also imports every module the image ships, which is the check that would
have caught a module extracted during a refactor and left out of the
Dockerfile's `COPY`.

### `daemon`

The operations in `docker.ts` build argv for a program this repo does not
control. The unit suite asserts the argv is what we intended; this environment
asserts the docker CLI actually accepts it -- an `--opt` the daemon rejects, or
a `--mount` spec the devcontainer CLI refuses, is only visible here.

Sysbox is deliberately out of scope: the containment layer needs the Colima VM,
so `tests/integration/stack` remains the place for it.

## Adding one

Create `tests/environments/<name>/Dockerfile` and put the tests beside it. The
Dockerfile must end with a `CMD` that runs them and exits non-zero on failure.
`run.sh` mounts the repo at `/repo` read-only and discovers the directory
automatically. Declare a socket requirement by creating a `needs-docker` file
next to the Dockerfile, so the environment skips cleanly rather than failing
where no daemon exists.
