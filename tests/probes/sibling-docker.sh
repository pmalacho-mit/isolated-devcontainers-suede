#!/usr/bin/env bash
# PROBE -- not a test. Answers a capability question about the environment so a
# design decision can be made; it asserts no invariant and gates nothing.
#
# QUESTION: can a devcontainer that holds ONLY the docker CLI and a bind-mounted
# socket of its own project dind -- with NO --privileged, no added capabilities,
# no nested dockerd -- do everything the agents currently need: build images,
# `compose up`, and bind-mount from /workspaces?
#
# This is the assumption SPEC-per-project-dind-v2 rests on, and the spec says so:
# "This is a day's work and it decides whether v2 exists."
#
# Why it matters: today a project that wants docker turns on the
# docker-in-docker feature, which makes its devcontainer --privileged inside the
# SHARED dind -- root over every other project's images, containers and, through
# the full /workspaces mount, every other project's source. v2 proposes giving
# each such project its own dind (a sysbox container on the VM daemon) and
# handing the devcontainer that dind's SOCKET instead of a daemon of its own.
# The agent's containers become siblings rather than children:
#
#   desolate-dind-<ns> (sysbox)     ONE dockerd
#     |- devcontainer               UNPRIVILEGED, mounts .../docker.sock
#     |- the agent's containers     siblings, created THROUGH that socket
#
# The privilege reduction is only worth having if the devcontainer can still do
# its job. Every Q below is a way that could fail:
#
#   Q1  HANDOFF    the spec hands the devcontainer the VOLUME `dind-sock-<ns>`.
#                  That volume belongs to the VM daemon, and the devcontainer is
#                  created by the DIND's daemon -- a different daemon with its
#                  own volume namespace. So what does that name mean one level
#                  in, and what does an unprivileged uid-1000 sibling need
#                  instead to reach a dockerd started with --group=1000?
#   Q2  MOUNTPOINT once it is a bind, there are two placements and they are not
#                  equivalent: the socket FILE at /var/run/docker.sock (what
#                  docker-outside-of-docker expects), or its DIRECTORY over
#                  /var/run -- which is a SYMLINK to /run in every common base
#                  image, so that mount lands on /run and replaces the
#                  container's whole runtime directory.
#   Q3  BUILD      `docker build` with a context inside /workspaces.
#   Q4  PATHS      the spec claims "/workspaces/<project> means the same thing on
#                  both sides". A bind SOURCE is resolved by the daemon, not the
#                  client, so this is the claim that decides whether every
#                  existing project's `-v $(pwd):/app` keeps working.
#   Q5  REACH      `docker compose up --build`, and then: can the devcontainer
#                  TALK to what it just started? Under docker-in-docker the
#                  service was a child on the devcontainer's own bridge. As a
#                  sibling it is on a different bridge, and docker isolates
#                  bridges from each other by default. This is the one place v2
#                  is a behaviour CHANGE rather than a relocation.
#   Q6  REACH-BACK the socket is root over that dind. So what does the
#                  devcontainer see of /workspaces THERE? v2's containment rests
#                  entirely on the answer, and not at all on the socket.
#   Q7  MOUNTS     the reliability claim: a nested dockerd accrues an overlay
#                  mount in the DEVCONTAINER's mount namespace per image and
#                  container, which is the class of state that could not be torn
#                  down. Measured here against the sibling case, not asserted.
#
# ANSWERED 2026-08-17, on the VM under sysbox-runc: the assumption HOLDS. Q3,
# Q4 and Q5 are all YES with no --privileged anywhere. Four answers change the
# design rather than confirming it:
#
#   Q1   the handoff is a BIND of /run/dind-sock, NOT the volume dind-sock-<ns>.
#        A volume name does not cross a daemon boundary, and naming it one level
#        in yields a new EMPTY volume rather than an error.
#   Q2   both placements work. The socket FILE at /var/run/docker.sock is the
#        narrow one; the DIRECTORY over /var/run resolves through the symlink
#        onto /run and hides whatever the image keeps there.
#   Q5b  the composed service was NOT reachable by name until the devcontainer
#        joined sibproj_default. Sibling bridges are isolated from each other.
#   Q6   the devcontainer read a SECOND project out of the same /workspaces.
#
#   Q7   sibling 1 -> 1 where the nested devcontainer went 1 -> 2, which is the
#        nested-mount claim, measured.
#
# A --runc run inside this repo's own .devcontainer gave IDENTICAL answers to
# the sysbox run, which is what makes that mode worth keeping.
#
# Keep this until v2 ships or is abandoned: it is what to re-run when the socket
# wiring, the workspace mount, or the policy exception for either one changes.
#
# WHAT THIS DOES NOT PROVE. The devcontainer stand-in is `docker:29-cli` (docker
# + compose + buildx, running as uid 1000), not a real image built by the
# `docker-outside-of-docker` feature. That models the socket relationship, which
# is what is in question; it does not model the feature's own install steps. If
# every Q passes, building one real devcontainer with that feature is the
# follow-up -- and Q2 is what tells you where to put the mount when you do.
#
# ---------------------------------------------------------------------------
# HOW TO RUN -- on your Mac. The stack does NOT need to be up; this only needs
# the VM with sysbox-runc registered (./cli.sh vm install):
#
#   ./tests/probes/sibling-docker.sh
#
# It re-execs itself INSIDE the Colima VM, creates ONE throwaway container named
# desolate-sibprobe-* on the VM daemon plus three throwaway volumes, and removes
# all of it on exit including on failure. It does not touch the desolate stack,
# any project, /workspaces, or anything on your Mac. Expect a few minutes on the
# first run (three image pulls). Paste the SUMMARY block back when it finishes.
#
# DESOLATE_SIBPROBE_KEEP=1 leaves the throwaway up afterwards and prints the two
# commands that remove it, for when a NO needs looking into rather than reading.
#
# Without sysbox -- e.g. from the repo's own .devcontainer, which has a plain
# docker-in-docker feature -- pass --runc. The throwaway dind then runs
# --privileged on whatever daemon is reachable instead of unprivileged under
# sysbox. Every Q below is about the DEVCONTAINER's relationship to the socket,
# one level further in, so the answers still stand; but sysbox is the boundary
# the whole design leans on, so the run is stamped APPROXIMATION and the real
# answer comes from a sysbox run.
#
# NOTE ON EGRESS: the throwaway dind is given its images by `docker save` from
# the host daemon and never pulls anything itself, so nothing here depends on
# what egress looks like one level in. Only the HOST daemon needs to be able to
# reach a registry, and only for images it has probably already cached.
set -uo pipefail

