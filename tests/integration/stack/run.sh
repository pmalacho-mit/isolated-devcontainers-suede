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
  # Capture the devcontainer id BEFORE stopping it. E6/E7/E8 all exec into it,
  # and `docker ps -q` lists only RUNNING containers -- looking it up after the
  # stop below yields "", which turned all three escape tests into silent skips.
  DEVC=$(docker exec "$C_ORCH" docker ps -q \
           --filter label=devcontainer.local_folder=/workspaces/example-project 2>/dev/null | head -1)
  [ -n "$DEVC" ] && pass "the devcontainer id was captured for the escape tests" \
    || fail "the devcontainer id was captured for the escape tests" \
            "E6, E7 and E8 will skip -- they are the escape tests that matter"
else
  fail "desolate example-project succeeded" "$(printf '%s' "$OUT" | tail -5)"
fi

# =========================================================================
group "E6: a project cannot poison the editor server every project executes"
# =========================================================================
# /vscode-server/bin/openvscode-server is EXECUTED by every devcontainer. When
# it was a shared bind of /server-dist, any project could overwrite it and run
# code in every other project on next start -- no privilege, no policy bypass:
# the volume is chowned 1000:1000 and the stock devcontainer user is uid 1000.
# Each project now gets an overlayfs volume whose lower is the pristine server,
# and overlayfs never writes down. This proves the lower survives the attempt.
if [ -z "${DEVC:-}" ]; then
  skip "E6 server poisoning" "no example-project devcontainer is running"
else
  BEFORE=$(docker exec "$C_DIND" sha256sum /server-dist/bin/openvscode-server 2>/dev/null | cut -d' ' -f1)
  # The attack, exactly as a compromised project would run it.
  docker exec "$C_ORCH" docker exec "$DEVC" \
    sh -c 'echo MALICIOUS > /vscode-server/bin/openvscode-server' >/dev/null 2>&1
  AFTER=$(docker exec "$C_DIND" sha256sum /server-dist/bin/openvscode-server 2>/dev/null | cut -d' ' -f1)

  if [ -n "$BEFORE" ] && [ "$BEFORE" = "$AFTER" ]; then
    pass "the pristine server survived a write through the project's view"
  else
    fail "the pristine server survived a write through the project's view" \
         "/server-dist changed: $BEFORE -> $AFTER -- every other project now executes it"
  fi
  # And the project must see only its OWN modification, not a shared one.
  SEEN=$(docker exec "$C_ORCH" docker exec "$DEVC" \
           sh -c 'cat /vscode-server/bin/openvscode-server 2>/dev/null | head -c 9' 2>/dev/null)
  assert_contains "the writer sees its own copy-up (overlay is working)" "$SEEN" "MALICIOUS"
fi

# =========================================================================
group "E7: a project cannot poison the shared CA scripts"
# =========================================================================
# /desolate-ca/install-ca.sh is executed with `docker exec -u 0` in EVERY
# devcontainer by installProxyCa(), and by dind's own entrypoint. Shared and
# writable, poisoning it once buys ROOT execution in every project and in the
# daemon holding them all -- strictly worse than the editor binary in E6. Same
# defence: each project gets an overlay whose lower cannot be written through.
if [ -z "${DEVC:-}" ]; then
  skip "E7 CA poisoning" "no example-project devcontainer is running"
else
  CA_BEFORE=$(docker exec "$C_DIND" sha256sum /desolate-ca/install-ca.sh 2>/dev/null | cut -d' ' -f1)
  docker exec "$C_ORCH" docker exec "$DEVC" \
    sh -c 'echo POISONED > /desolate-ca/install-ca.sh' >/dev/null 2>&1
  # And the privileged escalation the read-only flag could not stop.
  docker exec "$C_ORCH" docker exec "$DEVC" sh -c \
    'mount -o remount,bind,rw /desolate-ca 2>/dev/null; echo POISONED > /desolate-ca/install-ca.sh' \
    >/dev/null 2>&1
  CA_AFTER=$(docker exec "$C_DIND" sha256sum /desolate-ca/install-ca.sh 2>/dev/null | cut -d' ' -f1)

  if [ -n "$CA_BEFORE" ] && [ "$CA_BEFORE" = "$CA_AFTER" ]; then
    pass "the shared install-ca.sh survived both write attempts"
  else
    fail "the shared install-ca.sh survived both write attempts" \
         "changed: $CA_BEFORE -> $CA_AFTER -- this runs as root in every devcontainer"
  fi
fi

