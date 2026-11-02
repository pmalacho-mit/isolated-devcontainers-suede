#!/usr/bin/env bash
# preflight.sh with nothing to ask: no daemon, no VM, no network. Every check
# must fail or skip -- none may pass. foldyard's "verify false-pass" study, as a
# test: a negative check needs a positive control, and a probe that failed to
# run is not a probe that found nothing. Each pass here was one, once: a
# `docker inspect` that failed read as "no mounts", "publishes nothing", "no
# shared network", an all-interfaces publish printed as no address at all.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

STUBS=$(mktemp -d)
trap 'rm -rf "$STUBS"' EXIT
# Every tool preflight asks the stack through fails, saying nothing.
for tool in docker colima curl lsof; do
  printf '#!/bin/sh\nexit 1\n' > "$STUBS/$tool"
  chmod +x "$STUBS/$tool"
done
OUT=$(PATH="$STUBS:$PATH" timeout 120 bash "$RELEASE/preflight.sh" 2>&1)

group "preflight, with nothing it can ask"
# The control: it ran -- every section, and it said so -- so that nothing
# passing is a finding and not a script that stopped at its first line.
for section in "1. containers" "2. privilege separation" "5. security invariants" "5b. lateral containment" \
               "7. egress proxy" "8. ingress" "9. every bridge is covered"; do
  assert_contains "  (it reached section $section)" "$OUT" "== $section"
done
assert_contains "  (and failed checks along the way)" "$OUT" "  FAIL  "
PASSES=$(printf '%s\n' "$OUT" | grep '^  ok ' || true)
assert_eq "no check passes" "$PASSES" ""
assert_contains "  and it says so in its tally" "$OUT" "-- 0 passed,"

summary
