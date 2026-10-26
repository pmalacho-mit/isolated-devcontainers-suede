#!/usr/bin/env bash
# The supervisor's admission and reaping, for real (capacity.ts decides,
# supervisor.ts acts): with room for ONE dind, an idle one gives way to a new
# project, a busy one never does, and an idle one is reaped on its own.
#
#   ./tests/environments/nested/run.sh up
#   ./tests/environments/nested/admission.sh
#
# Recreates the nested supervisor with DESOLATE_MAX_DINDS=1 and a one-minute
# idle period, and restores it on exit. Creates two throwaway projects in the
# nested workspaces and purges their dinds on exit. STOPS every other project
# dind first (warm: their images stay), since a ceiling of one has no room
# while another project's dind is running. APPROXIMATION (runc).
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
# shellcheck source=../../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"
STATE=${DESOLATE_NESTED_STATE:-/tmp/desolate-nested}
A=admission-a B=admission-b

docker inspect desolate-supervisor >/dev/null 2>&1 || { skip "admission" "no nested stack (run.sh up)"; summary; exit $?; }

compose() {
  docker compose -p desolate --project-directory "$ROOT/release" \
    -f "$ROOT/release/docker-compose.yml" -f "$HERE/compose.nested.yml" \
    --env-file "$STATE/admission.env" "$@"
}
# With the env file as it now stands -- and PROVED to be: a recreate compose
# did not finish leaves the old supervisor answering with the old limits, and
# its old "listening" line satisfies a wait for one. So the running container
# must carry the grace period this file asks for, and answer.
recreate_supervisor() {
  local want
  want=$(sed -n 's/^DESOLATE_DIND_GRACE=//p' "$STATE/admission.env" | tail -1)
  compose up -d --no-deps --force-recreate supervisor >"$STATE/admission-compose.log" 2>&1 \
    || { tail -5 "$STATE/admission-compose.log"; return 1; }
  for _ in $(seq 1 60); do
    [ "$(docker exec desolate-supervisor printenv DESOLATE_DIND_GRACE 2>/dev/null)" = "${want:-15}" ] \
      && docker logs desolate-supervisor 2>&1 | grep -q "supervisor listening" \
      && [ "$(ok_of "$(ask '{"op":"status"}')")" = true ] && return 0
    sleep 0.25
  done
  return 1
}
ask() {
  docker exec desolate-orchestrator node -e '
    const s = require("net").createConnection("/run/supervisor/supervisor.sock");
    s.on("connect", () => s.write(process.argv[1] + "\n"));
    let out = ""; s.on("data", (d) => (out += d));
    s.on("end", () => process.stdout.write(out.trim().split("\n").pop() || "{}"));
    s.on("error", (e) => process.stdout.write(JSON.stringify({ ok: false, error: String(e) })));
  ' "$1"
}
ok_of()    { printf '%s' "$1" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>process.stdout.write(String(JSON.parse(b).ok)))'; }
error_of() { printf '%s' "$1" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>process.stdout.write(String(JSON.parse(b).error||"")))'; }
state()    { docker inspect -f '{{.State.Status}}' "desolate-dind-$1" 2>/dev/null || echo absent; }

cleanup() {
  ask "{\"op\":\"purge\",\"project\":\"$A\"}" >/dev/null
  ask "{\"op\":\"purge\",\"project\":\"$B\"}" >/dev/null
  docker exec desolate-vscode rm -rf "/workspaces/$A" "/workspaces/$B"
  cp "$STATE/.env" "$STATE/admission.env"
  recreate_supervisor || echo "  WARNING: could not restore the supervisor's defaults"
  rm -f "$STATE/admission.env"
}
trap cleanup EXIT

for other in $(docker ps --filter label=desolate.dind --format '{{.Label "desolate.dind"}}'); do
  [ "$other" = "$A" ] || [ "$other" = "$B" ] || {
    echo "  stopping $other's dind first (warm)"
    ask "{\"op\":\"stop\",\"project\":\"$other\"}" >/dev/null
  }
done

