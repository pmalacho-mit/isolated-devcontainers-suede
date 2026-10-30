#!/usr/bin/env bash
# PROBE -- not a test. Answers a capability question so a design decision can
# be made; it asserts no invariant and gates nothing.
#
# QUESTION (T5.3, #11): on a project's own daemon, does a BuildKit build --
# what `docker build` and `docker compose build` are by default -- resolve a
# SHADOWED tag (`trust-proxy-in-builds.sh --shadow`: the CA-trusting
# derivative retagged as the base's own name) to the derivative, or does it
# go back to the registry and build on the pristine base?
#
#   ./tests/probes/buildkit-shadow.sh [<project-with-a-dind>]
#
#   S1  STORE     which image store the daemon uses (containerd snapshotter or
#                 the classic graph driver); the answer turns on it.
#   S2  CLASSIC   DOCKER_BUILDKIT=0: the legacy builder, which always used
#                 local images (the control: shadowing's original target).
#   S3  BUILDKIT  `docker build` (BuildKit), FROM the shadowed tag.
#   S4  PULL      the same with --pull: the registry, by request (expected NO).
#   S5  COMPOSE   `docker compose build` of a service FROM the shadowed tag.
#   S6  ENGINE    `POST /build?version=2` -- BuildKit through the Engine API, what
#                 dockerode and tools on it post, and the case #11 is about:
#                 the README's table says it resolves the tag at the registry.
#   S7  MIRROR    the same Engine-API build on a throwaway dind whose
#                 daemon.json points `registry-mirrors` at a registry serving
#                 the derivative under the base's own name (docker.io only:
#                 that is all registry-mirrors covers). The README says
#                 BuildKit ignores those mirrors; this asks again.
#
# The derivative here is a marker, not the CA, so the answer is a file's
# presence and nothing else. The shadowed tag is re-pulled at the end.
#
# ANSWERED 2026-10-26, nested harness (APPROXIMATION: runc; the question is
# dockerd's, not sysbox's), docker 29.9.2, sample-siblings' dind:
#   S1 containerd image store -- the docker 29 default, on every project dind
#   S2/S3/S5 YES: the classic builder, `docker build` and `docker compose build`
#      all build on the shadow, as the README's table already said
#   S4 NO with --pull, as asked
#   S6 NO: BuildKit through the Engine API resolves the tag at the registry
#      even on the containerd store -- the store alone does not fix #11
#   S7 YES: with `registry-mirrors` at a registry serving the derivative under
#      the base's name, that same Engine-API build -- and `docker pull`, and
#      `--pull` -- got the derivative. The README said BuildKit ignores those
#      mirrors; on the containerd store it does not. Docker Hub images only:
#      registry-mirrors covers nothing else.
# So #11 is fixable on a project's own daemon: a registry in its dind serving
# the derivatives, as its mirror. Not built here; see the phase-4 PR.
set -uo pipefail
PROJECT=${1:-sample-siblings}
DIND=desolate-dind-${PROJECT//\//__}
BASE=alpine:3.20
in_dind() { docker exec -i "$DIND" "$@"; }
docker inspect "$DIND" >/dev/null 2>&1 || { echo "probe: $DIND is not running; start $PROJECT first"; exit 2; }

declare -A ANSWER
in_dind docker pull -q "$BASE" >/dev/null
STORE=$(in_dind docker info --format '{{json .DriverStatus}}' | grep -o 'io.containerd.snapshotter[^"]*' | head -1)
ANSWER[S1]=${STORE:+containerd image store ($STORE)}
ANSWER[S1]=${ANSWER[S1]:-classic graph driver ($(in_dind docker info --format '{{.Driver}}'))}

# The shadow: a derivative carrying a marker, retagged as the base itself.
printf 'FROM %s\nRUN echo shadowed > /shadow-marker\n' "$BASE" | in_dind docker build -q -t desolate-probe/shadow - >/dev/null
in_dind docker tag desolate-probe/shadow "$BASE"
restore() { in_dind docker pull -q "$BASE" >/dev/null 2>&1; }
trap restore EXIT

# Split in the source, whole in the output: a build echoes its Dockerfile, and
# the answer must come from what the RUN printed, not from that echo.
dockerfile="FROM $BASE
RUN cat /shadow-marker 2>/dev/null || echo NO-MAR\"\"KER"
build() {   # <label> <env> <args...>: did the build see the marker?
  local label=$1 env=$2; shift 2
  out=$(printf '%s\n' "$dockerfile" | in_dind env $env docker build --no-cache --progress=plain "$@" - 2>&1 \
        || printf '%s\n' "$dockerfile" | in_dind env $env docker build --no-cache "$@" - 2>&1)
  if printf '%s' "$out" | grep -qE '(^| )shadowed$'; then ANSWER[$label]="YES -- built on the derivative"
  elif printf '%s' "$out" | grep -qE '(^| )NO-MARKER$'; then ANSWER[$label]="NO -- built on the registry's base"
  else ANSWER[$label]="could not tell: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"; fi
}
build S2 DOCKER_BUILDKIT=0
build S3 DOCKER_BUILDKIT=1
build S4 DOCKER_BUILDKIT=1 --pull
in_dind docker tag desolate-probe/shadow "$BASE"   # --pull re-pointed the tag

# compose, the shape a project's own `docker compose up --build` takes.
in_dind sh -c "rm -rf /tmp/probe-compose && mkdir -p /tmp/probe-compose && cd /tmp/probe-compose \
  && printf '%s\n' '$dockerfile' > Dockerfile \
  && printf 'services:\n  probe:\n    build: .\n' > compose.yaml"
out=$(in_dind sh -c 'cd /tmp/probe-compose && docker compose build --no-cache --progress=plain 2>&1')
if printf '%s' "$out" | grep -qE '(^| )shadowed$'; then ANSWER[S5]="YES -- built on the derivative"
elif printf '%s' "$out" | grep -qE '(^| )NO-MARKER$'; then ANSWER[S5]="NO -- built on the registry's base"
else ANSWER[S5]="could not tell: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"; fi

# The Engine API, as an SDK would call it: a tar context, version=2. Its RUN
# output arrives as BuildKit trace protobufs, so the answer is read from the
# built image instead -- the marker copied to /out, or its absence written there.
API=$(in_dind docker version --format '{{.Server.APIVersion}}')
in_dind docker pull -q curlimages/curl:8.11.1 >/dev/null
in_dind sh -c "rm -rf /tmp/probe-engine && mkdir -p /tmp/probe-engine && cd /tmp/probe-engine \
  && printf 'FROM $BASE\nRUN (cat /shadow-marker || echo NO-MAR\"\"KER) > /out 2>/dev/null\n' > Dockerfile \
  && tar -cf /tmp/probe-engine.tar Dockerfile"
in_dind sh -c "docker run --rm --user 0 -v /run/dind-sock/docker.sock:/var/run/docker.sock -v /tmp/probe-engine.tar:/ctx.tar:ro \
  curlimages/curl:8.11.1 -s --unix-socket /var/run/docker.sock -X POST -H 'Content-Type: application/x-tar' \
  --data-binary @/ctx.tar 'http://localhost/v$API/build?version=2&nocache=1&t=desolate-probe/engine-out'" >/dev/null 2>&1
out=$(in_dind docker run --rm desolate-probe/engine-out cat /out 2>&1)
case "$out" in
  shadowed) ANSWER[S6]="YES -- built on the derivative" ;;
  NO-MARKER) ANSWER[S6]="NO -- built on the registry's base" ;;
  *) ANSWER[S6]="could not tell: $(printf '%s' "$out" | tail -1)" ;;
