#!/usr/bin/env bash
# PROBE -- not a test. Answers a capability question about the environment so a
# design decision can be made; it asserts no invariant and gates nothing.
#
# QUESTION: does a REAL devcontainer built with the `docker-outside-of-docker`
# feature work against a project dind, unprivileged -- and exactly which mounts
# does desolate have to give it?
#
# `sibling-docker.sh` answered the socket question with `docker:29-cli` standing
# in for the devcontainer. That modelled the socket and nothing the feature
# itself does. The feature has opinions: it declares a mount of its own, it
# installs an entrypoint (`docker-init.sh`) that runs at every start, and that
# entrypoint may proxy one socket path to another with socat. Any of those can
# fight a socket desolate binds. This probe builds `samples/sample-siblings`
# with the real devcontainer CLI and finds out. Each F is one way it fails:
#
#   F1  METADATA   what the feature declares, read back from the built image's
#                  `devcontainer.metadata` label: its mounts, entrypoint, and
#                  any privilege. This is what policy.ts will see (T3.3), and
#                  the plan assumed its mount targets /var/run/docker.sock.
#   F2  SUBPATH    the project dind's /workspaces is a `volume-subpath` of ONE
#                  project, on this daemon. Refused here means Phase 3 cannot
#                  ship as designed.
#   F3  FEATURE    `devcontainer up` with ONLY the feature's own mount, the dind
#                  providing /var/run/docker.sock as a link to its socket: does
#                  uid 1000 reach the daemon?
#   F4  INJECTED   the same plus desolate's own bind of the socket FILE at
#                  /var/run/docker.sock (Q2's narrow placement): does
#                  docker-init.sh fight it, and does uid 1000 still reach it?
#   F5  INIT       the feature's entrypoint ran without an error and left the
#                  container running.
#   F6  PRIVILEGE  in each variant, the devcontainer's PID 1 holds exactly
#                  docker's DEFAULT capability set (00000000a80425fb -- an
#                  ordinary container's root; --privileged is 000001ffffffffff)
#                  and the remote user holds none: nothing above needed
#                  --privileged or an added capability.
#   F7  PATHS      from inside, `docker run -v /workspaces/<p>:/x` reads what the
#                  devcontainer wrote: the same path means the same directory
#                  through the subpath mount.
#   F8  REACH-BACK from inside, `docker run -v /workspaces:/x` sees ONLY this
#                  project -- the containment v2 rests on, measured with the
#                  real image rather than the CLI stand-in.
#
# The SUMMARY ends with the mount strings each variant actually had, read from
# `docker inspect` on the project dind, so desolate.ts can emit exactly those.
#
# APPROXIMATION 2026-10-26, --runc in this repo's own .devcontainer (docker
# 29.9.2, devcontainer CLI 0.88.0): HOLDS, and two answers change Phase 3.
#   F1  the feature declares ONE mount, and not the one the plan assumed:
#       `type=bind,source=/var/run/docker.sock,target=/var/run/docker-host.sock`,
#       plus `"securityOpt": ["label=disable"]` and the entrypoint
#       /usr/local/share/docker-init.sh. T3.3's single bind exception is THIS
#       bind (source = dind.socket.alias), and label=disable must pass on a
#       project-daemon target.
#   F3  that mount alone is enough: docker-init.sh socat-proxies
#       docker-host.sock to a /var/run/docker.sock owned by the remote user, and
#       uid 1000 reaches the daemon. F4: desolate's own bind of the socket at
#       /var/run/docker.sock also works, but docker-init.sh lays a fresh socket
#       over it -- so T3.2 need inject NO mount; the dind's alias link does it.
#   F2/F7/F8 the subpath dind sees one project; a sibling's bind of the project
#       path is the devcontainer's own directory; /workspaces shows only it.
#   F6  PID 1 holds docker's default set (a80425fb), the remote user none.
# Still owed: the same run under sysbox on the VM.
#
# ---------------------------------------------------------------------------
# HOW TO RUN -- on your Mac, from a checkout that has samples/sample-siblings.
# The stack must be UP: the devcontainer CLI comes from the orchestrator's own
# image, so the CLI under test is the one desolate ships.
#
#   ./tests/probes/sibling-feature.sh
#
# It re-execs itself INSIDE the Colima VM and creates ONE throwaway dind named
# desolate-sfprobe-dind, throwaway helper containers, four throwaway volumes and
# a few desolate-sfprobe/* images, and removes all of it on exit including on
# failure. It does not touch the desolate stack's containers, any project, or
# anything on your Mac. Expect several minutes on a first run: it builds the
# feature into an image on the VM daemon, then hands that image to the dind.
# Paste the SUMMARY block back.
#
# DESOLATE_SFPROBE_KEEP=1 leaves the throwaways up and prints how to remove
# them.
#
# Without sysbox -- e.g. from this repo's own .devcontainer -- pass --runc. The
# dind then runs --privileged, and the CLI comes from a node directory and the
# repo's node_modules (DESOLATE_SFPROBE_NODE, DESOLATE_SFPROBE_CLI_JS) mounted
# into a debian helper. Where the outer daemon's builds go through the desolate
# proxy, DESOLATE_SFPROBE_CA=<pem> derives a CA-trusting base first, as
# desolate.ts does in production. Stamped APPROXIMATION.
#
# NOTE ON EGRESS: the dind never pulls or builds anything that needs the
# network. The outer daemon builds the feature image and hands it over with
# `docker save`, so every F is about mounts and sockets, not about egress.
set -uo pipefail