docker exec desolate-vscode mkdir -p "/workspaces/$A" "/workspaces/$B"
{ cat "$STATE/.env"; echo "DESOLATE_MAX_DINDS=1"; echo "DESOLATE_DIND_IDLE=1"; echo "DESOLATE_DIND_GRACE=0"; } > "$STATE/admission.env"
recreate_supervisor || { fail "the supervisor restarts with a ceiling of 1" "it did not come up"; summary; exit $?; }
pass "the supervisor restarts with a ceiling of 1"

group "an idle dind gives way to a new project"
R=$(ask "{\"op\":\"ensure\",\"project\":\"$A\"}"); assert_eq "ensure $A" "$(ok_of "$R")" "true" || echo "       $(error_of "$R")"
assert_eq "ensure $B" "$(ok_of "$(ask "{\"op\":\"ensure\",\"project\":\"$B\"}")")" "true"
assert_eq "$A was stopped to make room, not removed" "$(state "$A")" "exited"
assert_eq "$B is running" "$(state "$B")" "running"

group "nor does one ensured moments ago"
# ensure returns before its devcontainer exists; the build in between leaves
# the dind looking idle. DESOLATE_DIND_GRACE (default 15 min) covers it.
{ cat "$STATE/.env"; echo "DESOLATE_MAX_DINDS=1"; echo "DESOLATE_DIND_IDLE=1"; echo "DESOLATE_DIND_GRACE=10"; } > "$STATE/admission.env"
recreate_supervisor || fail "the supervisor restarts with a grace period" "it did not come up"
assert_eq "ensure $B (warm)" "$(ok_of "$(ask "{\"op\":\"ensure\",\"project\":\"$B\"}")")" "true"
R=$(ask "{\"op\":\"ensure\",\"project\":\"$A\"}")
assert_eq "ensure $A is refused while $B is within its grace" "$(ok_of "$R")" "false"
assert_contains "and the refusal says why" "$(error_of "$R")" "DESOLATE_DIND_GRACE"
assert_eq "$B is still running" "$(state "$B")" "running"
{ cat "$STATE/.env"; echo "DESOLATE_MAX_DINDS=1"; echo "DESOLATE_DIND_IDLE=1"; echo "DESOLATE_DIND_GRACE=0"; } > "$STATE/admission.env"
recreate_supervisor || fail "the supervisor restarts without one" "it did not come up"

group "a busy dind never does"
# A container carrying the devcontainer CLI's identity label is what "in use"
# means (docker.ts hostsDevcontainer): somebody's editor.
docker exec "desolate-dind-$B" docker run -d --name stand-in-devcontainer \
  --label devcontainer.local_folder=/workspaces/$B busybox:1.37 sleep 600 >/dev/null 2>&1 \
  || docker exec "desolate-dind-$B" sh -c "docker pull -q busybox:1.37 >/dev/null && docker run -d --name stand-in-devcontainer --label devcontainer.local_folder=/workspaces/$B busybox:1.37 sleep 600" >/dev/null
R=$(ask "{\"op\":\"ensure\",\"project\":\"$A\"}")
assert_eq "ensure $A is refused" "$(ok_of "$R")" "false"
assert_contains "the refusal names what is in the way" "$(error_of "$R")" "desolate-dind-$B"
assert_contains "and which limit" "$(error_of "$R")" "DESOLATE_MAX_DINDS"
assert_eq "$B is still running" "$(state "$B")" "running"

group "an idle dind is reaped on its own"
docker exec "desolate-dind-$B" docker rm -f stand-in-devcontainer >/dev/null
# Idle from the moment the supervisor next looks, then one idle period (1 min),
# then the next reaper tick (at most 1 min).
reaped=""
for _ in $(seq 1 30); do
  [ "$(state "$B")" = exited ] && { reaped=1; break; }
  sleep 6
done
assert_eq "$B was stopped by the reaper within three minutes" "${reaped:-no}" "1"
assert_contains "and the supervisor said why" "$(docker logs desolate-supervisor 2>&1)" "reaping desolate-dind-$B"

summary
