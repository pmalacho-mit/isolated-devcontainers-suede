#!/bin/sh
# inner-health.sh -- what the inner daemon is doing, in one word.
#
# dind's healthcheck runs this, and `cli.sh reset-inner` runs THE SAME FILE out
# of the same volume. One implementation, because two would eventually hold two
# opinions about what "wedged" means, and the whole value here is that a human
# and a healthcheck agree mid-boot.
#
# The three states, and why the middle one is worth a script:
#
#   booting   no socket yet. dockerd binds it when it starts listening, so this
#             is the ordinary first seconds of a start.
#   wedged    the socket is bound and `info` does not come back. The daemon is
#             up and not answering -- startup reconciliation over poisoned
#             on-disk state looks like this, and it looks like it at the FIRST
#             probe rather than at the twenty-fourth.
#   healthy   `info` answers. This is the definition this replaced, kept
#             unchanged: it is the right question.
#
# Exit status is the state, so a caller needs no parsing: 0 healthy, 1 booting,
# 2 wedged.
set -u

SOCKET=${DESOLATE_INNER_SOCKET:-/run/inner/docker.sock}
# Deliberately shorter than the healthcheck's own timeout: a check killed from
# outside reports nothing at all, and "nothing" is the state we are here to stop
# printing.
PATIENCE=${DESOLATE_INNER_PATIENCE:-2}

BOOTING=1
WEDGED=2

say() { echo "inner daemon: $1"; }

if [ ! -S "$SOCKET" ]; then
  say "booting -- $SOCKET is not bound yet"
  exit "$BOOTING"
fi

if timeout "$PATIENCE" docker -H "unix://$SOCKET" info >/dev/null 2>&1; then
  say "healthy -- info answered"
  exit 0
fi

say "wedged -- $SOCKET is bound, but 'docker info' did not answer in ${PATIENCE}s"
exit "$WEDGED"