PROFILE="${COLIMA_PROFILE:-desolate}"
RUNTIME="${DESOLATE_SIBPROBE_RUNTIME:-sysbox-runc}"

for arg in "$@"; do
  case "$arg" in
    --runc) RUNTIME=runc ;;
    *) echo "unknown argument '$arg' (only --runc is understood)" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Stage 0: get inside the VM. On the Mac, `docker` is not the daemon that has
# sysbox-runc -- the VM's is. Ship this whole file in and run it there, where
# every docker call below is local. Flags do not survive `bash -s`, so the
# runtime choice travels as an environment variable.
# ---------------------------------------------------------------------------
if [ "${DESOLATE_SIBPROBE_INVM:-}" != 1 ]; then
  if ! command -v colima >/dev/null 2>&1; then
    echo "This probe must run from the Mac (colima not found on PATH)." >&2
    echo "If you are already somewhere with a usable daemon, re-run with" >&2
    echo "DESOLATE_SIBPROBE_INVM=1 (and --runc if it has no sysbox-runc)." >&2
    exit 1
  fi
  echo "== entering the Colima VM (profile '$PROFILE') =="
  exec colima ssh -p "$PROFILE" -- \
    env DESOLATE_SIBPROBE_INVM=1 DESOLATE_SIBPROBE_RUNTIME="$RUNTIME" bash -s < "$0"
  echo "could not enter the VM via 'colima ssh -p $PROFILE'." >&2
  exit 1
