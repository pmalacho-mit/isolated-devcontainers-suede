#!/usr/bin/env bash
# #11 on a project dind: --shadow's mirror, end to end.
#
#   ./tests/environments/mirror/run.sh
#
# A dind started as the supervisor starts a project's -- its daemon.json from
# supervisor.ts settingsFrom, the registry mirror among it -- under sysbox where
# the daemon has it, --privileged otherwise. In it, the real
# trust-proxy-in-builds.sh, and the three builders #11 is about: what
# `FROM alpine:3.20` gets from a BuildKit build posted to the Engine API
# (`/build?version=2`, dockerode's), before a shadow, with one, and after
# --unshadow; and how long a pull takes while nothing listens on the mirror.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
# shellcheck source=../../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"
DIND=desolate-mirror-test BASE=alpine:3.20
CA=${DESOLATE_TEST_CA:-/desolate/ca/ca.pem}
[ -n "${DESOLATE_TEST_CA:-}" ] || [ -f "$CA" ] || CA=/desolate-ca/ca.pem   # a devcontainer made before the move
RUNTIME=(--privileged)
docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q sysbox-runc && RUNTIME=(--runtime sysbox-runc)

# Through the environment, not argv: supervisor.ts takes itself for the entry
# point when its path is argv[1], and starts serving.
DAEMON_JSON=$(SUPERVISOR_TS="$RELEASE/vscode-image/supervisor.ts" \
  node -e 'const { settingsFrom } = await import(process.env.SUPERVISOR_TS); process.stdout.write(settingsFrom({}).daemonJson)')
assert_contains "the supervisor's daemon.json lists the mirror" "$DAEMON_JSON" '"registry-mirrors":["http://127.0.0.1:5995"]'

cleanup() { docker rm -f "$DIND" >/dev/null 2>&1; }
trap '[ -n "${DESOLATE_TEST_KEEP:-}" ] || cleanup' EXIT
cleanup
docker run -d --name "$DIND" "${RUNTIME[@]}" -e DOCKER_TLS_CERTDIR= -e "DAEMON_JSON=$DAEMON_JSON" \
  --entrypoint sh docker:29-dind -c '
    mkdir -p /etc/docker /desolate/ca && printf "%s" "$DAEMON_JSON" > /etc/docker/daemon.json
    while [ ! -s /desolate/ca/ca.pem ]; do sleep 0.2; done
    cp /desolate/ca/ca.pem /usr/local/share/ca-certificates/desolate.crt && update-ca-certificates >/dev/null 2>&1
    exec dockerd-entrypoint.sh' >/dev/null || { fail "start a dind"; summary; exit 1; }
# The proxy's CA where a devcontainer has it (the dind pulls through the proxy
# too), and the script beside it. Outside desolate, a CA of no consequence.
if [ -f "$CA" ]; then docker cp "$CA" "$DIND:/desolate/ca/ca.pem" >/dev/null
else SCRATCH=$(mktemp -d)
     openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=test -days 1 -keyout /dev/null -out "$SCRATCH/ca.pem" 2>/dev/null \
       && docker cp "$SCRATCH/ca.pem" "$DIND:/desolate/ca/ca.pem" >/dev/null; fi
docker cp "$RELEASE/proxy/container/trust-proxy-in-builds.sh" "$DIND:/desolate/ca/" >/dev/null
in_dind() { docker exec -i "$DIND" "$@"; }
for _ in $(seq 1 60); do in_dind docker info >/dev/null 2>&1 && break; sleep 1; done

group "nothing listens on the mirror: pulls fall through to Docker Hub"
START=$(date +%s)
assert_ok "a pull works with no mirror running" in_dind docker pull -q busybox:1.37
ELAPSED=$(( $(date +%s) - START ))
[ "$ELAPSED" -lt 60 ] && pass "and takes ${ELAPSED}s, not a timeout's worth" || fail "the pull took ${ELAPSED}s"
# Pulled until it is there to run: in a dind nested in another (this test's
# home inside desolate), a pull can return before the image is usable --
# measured as often with no mirror configured as with one, so it is the
# nesting's, not the mirror's.
usable() {  # <image>
  local tries
  for tries in 1 2 3 4 5 6; do
    in_dind docker pull -q "$1" >/dev/null 2>&1
    in_dind docker run --rm --pull never --entrypoint true "$1" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
for image in "$BASE" curlimages/curl:8.11.1; do
  usable "$image" || { fail "pull $image" "never usable"; summary; exit 1; }
done

# A BuildKit build posted to the Engine API, as dockerode posts one: which base
# did FROM get? The derivative carries the proxy CA where the script puts it.
engine_build() {
  in_dind sh -c "rm -rf /tmp/ctx && mkdir /tmp/ctx && cd /tmp/ctx \
    && printf 'FROM $BASE\nRUN (test -f /usr/local/share/ca-certificates/desolate-proxy.crt && echo DERIVATIVE || echo PRISTINE) > /base\n' > Dockerfile \
    && tar -cf /tmp/ctx.tar Dockerfile \
    && docker run --rm --user 0 -v /var/run/docker.sock:/var/run/docker.sock -v /tmp/ctx.tar:/ctx.tar:ro curlimages/curl:8.11.1 \
         -s --unix-socket /var/run/docker.sock -X POST -H 'Content-Type: application/x-tar' --data-binary @/ctx.tar \
         'http://localhost/build?version=2&nocache=1&t=mirror-test/out' > /tmp/build.log \
    && docker run --rm mirror-test/out cat /base" > "$SCRATCH_LOG" 2>&1
  case "$(tail -1 "$SCRATCH_LOG")" in
    DERIVATIVE|PRISTINE) tail -1 "$SCRATCH_LOG" ;;
    *) { echo "--- the build said:"; cat "$SCRATCH_LOG"; in_dind tail -c 400 /tmp/build.log; } >&2 ;;
  esac
}
SCRATCH_LOG=$(mktemp)

group "before a shadow, the Engine-API build gets the pristine base"
assert_eq "FROM $BASE" "$(engine_build)" "PRISTINE"

group "--shadow: the mirror serves the derivative under the base's name"
OUT=$(in_dind sh -c "cd /tmp && sh /desolate/ca/trust-proxy-in-builds.sh --image $BASE --shadow" 2>&1)
assert_contains "the script says so" "$OUT" "the mirror serves it as library/alpine:3.20"
assert_eq "the mirror runs on the dind's loopback" \
  "$(in_dind docker port desolate-mirror 5000/tcp 2>/dev/null)" "127.0.0.1:5995"
assert_eq "a BuildKit build posted to the Engine API now gets the derivative" "$(engine_build)" "DERIVATIVE"
in_dind docker image rm -f "$BASE" >/dev/null 2>&1
usable "$BASE"
assert_eq "and so does a pull" \
  "$(in_dind docker run --rm "$BASE" sh -c 'test -f /usr/local/share/ca-certificates/desolate-proxy.crt && echo DERIVATIVE || echo PRISTINE')" "DERIVATIVE"

group "--unshadow takes it out of the mirror again"
OUT=$(in_dind sh -c "cd /tmp && sh /desolate/ca/trust-proxy-in-builds.sh --image $BASE --unshadow" 2>&1)
assert_contains "the script says so" "$OUT" "the mirror no longer serves library/alpine:3.20"
assert_eq "the Engine-API build gets the pristine base" "$(engine_build)" "PRISTINE"

summary
