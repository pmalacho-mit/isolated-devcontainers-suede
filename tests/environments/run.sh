#!/usr/bin/env bash
# tests/environments/run.sh -- build each environment and run its tests inside it.
#
#   ./tests/environments/run.sh              every environment
#   ./tests/environments/run.sh runtime      one of them
#   ./tests/environments/run.sh --keep       do not remove the containers
#
# An environment is a directory holding a Dockerfile and the tests that only
# mean something in that runtime. Discovery is by directory, so adding one takes
# no change here. A `needs-docker` file next to the Dockerfile declares that the
# environment wants the host's socket; without one it gets no daemon at all, so
# a unit test that starts depending on docker fails instead of hiding.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)

KEEP=0
WANTED=()
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    -*) echo "usage: run.sh [--keep] [environment...]" >&2; exit 2 ;;
    *) WANTED+=("$arg") ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }

if ! command -v docker >/dev/null 2>&1; then
  echo "  skip: no docker CLI -- environments need one to build" >&2
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo "  skip: docker CLI present but no daemon reachable" >&2
  exit 0
fi

# The socket to hand environments that ask for one. Inside this devcontainer
# that is docker-outside-of-docker: the containers we start are siblings of it,
# not children.
SOCKET=${DESOLATE_TEST_DOCKER_SOCKET:-/var/run/docker.sock}

# Sources are COPIED IN at build time rather than bind-mounted. Under
# docker-outside-of-docker a bind of a path only this container can see is
# resolved by the outer daemon against ITS filesystem, where it does not exist
# -- which surfaces either as a mount error or, worse, as a silently empty
# directory. Copying also means an environment tests the files as the image
# would ship them.
RC=0
ran=0

for dir in "$HERE"/*/; do
  name=$(basename "$dir")
  [ -f "$dir/Dockerfile" ] || continue
  if [ ${#WANTED[@]} -gt 0 ]; then
    match=0
    for want in "${WANTED[@]}"; do [ "$want" = "$name" ] && match=1; done
    [ "$match" = 1 ] || continue
  fi

  echo
  bold "== environment: $name =="

  needs_docker=0
  [ -f "$dir/needs-docker" ] && needs_docker=1
  if [ "$needs_docker" = 1 ] && [ ! -S "$SOCKET" ]; then
    echo "  skip: needs a docker socket and $SOCKET is not one"
    continue
  fi

  image="desolate-test-env-$name"
  if ! docker build -q -t "$image" -f "$dir/Dockerfile" "$ROOT" >/dev/null; then
    red "  FAIL: could not build $name"
    RC=1
    continue
  fi

  args=(-e "CI=${CI:-}")
  [ "$needs_docker" = 1 ] && args+=(-v "$SOCKET:/var/run/docker.sock")

  # Detached, then `docker wait` + `docker logs`, rather than a foreground run.
  # A foreground container's output arrives over a stream that is truncated when
  # the process exits promptly after writing -- which lost an entire test report
  # while still reporting the right exit code, the worst possible combination.
  ran=$((ran + 1))
  cid=$(docker run -d "${args[@]}" "$image")
  status=$(docker wait "$cid")
  docker logs "$cid" 2>&1
  [ "$KEEP" = 1 ] || docker rm -f "$cid" >/dev/null 2>&1

  if [ "$status" = 0 ]; then
    green "  $name passed"
  else
    red "  $name FAILED (exit $status)"
    RC=1
  fi
done

echo
if [ "$ran" = 0 ]; then
  echo "no environments ran"
elif [ "$RC" = 0 ]; then
  green "ALL ENVIRONMENTS PASSED"
else
  red "ENVIRONMENT FAILURES -- see above"
fi
exit "$RC"