fi

# ---- from here on `docker` is the daemon that will host the project dind ----

DIND=desolate-sibprobe-dind         # the throwaway project dind
DEV=desolate-sibprobe-dev           # the throwaway "devcontainer" inside it
NESTED=desolate-sibprobe-nested     # today's shape, for the Q7 comparison
SOCK_VOL=desolate-sibprobe-sock     # dind-sock-<ns>: the socket handoff
WS_VOL=desolate-sibprobe-ws         # stands in for the workspaces volume
DATA_VOL=desolate-sibprobe-data     # the dind's image store (never overlayfs)

DIND_IMG="docker:29-dind"
CLI_IMG="docker:29-cli"             # the devcontainer stand-in: CLI, no daemon
SOCK=/run/dind-sock/docker.sock     # where the dind publishes it
PROJ=sibproj                        # the project this devcontainer owns
OTHER=another-project               # a second project in the same /workspaces

Q1="UNKNOWN"; Q2="UNKNOWN"; Q3="UNKNOWN"; Q4="UNKNOWN"
Q5="UNKNOWN"; Q5B="UNKNOWN"; Q6="UNKNOWN"; Q7="UNKNOWN"
SIBLING_MOUNTS=""; NESTED_MOUNTS=""; RUN_CONTENTS=""
# Q1's answer is a sentence about two different mounts; the verdict needs the
# one bit underneath it.
HANDOFF=NO

note() { printf '      %s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }
tail4(){ tail -n 4 | sed 's/^/        /'; }

# The three daemons this probe talks to, one function each. Every docker call
# below goes through one of them, so which daemon a step exercises is never a
# question of reading the flags.
vm()     { docker "$@"; }                        # hosts the project dind
inner()  { docker exec "$DIND" docker "$@"; }    # the project dind's own daemon
dev()    { inner exec "$DEV" "$@"; }             # inside the devcontainer
devsh()  { dev sh -c "$*"; }

cleanup() {
  # Removing the dind takes its daemon, the devcontainer and every sibling with
  # it -- nothing of this probe survives.
  [ -n "${DESOLATE_SIBPROBE_KEEP:-}" ] && {
    printf '\n  kept: docker rm -f %s && docker volume rm -f %s %s %s\n' \
      "$DIND" "$SOCK_VOL" "$WS_VOL" "$DATA_VOL"
    return
  }
  vm rm -f "$DIND" >/dev/null 2>&1
  vm volume rm -f "$SOCK_VOL" "$WS_VOL" "$DATA_VOL" >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

# --- 0. the host daemon, and which boundary this run actually tests ----------

require_runtime() {
  if ! vm info >/dev/null 2>&1; then
    bad "cannot reach the docker daemon"
    note "on the Mac:  colima start -p $PROFILE"
    exit 1
  fi
  [ "$RUNTIME" = sysbox-runc ] || {
    ok "runtime: runc + --privileged (APPROXIMATION -- see the header)"
    return
  }
  if vm info --format '{{json .Runtimes}}' 2>/dev/null | grep -q sysbox-runc; then
    ok "sysbox-runc is registered -- the project dind runs UNPRIVILEGED"
  else
    bad "sysbox-runc is NOT registered on this daemon"
    note "install it first:  ./cli.sh vm install"
    note "or accept the weaker run:  $0 --runc"
    exit 1
  fi
}

# How the project dind is contained. This is the ONE place the two runs differ.
containment_args() {
  case "$RUNTIME" in
    sysbox-runc) printf '%s\n' --runtime=sysbox-runc ;;
    runc)        printf '%s\n' --privileged ;;
  esac
}

# --- 1. the project dind, publishing its socket into a volume ---------------

