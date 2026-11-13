#!/bin/bash
# Start this workspace's editor (P1: the editor is inside the boundary). Run as the
# workspace's user, by start.sh, on every start. Idempotent.
#   editor.sh <this workspace's editor hostname>
#
# Two processes, both on this VM's loopback:
#   codium-server   the pinned VSCodium server baked into the image (pins.env), port 31580.
#                   It runs in the project's devcontainer when there is one it can run in,
#                   and in the VM itself otherwise.
#   editor-gate.ts  in front of it, port 31581, always in the VM: the only one the host's
#                   forwarder reaches
set -euo pipefail
NAME=${1:?usage: editor.sh <editor hostname>}
HERE=$(cd "$(dirname "$0")" && pwd)
SRV=/opt/desolate/editor/bin/codium-server
DATA="$HOME/.desolate-editor"
SERVER_PORT=31580
GATE_PORT=31581
if [ ! -x "$SRV" ]; then
  echo "editor: this image has no editor: $(cat /opt/desolate/EDITOR-MISSING 2>/dev/null || echo "$SRV is missing")" >&2
  exit 3
fi
umask 077
mkdir -p "$DATA/extensions" "$DATA/data/Machine"
# The connection token: made here once, read by the host when it prints the editor's URL.
[ -s "$DATA/token" ] || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$DATA/token"

listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# WHERE the server runs. In the project's devcontainer when it can: there the editor's
# language servers, tasks and terminal see the project's own toolchain, as in v2. That
# needs a glibc container (the server is a glibc program) on the VM's network (so it
# listens on the VM's loopback, behind the gate). Otherwise in the VM, with a terminal that
# enters the container (enter.sh).
STATE=/run/desolate/devcontainer.json
WHERE=vm
if [ "$(jq -r '.state == "up" and .hostNetwork and .glibc and (.compose | not)' "$STATE" 2>/dev/null)" = true ]; then
  WHERE=$(jq -r .containerId "$STATE")
fi
node --disable-warning=ExperimentalWarning "$HERE/editor-settings.ts" "$DATA/data/Machine/settings.json" "$([ "$WHERE" = vm ] && echo enter || echo plain)"
HAVE=$(cat "$DATA/server.where" 2>/dev/null || true)
if listening "$SERVER_PORT" && [ "$HAVE" != "$WHERE" ]; then
  # It is running in the other place (the devcontainer appeared, changed or went): stop it.
  # The process GROUP: codium-server is a launcher whose node child holds the port.
  [ "$HAVE" != vm ] && [ -n "$HAVE" ] && docker exec -u 0 "$HAVE" sh -c 'kill -- -"$(cat /desolate/editor-data/server.pid)"' 2>/dev/null || true
  [ -s "$DATA/server.pid" ] && kill -- -"$(cat "$DATA/server.pid")" 2>/dev/null || true
  pkill -f "server-main.js --host 127.0.0.1 --port $SERVER_PORT" 2>/dev/null || true
  for _ in $(seq 1 50); do listening "$SERVER_PORT" || break; sleep 0.2; done
fi
if ! listening "$SERVER_PORT"; then
  FLAGS="--host 127.0.0.1 --port $SERVER_PORT --disable-workspace-trust --telemetry-level off --accept-server-license-terms"
  if [ "$WHERE" = vm ]; then
    # shellcheck disable=SC2086
    setsid nohup "$SRV" $FLAGS --connection-token-file "$DATA/token" \
      --extensions-dir "$DATA/extensions" --server-data-dir "$DATA" >"$DATA/server.log" 2>&1 </dev/null &
    echo $! >"$DATA/server.pid"
  else
    # The VM's editor directory is mounted in the container at /desolate/editor-data, so the
    # token, the settings and the extensions are the same wherever the server runs.
    docker exec -d -u "$(jq -r .remoteUser "$STATE")" -w "$(jq -r .folder "$STATE")" "$WHERE" sh -c "
      echo \$\$ >/desolate/editor-data/server.pid
      exec setsid $SRV $FLAGS --connection-token-file /desolate/editor-data/token \
        --extensions-dir /desolate/editor-data/extensions --server-data-dir /desolate/editor-data \
        >/desolate/editor-data/server.log 2>&1 </dev/null"
  fi
  printf '%s' "$WHERE" >"$DATA/server.where"
fi
# The extensions the spec asks for (customizations.*.extensions), from Open VSX, through
# the domain's proxy. In the background: a refused or slow registry never holds up a start.
EXTENSIONS=$(jq -r '.extensions // [] | .[]' "$STATE" 2>/dev/null || true)
if [ -n "$EXTENSIONS" ]; then
  (
    for id in $EXTENSIONS; do
      if [ "$WHERE" = vm ]; then
        "$SRV" --install-extension "$id" --extensions-dir "$DATA/extensions" --server-data-dir "$DATA"
      else
        docker exec -u "$(jq -r .remoteUser "$STATE")" "$WHERE" "$SRV" --install-extension "$id" --extensions-dir /desolate/editor-data/extensions --server-data-dir /desolate/editor-data
      fi || echo "desolate: extension unavailable (Open VSX, through the domain's proxy): $id"
    done >"$DATA/extensions.log" 2>&1 </dev/null &
  )
fi
# The gate is restarted if the name it answers to, or its own code, has changed.
GATE_ID="$NAME $(cat "$HERE/editor-gate.ts" "$HERE/../shared/gate.ts" | sha256sum | cut -c1-16)"
if ! listening "$GATE_PORT" || [ "$(cat "$DATA/gate.host" 2>/dev/null)" != "$GATE_ID" ]; then
  [ -s "$DATA/gate.pid" ] && kill "$(cat "$DATA/gate.pid")" 2>/dev/null || true
  for _ in $(seq 1 20); do listening "$GATE_PORT" || break; sleep 0.1; done
  setsid nohup node --disable-warning=ExperimentalWarning "$HERE/editor-gate.ts" "$NAME" "$GATE_PORT" "$SERVER_PORT" "$DATA/token" >"$DATA/gate.log" 2>&1 </dev/null &
  echo $! >"$DATA/gate.pid"
  printf '%s' "$GATE_ID" >"$DATA/gate.host"
fi
for _ in $(seq 1 300); do
  if listening "$SERVER_PORT" && listening "$GATE_PORT"; then exit 0; fi
  sleep 0.2
done
echo "editor: it did not start listening; see $DATA/server.log and $DATA/gate.log" >&2
tail -5 "$DATA/server.log" >&2 || true
exit 1
