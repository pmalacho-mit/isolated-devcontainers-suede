#!/bin/bash
# Start this workspace's editor (P1: the editor is inside the boundary). Run as the
# workspace's user, by start.sh, on every start. Idempotent.
#   editor.sh <this workspace's editor hostname>
#
# Two processes, both on this VM's loopback:
#   codium-server   the pinned VSCodium server baked into the image (pins.env), port 31580
#   editor-gate.ts  in front of it, port 31581: the only one the host's forwarder reaches
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
node --disable-warning=ExperimentalWarning "$HERE/editor-settings.ts" "$DATA/data/Machine/settings.json"

listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if ! listening "$SERVER_PORT"; then
  setsid nohup "$SRV" --host 127.0.0.1 --port "$SERVER_PORT" \
    --connection-token-file "$DATA/token" \
    --disable-workspace-trust --telemetry-level off --accept-server-license-terms \
    --extensions-dir "$DATA/extensions" --server-data-dir "$DATA" \
    >"$DATA/server.log" 2>&1 </dev/null &
fi
# The gate is restarted if the name it answers to has changed.
if ! listening "$GATE_PORT" || [ "$(cat "$DATA/gate.host" 2>/dev/null)" != "$NAME" ]; then
  [ -s "$DATA/gate.pid" ] && kill "$(cat "$DATA/gate.pid")" 2>/dev/null || true
  for _ in $(seq 1 20); do listening "$GATE_PORT" || break; sleep 0.1; done
  setsid nohup node --disable-warning=ExperimentalWarning "$HERE/editor-gate.ts" "$NAME" "$GATE_PORT" "$SERVER_PORT" >"$DATA/gate.log" 2>&1 </dev/null &
  echo $! >"$DATA/gate.pid"
  printf '%s' "$NAME" >"$DATA/gate.host"
fi
for _ in $(seq 1 300); do
  if listening "$SERVER_PORT" && listening "$GATE_PORT"; then exit 0; fi
  sleep 0.2
done
echo "editor: it did not start listening; see $DATA/server.log and $DATA/gate.log" >&2
tail -5 "$DATA/server.log" >&2 || true
exit 1
