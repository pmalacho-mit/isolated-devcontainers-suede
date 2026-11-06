#!/usr/bin/env bash
# desolate points a project daemon's devcontainer past the feature's socat relay
# (issue #50).
#
# docker-outside-of-docker serves /var/run/docker.sock to a non-root user through
# `socat ... fork,mode=660,user=<user>`, run without -t. socat tears the
# connection down 0.5s after one side half-closes, and an attached `docker run`
# with no stdin half-closes at once, so output stops at the first pause of about
# 0.5s -- and the client exits 0:
#
#   docker run --rm alpine sh -c 'echo a; sleep 1; echo b'     # prints only: a
#
# The relay exists for a user who cannot open /var/run/docker-host.sock. On a
# project daemon that user can: dind serves it as group 1000 (docker.ts,
# `--group=1000`), the primary group of the base image's `vscode` user. So
# desolate sets DOCKER_HOST to the socket itself (dind.directSocket), in the spec
# it starts (deriveRunConfig) and in `desolate exec`, a plain docker exec that
# sees no remoteEnv.
#
# What this pins is the wiring and the boundaries -- the behaviour is in
# tests/unit/desolate/dind.test.ts and docker.test.ts:
#   - it is applied on a project's OWN daemon and nowhere else;
#   - the shared templates under .suede/ do NOT set it: they run on other hosts,
#     where the socket may be root-only and the relay is what makes docker work;
#   - the group it depends on, and the docs that say why, stay.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"
cd "$ROOT"

DESOLATE=$(cat release/vscode-image/desolate.ts)

group "the start applies it, on a project's own daemon only"
# The guard and the call are one expression; a refactor that drops either
# changes who gets it.
assert_contains "deriveRunConfig adds it only when the daemon is the project's" \
  "$DESOLATE" 'daemon === "project" && dind.addDirectSocket('
# Exactly one call site: a second, unguarded one would be the shared daemon's.
calls=$(grep -c 'dind.addDirectSocket(' release/vscode-image/desolate.ts)
assert_eq "and nothing else adds it" "$calls" "1"

group "desolate exec gives it the same way, on a project daemon only"
assert_contains "exec asks the rule only for a container on a project daemon" \
  "$DESOLATE" 'daemons.saved(target) === "project"'
assert_contains "exec passes what the rule says" "$DESOLATE" 'dind.dockerHostForExec('
assert_contains "exec builds its argv with the variable" "$DESOLATE" 'execArgv({'

group "the shared templates stay portable: they do not set it"
# <file> -> the remoteEnv/containerEnv DOCKER_HOST a config declares ("unset" if none)
declared() {
  python3 - "$1" <<'PY' 2>/dev/null || echo "PARSE-ERROR"
import json, re, sys
raw = open(sys.argv[1]).read()
raw = re.sub(r'/\*[\s\S]*?\*/', '', raw)
raw = re.sub(r'^\s*//.*$', '', raw, flags=re.M)
raw = re.sub(r',(\s*[}\]])', r'\1', raw)
cfg = json.loads(raw)
for key in ("remoteEnv", "containerEnv"):
    if "DOCKER_HOST" in (cfg.get(key) or {}):
        print(f"{key}={cfg[key]['DOCKER_HOST']}"); sys.exit()
print("unset")
PY
}
templates=0
while IFS= read -r f; do
  templates=$((templates + 1))
  got=$(declared "$f")
  [ "$got" = unset ] && pass "$f leaves DOCKER_HOST alone" \
    || fail "$f sets DOCKER_HOST ($got)" "the templates run off desolate too; see this file's header"
done < <(git ls-files '.suede/devcontainers-suede/*.json')
# A glob that matched nothing would pass every check above.
[ "$templates" -ge 10 ] || fail "found only $templates templates -- the file selection is wrong"

group "what it depends on, and the docs"
assert_contains "the project dind serves its socket to group 1000" \
  "$(cat release/vscode-image/docker.ts)" '"--group=1000",'
assert_contains "policy allows the bind of exactly the socket dind.directSocket names" \
  "$(cat release/vscode-image/policy.ts)" 'const DOCKER_HOST_SOCKET_TARGET = dind.directSocket.path;'
README=$(cat release/README.md)
assert_contains "the README explains the relay and the direct socket" \
  "$README" 'talks to the daemon'"'"'s socket directly'
assert_contains "the README says how to opt out" \
  "$README" '"remoteEnv": { "DOCKER_HOST": "unix:///var/run/docker.sock" }'
assert_contains "the README names the bind-mount edge" "$README" "an empty directory"
assert_contains "the agent docs say exec sets it" "$(cat docs/agents.md)" "/var/run/docker-host.sock"
assert_contains "the in-container notes say it is set for you" \
  "$(cat release/AGENTS.md)" "DOCKER_HOST"

summary
