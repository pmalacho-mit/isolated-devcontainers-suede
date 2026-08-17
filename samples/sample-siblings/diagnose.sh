#!/usr/bin/env bash
# Run this INSIDE the sample-siblings devcontainer, from its terminal:
#
#   bash diagnose.sh
#
# It reports what this container is, what daemon it can reach, what that daemon
# can see, and whether the three things a project actually needs still work. It
# starts and removes its own containers under sample-siblings-diag-*, and leaves
# the compose stack up so ports can be checked afterwards.
#
# Paste the SUMMARY block back. Every line in it is something that decides a
# piece of the per-project-dind design, and several are things that can only be
# measured from in here.
set -uo pipefail

MARKER=SAMPLE-SIBLINGS-MARKER
PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DIAG=sample-siblings-diag

PRIVILEGE="UNKNOWN"; DAEMON="UNKNOWN"; REACH="UNKNOWN"; SEES="UNKNOWN"
BUILD="UNKNOWN"; COMPOSE="UNKNOWN"; SERVICE="UNKNOWN"; MOUNTS="UNKNOWN"
SOCKETS=""; PORTS=""

note() { printf '      %s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }

cleanup() { docker rm -f "$DIAG" >/dev/null 2>&1; }
trap cleanup EXIT INT TERM

# --- what this container is -------------------------------------------------

# CapEff 0 is an ordinary unprivileged process; the full mask is --privileged.
# The uid_map's middle field says whether a user namespace is in play at all.
check_privilege() {
  local caps uidmap
  caps=$(grep CapEff /proc/self/status | awk '{print $2}')
  uidmap=$(tr -s ' ' < /proc/self/uid_map | sed 's/^ *//')
  note "CapEff  : $caps"
  note "uid_map : $uidmap"
  note "user    : $(id)"
  case "$caps" in
    0000000000000000) ok "unprivileged: no effective capabilities"
                      PRIVILEGE="unprivileged (CapEff 0)" ;;
    *fffff*)          bad "this container holds the full capability set"
                      PRIVILEGE="PRIVILEGED ($caps)" ;;
    *)                note "a partial capability set"
                      PRIVILEGE="partial ($caps)" ;;
  esac
}

# Which socket paths exist, and which one the CLI is actually pointed at.
check_sockets() {
  for path in /var/run/docker.sock /run/dind-sock/docker.sock /var/run/docker-host.sock; do
    [ -S "$path" ] && SOCKETS="$SOCKETS $path($(stat -c '%a %u:%g' "$path" 2>/dev/null))"
  done
  note "DOCKER_HOST: ${DOCKER_HOST:-<unset, so the CLI uses its default>}"
  note "sockets    :${SOCKETS:- none}"
  [ -n "$SOCKETS" ] || bad "no docker socket is present in this container"
}

# --- which daemon, and what it can see --------------------------------------

check_daemon() {
  if ! docker info >/dev/null 2>&1; then
    bad "no docker daemon is reachable"
    docker info 2>&1 | tail -n 3 | sed 's/^/        /'
    DAEMON="unreachable"; REACH="unreachable"
    return 1
  fi
  DAEMON=$(docker info --format '{{.Name}} / {{.Driver}} / {{.ServerVersion}}' 2>/dev/null)
  ok "daemon reachable: $DAEMON"
  note "docker root : $(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"
  note "containers  : $(docker info --format '{{.Containers}} ({{.ContainersRunning}} running)' 2>/dev/null)"
  return 0
}

# THE containment question. The daemon resolves bind sources on ITS filesystem,
# so what it holds at /workspaces is what this project can read -- whatever this
# container was allowed to mount.
check_what_the_daemon_sees() {
  local listing
  listing=$(docker run --rm -v /workspaces:/w alpine:3 sh -c 'ls -A /w | tr "\n" " "' 2>/dev/null | tr -d '\r')
  if [ -z "$listing" ]; then
    note "the daemon holds nothing at /workspaces (or the run failed)"
    SEES="nothing at /workspaces"
    return
  fi
  note "the daemon's /workspaces holds: $listing"
  case "$listing" in
    *sample-siblings*)
      local others
      others=$(printf '%s' "$listing" | tr ' ' '\n' | grep -v '^sample-siblings$' | grep -v '^$' | tr '\n' ' ')
      if [ -z "$others" ]; then
        ok "ONLY this project -- containment is per-project"
        SEES="only sample-siblings"
      else
        bad "this project's daemon can also read: $others"
        SEES="ALSO $others"
      fi ;;
    *) SEES="unexpected: $listing" ;;
  esac

  local siblings
  siblings=$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -cv '^$')
  note "containers this daemon already holds: ${siblings:-0}"
}

# --- the three things a project actually needs ------------------------------

check_build() {
  if docker build -q -t "$DIAG-image" "$PROJECT_DIR" >/dev/null 2>&1 &&
     docker run --rm "$DIAG-image" cat /baked-marker.txt 2>/dev/null | grep -q "$MARKER"; then
    ok "docker build from this project's directory"
    BUILD="YES"
  else
    bad "docker build failed"
    docker build -t "$DIAG-image" "$PROJECT_DIR" 2>&1 | tail -n 4 | sed 's/^/        /'
    BUILD="NO"
  fi
}

