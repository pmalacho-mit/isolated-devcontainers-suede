#!/usr/bin/env bash
# Syntax + reachability checks. Cheap, and they catch the class of bug where a
# whole section of a script never runs.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

group "shell syntax"
while IFS= read -r f; do
  assert_ok "bash -n ${f#"$ROOT/"}" bash -n "$f"
done < <(find "$ROOT" -name '*.sh' -not -path '*/node_modules/*' -not -path '*/.git/*' | sort)

group "python syntax"
if command -v python3 >/dev/null; then
  assert_ok "py_compile proxy/vm/addon.py" python3 -m py_compile "$RELEASE/proxy/vm/addon.py"
else
  skip "python syntax" "python3 not installed"
fi

group "typescript parses"
if node -e 'process.exit(process.versions.node.split(".").map(Number)[0] >= 22 ? 0 : 1)' 2>/dev/null; then
  for f in policy.ts broker.ts desolate.ts desolate-client.ts newrepo.ts; do
    # --check parses and strips types without executing.
    assert_ok "node --check vscode-image/$f" node --check "$RELEASE/vscode-image/$f"
  done
else
  skip "typescript parses" "node >= 22 required for native type stripping"
fi

group "no unreachable code after a top-level exit"
# preflight.sh once had its entire egress-proxy section sitting after `exit`,
# so the single check that tells you whether interception is on never ran and
# nothing complained. Generic guard: a top-level `exit` must be the last
# statement in the file.
for f in "$RELEASE/preflight.sh" "$RELEASE/observe.sh" "$RELEASE/cli.sh"; do
  name="no code after top-level exit in ${f#"$ROOT/"}"
  last_exit=$(grep -n '^exit ' "$f" | tail -1 | cut -d: -f1)
  if [ -z "$last_exit" ]; then
    pass "$name"
  else
    trailing=$(tail -n "+$((last_exit + 1))" "$f" | grep -vE '^\s*(#.*)?$' | head -3)
    if [ -z "$trailing" ]; then pass "$name"
    else fail "$name" "unreachable after line $last_exit: $(printf '%s' "$trailing" | head -1)"; fi
  fi
done


group "CLI argument formats we hand to other tools"
# The devcontainer CLI validates --mount against exactly
#   type=<bind|volume>,source=<source>,target=<target>[,external=<true|false>]
# and rejects the ENTIRE invocation with "Unmatched argument format" on anything
# else -- a `readonly` key here once broke every `desolate <project>`, and only
# after the egress proxy was installed, because that mount is conditional on
# ca.pem existing. Nothing at build or unit level catches it: it is a string
# assembled at runtime and validated by a different process.
MOUNT_SPECS=$(grep -oE '"--mount", `[^`]+`' "$RELEASE/vscode-image/desolate.ts" | sed 's/.*`\(.*\)`/\1/')
if [ -z "$MOUNT_SPECS" ]; then
  fail "found the --mount specs in desolate.ts" "grep matched nothing -- did the call shape change?"
else
  while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    # Drop ${...} interpolations; only the KEYS matter for this grammar.
    keys=$(printf '%s' "$spec" | sed 's/\${[^}]*}/X/g' | tr ',' '\n' | sed 's/=.*//' | paste -sd, -)
    case "$keys" in
      type,source,target|type,source,target,external)
        pass "devcontainer --mount spec is well-formed ($keys)" ;;
      *)
        fail "devcontainer --mount spec is well-formed" \
             "keys '$keys' -- the CLI accepts only type,source,target[,external]" ;;
    esac
  done <<< "$MOUNT_SPECS"
fi

group "every entry point carries proxy-CA trust"
# with-ca grants trust by EXPORTING env vars and exec'ing, and `docker exec`
# inherits nothing the entrypoint exported. A wrapper that skips it therefore
# works from the broker (which inherits the entrypoint's env) and fails from the
# Mac (`cli.sh desolate` -> docker exec), with an "unable to verify the first
# certificate" from whatever it spawns. Same root cause has now hit preflight,
# `cli.sh proxy test`, and `desolate` itself.
WRAPPERS=$(grep -oE "printf '#!/bin/sh[^']*' > /usr/local/bin/[a-z-]+" "$RELEASE/vscode-image/Dockerfile")
if [ -z "$WRAPPERS" ]; then
  fail "found the wrapper definitions in the Dockerfile" "grep matched nothing -- did they move?"
else
  while IFS= read -r w; do
    [ -n "$w" ] || continue
    name=${w##*/}
    case "$w" in
      *with-ca*) pass "$name routes through with-ca" ;;
      *) fail "$name routes through with-ca" \
              "bare exec -- works under the entrypoint, breaks under 'docker exec'" ;;
    esac
  done <<< "$WRAPPERS"
fi

summary