PROFILE="${COLIMA_PROFILE:-desolate}"
RUNTIME="${DESOLATE_SFPROBE_RUNTIME:-sysbox-runc}"

for arg in "$@"; do
  case "$arg" in
    --runc) RUNTIME=runc ;;
    *) echo "unknown argument '$arg' (only --runc is understood)" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Stage 0: get inside the VM, carrying the sample with us. Flags do not survive
# `bash -s` and the VM cannot see this checkout, so the runtime and the sample
# both travel as environment variables.
# ---------------------------------------------------------------------------
if [ "${DESOLATE_SFPROBE_INVM:-}" != 1 ]; then
  if ! command -v colima >/dev/null 2>&1; then
    echo "This probe must run from the Mac (colima not found on PATH)." >&2
    echo "If you are already somewhere with a usable daemon, re-run with" >&2
    echo "DESOLATE_SFPROBE_INVM=1 (and --runc if it has no sysbox-runc)." >&2
    exit 1
  fi
  REPO=$(cd "$(dirname "$0")/../.." && pwd)
  [ -f "$REPO/samples/sample-siblings/.devcontainer/devcontainer.json" ] || {
    echo "no samples/sample-siblings in $REPO -- run this from a checkout that has it" >&2
    exit 1
  }
  SAMPLE=$(tar -C "$REPO/samples" -czf - sample-siblings | base64 | tr -d '\n')
  echo "== entering the Colima VM (profile '$PROFILE') =="
  exec colima ssh -p "$PROFILE" -- \
    env DESOLATE_SFPROBE_INVM=1 DESOLATE_SFPROBE_RUNTIME="$RUNTIME" \
        DESOLATE_SFPROBE_SAMPLE="$SAMPLE" bash -s < "$0"
  echo "could not enter the VM via 'colima ssh -p $PROFILE'." >&2
  exit 1
fi

# When run in place (INVM=1 by hand), take the sample from this checkout.
if [ -z "${DESOLATE_SFPROBE_SAMPLE:-}" ]; then
  REPO=$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)
  DESOLATE_SFPROBE_SAMPLE=$(tar -C "$REPO/samples" -czf - sample-siblings 2>/dev/null | base64 | tr -d '\n')
fi

# ---- from here on `docker` is the daemon that will host the project dind ----

PROJ=sample-siblings
OTHER=another-project
DIND=desolate-sfprobe-dind
HELPER=desolate-sfprobe-cli
WS_VOL=desolate-sfprobe-ws          # stands in for the shared `workspaces` volume
DATA_VOL=desolate-sfprobe-data      # dind-data-<ns>
SOCK_VOL=desolate-sfprobe-sock      # carries the dind's socket to the CLI helper
CFG_VOL=desolate-sfprobe-cfg        # the override configs the CLI is handed
DEV_IMAGE=desolate-sfprobe/dev:latest
BASE_CA_IMAGE=desolate-sfprobe/base-ca:latest
CLI_BASE_IMAGE=desolate-sfprobe/cli-base:latest
DIND_IMG="docker:29-dind"
SOCK=/run/dind-sock/docker.sock
WSF=/workspaces/$PROJ

