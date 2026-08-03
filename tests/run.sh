#!/usr/bin/env bash
# tests/run.sh -- the whole suite, or one layer of it.
#
#   ./tests/run.sh                 static + unit          (fast, no stack, no docker daemon needed)
#   ./tests/run.sh static          config invariants only
#   ./tests/run.sh unit            policy + desolate + proxy addon logic only
#   ./tests/run.sh environments    the unit suite inside containers that mirror
#                                  the shipped runtime (needs docker, no VM)
#   ./tests/run.sh integration     brings a stack UP and attacks it (slow, needs docker)
#   ./tests/run.sh all             everything
#
# static and unit are the ones to wire into CI: they need no daemon, no VM and
# no network, and they carry a regression case for every escape that has been
# demonstrated against this design.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

SUITE="${1:-default}"
RC=0
run() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; shift; "$@" || RC=1; }

# --- how to run TypeScript -------------------------------------------------
# node >= 22.18 strips types natively, so the unit tests need nothing installed.
# Older node falls back to tsx if it happens to be around.
node_test() {
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a>22||(a===22&&b>=18))?0:1)' 2>/dev/null; then
    node --test "$@"
  elif command -v tsx >/dev/null 2>&1; then
    node --import tsx --test "$@"
  elif command -v npx >/dev/null 2>&1; then
    npx --yes tsx@4 --test "$@" 2>/dev/null || {
      echo "  skip: need node >= 22.18 (native type stripping) or tsx" >&2; return 0; }
  else
    echo "  skip: need node >= 22.18 or tsx" >&2; return 0
  fi
}

# --- which python has mitmproxy -------------------------------------------
find_python() {
  for p in "${DESOLATE_PYTHON:-}" /opt/desolate-proxy/venv/bin/python /opt/mitmtest/bin/python python3; do
    [ -n "$p" ] || continue
    command -v "$p" >/dev/null 2>&1 || [ -x "$p" ] || continue
    "$p" -c 'import mitmproxy, pytest' >/dev/null 2>&1 && { echo "$p"; return 0; }
  done
  return 1
}

run_static() {
  local rc=0
  for t in "$ROOT"/tests/static/*.sh; do
    printf '\n\033[1m-- %s --\033[0m\n' "$(basename "$t")"
    bash "$t" || rc=1
  done
  return $rc
}

run_unit() {
  local rc=0
  printf '\n\033[1m-- broker spec policy --\033[0m\n'
  node_test "$ROOT"/tests/unit/broker/*.test.ts || rc=1

  printf '\n\033[1m-- desolate --\033[0m\n'
  node_test "$ROOT"/tests/unit/desolate/*.test.ts || rc=1

  printf '\n\033[1m-- proxy addon --\033[0m\n'
  local py
  if py=$(find_python); then
    "$py" -m pytest "$ROOT/tests/unit/proxy" -q || rc=1
  else
    echo "  skip: no python with mitmproxy+pytest."
    echo "        python3 -m venv /tmp/desolate-test && /tmp/desolate-test/bin/pip install 'mitmproxy==11.0.2' pytest"
    echo "        then: DESOLATE_PYTHON=/tmp/desolate-test/bin/python ./tests/run.sh unit"
  fi
  return $rc
}

run_integration() {
  bash "$ROOT/tests/integration/run.sh"
}

case "$SUITE" in
  static)      run "static" run_static ;;
  unit)        run "unit" run_unit ;;
  environments) run "environments" bash "$ROOT/tests/environments/run.sh" ;;
  integration) run "integration" run_integration ;;
  all)         run "static" run_static; run "unit" run_unit
               run "environments" bash "$ROOT/tests/environments/run.sh"
               run "integration" run_integration ;;
  default)     run "static" run_static; run "unit" run_unit
               printf '\n(integration not run -- it starts containers. ./tests/run.sh integration)\n' ;;
  *)           echo "usage: tests/run.sh [static|unit|environments|integration|all]" >&2; exit 2 ;;
esac

printf '\n'
if [ "$RC" -eq 0 ]; then printf '\033[32mALL SUITES PASSED\033[0m\n'; else printf '\033[31mSUITE FAILURES -- see above\033[0m\n'; fi
exit "$RC"
