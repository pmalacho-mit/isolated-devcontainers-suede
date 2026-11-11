#!/bin/bash
# The root's editor (section 4.6): VSCodium's server in the root VM, for REVIEW. Source
# Control and the diff editor over the root clones, every domain's branches as remotes
# (section 6.5), and nothing that executes or renders what a repository contains.
#   editor.sh            as the root's user; idempotent
#
# Why git is safe here and was not in v2's outer editor: these clones' config is desolate's
# own, their hooks path is a root-owned directory, and a domain's work arrives only as
# bundle objects. What still must not happen is CONTENT running: so the editor stays in
# Restricted Mode (workspace trust on, never granted by a prompt), with no automatic tasks,
# no recommended extensions, and no extension updates. root/editor-settings.ts holds those.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRV=/opt/desolate/editor/bin/codium-server
DATA="$HOME/.desolate-root-editor"
NAME=desolate-editor.localhost
SERVER_PORT=31580
GATE_PORT=31581
if [ ! -x "$SRV" ]; then
  echo "root editor: this image has no editor: $(cat /opt/desolate/EDITOR-MISSING 2>/dev/null || echo "$SRV is missing")" >&2
  exit 3
fi
umask 077
mkdir -p "$DATA/extensions" "$DATA/data/Machine"
[ -s "$DATA/token" ] || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$DATA/token"
node --disable-warning=ExperimentalWarning "$HERE/editor-settings.ts" "$DATA/data/Machine/settings.json"
listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if ! listening "$SERVER_PORT"; then
  # No --disable-workspace-trust: Restricted Mode is the point.
  GIT_CONFIG_GLOBAL=/var/lib/desolate/gitconfig setsid nohup "$SRV" --host 127.0.0.1 --port "$SERVER_PORT" \
    --connection-token-file "$DATA/token" --telemetry-level off --accept-server-license-terms \
    --extensions-dir "$DATA/extensions" --server-data-dir "$DATA" >"$DATA/server.log" 2>&1 </dev/null &
fi
if ! listening "$GATE_PORT"; then
  setsid nohup node --disable-warning=ExperimentalWarning "$HERE/../workspace/editor-gate.ts" "$NAME" "$GATE_PORT" "$SERVER_PORT" >"$DATA/gate.log" 2>&1 </dev/null &
fi
for _ in $(seq 1 300); do
  if listening "$SERVER_PORT" && listening "$GATE_PORT"; then exit 0; fi
  sleep 0.2
done
echo "root editor: it did not start listening; see $DATA/server.log" >&2
exit 1