F1="UNKNOWN"; F2="UNKNOWN"; F3="UNKNOWN"; F4="UNKNOWN"
F5="UNKNOWN"; F6="UNKNOWN"; F7="UNKNOWN"; F8="UNKNOWN"
MOUNTS_A=""; MOUNTS_B=""

note() { printf '      %s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }
tail6(){ tail -n 6 | sed 's/^/        /'; }
stamp(){ [ "$RUNTIME" = runc ] && printf 'APPROXIMATION (runc) -- %s' "$1" || printf '%s' "$1"; }

vm()    { docker "$@"; }
inner() { docker exec "$DIND" docker "$@"; }

remove_throwaways() {
  vm rm -f "$DIND" "$HELPER" >/dev/null 2>&1
  vm volume rm -f "$WS_VOL" "$DATA_VOL" "$SOCK_VOL" "$CFG_VOL" >/dev/null 2>&1
  vm image rm -f "$DEV_IMAGE" "$BASE_CA_IMAGE" "$CLI_BASE_IMAGE" >/dev/null 2>&1
}
cleanup() {
  [ -n "${DESOLATE_SFPROBE_KEEP:-}" ] && {
    printf '\n  kept: docker rm -f %s && docker volume rm -f %s %s %s %s\n' \
      "$DIND" "$WS_VOL" "$DATA_VOL" "$SOCK_VOL" "$CFG_VOL"
    return
  }
  remove_throwaways
}
trap cleanup EXIT
trap 'exit 130' INT TERM
remove_throwaways   # a previous run killed before its trap ran

# --- 0. the outer daemon, the CLI, and which boundary this run tests ---------

echo
echo "== 0. the outer daemon, and where the devcontainer CLI comes from =="
vm info >/dev/null 2>&1 || { bad "cannot reach the docker daemon"; exit 1; }
if [ "$RUNTIME" = sysbox-runc ]; then
  vm info --format '{{json .Runtimes}}' 2>/dev/null | grep -q sysbox-runc || {
    bad "sysbox-runc is NOT registered on this daemon"
    note "install it first:  ./cli.sh vm install    or accept the weaker run:  $0 --runc"
    exit 1
  }
  ok "sysbox-runc is registered -- the project dind runs UNPRIVILEGED"
  CONTAINMENT=(--runtime=sysbox-runc)
else
  ok "runtime: runc + --privileged (APPROXIMATION -- see the header)"
  CONTAINMENT=(--privileged)
fi
note "outer docker $(vm version --format '{{.Server.Version}}' 2>/dev/null); kernel $(uname -r)"

# The CLI runs in a helper container on the OUTER daemon, never on the host:
# it has to see the project at /workspaces/<p> -- the same path the dind's
# daemon resolves binds against -- and only a container can be given that.
ORCH_IMAGE=$(vm inspect -f '{{.Config.Image}}' desolate-orchestrator 2>/dev/null)
if [ -n "$ORCH_IMAGE" ] && vm run --rm --entrypoint devcontainer "$ORCH_IMAGE" --version >/dev/null 2>&1; then
  CLI_RUN=(--entrypoint devcontainer "$ORCH_IMAGE")
  CLI_VERSION=$(vm run --rm --entrypoint devcontainer "$ORCH_IMAGE" --version 2>/dev/null)
  ok "devcontainer CLI $CLI_VERSION from the orchestrator's image ($ORCH_IMAGE)"
elif [ -n "${DESOLATE_SFPROBE_NODE:-}" ] && [ -n "${DESOLATE_SFPROBE_CLI_JS:-}" ]; then
  # node, the CLI with every module beside it, and a docker CLI (the
  # devcontainer CLI shells out to one), mounted into a plain debian.
  MODULES=$(cd "$(dirname "$DESOLATE_SFPROBE_CLI_JS")/../.." && pwd)
  DOCKER_CLI=$(command -v docker)
  CLI_RUN=(-v "$DESOLATE_SFPROBE_NODE:/opt/node:ro" -v "$MODULES:/opt/node_modules:ro"
           -v "$DOCKER_CLI:/usr/local/bin/docker:ro")
  for plugins in /usr/libexec/docker/cli-plugins /usr/local/lib/docker/cli-plugins; do
    [ -d "$plugins" ] && CLI_RUN+=(-v "$plugins:/usr/libexec/docker/cli-plugins:ro") && break
  done
  # A docker CLI built against OpenSSL (Microsoft's Go toolchain) dlopens
  # libcrypto at start and panics without it, so the helper base gets libssl3.
  printf 'FROM debian:bookworm-slim\nRUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libssl3 >/dev/null && rm -rf /var/lib/apt/lists/*\n' \
    | vm build -q -t "$CLI_BASE_IMAGE" -f - "$(mktemp -d)" >/dev/null 2>&1 \
    || { bad "could not build the CLI helper base"; exit 1; }
  CLI_RUN+=(--entrypoint /opt/node/bin/node "$CLI_BASE_IMAGE"
            "/opt/node_modules/${DESOLATE_SFPROBE_CLI_JS#"$MODULES"/}")
  CLI_VERSION=$(vm run --rm "${CLI_RUN[@]}" --version 2>/dev/null)
  [ -n "$CLI_VERSION" ] || { bad "the mounted devcontainer CLI does not run"; exit 1; }
  ok "devcontainer CLI $CLI_VERSION from $DESOLATE_SFPROBE_CLI_JS (APPROXIMATION)"
else
  bad "no devcontainer CLI: the stack is not up (no desolate-orchestrator container)"
  note "start it:  ./cli.sh up"
  exit 1
fi

# --- 1. the workspace, with a second project the dind must NOT see ------------

echo
echo "== 1. a workspaces volume holding $PROJ and $OTHER =="
vm volume create "$WS_VOL" >/dev/null && vm volume create "$CFG_VOL" >/dev/null
[ -n "${DESOLATE_SFPROBE_SAMPLE:-}" ] || { bad "the sample did not travel with the probe"; exit 1; }
printf '%s' "$DESOLATE_SFPROBE_SAMPLE" | base64 -d \
  | vm run --rm -i -v "$WS_VOL:/w" alpine:3 sh -c "
      set -e
      tar -xzf - -C /w
      mkdir -p /w/$OTHER && echo ANOTHER-PROJECTS-SOURCE > /w/$OTHER/secret.txt
      chown -R 1000:1000 /w" >/dev/null 2>&1
vm run --rm -v "$WS_VOL:/w" alpine:3 test -f "/w/$PROJ/.devcontainer/devcontainer.json" \
  || { bad "could not seed the workspace (an empty volume would read as a design failure)"; exit 1; }
ok "seeded $PROJ (from the checkout) and $OTHER"

# --- F2: the project dind, its /workspaces a subpath of one project ------------

echo
echo "== F2. the project dind's /workspaces is a volume-subpath of $PROJ only =="
# /var/run/docker.sock inside the dind is a LINK to the real socket: it is where
# the feature's own mount takes its source from (dind.ts `socket.alias`).
if ! vm run -d --name "$DIND" "${CONTAINMENT[@]}" \
      -e DOCKER_TLS_CERTDIR="" \
      --mount "type=volume,source=$WS_VOL,target=$WSF,volume-subpath=$PROJ" \
      -v "$DATA_VOL:/var/lib/docker" -v "$SOCK_VOL:/run/dind-sock" \
      --entrypoint sh "$DIND_IMG" -c \
      "ln -sf $SOCK /var/run/docker.sock && exec dockerd-entrypoint.sh dockerd --host=unix://$SOCK --group=1000" \
      >/tmp/desolate-sfprobe-run.err 2>&1; then
  bad "the daemon refused to create the dind"
  tail6 < /tmp/desolate-sfprobe-run.err
  F2="NO: dind not created -- $(tr '\n' ' ' < /tmp/desolate-sfprobe-run.err | cut -c1-120)"
  exit 1
fi
for _ in $(seq 1 60); do inner info >/dev/null 2>&1 && break; sleep 1; done
inner info >/dev/null 2>&1 || { bad "the project dind never became reachable"; vm logs "$DIND" 2>&1 | tail6; exit 1; }
seen=$(vm exec "$DIND" sh -c 'ls -A /workspaces | tr "\n" " "')
if [ "${seen% }" = "$PROJ" ] && vm exec "$DIND" test -f "$WSF/.devcontainer/devcontainer.json"; then
  ok "the dind's /workspaces holds only: $seen"
  F2=$(stamp "YES, the dind sees only '$PROJ' (docker $(inner version --format '{{.Server.Version}}'))")
else
  bad "the dind's /workspaces holds: ${seen:-<nothing>}"
  F2=$(stamp "NO, the dind sees '${seen% }'")
fi

# --- F1: build the feature into an image, on the OUTER daemon ------------------

echo
echo "== F1. the feature, built for real, and what it declares =="
# The config handed to the CLI: the sample's own image and feature, plus the
# CA-trusting base when the outer daemon's builds are intercepted.
BUILD_IMAGE=mcr.microsoft.com/devcontainers/base:ubuntu-24.04
if [ -n "${DESOLATE_SFPROBE_CA:-}" ]; then
  CA_DIR=$(dirname "$DESOLATE_SFPROBE_CA")
  printf 'FROM %s\nUSER root\nCOPY %s /usr/local/share/ca-certificates/desolate-sfprobe.crt\nRUN update-ca-certificates\n' \
      "$BUILD_IMAGE" "$(basename "$DESOLATE_SFPROBE_CA")" \
    | vm build -q -t "$BASE_CA_IMAGE" -f - "$CA_DIR" >/dev/null 2>&1 \
    || { bad "could not derive a CA-trusting base from $BUILD_IMAGE"; exit 1; }
  BUILD_IMAGE=$BASE_CA_IMAGE
  note "built on $BUILD_IMAGE (the proxy CA added, as desolate.ts does)"
fi
write_config() {   # <file in CFG_VOL> <json>
  printf '%s' "$2" | vm run --rm -i -v "$CFG_VOL:/c" alpine:3 sh -c "cat > /c/$1"
}
write_config build.json "{\"name\":\"sfprobe\",\"image\":\"$BUILD_IMAGE\",
  \"features\":{\"ghcr.io/devcontainers/features/docker-outside-of-docker:1\":{}}}"

cli() {   # <docker-host socket or ""> <cli args...>  (output to stdout+stderr)
  local host=$1; shift
  local daemon=(-v /var/run/docker.sock:/var/run/docker.sock)
  [ -n "$host" ] && daemon=(-v "$SOCK_VOL:/run/dind-sock" -e "DOCKER_HOST=unix://$host")
  # The CLI fetches feature tarballs itself, in node, so an intercepting proxy
  # has to be trusted there too -- not only in the image it builds.
  [ -n "${DESOLATE_SFPROBE_CA:-}" ] && daemon+=(-v "$DESOLATE_SFPROBE_CA:/opt/sfprobe-ca.pem:ro"
                                              -e NODE_EXTRA_CA_CERTS=/opt/sfprobe-ca.pem)
  vm run --rm --name "$HELPER" --user 0 "${daemon[@]}" \
    --mount "type=volume,source=$WS_VOL,target=$WSF,volume-subpath=$PROJ" \
    -v "$CFG_VOL:/cfg" -e HOME=/tmp "${CLI_RUN[@]}" "$@" 2>&1   # rw: the CLI writes a lockfile beside the config
}

if cli "" build --workspace-folder "$WSF" --config /cfg/build.json \
      --image-name "$DEV_IMAGE" > /tmp/desolate-sfprobe-build.log; then
  ok "built $DEV_IMAGE with docker-outside-of-docker on the outer daemon"
else
  bad "devcontainer build failed"; tail6 < /tmp/desolate-sfprobe-build.log; exit 1
fi
meta=$(vm image inspect -f '{{index .Config.Labels "devcontainer.metadata"}}' "$DEV_IMAGE")
feature_meta=$(printf '%s' "$meta" | python3 -c '
import json, sys
for entry in json.load(sys.stdin):
    if "docker-outside-of-docker" in str(entry.get("id", "")):
        keep = {k: entry[k] for k in ("mounts", "entrypoint", "privileged", "capAdd",
                                       "securityOpt", "init", "containerEnv") if k in entry}
        print(json.dumps(keep, separators=(",", ":")))' 2>/dev/null)
note "feature metadata: ${feature_meta:-<none found>}"
F1="${feature_meta:-NONE FOUND in devcontainer.metadata}"

vm save "$DEV_IMAGE" alpine:3 | vm exec -i "$DIND" docker load >/dev/null 2>&1 \
  || { bad "could not load the images into the dind"; exit 1; }
ok "handed $DEV_IMAGE and alpine:3 to the dind (no pulls inside it)"

# The config `up` gets: the built image, no features -- the CLI re-reads what
# the feature declared from the image's metadata label, as for any prebuilt.
write_config up.json "{\"name\":\"sfprobe\",\"image\":\"$DEV_IMAGE\"}"

# --- F3 / F4: up, without and with desolate's own socket bind ------------------

DEV_ID=""
up_variant() {   # <label> [extra cli args...]  -> sets DEV_ID, prints the CLI tail on failure
  local label=$1; shift
  inner rm -f $(inner ps -aq --filter "label=sfprobe.variant=$label") >/dev/null 2>&1
  if ! cli "$SOCK" up --workspace-folder "$WSF" --override-config /cfg/up.json \
        --id-label "sfprobe.variant=$label" "$@" > "/tmp/desolate-sfprobe-up-$label.log"; then
    bad "devcontainer up failed ($label)"; tail6 < "/tmp/desolate-sfprobe-up-$label.log"
    DEV_ID=""; return 1
  fi
  DEV_ID=$(inner ps -q --filter "label=sfprobe.variant=$label" | head -n 1)
  [ -n "$DEV_ID" ] || { bad "up reported success but no container carries the label"; return 1; }
}

as_remote() {   # <shell command>, run as the image's remote user, through the CLI
  cli "$SOCK" exec --workspace-folder "$WSF" --override-config /cfg/up.json \
    --id-label "sfprobe.variant=$1" sh -c "$2"
}

mounts_of() {
  inner inspect -f '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' "$1" \
    | sed '/^$/d' | tr '\n' ';' | sed 's/;$//'
}

reach_as_remote() {   # <label> -> "YES (uid N via PATH)" / "NO (...)"
  local out
  out=$(as_remote "$1" 'id -u; echo "DOCKER_HOST=${DOCKER_HOST:-}"; ls -l /var/run/docker.sock /var/run/docker-host.sock 2>&1; docker info --format "server {{.ServerVersion}}" 2>&1 | tail -n 1')
  printf '%s\n' "$out" | sed 's/^/        /' >&2
  case "$out" in
    *"server "[0-9]*) echo "YES (uid $(printf '%s' "$out" | head -n 1))" ;;
    *) echo "NO ($(printf '%s' "$out" | tail -n 1 | cut -c1-80))" ;;
  esac
}

