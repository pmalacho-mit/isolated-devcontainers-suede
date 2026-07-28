#!/usr/bin/env bash
# Queries cli.sh hands to other programs, EXECUTED rather than eyeballed.
#
# `secret list` shipped with a jq program that was invalid jq -- it escaped its
# quotes to survive `colima ssh` re-parsing, and `\"` is not legal inside a
# `\(...)` interpolation. It could never have worked, on any machine, and
# nothing caught it: bash -n only checks bash, and the failure was masked by a
# `|| echo "(no secrets configured yet)"` that reported an empty store.
#
# So: pull the real program out of cli.sh and run it against a fixture.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

if ! command -v jq >/dev/null 2>&1; then
  skip "cli.sh queries" "jq not installed"
  summary; exit $?
fi

group "the 'secret list' jq program"

# Extracted, not retyped -- a copy here could drift from what actually ships.
PROG=$(sed -n "s/^SECRET_LIST_JQ='\(.*\)'$/\1/p" "$RELEASE/cli.sh")
if [ -z "$PROG" ]; then
  fail "found SECRET_LIST_JQ in cli.sh" "sed matched nothing -- was it renamed or reformatted?"
  summary; exit $?
fi
pass "found SECRET_LIST_JQ in cli.sh"

FIXTURE='{"secrets":{"MYAPP-OPENAI-KEY":{"value":"x","hosts":["api.openai.com","*.example.com"]},"OTHER-KEY":{"value":"y","hosts":["b.com"]}}}'

if OUT=$(printf '%s' "$FIXTURE" | jq -r "$PROG" 2>&1); then
  pass "it is valid jq and runs"
else
  fail "it is valid jq and runs" "$OUT"
fi

assert_contains "it lists a secret with its allowlist" "$OUT" "MYAPP-OPENAI-KEY"
assert_contains "it includes every host, not just the first" "$OUT" "*.example.com"
assert_contains "it lists every secret" "$OUT" "OTHER-KEY"

# The whole point of the TSV shape: nothing for a remote shell to re-parse.
case "$PROG" in
  *'"'*) fail "the program survives 'colima ssh' re-parsing" \
              "it contains a double quote, which the remote shell may strip" ;;
  *' '*) fail "the program survives 'colima ssh' re-parsing" \
              "it contains a space, which the remote shell may split on" ;;
  *)     pass "the program survives 'colima ssh' re-parsing" ;;
esac

# An empty store must be distinguishable from a broken query -- conflating them
# is what hid the bug.
EMPTY=$(printf '%s' '{"secrets":{}}' | jq -r "$PROG" 2>&1)
assert_eq "an empty store yields no rows" "$EMPTY" ""

summary
