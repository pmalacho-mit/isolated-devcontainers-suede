#!/usr/bin/env bash
# The supervisor (release/vscode-image/supervisor.ts) against a real daemon,
# through the nested stack: requests over its socket from the orchestrator,
# exactly as the orchestrator will send them, and every answer checked on the
# daemon rather than taken from the reply.
#
#   ./tests/environments/nested/run.sh up
#   ./tests/environments/nested/supervisor.sh [project]   # default: demo
#
# Needs a project directory in the nested workspaces (run.sh up leaves none;
# `demo` is the one the T0.3 end-to-end run created). APPROXIMATION: the
# project dinds run under runc, not sysbox (compose.nested.yml).
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
# shellcheck source=../../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

PROJECT=${1:-demo}
DIND=desolate-dind-$PROJECT
NS=$PROJECT
INGRESS=/run/desolate-ingress/dinds

docker inspect desolate-supervisor >/dev/null 2>&1 || { skip "supervisor" "no nested stack (run.sh up)"; summary; exit $?; }

# One request, as the orchestrator sends it; prints the supervisor's last line.
ask() {
  docker exec desolate-orchestrator node -e '
    const s = require("net").createConnection(process.argv[1]);
    s.on("connect", () => s.write(process.argv[2] + "\n"));
    let out = ""; s.on("data", (d) => (out += d));
    s.on("end", () => process.stdout.write(out));
    s.on("error", (e) => { console.log(JSON.stringify({ ok: false, error: String(e) })); });
  ' /run/supervisor/supervisor.sock "$1" | tail -n 1
}
field() { printf '%s' "$1" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const v=JSON.parse(b)[process.argv[1]];process.stdout.write(v===undefined?"":String(v))})' "$2"; }
inner() { docker exec "$DIND" docker "$@"; }

group "ensure creates a healthy dind that sees one project"
docker exec desolate-vscode test -d "/workspaces/$PROJECT" || { fail "the project exists" "/workspaces/$PROJECT is missing"; summary; exit $?; }
R=$(ask "{\"op\":\"ensure\",\"project\":\"$PROJECT\"}")
assert_eq "ensure succeeds" "$(field "$R" ok)" "true"
assert_eq "it names the socket the orchestrator reaches it by" "$(field "$R" socket)" "/run/dind-sockets/$NS/docker.sock"
assert_eq "the dind is running" "$(docker inspect -f '{{.State.Status}}' "$DIND" 2>/dev/null)" "running"
assert_eq "the orchestrator's uid can drive it through that socket" \
  "$(docker exec desolate-orchestrator docker -H "unix:///run/dind-sockets/$NS/docker.sock" info --format ok 2>&1)" "ok"
assert_eq "its /workspaces holds only $PROJECT" "$(docker exec "$DIND" ls -A /workspaces | tr '\n' ' ')" "$PROJECT "
assert_eq "it publishes nothing" "$(docker port "$DIND" | wc -l | tr -d ' ')" "0"
assert_eq "it has no restart policy" "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$DIND")" "no"
NET=$(docker inspect -f '{{range $n, $_ := .NetworkSettings.Networks}}{{$n}}{{end}}' "$DIND")
BRIDGE=$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$NET" 2>/dev/null)
case "$BRIDGE" in br-d-*) pass "it sits on its own br-d-* bridge ($BRIDGE)" ;; *) fail "it sits on its own br-d-* bridge" "got '$BRIDGE'" ;; esac
ADDR=$(cat "$INGRESS/$DIND" 2>/dev/null)
assert_eq "its address is published for the ingress" "$ADDR" "$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$DIND")"
assert_ok "the alias docker-outside-of-docker binds from is there" docker exec "$DIND" test -S /var/run/docker.sock

group "a project dind's egress is intercepted like everyone else's"
# br-d-* is in DESOLATE_IFS, so the pull goes through addon.py; it only
# succeeds because the dind trusts the proxy's CA (its entrypoint installs it).
if inner pull -q busybox:1.37 >/dev/null 2>&1; then pass "the dind pulled an image"
else fail "the dind pulled an image" "$(inner pull busybox:1.37 2>&1 | tail -1)"; fi
if sudo grep -a "AUDIT verdict=ALLOW" /tmp/desolate-nested/proxy.log | tail -50 \
     | grep -qE 'host=[a-z0-9.-]*docker\.(io|com) '; then
  pass "and addon.py audited the registry traffic"
else fail "and addon.py audited the registry traffic" "no recent AUDIT line for a docker.io/docker.com host"; fi

group "ensure is idempotent"
ID=$(docker inspect -f '{{.Id}}' "$DIND")
R=$(ask "{\"op\":\"ensure\",\"project\":\"$PROJECT\"}")
assert_eq "a second ensure succeeds" "$(field "$R" ok)" "true"
assert_eq "and is the same container" "$(docker inspect -f '{{.Id}}' "$DIND")" "$ID"

group "stop keeps the image store; ensure starts it warm"
R=$(ask "{\"op\":\"stop\",\"project\":\"$PROJECT\"}")
assert_eq "stop succeeds" "$(field "$R" ok)" "true"
assert_eq "the dind is stopped, not removed" "$(docker inspect -f '{{.State.Status}}' "$DIND" 2>/dev/null)" "exited"
assert_eq "its ingress entry is withdrawn" "$([ -e "$INGRESS/$DIND" ] && echo present || echo gone)" "gone"
R=$(ask "{\"op\":\"ensure\",\"project\":\"$PROJECT\"}")
assert_eq "ensure after stop succeeds" "$(field "$R" ok)" "true"
assert_eq "it is the same container again" "$(docker inspect -f '{{.Id}}' "$DIND")" "$ID"
assert_ok "the image it pulled before the stop is still there" inner image inspect busybox:1.37

group "purge removes the container, its image store and its bridge"
R=$(ask "{\"op\":\"purge\",\"project\":\"$PROJECT\"}")
assert_eq "purge succeeds" "$(field "$R" ok)" "true"
assert_eq "no container" "$(docker inspect "$DIND" >/dev/null 2>&1 && echo present || echo gone)" "gone"
assert_eq "no image store" "$(docker volume inspect "dind-data-$NS" >/dev/null 2>&1 && echo present || echo gone)" "gone"
assert_eq "no bridge" "$(docker network inspect "$NET" >/dev/null 2>&1 && echo present || echo gone)" "gone"
assert_eq "no ingress entry" "$([ -e "$INGRESS/$DIND" ] && echo present || echo gone)" "gone"

group "the vocabulary is all there is"
for request in '{"op":"ensure","project":"../etc"}' '{"op":"ensure","project":"x","runtime":"runc"}' \
               '{"op":"run","args":["--privileged"]}' 'not json'; do
  assert_eq "refused: $request" "$(field "$(ask "$request")" ok)" "false"
done

summary