check_init() {   # <label> <id>  -> INIT verdict line
  local logs running
  sleep 5
  running=$(inner inspect -f '{{.State.Running}}' "$2" 2>/dev/null)
  logs=$(inner logs "$2" 2>&1 | grep -iE 'error|fail|denied|busy|exists' | head -n 3 | tr '\n' ' ')
  if [ "$running" = true ] && [ -z "$logs" ]; then echo "$1: running, no errors from the entrypoint"
  else echo "$1: running=$running; entrypoint said: ${logs:-<nothing>}"; fi
}

# Docker's default set for a container's root. Anything else -- more, or the
# full mask of --privileged -- is a capability the feature or desolate added.
DEFAULT_CAPS=00000000a80425fb
capeff_of() {   # <label> <id>  -> "pid1=<mask> user=<mask>"
  local pid1 user
  pid1=$(inner exec "$2" sh -c 'grep CapEff /proc/1/status | cut -f2')
  user=$(as_remote "$1" 'grep CapEff /proc/self/status | cut -f2' | tail -n 1)
  echo "pid1=$pid1 user=$user"
}

echo
echo "== F3. up with ONLY the feature's own mount =="
if up_variant A; then
  ok "devcontainer is up ($DEV_ID)"
  MOUNTS_A=$(mounts_of "$DEV_ID")
  F3=$(stamp "$(reach_as_remote A)")
  note "$F3"
  INIT_A=$(check_init A "$DEV_ID")
  CAP_A=$(capeff_of A "$DEV_ID")
