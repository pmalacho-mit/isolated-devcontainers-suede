#!/usr/bin/env bash
# Host-side visibility into the INNER dockerd -- what is running in there, what
# it is logging, what it is using.
#
#   ./cli.sh observe            # ps (default)
#   ./cli.sh observe logs -f <container>
#   ./cli.sh observe stats
#   ./cli.sh observe inspect <container>
#   ./cli.sh observe raw        # container list as JSON
#   ./cli.sh observe docker <any docker args...>
#
# HOW IT GETS THERE, and why there is no port to point a tool at:
#
# The inner daemon listens on a unix socket in a named volume and nothing
# publishes it. This script reaches it by exec'ing into the orchestrator, which
# already holds that socket. Earlier versions instead published a GET-only
# socket proxy on 127.0.0.1:2375. That was removed on purpose -- its read-only
# guarantee only ever constrained this machine, which can drive the inner daemon
# through the orchestrator regardless, whereas an unauthenticated HTTP port on
# loopback is reachable from any browser pointed at a hostile page. A unix
# socket is not.
#
# The consequence to be honest about: this is a FULL-ACCESS channel presented
# through a fixed set of subcommands. It is not mechanically read-only, and the
# `docker` subcommand below is an explicit escape hatch. Nothing here is a
# containment boundary -- the boundaries are sysbox and the broker.
set -euo pipefail

ORCHESTRATOR=desolate-orchestrator
INNER_SOCK=unix:///run/inner/docker.sock
FALLBACK_IMAGE=docker:29-cli

# Normal path: the orchestrator has the socket and the CLI already.
# Fallback: when the ORCHESTRATOR is the thing that is broken, that path is gone
# exactly when it is most wanted. A throwaway CLI container on the same volume
# needs no running service -- only the volume, which outlives every container.
# Still a unix socket; still nothing published.
#
# The TTY decision is made HERE, per call, not once at startup: `inspect` pipes
# into jq, and a -t allocated because the SCRIPT's stdout was a terminal would
# feed jq carriage returns and fail. Inside the function the pipe is already in
# place, so this reads the real destination.
#
# The volume is mounted read-write on purpose: connecting to a unix socket needs
# write permission on it, so a :ro mount here fails with EACCES.
inner() {
  local tty=(); [ -t 0 ] && [ -t 1 ] && tty=(-it)
  if docker inspect -f '{{.State.Status}}' "$ORCHESTRATOR" 2>/dev/null | grep -qx running; then
    docker exec "${tty[@]}" "$ORCHESTRATOR" docker "$@"
  else
    echo "observe: $ORCHESTRATOR is not running -- using a throwaway CLI container" >&2
    docker run --rm "${tty[@]}" \
      -v desolate_inner-run:/run/inner \
      -e DOCKER_HOST="$INNER_SOCK" \
      "$FALLBACK_IMAGE" docker "$@"
  fi
}

# jq formats two of the subcommands below and runs HERE, on the Mac -- unlike
# cli.sh's jq calls, which all execute in the VM via `vm sudo jq`. Check it
# rather than letting the pipe fail with an empty result that reads like "no
# containers".
need_jq() {
  command -v jq >/dev/null 2>&1 || {
    echo "observe: '$1' formats output with jq, which is not installed." >&2
    echo "         brew install jq   (or use: $0 docker inspect ...)" >&2
    exit 1
  }
}

case "${1:-ps}" in
  ps)      inner ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' ;;
  stats)   shift; inner stats "${@:---no-stream}" ;;
  logs)    shift; inner logs "$@" ;;
  inspect) need_jq inspect; shift; inner inspect "$@" | jq . ;;
  raw)     need_jq raw; inner ps -a --format '{{json .}}' | jq -s . ;;
  docker)  shift; inner "$@" ;;
  *)       sed -n '5,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 1 ;;
esac
