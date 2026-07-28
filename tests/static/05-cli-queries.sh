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

group "the jq expressions in ssh-allow.sh"
# Third jq bug in this codebase, and none were caught by anything: a jq program
# is a string in one language embedded in another, so `bash -n` sees a valid
# script and the error only appears when that line runs. `secret list` shipped
# invalid jq for months; ssh-allow.sh's final assertion used `?//`, which parses
# as jq's destructuring-alternative operator, so the check could never run.
# Extract every jq program from the script and EXECUTE it.
SSH_ALLOW="$RELEASE/proxy/vm/ssh-allow.sh"
GH_FIXTURE='{"git":["192.30.252.0/22","140.82.112.0/20","2a0a:a440::/29"]}'

# Flags are OPTIONAL in this pattern. Requiring one (`jq -[a-z]+`) is how the
# first version of this test missed the very bug it was written for: that call
# was a bare `jq '<prog>'`, so the grep skipped it and the group passed on the
# OTHER programs. A guard that matches some of its subjects is worse than one
# that matches none, because the empty-guard below cannot see it.
PROGS=$(grep -oE "jq( -[a-zA-Z]+)* '[^']+'" "$SSH_ALLOW" \
        | sed -E "s/^jq( -[a-zA-Z]+)* '//; s/'$//" | sort -u)
# ...plus the two passed via the add_all helper.
PROGS="$PROGS
$(grep -oE "add_all ssh_allow_v[46] '[^']+'" "$SSH_ALLOW" | sed -E "s/.*'([^']+)'.*/\1/")"

if [ -z "$(printf '%s' "$PROGS" | tr -d '[:space:]')" ]; then
  fail "found jq programs in ssh-allow.sh" "grep matched nothing -- did the calls change shape?"
else
  while IFS= read -r prog; do
    [ -n "$prog" ] || continue
    if OUT=$(printf '%s' "$GH_FIXTURE" | jq -r "$prog" 2>&1); then
      pass "jq program runs: $prog"
    else
      fail "jq program runs: $prog" "$OUT"
    fi
  done <<< "$PROGS"
fi

# And the split must actually separate families, or one set gets both.
V4=$(printf '%s' "$GH_FIXTURE" | jq -r '.git[] | select(contains(":") | not)' | tr '\n' ' ')
V6=$(printf '%s' "$GH_FIXTURE" | jq -r '.git[] | select(contains(":"))' | tr '\n' ' ')
assert_not_contains "the v4 filter excludes IPv6 ranges" "$V4" ":"
assert_contains "the v6 filter keeps IPv6 ranges" "$V6" "2a0a"

summary