start_project_dind() {
  vm rm -f "$DIND" >/dev/null 2>&1
  vm volume rm -f "$SOCK_VOL" "$WS_VOL" "$DATA_VOL" >/dev/null 2>&1
  mapfile -t containment < <(containment_args)

  # --group=1000 is what makes the socket reachable by the editor user without
  # privilege; the data root gets a volume because dockerd refuses to run on
  # overlayfs, exactly as the shipped dind does.
  vm run -d --name "$DIND" "${containment[@]}" \
    -e DOCKER_TLS_CERTDIR="" \
    -e DOCKER_HOST="unix://$SOCK" \
    -v "$SOCK_VOL:/run/dind-sock" \
    -v "$WS_VOL:/workspaces" \
    -v "$DATA_VOL:/var/lib/docker" \
    "$DIND_IMG" dockerd --host="unix://$SOCK" --group=1000 >/dev/null 2>&1 \
    || { bad "could not start the project dind"; exit 1; }

  for _ in $(seq 1 60); do inner info >/dev/null 2>&1 && { ok "project dind is up"; return; }; sleep 1; done
  bad "the project dind never became reachable"
  vm logs "$DIND" 2>&1 | tail4
  exit 1
}

# A dind that pulls nothing is a dind whose answers are about the socket rather
# than about whatever sits between it and a registry -- an intercepting proxy,
# a rate limit, an offline VM. The host daemon does the pulling; the dind is
# handed the result.
preload_images() {
  for image in "$CLI_IMG" alpine:3 "$DIND_IMG"; do
    vm image inspect "$image" >/dev/null 2>&1 || vm pull -q "$image" >/dev/null 2>&1 || {
      bad "the host daemon cannot pull $image"
      note "this probe needs three images; it gives them to the dind itself"
      exit 1
    }
    vm save "$image" | vm exec -i "$DIND" docker load >/dev/null 2>&1 || {
      bad "could not load $image into the project dind"
      exit 1
    }
  done
  ok "loaded $CLI_IMG, alpine:3 and $DIND_IMG into the dind (no pulls inside it)"
}

# Two projects, because Q6 asks what ONE devcontainer can see of the OTHER.
#
# The composed service serves marker.txt out of its own bind mount, so a
# successful fetch in Q5b says the compose bind resolved to the project as well
# -- compose sends the daemon an absolute path it computed from the CLIENT's
# working directory, which is the same claim Q4 makes about `docker run -v`.
seed_workspaces() {
  vm exec -i -u 0 "$DIND" sh -s <<SEED >/dev/null 2>&1
set -e
mkdir -p /workspaces/$PROJ /workspaces/$OTHER
echo WORKSPACE-MARKER > /workspaces/$PROJ/marker.txt
echo ANOTHER-PROJECTS-SOURCE > /workspaces/$OTHER/secret.txt
printf 'FROM alpine:3\nCOPY marker.txt /built-marker\n' > /workspaces/$PROJ/Dockerfile
printf 'services:\n  web:\n    build: .\n    command: ["sh", "/srv/serve.sh"]\n    volumes:\n      - .:/srv\n' > /workspaces/$PROJ/compose.yml
printf '%s\n' 'while true; do' '  { printf "HTTP/1.1 200 OK\r\n\r\n"; cat /srv/marker.txt; } | nc -l -p 8000' 'done' > /workspaces/$PROJ/serve.sh
chown -R 1000:1000 /workspaces
SEED

  # An unseeded /workspaces does not announce itself: docker creates a missing
  # bind source as an empty root-owned directory, so every Q below would fail
  # as if the design were at fault.
  vm exec "$DIND" test -s "/workspaces/$PROJ/compose.yml" || {
    bad "could not seed the project inside the dind"
    exit 1
  }
  ok "seeded /workspaces/$PROJ and /workspaces/$OTHER inside the dind"
}

# --- Q1: the socket handoff -------------------------------------------------