# A bind SOURCE is resolved by the daemon, not by this shell. Writing here and
# reading there is the only way to tell a path that resolves from one that
# merely exists on both sides.
check_bind_identity() {
  local token="BIND-$$" seen
  echo "$token" > "$PROJECT_DIR/.diag-token"
  seen=$(docker run --rm -v "$PROJECT_DIR:/x" alpine:3 cat /x/.diag-token 2>/dev/null | tr -d '\r')
  rm -f "$PROJECT_DIR/.diag-token"
  if [ "$seen" = "$token" ]; then
    ok "a container's bind of $PROJECT_DIR is this directory"
    REACH="YES"
  else
    bad "a container's bind of $PROJECT_DIR is NOT this directory"
    note "wrote '$token', the container read '${seen:-<nothing>}'"
    REACH="NO -- paths differ"
  fi
}

check_compose() {
  if (cd "$PROJECT_DIR" && docker compose up -d --build >/dev/null 2>&1); then
    ok "docker compose up --build"
    COMPOSE="YES"
  else
    bad "docker compose up failed"
    (cd "$PROJECT_DIR" && docker compose up --build 2>&1 | tail -n 4 | sed 's/^/        /')
    COMPOSE="NO"
    return 1
  fi
}

# Under docker-in-docker the service was a child on this container's own
# bridge. As a sibling it is on the compose bridge, which docker isolates --
# so this is where the two designs behave differently.
check_service_reachable() {
  local url=http://web:8000/marker.txt network
  if curl -fsS --max-time 5 "$url" 2>/dev/null | grep -q "$MARKER"; then
    ok "reached the service by name, unaided"
    SERVICE="YES -- by name"
    return
  fi
  network=$(cd "$PROJECT_DIR" && docker compose ps --format '{{.Networks}}' 2>/dev/null | head -1 | tr -d '\r')
  note "not reachable by name; its network is '${network:-unknown}'"
  if [ -n "$network" ] && docker network connect "$network" "$(hostname)" >/dev/null 2>&1 &&
     curl -fsS --max-time 5 "$url" 2>/dev/null | grep -q "$MARKER"; then
    note "reachable after joining '$network' -- which nothing does automatically"
    SERVICE="NO by default; YES after joining $network"
  else
    bad "not reachable, and joining its network did not fix it"
    SERVICE="NO"
  fi
}

# What the published port actually landed on. Under v2 the sibling publishes on
# the DIND, not on this container, so whatever forwards it to the Mac has a
# different address to find than it does today.
check_published_ports() {
  PORTS=$(cd "$PROJECT_DIR" && docker compose ps --format '{{.Name}} {{.Ports}}' 2>/dev/null | tr '\n' '|' | tr -d '\r')
  note "compose ports: ${PORTS:-<none>}"
  curl -fsS --max-time 5 http://127.0.0.1:8000/marker.txt >/dev/null 2>&1 \
    && note "127.0.0.1:8000 answers from inside this container" \
    || note "127.0.0.1:8000 does NOT answer from inside this container"
}

# The reliability claim: a nested daemon accrues an overlay mount in THIS
# container's mount namespace per image and container. A sibling design accrues
# none, because there is no daemon in here to hold them.
check_mount_namespace() {
  local before after
  before=$(grep -c overlay /proc/self/mounts)
  docker run -d --name "$DIAG" alpine:3 sleep 60 >/dev/null 2>&1
  after=$(grep -c overlay /proc/self/mounts)
  docker rm -f "$DIAG" >/dev/null 2>&1
  MOUNTS="$before -> $after"
  [ "$before" = "$after" ] \
    && ok "this container's mount namespace did not change ($MOUNTS)" \
    || note "this container accrued mounts by starting a container ($MOUNTS)"
}

summary() {
  echo
  echo "=============== SUMMARY (paste this back) ==============="
  echo "  privilege          : $PRIVILEGE"
  echo "  sockets present    :${SOCKETS:- none}"
  echo "  daemon             : $DAEMON"
  echo "  daemon's workspaces: $SEES"
  echo "  build              : $BUILD"
  echo "  bind path identity : $REACH"
  echo "  compose up         : $COMPOSE"
  echo "  service reachable  : $SERVICE"
  echo "  compose ports      : ${PORTS:-<none>}"
  echo "  overlay mounts here: $MOUNTS"
  echo "========================================================="
}

echo
echo "== what this container is =="
check_privilege
check_sockets
echo
echo "== which daemon it reaches, and what that daemon can see =="
if check_daemon; then
  check_what_the_daemon_sees
  echo
  echo "== the three things a project actually needs =="
  check_build
  check_bind_identity
  if check_compose; then
    check_service_reachable
    check_published_ports
  fi
  echo
  echo "== this container's mount namespace =="
  check_mount_namespace
fi
summary
echo
echo "the compose stack is left UP. Tear it down with:"
echo "  cd $PROJECT_DIR && docker compose down"
echo
