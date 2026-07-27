#!/usr/bin/env bash
# Full-stack integration test: brings up a real (isolated) copy of the stack and
# checks the containment properties from the outside AND from inside the editor
# container -- which is where an attacker would actually be standing.
#
# Runs on the Mac against Colima+sysbox. It refuses to fake the sysbox layer:
# without sysbox the containment claim is simply not being tested, and the
# script says so rather than printing green.
#
#   ./tests/integration/stack/run.sh
#   DESOLATE_TEST_KEEP=1 ./tests/integration/stack/run.sh   # leave it up to poke at
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
# shellcheck source=../../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

PROJECT=desolate-test
EDITOR_PORT=3100
TOKEN="test-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"

C_DIND=$PROJECT-dind-1
C_VSCODE=$PROJECT-vscode-1
C_ORCH=$PROJECT-orchestrator-1

compose() {
  # project-directory must be RELEASE: the build contexts (./vscode-image) and
  # the CA bind mount are all resolved relative to it.
  VSCODE_TOKEN="$TOKEN" docker compose -p "$PROJECT" --project-directory "$RELEASE" \
    -f "$RELEASE/docker-compose.yml" -f "$ROOT/tests/integration/stack/compose.test.yml" "$@"
}

if ! docker info >/dev/null 2>&1; then
  skip "stack integration" "no docker daemon (on the Mac: colima start desolate)"
  summary; exit $?
fi

HAVE_SYSBOX=no
docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q sysbox-runc && HAVE_SYSBOX=yes
if [ "$HAVE_SYSBOX" != yes ]; then
  skip "stack integration" \
    "sysbox-runc is not registered on this daemon; the containment layer under test does not exist here. See README 'Installing sysbox into Colima'."
  summary; exit $?
fi

cleanup() {
  if [ "${DESOLATE_TEST_KEEP:-0}" = 1 ]; then
    printf '\nstack left running as project %s (editor: http://127.0.0.1:%s/?tkn=%s)\n' \
      "$PROJECT" "$EDITOR_PORT" "$TOKEN"
    printf 'tear down with: docker compose -p %s down -v\n' "$PROJECT"
    return
  fi
  compose down -v --remove-orphans >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

group "bring the stack up"
if ! compose up -d --build >/tmp/desolate-test-up.log 2>&1; then
  fail "compose up" "$(tail -20 /tmp/desolate-test-up.log)"
  summary; exit 1
fi
pass "compose up --build"

for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$C_DIND" 2>/dev/null)" = healthy ] && break
  sleep 2
done
assert_eq "dind reports healthy" \
  "$(docker inspect -f '{{.State.Health.Status}}' "$C_DIND" 2>/dev/null)" "healthy"

group "sysbox containment"
assert_eq "dind runtime is sysbox-runc" \
  "$(docker inspect -f '{{.HostConfig.Runtime}}' "$C_DIND")" "sysbox-runc"
assert_eq "dind is not privileged" \
  "$(docker inspect -f '{{.HostConfig.Privileged}}' "$C_DIND")" "false"
UIDMAP=$(docker exec "$C_DIND" cat /proc/self/uid_map 2>/dev/null | awk '{print $2}')
if [ -n "$UIDMAP" ] && [ "$UIDMAP" != "0" ]; then
  pass "user namespace active (container uid0 -> VM uid $UIDMAP)"
else
  fail "user namespace active" "uid_map maps container-root to VM-root ($UIDMAP)"
fi

group "privilege separation"
assert_fails "the editor cannot reach any docker daemon" \
  docker exec "$C_VSCODE" docker info
assert_not_contains "the editor does not mount the daemon socket volume" \
  "$(docker inspect "$C_VSCODE" --format '{{range .Mounts}}{{.Name}} {{end}}')" "inner-run"
assert_ok "the orchestrator can drive the inner daemon" \
  docker exec "$C_ORCH" docker info
assert_ok "the broker socket is reachable from the editor" \
  docker exec "$C_VSCODE" test -S /run/broker/desolate.sock
assert_not_contains "the host docker socket is mounted nowhere" \
  "$(docker inspect "$C_VSCODE" "$C_ORCH" 2>/dev/null)" '"Source": "/var/run/docker.sock"'
assert_fails "the editor cannot write the orchestrator's spec snapshots" \
  docker exec "$C_VSCODE" test -d /tmp/desolate-specs

group "the inner daemon API is not on the network"
# The stack used to publish a GET-only socket proxy for host-side observability.
# It was removed: read-only constrained only the Mac (already the trust root),
# while an unauthenticated HTTP port on loopback is reachable from a browser via
# DNS rebinding. Assert the absence, so re-adding one has to be deliberate.
assert_fails "nothing answers the docker API on the old proxy port" \
  curl -s -f --max-time 3 "http://127.0.0.1:2475/_ping"
assert_not_contains "no stack container publishes a daemon API port" \
  "$(docker ps --filter "name=$PROJECT" --format '{{.Ports}}')" "2375"