# The spec's wording -- "dind-sock-<ns> is mounted into the dind at
# /run/dind-sock, and into the devcontainer at /var/run/" -- reads as one volume
# mounted twice. It cannot be. The first mount is on the VM daemon; the second
# is on the dind's daemon, which never heard of that volume and will happily
# create an empty one under the same name. That failure is silent: the container
# starts, and the socket is simply not there.
check_volume_name_does_not_cross() {
  local contents
  contents=$(inner run --rm -v "$SOCK_VOL:/mnt" alpine:3 \
               sh -c 'ls -A /mnt | tr "\n" " "' 2>/dev/null | tr -d '\r')
  inner volume rm -f "$SOCK_VOL" >/dev/null 2>&1

  if [ -z "$contents" ]; then
    note "naming the volume '$SOCK_VOL' on the dind's daemon got an EMPTY volume"
    note "-- the socket is NOT in it. The spec's mount has to be a bind."
    Q1="volume name does NOT cross the daemon boundary"
  else
    ok "the volume name resolved to something holding: $contents"
    Q1="volume name unexpectedly carried content -- look at why"
  fi
}

start_devcontainer() {
  # Everything a v2 devcontainer is allowed to be: uid 1000, the CLI, a BIND of
  # the socket directory out of the dind's own filesystem, and a bind of its own
  # project directory -- which is how desolate already mounts a workspace, for
  # the same reason the socket has to be one. No --privileged, no --cap-add, no
  # --group-add, no daemon of its own.
  inner run -d --name "$DEV" --user 1000:1000 \
    -e DOCKER_HOST="unix://$SOCK" \
    -e HOME=/tmp \
    -v /run/dind-sock:/run/dind-sock \
    -v "/workspaces/$PROJ:/workspaces/$PROJ" \
    -w "/workspaces/$PROJ" \
    "$CLI_IMG" sleep infinity >/dev/null 2>&1 \
    || { bad "could not start the devcontainer stand-in"; Q1="$Q1; container would not start"; return 1; }

  if dev docker info >/dev/null 2>&1; then
    ok "an unprivileged uid-1000 sibling drives the dind through a BIND of it"
    Q1="$Q1; a bind of /run/dind-sock DOES"
    HANDOFF=YES
    return 0
  fi

  bad "the devcontainer could not reach the socket"
  dev docker info 2>&1 | tail4
  Q1="$Q1; and neither did a bind of /run/dind-sock"
  return 1
}

# --- Q2: where to put the socket in the devcontainer ------------------------

# Two placements, and the difference is not cosmetic. Binding the socket FILE is
# what docker-outside-of-docker expects and touches nothing else. Binding its
# DIRECTORY over /var/run is what the spec says -- and /var/run is a symlink, so
# docker resolves it and the mount replaces /run.
check_socket_placement() {
  RUN_CONTENTS=$(inner run --rm "$CLI_IMG" sh -c 'ls -A /run 2>/dev/null | tr "\n" " "' 2>/dev/null | tr -d '\r')
  local link
  link=$(inner run --rm "$CLI_IMG" sh -c 'readlink /var/run || echo "(not a symlink)"' 2>/dev/null | tr -d '\r')
  note "/var/run -> $link"
  note "the image ships this in /run: ${RUN_CONTENTS:-<empty>}"

  local as_file as_dir
  as_file=$(reaches_daemon_via -v "$SOCK:/var/run/docker.sock")
  as_dir=$(reaches_daemon_via -v /run/dind-sock:/var/run)

  case "$as_file" in
    YES) ok  "binding the socket FILE at /var/run/docker.sock works" ;;
    *)   bad "binding the socket FILE at /var/run/docker.sock does NOT work" ;;
  esac
  case "$as_dir" in
    YES) ok  "binding the DIRECTORY over /var/run works too -- but see below" ;;
    *)   bad "binding the DIRECTORY over /var/run does NOT work" ;;
  esac

  local shadowed="nothing (the image's /run is empty)"
  [ -n "$RUN_CONTENTS" ] && shadowed="${RUN_CONTENTS% }"
  Q2="file=$as_file dir=$as_dir; the dir mount hides /run, which holds $shadowed"
}

