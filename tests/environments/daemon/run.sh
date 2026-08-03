#!/usr/bin/env bash
# Runs inside the `daemon` environment, with a docker socket.
#
# The report goes to a FILE and is then cat'd, rather than straight to stdout.
# Writes to a pipe are async in node, and the runner exits before they flush --
# so piping this environment's output produced a pass/fail with no report at all.
set -uo pipefail
cd /repo || exit 1

REPORT=$(mktemp)
node --test /repo/tests/environments/daemon/*.test.ts >"$REPORT" 2>&1
RC=$?
cat "$REPORT"
exit "$RC"
