#!/usr/bin/env bash
# The self-test fixture: the placeholder preflight trips to prove leak
# detection is running.
#
# It is a fixture, not a secret, and it has failed in both directions:
#
#   ABSENT  -- `cli.sh secret rm` deleted it and install.sh only seeded
#              settings.json when the file did not exist. addon.py matches
#              CONFIGURED placeholder names only, so the probes stopped
#              failing closed and started reporting `secrets can be
#              exfiltrated` against a completely healthy addon.
#
#   PRESENT -- its name is a PUBLISHED string: it ships in this repo's source,
#              docs and tests. Under the ordinary substring rule every request
#              carrying those bytes toward anything but httpbin.org was a 403,
#              so `git push` and any agent editing this repo were refused. The
#              cure people found was deleting it, which is the first failure.
#
# Both are fixed at once or neither is: install.sh re-asserts it every run, and
# `"selftest": true` narrows detection to the one shape the probes send. This
# suite pins the pieces that have to agree, because they live in four files and
# nothing else would notice them drifting apart.
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

group "the shipped fixture"
if command -v jq >/dev/null 2>&1; then
  assert_eq "settings.example.json defines $FIXTURE" \
    "$(jq -r --arg n "$FIXTURE" 'if .secrets[$n] then "yes" else "no" end' "$EXAMPLE")" "yes"
  assert_eq "its allowlist pins httpbin.org" \
    "$(jq -r --arg n "$FIXTURE" '.secrets[$n].hosts | join(",")' "$EXAMPLE")" "httpbin.org"
  # Without this the fixture is a landmine rather than a fixture: see the header.
  assert_eq "it is marked selftest" \
    "$(jq -r --arg n "$FIXTURE" '.secrets[$n].selftest' "$EXAMPLE")" "true"
  EXAMPLE_VALUE=$(jq -r --arg n "$FIXTURE" '.secrets[$n].value' "$EXAMPLE")
else
  skip "settings.example.json fixture shape" "jq not installed"
  EXAMPLE_VALUE=""
fi

group "install.sh restores it without touching anything else"
INSTALL_SRC=$(cat "$INSTALL")
# THE dangerous regression. If the guard goes away, `vm install` overwrites a
# settings.json holding real secrets with the example file, on every run. This
# is the most damaging way to get the restore step wrong, so it is asserted
# before anything about the restore step itself.
assert_contains "settings.json is still only SEEDED when absent" "$INSTALL_SRC" \
  '[ ! -f /etc/desolate-proxy/settings.json ]'
assert_contains "the restore step re-asserts the fixture by key" "$INSTALL_SRC" \
  ".secrets[\"$FIXTURE\"] ="
assert_contains "it restores the selftest flag too" "$INSTALL_SRC" "selftest: true"
# Two copies of the same literal in two files is how this comes back: the
# installer would happily restore a fixture whose value no longer matches the
# one everything else documents.
if [ -n "$EXAMPLE_VALUE" ]; then
  assert_contains "install.sh's fixture value matches settings.example.json" \
    "$INSTALL_SRC" "value: \"$EXAMPLE_VALUE\""
fi
# A pre-`selftest` fixture satisfies a bare presence test while still poisoning
# every request that names it, so the installer has to check the SHAPE.
assert_contains "the presence test demands the selftest flag, not just the key" \
  "$INSTALL_SRC" ".selftest == true"