# Can an unprivileged uid-1000 container reach the daemon with THIS mount?
reaches_daemon_via() {
  inner run --rm --user 1000:1000 \
    -e DOCKER_HOST=unix:///var/run/docker.sock "$@" \
    "$CLI_IMG" docker info >/dev/null 2>&1 && echo YES || echo NO
}

# --- Q3: builds -------------------------------------------------------------

check_build() {
  if devsh "docker build -q -t sibprobe/built . >/dev/null 2>&1"; then
    local marker
    marker=$(dev docker run --rm sibprobe/built cat /built-marker 2>/dev/null | tr -d '\r')
    if [ "$marker" = WORKSPACE-MARKER ]; then
      ok "built an image from a context inside /workspaces, unprivileged"
      Q3="YES"
    else
      bad "the build succeeded but the context did not carry the project's file"
      Q3="NO -- wrong build context (got '$marker')"
    fi
  else
    bad "docker build failed from the devcontainer"
    devsh "docker build -t sibprobe/built ." 2>&1 | tail4
    Q3="NO -- build failed"
  fi
}

# --- Q4: bind-mount path identity -------------------------------------------

# A bind SOURCE is resolved by the DAEMON. Under docker-in-docker the daemon was
# inside the devcontainer, so `-v /workspaces/x:/y` meant the devcontainer's own
# path. As a sibling the daemon is the dind, and this only keeps working because
# the dind mounts the workspaces volume at the same path. Write from one side,
# read from the other, so a stale or empty directory cannot read as success.
check_bind_paths() {
  local token="BIND-IDENTITY-$$"
  devsh "echo $token > /workspaces/$PROJ/written-by-devcontainer" >/dev/null 2>&1
  local seen
  seen=$(dev docker run --rm -v "/workspaces/$PROJ:/x" alpine:3 \
           cat /x/written-by-devcontainer 2>/dev/null | tr -d '\r')

  if [ "$seen" = "$token" ]; then
    ok "a sibling's bind of /workspaces/$PROJ is the devcontainer's own directory"
    Q4="YES"
  else
    bad "the sibling did not see what the devcontainer wrote"
    note "expected '$token', got '${seen:-<nothing>}'"
    Q4="NO -- paths do not resolve to the same directory"
  fi
}

# --- Q5: compose, and whether the devcontainer can reach what it started -----

compose_up() {
  if devsh "docker compose -f compose.yml up -d --build >/dev/null 2>&1"; then
    ok "docker compose up --build from the devcontainer, unprivileged"
    Q5="YES"
    return 0
  fi
  bad "docker compose up failed"
  devsh "docker compose -f compose.yml up -d --build" 2>&1 | tail4
  Q5="NO -- compose failed"
  return 1
}

# THE behaviour change. Under docker-in-docker `web` was a child on the
# devcontainer's own bridge and resolved by name. As a sibling it sits on the
# compose bridge, which docker isolates from the devcontainer's -- so the
# question is whether the devcontainer can still talk to its own service, and
# what it costs to restore that.
check_service_reachable() {
  local url="http://web:8000/marker.txt"
  if devsh "wget -qO- -T 5 $url 2>/dev/null" | grep -q WORKSPACE-MARKER; then
    ok "the devcontainer reached the composed service by name, unaided"
    Q5B="YES -- reachable without joining the network"
    return
  fi

  local network
  network=$(devsh "docker compose -f compose.yml ps --format '{{.Networks}}' | head -1" 2>/dev/null | tr -d '\r')
  if [ -z "$network" ]; then
    bad "the service is not reachable and its network could not be identified"
    Q5B="NO -- unreachable, no network name"
    return
  fi

  if ! devsh "docker network connect $network $DEV >/dev/null 2>&1"; then
    bad "the devcontainer could not join '$network' through the socket"
    Q5B="NO -- unreachable and could not join '$network'"
    return
  fi

  if devsh "wget -qO- -T 5 $url 2>/dev/null" | grep -q WORKSPACE-MARKER; then
    note "not reachable until the devcontainer joined '$network' -- which it can"
    note "do itself through the socket, but which nothing does today"
    Q5B="NO by default; YES after 'docker network connect $network'"
  else
    bad "still unreachable after joining '$network'"
    Q5B="NO -- unreachable even after joining the network"
  fi
}

