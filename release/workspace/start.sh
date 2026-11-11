#!/bin/bash
# Bring a workspace VM's own services up. Run as root in the VM, by the host, on every start.
# Idempotent. Nothing here is a boundary: the VM's shares, link and forwarded ports are
# decided outside it (P5); this only makes the inside convenient.
#   start.sh <uid of the workspace user>
set -euo pipefail
USER_UID=${1:?usage: start.sh <uid>}
HERE=$(cd "$(dirname "$0")" && pwd)
USER_NAME=$(getent passwd "$USER_UID" | cut -d: -f1)
install -d -m 0755 /run/desolate /var/lib/desolate
install -d -m 0755 -o "$USER_NAME" /home/"$USER_NAME"/.desolate 2>/dev/null || true
# `desolate` and `/desolate/status` inside a workspace: its own small CLI.
ln -sf "$HERE/desolate" /usr/local/bin/desolate
[ -x "$HERE/net/up.sh" ] && "$HERE/net/up.sh"
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
chown "$USER_NAME" /run/desolate
if ! alive /run/desolate/wsd.pid; then
  setsid runuser -u "$USER_NAME" -- node --disable-warning=ExperimentalWarning "$HERE/wsd.ts" >>/var/lib/desolate/wsd.log 2>&1 </dev/null &
  echo $! >/run/desolate/wsd.pid
fi
for _ in $(seq 1 100); do [ -S /run/desolate/wsd.sock ] && break; sleep 0.1; done
[ -S /run/desolate/wsd.sock ] || { echo "start.sh: the workspace daemon did not start; see /var/lib/desolate/wsd.log" >&2; tail -5 /var/lib/desolate/wsd.log >&2; exit 1; }
echo "workspace services: up"