# =========================================================================
group "E8: an attacker standing in a DEVCONTAINER"
# =========================================================================
# Everything above stands the attacker in the editor. This is the other half of
# the threat model and it was untested: a compromised project, inside dind,
# trying to reach the editor container -- which is where the git deploy keys
# are minted and kept. Every probe below runs INSIDE the project's container.
if [ -z "${DEVC:-}" ]; then
  skip "E8 devcontainer escape" "no example-project devcontainer is running"
else
  # Try curl, then wget, then bash's /dev/tcp: the base image is the project's
  # choice, and a probe that silently finds no tool would report containment
  # that was never tested.
  reach() { # reach <ip> <port> -> non-empty output means a TCP connection completed
    docker exec "$C_ORCH" docker exec "$DEVC" sh -c "
      if command -v curl >/dev/null 2>&1; then
        curl -s -o /dev/null -m 4 -w 'REACHED-%{http_code}' http://$1:$2/ 2>/dev/null \
          | grep -v 'REACHED-000' || true
      elif command -v wget >/dev/null 2>&1; then
        wget -T 4 -q -S -O /dev/null http://$1:$2/ 2>&1 | grep -o 'HTTP/[0-9.]*' | head -1
      else
        (exec 3<>/dev/tcp/$1/$2) 2>/dev/null && echo REACHED-tcp
      fi" 2>/dev/null
  }
  probes=0

  # 1. the editor, by container IP on every network it holds.
  for ip in $(docker inspect -f '{{range $n, $c := .NetworkSettings.Networks}}{{$c.IPAddress}} {{end}}' \
              "$C_VSCODE" 2>/dev/null); do
    probes=$((probes+1))
    # A 401/403 is still REACHED -- the editor answers tokenless requests with
    # one. Only the absence of any reply means the packet did not arrive.
    OUT=$(reach "$ip" 3000)
    if [ -n "$OUT" ]; then
      fail "a devcontainer cannot reach the editor at $ip:3000" \
           "got '$OUT' -- the ssh deploy keys live in that container"
    else
      pass "a devcontainer cannot reach the editor at $ip:3000"
    fi
  done
  [ "$probes" = 0 ] && skip "editor reachability" "could not resolve the editor's addresses"

  # 2. the default gateway, which is dind's bridge address on the VM.
  GW=$(docker exec "$C_ORCH" docker exec "$DEVC" \
       sh -c "ip route 2>/dev/null | awk '/^default/{print \$3; exit}'" 2>/dev/null)
  if [ -n "$GW" ]; then
    OUT=$(reach "$GW" 3000)
    [ -z "$OUT" ] && pass "a devcontainer cannot reach the gateway on :3000" \
      || fail "a devcontainer cannot reach the gateway on :3000" "got '$OUT'"
  else
    skip "gateway probe" "no default route reported inside the devcontainer"
  fi

  # 3. the proxy as a confused deputy. :80 is REDIRECTed to mitmproxy whatever
  #    the destination, and mitmproxy dials it from the VM, where the bridge
  #    drops no longer apply. Without an address check in addon.py that is a
  #    route to the Mac and the LAN.
  SSRF=$(docker exec "$C_ORCH" docker exec "$DEVC" sh -c \
         "curl -s -o /dev/null -m 6 -w '%{http_code}' http://192.168.5.2/ 2>/dev/null" 2>/dev/null)
  case "$SSRF" in
    403) pass "the proxy refuses an internal destination (no SSRF to the Mac)" ;;
    ""|000) skip "internal-destination probe" "no curl in this devcontainer, or no reply" ;;
    502) fail "the proxy refuses an internal destination" \
              "got 502 -- the proxy DIALLED it; the address check is not running" ;;
    *)   fail "the proxy refuses an internal destination" \
              "got '$SSRF' -- addon.py must refuse private destination ADDRESSES" ;;
  esac

  # 4. and the daemon socket, which must not be visible at all.
  assert_fails "a devcontainer has no inner daemon socket" \
    docker exec "$C_ORCH" docker exec "$DEVC" test -S /run/inner/docker.sock

  # Teardown moved here from the end-to-end group above: E6, E7 and E8 all need
  # the container RUNNING, and stopping it before them is what made all three
  # skip silently.
  assert_ok "desolate --stop tears it down" ed desolate --stop example-project
fi

group "host-side visibility into the inner daemon still works"
# observe.sh is now the only view, so it has to keep working -- otherwise the
# next person reaches for a published port again. It goes through the
# orchestrator over the inner unix socket; nothing is published.
assert_ok "inner containers are listable through the orchestrator" \
  docker exec "$C_ORCH" docker ps -a --format '{{.Names}}'

summary