# --- Q6: what the socket reaches --------------------------------------------

# The socket is root over this dind, so the devcontainer can bind ANY path the
# dind can see. That is accepted by the design -- the dind is the boundary. What
# it means is that the containment claim rests on the dind's /workspaces holding
# ONE project. If the project dinds mount the shared workspaces volume the way
# the current dind does, v2 hands back exactly the cross-project read it removes.
check_reach_back() {
  local leaked
  leaked=$(dev docker run --rm -v /workspaces:/all alpine:3 \
             cat "/all/$OTHER/secret.txt" 2>/dev/null | tr -d '\r')
  if [ "$leaked" = ANOTHER-PROJECTS-SOURCE ]; then
    note "the devcontainer read /workspaces/$OTHER through the socket, as expected"
    Q6="reaches EVERY project in its dind's /workspaces"
  else
    ok "the devcontainer could not read the second project"
    Q6="could not read a second project in the same /workspaces (unexpected -- look at why)"
  fi
}

# --- Q7: the mount namespace ------------------------------------------------

# The nested-mount failure class, measured. Count overlay mounts in the
# DEVCONTAINER's own mount namespace before and after it starts a container --
# then do the same to a docker-in-docker devcontainer, which is today's shape.
check_mount_namespace() {
  local before after
  before=$(dev grep -c overlay /proc/self/mounts 2>/dev/null | tr -d '\r')
  dev docker run -d --name sibprobe-longrunner alpine:3 sleep 300 >/dev/null 2>&1
  after=$(dev grep -c overlay /proc/self/mounts 2>/dev/null | tr -d '\r')
  SIBLING_MOUNTS="$before -> $after"
  dev docker rm -f sibprobe-longrunner >/dev/null 2>&1

  NESTED_MOUNTS=$(measure_nested_devcontainer)

  if [ "$before" = "$after" ]; then
    ok "the devcontainer's mount namespace did not change when it ran a container"
    Q7="YES -- constant at $after (nested devcontainer: $NESTED_MOUNTS)"
  else
    bad "the devcontainer accrued mounts despite holding no daemon"
    Q7="NO -- $SIBLING_MOUNTS"
  fi
}

# Today's shape, for the comparison: a --privileged devcontainer running its own
# dockerd. Its overlay mounts land in ITS mount namespace, which is the state a
# container stopped mid-build cannot tear down.
measure_nested_devcontainer() {
  inner run -d --name "$NESTED" --privileged -e DOCKER_TLS_CERTDIR="" \
    "$DIND_IMG" >/dev/null 2>&1 || { echo "could not start one"; return; }

  local up=""
  for _ in $(seq 1 45); do
    inner exec "$NESTED" docker info >/dev/null 2>&1 && { up=1; break; }
    sleep 1
  done
  [ -n "$up" ] || { inner rm -f "$NESTED" >/dev/null 2>&1; echo "its dockerd never came up"; return; }

  # Its daemon is a third one, with a third image store, so it needs the image
  # handed to it as well -- which is the doubled storage v2 is removing.
  inner save alpine:3 | vm exec -i "$DIND" docker exec -i "$NESTED" docker load >/dev/null 2>&1

  local before after
  before=$(inner exec "$NESTED" grep -c overlay /proc/self/mounts 2>/dev/null | tr -d '\r')
  if ! inner exec "$NESTED" docker run -d --name nested-longrunner alpine:3 sleep 300 >/dev/null 2>&1; then
    inner rm -f "$NESTED" >/dev/null 2>&1
    echo "it could not run a container"
    return
  fi
  after=$(inner exec "$NESTED" grep -c overlay /proc/self/mounts 2>/dev/null | tr -d '\r')
  inner rm -f "$NESTED" >/dev/null 2>&1
  echo "$before -> $after"
}