group "the restore step cannot damage a real store"
# Not a source-text assertion: pull install.sh's actual jq program out and RUN
# it against a store holding a real secret. `.secrets["NAME"] = {...}` and
# `.secrets = {...}` differ by four characters and the second silently deletes
# every real secret on the box on every `vm install`. Only executing it can
# tell those apart.
if command -v jq >/dev/null 2>&1; then
  RESTORE_JQ=$(sed -n "/elif jq '/,/}' *\\\\$/p" "$INSTALL" \
               | sed -e "s/.*elif jq '//" -e "s/' *\\\\$//")
  if [ -z "${RESTORE_JQ//[[:space:]]/}" ]; then
    fail "install.sh's restore expression can be extracted" \
         "no 'elif jq ...' block found -- this suite is asserting nothing"
  else
    BEFORE='{"default_action":"deny","secrets":{"MYAPP-OPENAI-KEY":{"value":"sk-a-real-one","hosts":["api.openai.com","*.openai.com"]}},"network":[{"action":"allow","host":"deb.debian.org"}],"scrub_responses":true}'
    if AFTER=$(printf '%s' "$BEFORE" | jq "$RESTORE_JQ" 2>&1); then
      pass "install.sh's restore expression is valid jq"
      assert_eq "a real secret's value survives untouched" \
        "$(printf '%s' "$AFTER" | jq -r '.secrets["MYAPP-OPENAI-KEY"].value')" "sk-a-real-one"
      assert_eq "a real secret's allowlist survives untouched" \
        "$(printf '%s' "$AFTER" | jq -c '.secrets["MYAPP-OPENAI-KEY"].hosts')" \
        '["api.openai.com","*.openai.com"]'
      assert_eq "nothing but the fixture key changes" \
        "$(printf '%s' "$AFTER" | jq -S "del(.secrets[\"$FIXTURE\"])")" \
        "$(printf '%s' "$BEFORE" | jq -S .)"
      assert_eq "and the fixture it writes satisfies install.sh's own presence test" \
        "$(printf '%s' "$AFTER" | jq -r ".secrets[\"$FIXTURE\"].selftest == true")" "true"
    else
      fail "install.sh's restore expression is valid jq" "$AFTER"
    fi
  fi
else
  skip "install.sh's restore expression preserves real secrets" "jq not installed"
fi

group "addon.py implements the narrowed match"
ADDON_SRC=$(cat "$ADDON")
assert_contains "the selftest flag is read off the entry" "$ADDON_SRC" \
  'entry.get("selftest", False)'
assert_contains "response scrubbing skips selftest entries" "$ADDON_SRC" \
  'if entry.get("selftest"):'
# The probes send the placeholder as a whole header value and nothing else
# does; that is the entire discriminator. If matching widens back to a
# substring search the fixture becomes a landmine again, silently.
assert_contains "detection is scoped to a complete header value" "$ADDON_SRC" \
  'name in header_values'

group "the fixture cannot be removed by accident"
CLI_SRC=$(cat "$CLI")
assert_contains "cli.sh secret rm guards the fixture name" "$CLI_SRC" \
  "\"\$NAME\" = \"$FIXTURE\""
# Deleting it was the only cure for the PRESENT failure above, and that cure
# has to survive a regression in the narrowed match -- otherwise a bug in
# addon.py leaves the stack unusable with no way out.
assert_contains "and still offers a documented override" "$CLI_SRC" '--force'

group "preflight uses the fixture it thinks it uses"
PREFLIGHT_SRC=$(cat "$PREFLIGHT")
assert_contains "preflight's probes reference the fixture" "$PREFLIGHT_SRC" "$FIXTURE"
assert_contains "a missing fixture skips rather than fails" "$PREFLIGHT_SRC" \
  'skipped "leak detection'
assert_contains "the summary reports the skip count" "$PREFLIGHT_SRC" \
  '$skip skipped'
# Pins Change 3c against a reword. addon.py logs this once per config load and
# preflight greps for it; if the wording drifts the check goes quiet and the
# "intercepted but UNGOVERNED" state stops being reported at all. Same spirit
# as 06-proxy-service.sh pinning the mitmproxy options.
LOADED_FORMAT='loaded '
assert_contains "addon.py emits the config-load line preflight parses" "$ADDON_SRC" \
  'f"loaded {len(self.secrets)} secret(s), {len(self.network)} network rule(s), "'
assert_contains "preflight greps for that exact format" "$PREFLIGHT_SRC" \
  "${LOADED_FORMAT}[0-9]+ secret\\(s\\), [0-9]+ network rule\\(s\\), default_action="

summary
