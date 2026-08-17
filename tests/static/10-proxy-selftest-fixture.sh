#!/usr/bin/env bash
# Cross-file agreement about the self-test fixture -- the placeholder preflight
# trips to prove leak detection is live.
#
# It has failed in both directions. ABSENT: `secret rm` deleted it and install.sh
# only seeded settings.json when the file did not exist, so the probes stopped
# failing closed and reported `secrets can be exfiltrated` against a healthy
# addon. PRESENT: its name is published in this repo's own source, so under the
# ordinary substring rule every request carrying those bytes toward anything but
# httpbin.org was a 403 -- and deleting it was the cure, which is the first
# failure again.
#
# addon.py's BEHAVIOUR is covered by tests/unit/proxy. What only this suite can
# see is the four files agreeing: a value in two places, a name in three, and a
# log format string parsed across the Mac/VM boundary.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

FIXTURE="DESOLATE-SELFTEST-PLACEHOLDER"
EXAMPLE="$RELEASE/proxy/vm/settings.example.json"
INSTALL="$RELEASE/proxy/vm/install.sh"
ADDON="$RELEASE/proxy/vm/addon.py"
PREFLIGHT="$RELEASE/preflight.sh"
CLI="$RELEASE/cli.sh"

for f in "$EXAMPLE" "$INSTALL" "$ADDON" "$PREFLIGHT" "$CLI"; do
  [ -f "$f" ] || { fail "$(basename "$f") exists" "$f not found"; summary; exit $?; }
done

# Same extraction discipline as 05-cli-queries.sh: a single-quoted one-liner at
# column 0, pulled out and EXECUTED rather than pattern-matched.
extract_jq_program() { sed -n "s/^$1='\(.*\)'$/\1/p" "$2"; }

group "the shipped fixture"
if ! command -v jq >/dev/null 2>&1; then
  skip "the shipped fixture" "jq not installed"
  EXAMPLE_VALUE=""
else
  assert_eq "settings.example.json defines $FIXTURE" \
    "$(jq -r --arg n "$FIXTURE" 'if .secrets[$n] then "yes" else "no" end' "$EXAMPLE")" "yes"
  assert_eq "its allowlist pins httpbin.org" \
    "$(jq -r --arg n "$FIXTURE" '.secrets[$n].hosts | join(",")' "$EXAMPLE")" "httpbin.org"
  assert_eq "it is marked selftest" \
    "$(jq -r --arg n "$FIXTURE" '.secrets[$n].selftest' "$EXAMPLE")" "true"
  EXAMPLE_VALUE=$(jq -r --arg n "$FIXTURE" '.secrets[$n].value' "$EXAMPLE")
fi

group "install.sh seeds only when absent"
INSTALL_SRC=$(cat "$INSTALL")
# THE dangerous regression: without this guard, `vm install` overwrites a
# settings.json holding real secrets with the example file, on every run.
assert_contains "the settings path is named once" "$INSTALL_SRC" \
  'SETTINGS_JSON=/etc/desolate-proxy/settings.json'
assert_contains "and the file is only written when it does not exist" "$INSTALL_SRC" \
  '[ ! -f "$SETTINGS_JSON" ]'

group "install.sh's restore step cannot damage a real store"
RESTORE_JQ=$(extract_jq_program SELFTEST_FIXTURE_JQ "$INSTALL")
CURRENT_JQ=$(extract_jq_program SELFTEST_FIXTURE_CURRENT_JQ "$INSTALL")
if ! command -v jq >/dev/null 2>&1; then
  skip "install.sh's restore step" "jq not installed"
elif [ -z "$RESTORE_JQ" ] || [ -z "$CURRENT_JQ" ]; then
  fail "install.sh's jq programs can be extracted" \
       "sed matched nothing -- were they renamed or reformatted?"