# --- the report -------------------------------------------------------------

summary() {
  local stamp="sysbox-runc (the boundary v2 ships)"
  [ "$RUNTIME" = sysbox-runc ] || stamp="runc + --privileged (APPROXIMATION)"
  echo
  echo "=============== SUMMARY (paste this back) ==============="
  echo "  kernel                  : $(uname -r 2>/dev/null)"
  echo "  project dind contained by: $stamp"
  echo "  Q1 socket handoff       : $Q1"
  echo "  Q2 socket placement     : $Q2"
  echo "  Q3 build from /workspaces: $Q3"
  echo "  Q4 bind paths identical : $Q4"
  echo "  Q5 compose up --build   : $Q5"
  echo "  Q5b service reachable   : $Q5B"
  echo "  Q6 socket reaches       : $Q6"
  echo "  Q7 devcontainer mounts  : $Q7"
  echo "     sibling  (v2)        : ${SIBLING_MOUNTS:-unknown}"
  echo "     nested   (today)     : ${NESTED_MOUNTS:-unknown}"
  echo "========================================================="
  echo
}

verdict() {
  case "$HANDOFF$Q3$Q4$Q5" in
    YESYESYESYES)
      echo "VERDICT: v2's core assumption HOLDS. An unprivileged devcontainer with a"
      echo "         bind-mounted dind socket builds, composes and bind-mounts from"
      echo "         /workspaces. --privileged is not needed for any of it."
      echo
      echo "         Three things the passes do NOT let you skip:"
      echo "           - Q1: the socket reaches the devcontainer as a BIND of the"
      echo "             dind's own filesystem, not as the volume the spec names."
      echo "             policy.ts refuses bind mounts categorically today, so the"
      echo "             exception it needs is not the volume allowlist v2 describes."
      echo "           - Q5b: sibling services are on a different bridge. Whatever"
      echo "             starts a v2 devcontainer has to join it to its own compose"
      echo "             networks, or 'wget http://web:8000' stops working in every"
      echo "             project that has a compose file today."
      echo "           - Q6: the socket is root over its dind, so the containment"
      echo "             comes from that dind holding ONE project. The volume-subpath"
      echo "             mount for /workspaces is load-bearing in v2, not an extra."
      ;;
    *)
      echo "VERDICT: not viable as specified. The first Q above that is not YES is the"
      echo "         blocker; read its output higher up for what docker actually said."
      ;;
  esac
  [ "$RUNTIME" = sysbox-runc ] || {
    echo
    echo "         This run used --runc, so it says nothing about sysbox. Re-run on"
    echo "         the VM before treating any of it as the answer."
  }
}

# --- what actually runs -----------------------------------------------------

echo
echo "== 0. the daemon that will host the project dind =="
require_runtime
echo
echo "== 1. project dind, publishing its socket into a volume =="
start_project_dind
preload_images
seed_workspaces
echo
echo "== Q1. an unprivileged devcontainer holding only that socket =="
check_volume_name_does_not_cross
if start_devcontainer; then
  echo
  echo "== Q2. where the socket goes inside the devcontainer =="
  check_socket_placement
  echo
  echo "== Q3. building an image from the project's own directory =="
  check_build
  echo
  echo "== Q4. do bind-mount paths mean the same thing on both sides =="
  check_bind_paths
  echo
  echo "== Q5. compose up, and reaching what it started =="
  compose_up && check_service_reachable
  echo
  echo "== Q6. what else the socket reaches =="
  check_reach_back
  echo
  echo "== Q7. the devcontainer's mount namespace, v2 vs today =="
  check_mount_namespace
fi

summary
verdict
echo
