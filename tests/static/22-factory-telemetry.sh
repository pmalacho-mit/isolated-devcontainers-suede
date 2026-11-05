#!/usr/bin/env bash
# examples/factory's timing log (lib/telemetry.sh, telemetry.sh): a timed call
# keeps its output and exit status and leaves one line; "off" writes nothing;
# the report reads what was written.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"
command -v jq >/dev/null || { skip "telemetry" "jq not installed"; summary; exit $?; }

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export FACTORY_TELEMETRY=$T/t.jsonl
. "$ROOT/examples/factory/lib/telemetry.sh"

group "a timed call"
out=$(PROJECT=a/b TELE_ISSUE=3 tele_timed demo sh -c 'echo hello; exit 4'); code=$?
assert_eq "its output passes through" "$out" hello
assert_eq "its exit status passes through" "$code" 4
assert_eq "one valid line is left" "$(jq -c 'select(.op == "demo" and .exit == 4 and .issue == 3 and .project == "a/b") | .ms | type' "$FACTORY_TELEMETRY")" '"number"'
tele_event issue_seen project=a/b issue=3 title='say "hi"'
assert_eq "a quote in a value stays valid JSON" "$(jq -r 'select(.event == "issue_seen") | .title' "$FACTORY_TELEMETRY")" 'say "hi"'

group "report"
assert_contains "names the operation" "$("$ROOT/examples/factory/telemetry.sh" report)" "demo | 1 | 1"

group "off"
rm -f "$FACTORY_TELEMETRY"; TELEMETRY_FILE=off tele_timed demo true
assert_eq "writes nothing" "$(ls "$T" | wc -l | tr -d ' ')" 0
summary