else
  F3=$(stamp "NO: up failed -- $(tail -n 1 /tmp/desolate-sfprobe-up-A.log | cut -c1-100)")
fi

echo
echo "== F4. up with desolate's bind of the socket FILE at /var/run/docker.sock too =="
INJECTED="type=bind,source=$SOCK,target=/var/run/docker.sock"
if up_variant B --mount "$INJECTED"; then
  ok "devcontainer is up ($DEV_ID)"
  MOUNTS_B=$(mounts_of "$DEV_ID")
  F4=$(stamp "$(reach_as_remote B)")
  note "$F4"
  INIT_B=$(check_init B "$DEV_ID")
  CAP_B=$(capeff_of B "$DEV_ID")
else
  F4=$(stamp "NO: up failed -- $(tail -n 1 /tmp/desolate-sfprobe-up-B.log | cut -c1-100)")
fi

echo
echo "== F5 / F6. the entrypoint, and privilege =="
F5=$(stamp "${INIT_A:-A not up}; ${INIT_B:-B not up}")
note "$F5"
F6=$(stamp "A ${CAP_A:-not up}; B ${CAP_B:-not up} (default $DEFAULT_CAPS)")
caps_ok() { [ "$1" = "pid1=$DEFAULT_CAPS user=0000000000000000" ]; }
if { [ -z "${CAP_A:-}" ] || caps_ok "$CAP_A"; } && { [ -z "${CAP_B:-}" ] || caps_ok "$CAP_B"; }; then
  ok "PID 1 holds docker's default set and the remote user none, where it came up"
