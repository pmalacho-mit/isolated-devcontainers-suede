#!/usr/bin/env bash
# Tiny assertion harness shared by the shell-based suites.
#
# Deliberately dependency-free: these tests have to run on a bare Mac with
# nothing installed but the tools the stack itself already needs.

# Repo layout (prescribed by the suede workflow): everything that SHIPS lives
# under release/; this harness and all dev-only code lives outside it. So there
# are two roots, and conflating them is how tests end up silently asserting
# against files that are not there:
#
#   ROOT    -- the repo. Only for repo-wide concerns (git hygiene).
#   RELEASE -- the shipped tree. Everything under test lives here.
#   SAMPLES -- example devcontainers. Deliberately OUTSIDE release/: they are
#              fixtures and documentation, not something users install.
#
# Derived from this file's own location so a suite cannot drift by computing it
# differently, and overridable so a caller can point the suite at another tree.
_HARNESS_LIB=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ROOT="${ROOT:-$_HARNESS_LIB}"
RELEASE="${RELEASE:-$_HARNESS_LIB/release}"
SAMPLES="${SAMPLES:-$_HARNESS_LIB/samples}"

PASS=0
FAIL=0
SKIP=0
FAILED_NAMES=()

_c() { [ -t 1 ] && printf '\033[%sm' "$1" || true; }
GREEN() { _c 32; }; RED() { _c 31; }; YELLOW() { _c 33; }; DIM() { _c 2; }; OFF() { _c 0; }

pass() { GREEN; printf '  ok   '; OFF; printf '%s\n' "$1"; PASS=$((PASS+1)); }
fail() { RED;   printf '  FAIL '; OFF; printf '%s\n' "$1"; [ -n "${2:-}" ] && { DIM; printf '       %s\n' "$2"; OFF; }; FAIL=$((FAIL+1)); FAILED_NAMES+=("$1"); }
skip() { YELLOW; printf '  skip '; OFF; printf '%s' "$1"; [ -n "${2:-}" ] && printf ' (%s)' "$2"; printf '\n'; SKIP=$((SKIP+1)); }
group() { printf '\n'; printf '%s\n' "-- $* --"; }

# assert_ok "name" <command...>       -- command must exit 0
assert_ok() {
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then pass "$name"; else fail "$name" "$(printf '%s' "$out" | tail -3)"; fi
}

# assert_fails "name" <command...>    -- command must exit non-zero
assert_fails() {
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then fail "$name" "expected failure, got success"; else pass "$name"; fi
}

# assert_contains "name" "haystack" "needle"
assert_contains() {
  case "$2" in
    *"$3"*) pass "$1" ;;
    *)      fail "$1" "expected to find: $3" ;;
  esac
}

# assert_not_contains "name" "haystack" "needle"
assert_not_contains() {
  case "$2" in
    *"$3"*) fail "$1" "should NOT contain: $3" ;;
    *)      pass "$1" ;;
  esac
}

# assert_eq "name" "actual" "expected"
assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected '$3', got '$2'"; fi
}

summary() {
  printf '\n'
  if [ "$FAIL" -eq 0 ]; then GREEN; else RED; fi
  printf '%s passed, %s failed, %s skipped\n' "$PASS" "$FAIL" "$SKIP"; OFF
  if [ "$FAIL" -gt 0 ]; then
    printf 'failed:\n'
    for n in "${FAILED_NAMES[@]}"; do printf '  - %s\n' "$n"; done
  fi
  [ "$FAIL" -eq 0 ]
}