group "the editor's token actually gates the editor"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$EDITOR_PORT/")
case "$CODE" in 401|403) pass "tokenless editor request -> $CODE" ;;
  *) fail "tokenless editor request is refused" "got $CODE (expected 401/403)" ;; esac

# =========================================================================
group "an attacker standing in the editor container"
# =========================================================================
# This is the real threat model: a malicious VS Code extension owns the editor,
# can write anything into /workspaces, and can talk to the broker. Everything
# below runs INSIDE desolate-vscode, with no docker access, exactly as it would.

ed() { docker exec "$C_VSCODE" "$@"; }

write_project() { # write_project <name> <devcontainer.json>
  ed sh -c "mkdir -p /workspaces/$1/.devcontainer && cat > /workspaces/$1/.devcontainer/devcontainer.json" <<EOF
$2
EOF
}

attack() { # attack <name> <json> <what it would have got them>
  write_project "$1" "$2"
  local out; out=$(ed desolate "$1" 2>&1)
  if printf '%s' "$out" | grep -q "desolate:"; then
    pass "refused: $3"
  else
    fail "refused: $3" "broker ACCEPTED it -- $(printf '%s' "$out" | tail -2)"
  fi
  ed sh -c "rm -rf /workspaces/$1" >/dev/null 2>&1
}

attack evil-init '{
  "image": "alpine:3",
  "initializeCommand": "touch /tmp/desolate-stack-pwned"
}' "initializeCommand (code execution in the orchestrator)"
assert_fails "initializeCommand did not execute in the orchestrator" \
  docker exec "$C_ORCH" test -f /tmp/desolate-stack-pwned

attack evil-compose '{
  "dockerComposeFile": "docker-compose.yml",
  "service": "app",
  "workspaceFolder": "/work"
}' "compose mode (privileged / pid:host / bind of dind's root)"

attack evil-mount '{
  "image": "alpine:3",
  "mounts": ["source=example-project-secrets,target=/steal,type=volume"]
}' "another project's volume"

attack evil-bind '{
  "image": "alpine:3",
  "mounts": ["source=/,target=/host,type=bind"]
}' "bind mount of the inner daemon's root"

attack evil-runargs '{
  "image": "alpine:3",
  "runArgs": ["--network", "host"]
}' "--network host (space-separated spelling)"

attack evil-priv '{
  "image": "alpine:3",
  "runArgs": ["--privileged"]
}' "--privileged"

attack evil-jsonc '{
  "image": "alpine:3",
  "name": "a/*",
  "mounts": ["source=example-project-secrets,target=/steal,type=volume"],
  "postCreateCommand": "*/ id"
}' "mounts hidden behind a JSONC comment"

# The op vocabulary itself.
OUT=$(ed sh -c 'printf "%s\n" "{\"op\":\"exec\",\"project\":\"x\"}" | node -e "
const net=require(\"net\");const c=net.createConnection(\"/run/broker/desolate.sock\");
process.stdin.pipe(c);c.pipe(process.stdout);"' 2>&1)
assert_contains "the broker rejects ops outside its vocabulary" "$OUT" '"ok":false'

# =========================================================================
group "a legitimate project still starts, end to end"
# =========================================================================
docker cp "$SAMPLES/example-project" "$C_VSCODE:/workspaces/example-project" >/dev/null 2>&1
ed sh -c 'chown -R 1000:1000 /workspaces/example-project 2>/dev/null; true'
OUT=$(ed desolate example-project 2>&1)
if printf '%s' "$OUT" | grep -q "is ready:"; then
  pass "desolate example-project succeeded from inside the editor"
  URL=$(printf '%s' "$OUT" | grep -oE 'http://127\.0\.0\.1:[0-9]+/\?tkn=[a-f0-9]+' | head -1)
  INNER_PORT=$(printf '%s' "$URL" | sed -E 's|.*:([0-9]+)/.*|\1|')
  # The Mac-side hop: the test stack maps 8180-8190 -> dind's 8080-8090.
  MAC_PORT=$((INNER_PORT + 100))
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$MAC_PORT/" || echo none)
  case "$CODE" in 200|302|401|403) pass "the project editor answers through the relay (HTTP $CODE)" ;;
    *) fail "the project editor answers through the relay" "got '$CODE' on 127.0.0.1:$MAC_PORT" ;; esac
  assert_ok "desolate --ports reports the map" ed desolate --ports example-project
  assert_ok "desolate --stop tears it down" ed desolate --stop example-project
else
  fail "desolate example-project succeeded" "$(printf '%s' "$OUT" | tail -5)"
fi

group "host-side visibility into the inner daemon still works"
# observe.sh is now the only view, so it has to keep working -- otherwise the
# next person reaches for a published port again. It goes through the
# orchestrator over the inner unix socket; nothing is published.
assert_ok "inner containers are listable through the orchestrator" \
  docker exec "$C_ORCH" docker ps -a --format '{{.Names}}'

summary