else
  bad "a capability beyond the default: $F6"
fi

# --- F7 / F8: paths and containment, from inside whichever variant works ------

echo
echo "== F7 / F8. bind paths and reach-back, from inside =="
label=""
case "$F4" in *YES*) label=B ;; *) case "$F3" in *YES*) label=A ;; esac ;; esac
if [ -n "$label" ]; then
  token="SFPROBE-$$"
  out=$(as_remote "$label" "echo $token > $WSF/written-from-inside && docker run --rm -v $WSF:/x alpine:3 cat /x/written-from-inside")
  case "$out" in
    *"$token"*) ok "a sibling's bind of $WSF is the devcontainer's own directory"; F7=$(stamp "YES (variant $label)") ;;
    *) bad "the sibling did not see it: $(printf '%s' "$out" | tail -n 1)"; F7=$(stamp "NO (variant $label)") ;;
  esac
  out=$(as_remote "$label" "docker run --rm -v /workspaces:/x alpine:3 sh -c 'ls -A /x | tr \"\\n\" \" \"; cat /x/$OTHER/secret.txt 2>/dev/null'")
  out=$(printf '%s' "$out" | tail -n 1)
  case "$out" in
    *ANOTHER-PROJECTS-SOURCE*) bad "REACHED another project's file: $out"; F8=$(stamp "NO -- read $OTHER's source") ;;
    *"$OTHER"*) bad "another project is visible: $out"; F8=$(stamp "NO -- '$OTHER' visible") ;;
    *) ok "a sibling mounting /workspaces sees only: $out"; F8=$(stamp "YES, only '${out% }' (variant $label)") ;;
  esac