else
  pass "install.sh's jq programs can be extracted"
  BEFORE='{"default_action":"deny","secrets":{"MYAPP-OPENAI-KEY":{"value":"sk-a-real-one","hosts":["api.openai.com","*.openai.com"]}},"network":[{"action":"allow","host":"deb.debian.org"}]}'
  if AFTER=$(printf '%s' "$BEFORE" | jq "$RESTORE_JQ" 2>&1); then
    pass "the restore expression is valid jq"
    assert_eq "a real secret's value survives untouched" \
      "$(printf '%s' "$AFTER" | jq -r '.secrets["MYAPP-OPENAI-KEY"].value')" "sk-a-real-one"
    assert_eq "a real secret's allowlist survives untouched" \
      "$(printf '%s' "$AFTER" | jq -c '.secrets["MYAPP-OPENAI-KEY"].hosts')" \
      '["api.openai.com","*.openai.com"]'
    assert_eq "nothing but the fixture key changes" \
      "$(printf '%s' "$AFTER" | jq -S "del(.secrets[\"$FIXTURE\"])")" \
      "$(printf '%s' "$BEFORE" | jq -S .)"
    # Two copies of one literal in two files is how this comes back.
    assert_eq "the value it writes matches settings.example.json" \
      "$(printf '%s' "$AFTER" | jq -r ".secrets[\"$FIXTURE\"].value")" "$EXAMPLE_VALUE"
    assert_eq "what it writes satisfies install.sh's own presence test" \
      "$(printf '%s' "$AFTER" | jq -r "$CURRENT_JQ")" "true"
    # A fixture from an older install satisfies mere presence and still 403s
    # every request that names it, so the presence test must check the flag.
    assert_eq "a pre-selftest fixture is treated as stale" \
      "$(printf '%s' "$AFTER" | jq "del(.secrets[\"$FIXTURE\"].selftest)" | jq -r "$CURRENT_JQ")" \
      "false"
  else
    fail "the restore expression is valid jq" "$AFTER"
  fi
fi

group "an upgraded addon.py actually takes effect"
# mitmproxy loads addon.py once, at startup, but settings.json is adopted live
# by mtime. An install that refreshes both without restarting the service
# therefore runs the OLD policy against the NEW config -- the state in which a
# fixture carrying "selftest" is judged as a real secret and 403s every request
# naming it. `enable --now` does not restart a unit that is already running.
addon_install_line() { grep -n 'install -m 0644 addon.py' "$INSTALL" | head -1 | cut -d: -f1; }
proxy_restart_line() { grep -n 'systemctl try-restart desolate-proxy' "$INSTALL" | head -1 | cut -d: -f1; }
INSTALLED_AT=$(addon_install_line); RESTARTED_AT=$(proxy_restart_line)
if [ -z "$RESTARTED_AT" ]; then
  fail "install.sh restarts desolate-proxy after replacing addon.py" \
       "no 'systemctl try-restart desolate-proxy' -- a running proxy keeps the old addon"
elif [ -z "$INSTALLED_AT" ]; then
  fail "install.sh restarts desolate-proxy after replacing addon.py" \
       "could not find where addon.py is installed"
elif [ "$RESTARTED_AT" -gt "$INSTALLED_AT" ]; then
  pass "install.sh restarts desolate-proxy after replacing addon.py"
else
  fail "install.sh restarts desolate-proxy after replacing addon.py" \
       "restart at line $RESTARTED_AT precedes the addon.py install at line $INSTALLED_AT"
fi

group "the fixture cannot be removed by accident"
CLI_SRC=$(cat "$CLI")
assert_contains "cli.sh knows the fixture name" "$CLI_SRC" "SELFTEST_FIXTURE=$FIXTURE"
assert_contains "secret rm guards it" "$CLI_SRC" '[ "$NAME" = "$SELFTEST_FIXTURE" ]'
# Deleting it was the only cure for the PRESENT failure above, so the escape
# hatch has to survive a regression in addon.py's narrowed match.
assert_contains "and still offers a documented override" "$CLI_SRC" '--force'

group "preflight uses the fixture it thinks it uses"
PREFLIGHT_SRC=$(cat "$PREFLIGHT")
assert_contains "its probes reference the fixture" "$PREFLIGHT_SRC" "$FIXTURE"
assert_contains "a missing fixture skips rather than fails" "$PREFLIGHT_SRC" \
  'skip_fixture_dependent_probes'
assert_contains "the summary reports the skip count" "$PREFLIGHT_SRC" '$skip skipped'

group "the config-load line survives the Mac/VM boundary"
# addon.py emits this once per load and preflight greps it across `colima ssh`.
# A reword silences the check, and the "intercepted but UNGOVERNED" state stops
# being reported at all -- same spirit as 06-proxy-service.sh pinning the
# mitmproxy options the addon depends on.
assert_contains "addon.py emits the format preflight parses" "$(cat "$ADDON")" \
  'f"loaded {len(self.secrets)} secret(s), {len(self.network)} network rule(s), "'
assert_contains "preflight greps for that exact format" "$PREFLIGHT_SRC" \
  'loaded [0-9]+ secret\(s\), [0-9]+ network rule\(s\), default_action='

summary