esac

# S7: a dind of the probe's own, so no project's daemon is reconfigured --
# under sysbox where the VM has it, --privileged only in the nested harness.
RUNTIME=(--runtime sysbox-runc)
docker info --format '{{json .Runtimes}}' | grep -q sysbox-runc || RUNTIME=(--privileged)
MIRROR=desolate-probe-mirror
docker rm -f "$MIRROR" >/dev/null 2>&1
docker run -d "${RUNTIME[@]}" --name "$MIRROR" -v /var/lib/desolate-proxy/public:/desolate:ro --entrypoint sh docker:29-dind -c \
  'mkdir -p /etc/docker && printf "%s" "{\"registry-mirrors\":[\"http://127.0.0.1:5000\"],\"insecure-registries\":[\"127.0.0.1:5000\"]}" > /etc/docker/daemon.json \
   && { [ -f /desolate/ca/ca.pem ] && cp /desolate/ca/ca.pem /usr/local/share/ca-certificates/desolate.crt && update-ca-certificates >/dev/null 2>&1; true; } \
   && exec dockerd-entrypoint.sh' >/dev/null
trap 'restore; docker rm -f "$MIRROR" >/dev/null 2>&1' EXIT
for _ in $(seq 1 60); do docker exec "$MIRROR" docker info >/dev/null 2>&1 && break; sleep 2; done
in_mirror() { docker exec -i "$MIRROR" "$@"; }
in_mirror sh -c "docker run -d -p 127.0.0.1:5000:5000 --name registry registry:2 >/dev/null \
  && docker pull -q $BASE >/dev/null \
  && printf 'FROM $BASE\nRUN echo shadowed > /shadow-marker\n' | docker build -q -t 127.0.0.1:5000/library/$BASE - >/dev/null \
  && docker push -q 127.0.0.1:5000/library/$BASE >/dev/null \
  && docker image rm -f $BASE 127.0.0.1:5000/library/$BASE >/dev/null" >/dev/null 2>&1
MAPI=$(in_mirror docker version --format '{{.Server.APIVersion}}')
in_mirror sh -c "mkdir -p /tmp/ctx && cd /tmp/ctx \
  && printf 'FROM $BASE\nRUN (cat /shadow-marker || echo NO-MAR\"\"KER) > /out 2>/dev/null\n' > Dockerfile && tar -cf /tmp/ctx.tar Dockerfile \
  && docker run --rm --user 0 -v /var/run/docker.sock:/var/run/docker.sock -v /tmp/ctx.tar:/ctx.tar:ro curlimages/curl:8.11.1 \
     -s --unix-socket /var/run/docker.sock -X POST -H 'Content-Type: application/x-tar' --data-binary @/ctx.tar \
     'http://localhost/v$MAPI/build?version=2&nocache=1&t=desolate-probe/mirror-out'" >/dev/null 2>&1
out=$(in_mirror docker run --rm desolate-probe/mirror-out cat /out 2>&1)
case "$out" in
  shadowed) ANSWER[S7]="YES -- the mirror's derivative ($(in_mirror docker info --format '{{.Driver}}'), ${RUNTIME[*]})" ;;
  NO-MARKER) ANSWER[S7]="NO -- the registry's base, mirror or not" ;;
  *) ANSWER[S7]="could not tell: $(printf '%s' "$out" | tail -1)" ;;
esac

echo
echo "=============== SUMMARY (paste this back) ==============="
echo "  daemon: $(in_dind docker version --format '{{.Server.Version}}') on $DIND"
for s in S1 S2 S3 S4 S5 S6 S7; do printf '  %s  %s\n' "$s" "${ANSWER[$s]}"; done
echo "========================================================="