else
  note "skipped: neither variant reached the daemon"
  F7="SKIPPED"; F8="SKIPPED"
fi

# --- verdict ---------------------------------------------------------------------

holds=YES
case "$F2" in *YES*) ;; *) holds=NO ;; esac
case "$F3$F4" in *YES*) ;; *) holds=NO ;; esac
for caps in "${CAP_A:-}" "${CAP_B:-}"; do
  [ -z "$caps" ] || caps_ok "$caps" || holds=NO
done
case "$F7" in *YES*) ;; *) holds=NO ;; esac
case "$F8" in *YES*) ;; *) holds=NO ;; esac

echo
echo "================================ SUMMARY ================================"
echo "sibling-feature.sh  $(date '+%Y-%m-%d')  runtime=$RUNTIME  cli=$CLI_VERSION"
[ "$RUNTIME" = runc ] && echo "APPROXIMATION (runc): the real answer is the sysbox run on the VM"
echo "F1 METADATA   $F1"
echo "F2 SUBPATH    $F2"
echo "F3 FEATURE    $F3"
echo "F4 INJECTED   $F4"
echo "F5 INIT       $F5"
echo "F6 PRIVILEGE  $F6"
echo "F7 PATHS      $F7"
echo "F8 REACH-BACK $F8"
echo "mounts A (feature only): ${MOUNTS_A:-<not up>}"
echo "mounts B (+ injected):   ${MOUNTS_B:-<not up>}"
if [ "$holds" = YES ]; then
  echo "VERDICT: a real docker-outside-of-docker devcontainer works unprivileged on a project dind (T3.1, T3.2 proceed; see F3/F4 for which mount)"
else
  echo "VERDICT: does NOT hold as written -- see the failing F before T3.1/T3.2"
fi
echo "========================================================================="
