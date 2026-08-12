#!/usr/bin/env bash
# The type checker, over the tree this suite is about.
#
# WHY THIS IS NOT COVERED BY THE OTHER SUITES
#
# node RUNS these .ts files by STRIPPING types, never by compiling them. A type
# error is therefore not a syntax error and not a runtime error: nothing in
# 01-syntax.sh (`node --check`, which parses one file at a time) and nothing in
# the unit tests will ever mention it. What is left unchecked is precisely what
# the types are for -- whether the parts still AGREE.
#
# That is the failure this stack actually has. args.ts, broker.ts, desolate.ts
# and desolate-client.ts are separate processes speaking one grammar, and the
# unit tests exercise each of them alone; a field added on one side and read on
# another passes every one of them. A narrowing bug of exactly that shape --
# a guard that proved something about a request's OP while the code went on to
# read a project the op guarantees is absent -- is what this file exists to have
# caught.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"
cd "$ROOT"

# The locally installed checker first: it is pinned in package.json, so it is
# the only one this can be reproducible against. A `tsc` on PATH is the next
# best. Nothing is DOWNLOADED -- static and unit are the suites promised to run
# with no network, and buying a checker on the fly would quietly break that
# promise for whoever wired them into CI. No checker is a SKIP that says how to
# get one, in the same shape as this suite's python and tsx skips.
TSC=""
if [ -x "$ROOT/node_modules/.bin/tsc" ]; then
  TSC="$ROOT/node_modules/.bin/tsc"
elif command -v tsc >/dev/null 2>&1; then
  TSC=tsc
fi

group "typescript type-checks"

if [ -z "$TSC" ]; then
  skip "tsc --noEmit -p ." "not installed -- run: npm install"
else
  # `-p .` and not a list of flags: tsconfig.json is what the editor's language
  # service reads too, and a check that disagreed with the squiggles in front of
  # you is one people learn to ignore. It also decides the scope -- release/ and
  # tests/, never docs/ or .worktrees/; see the comments in that file.
  NAME="tsc --noEmit -p .  (release/ + tests/)"
  if OUT=$("$TSC" --noEmit -p "$ROOT" 2>&1); then
    pass "$NAME"
  else
    # Every error, not a truncated tail: a type error names a file and a line,
    # and the first one is usually the only one that is really a mistake.
    printf '%s\n' "$OUT" | sed 's/^/       /'
    fail "$NAME" "$(printf '%s\n' "$OUT" | grep -c ': error TS') error(s), listed above"
  fi
fi

summary
