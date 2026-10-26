#!/usr/bin/env bash
# observe.sh, executed against a stub docker: which daemon each spelling
# reaches, by both of its paths, and which project names it refuses.
#
# `--project` turns a name into a socket path. A name it should have refused
# is a path into another directory of the sockets volume -- someone else's
# daemon -- so the refusals are run, not read.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

OBSERVE="$RELEASE/observe.sh"
STUB=$(mktemp -d)
trap 'rm -rf "$STUB"' EXIT
mkdir -p "$STUB/bin"

# Records every call; answers `inspect` with whatever $STUB/orchestrator says.
cat > "$STUB/bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB_DIR/calls"
case "$1" in inspect) cat "$STUB_DIR/orchestrator" 2>/dev/null ;; esac
exit 0
EOF
chmod +x "$STUB/bin/docker"

observe() {
  : > "$STUB/calls"
  STUB_DIR="$STUB" PATH="$STUB/bin:$PATH" bash "$OBSERVE" "$@" </dev/null >/dev/null 2>"$STUB/stderr"
}
last_call() { tail -1 "$STUB/calls"; }

group "the shared daemon, as before"
echo running > "$STUB/orchestrator"
observe ps
assert_contains "through the orchestrator, at the inner socket" "$(last_call)" \
  "exec desolate-orchestrator docker -H unix:///run/inner/docker.sock ps"

group "a project's own daemon"
observe --project acme/widgets ps
assert_contains "--project reaches its socket in the dind-sockets volume" "$(last_call)" \
  "exec desolate-orchestrator docker -H unix:///run/dind-sockets/acme__widgets/docker.sock ps"
observe -p solo docker cp ctr:/etc/hostname -
assert_contains "-p too, and docker passes through" "$(last_call)" \
  "-H unix:///run/dind-sockets/solo/docker.sock cp ctr:/etc/hostname -"

group "the fallback, when the orchestrator is down"
: > "$STUB/orchestrator"
observe --project acme/widgets ps
assert_contains "a throwaway CLI on the sockets volume, at the project's socket" "$(last_call)" \
  "-v desolate_dind-sockets:/run/dind-sockets -e DOCKER_HOST=unix:///run/dind-sockets/acme__widgets/docker.sock"
observe ps
assert_contains "and on the inner one for the shared daemon" "$(last_call)" \
  "-v desolate_inner-run:/run/inner -e DOCKER_HOST=unix:///run/inner/docker.sock"

group "names that are not a project's are refused, and reach no daemon"
echo running > "$STUB/orchestrator"
for bad in "../x" "a/b/c" ".hidden" "a__b" "_x" "a/-b" "a b" ""; do
  if observe --project "$bad" ps; then
    fail "'$bad' is refused" "it ran"
  elif grep -q -- '-H' "$STUB/calls"; then
    fail "'$bad' is refused" "it reached docker: $(last_call)"
  else
    pass "'$bad' is refused"
  fi
done

summary
