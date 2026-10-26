#!/usr/bin/env bash
# PROBE -- not a test. Answers a capability question so a design decision can
# be made; it asserts no invariant and gates nothing.
#
# QUESTION (factory F5): can Claude Code be handed its credential as a proxy
# PLACEHOLDER -- so every target of a project starts logged in and the real
# token never enters a container -- or does it check the token's shape
# locally, or refuse it, before anything is sent?
#
#   ./tests/probes/agent-token-placeholder.sh [<project-with-a-dind>]
#
# Runs Claude Code (`npx @anthropic-ai/claude-code -p`) in a throwaway node
# container on that project's dind -- the reach a devcontainer has -- once per
# variant, with a placeholder registered as a secret for api.anthropic.com
# whose VALUE is fake. The proxy's audit line is the answer: SUBST means the
# placeholder was sent and substituted (the upstream then refuses the fake
# value, which is expected and not the question); no line means Claude Code
# never sent it.
#
#   V1  CLAUDE_CODE_OAUTH_TOKEN = a plain placeholder
#   V2  CLAUDE_CODE_OAUTH_TOKEN = a placeholder with the real prefix (sk-ant-oat01-)
#   V3  ANTHROPIC_API_KEY       = a plain placeholder
#   V4  ANTHROPIC_API_KEY       = a placeholder with the real prefix (sk-ant-api03-)
#
# Needs: the nested harness (tests/environments/nested) or the real stack;
# the proxy's settings and log are read and restored through STATE below.
#
# ANSWERED 2026-10-26, nested harness, Claude Code 2.1.310 (npx @latest), on
# sample-siblings' dind: ALL FOUR variants were SENT and substituted. Claude
# Code checks no shape locally: a plain placeholder and a prefixed one both
# went out as the bearer (GET /api/claude_code/settings, policy_limits, POST
# /api/eval/...), each audited `verdict=SUBST ... project=sample-siblings`, and
# the upstream's 401 for the fake value came back as "Invalid bearer token" /
# "Invalid API key" -- the expected answer to a fake value, not to the shape.
# So the factory's credential is a placeholder secret, scoped to the project
# (T4.6), as "Agent credentials across a project's worktrees" proposed; no
# prefix is needed, and the volume fallback (F5b) is not. Not asked here, and
# still open: refresh behaviour of a real OAuth token, which `setup-token`'s
# long-lived tokens should not need.
set -uo pipefail
PROJECT=${1:-sample-siblings}
DIND=desolate-dind-${PROJECT//\//__}
STATE=${DESOLATE_NESTED_STATE:-/tmp/desolate-nested}
SETTINGS=$STATE/settings.json LOG=$STATE/proxy.log
[ -f "$SETTINGS" ] || { echo "probe: no nested proxy settings at $SETTINGS (run tests/environments/nested/run.sh up)"; exit 2; }
docker inspect "$DIND" >/dev/null 2>&1 || { echo "probe: $DIND is not running; start $PROJECT first"; exit 2; }

declare -A VARIANT=(
  [V1]="CLAUDE_CODE_OAUTH_TOKEN PROBE-CLAUDE-OAUTH-PLACEHOLDER"
  [V2]="CLAUDE_CODE_OAUTH_TOKEN sk-ant-oat01-PROBE-CLAUDE-OAUTH"
  [V3]="ANTHROPIC_API_KEY PROBE-ANTHROPIC-KEY-PLACEHOLDER"
  [V4]="ANTHROPIC_API_KEY sk-ant-api03-PROBE-ANTHROPIC-KEY"
)

sudo cp "$SETTINGS" "$STATE/settings.probe-backup"
restore() { sudo cp "$STATE/settings.probe-backup" "$SETTINGS"; sudo chown desolate-proxy:desolate-proxy "$SETTINGS"; sudo chmod 600 "$SETTINGS"; }
trap restore EXIT
sudo python3 - "$SETTINGS" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
for name in ["PROBE-CLAUDE-OAUTH-PLACEHOLDER", "sk-ant-oat01-PROBE-CLAUDE-OAUTH",
             "PROBE-ANTHROPIC-KEY-PLACEHOLDER", "sk-ant-api03-PROBE-ANTHROPIC-KEY"]:
    d["secrets"][name] = {"value": "fake-value-for-the-probe", "hosts": ["api.anthropic.com", "*.anthropic.com"]}
json.dump(d, open(p, "w"))
PY
sudo chown desolate-proxy:desolate-proxy "$SETTINGS"; sudo chmod 600 "$SETTINGS"
sleep 2

docker exec "$DIND" docker pull -q node:22-bookworm-slim >/dev/null 2>&1
declare -A ANSWER
for v in V1 V2 V3 V4; do
  read -r var value <<<"${VARIANT[$v]}"
  start=$(sudo wc -l < "$LOG")
  out=$(docker exec "$DIND" timeout 300 docker run --rm -v /desolate-ca:/desolate-ca:ro \
    -e NODE_EXTRA_CA_CERTS=/desolate-ca/ca.pem -e "$var=$value" -e DISABLE_AUTOUPDATER=1 -e CI=1 \
    node:22-bookworm-slim sh -c 'npx -y @anthropic-ai/claude-code@latest -p "say ok" 2>&1 | tail -3' 2>&1)
  sleep 2
  lines=$(sudo tail -n +"$((start + 1))" "$LOG" | grep -a 'AUDIT .*host=[a-z.]*anthropic.com' | sed 's/^.*AUDIT/AUDIT/')
  if printf '%s' "$lines" | grep -q "secrets=$value"; then ANSWER[$v]="SENT and substituted"
  elif printf '%s' "$lines" | grep -q "suspect=.*$value"; then ANSWER[$v]="sent, NOT substituted"
  elif [ -n "$lines" ]; then ANSWER[$v]="reached anthropic.com WITHOUT the placeholder"
  else ANSWER[$v]="nothing reached anthropic.com"; fi
  echo "== $v ($var=$value)"
  printf '%s\n' "$lines" | head -4 | sed 's/^/   /'
  printf '%s\n' "$out" | sed 's/^/   claude: /'
done

echo
echo "=============== SUMMARY (paste this back) ==============="
for v in V1 V2 V3 V4; do printf '  %s  %-48s %s\n' "$v" "${VARIANT[$v]}" "${ANSWER[$v]}"; done
echo "========================================================="
