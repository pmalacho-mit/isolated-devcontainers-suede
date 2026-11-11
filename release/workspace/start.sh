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
echo "workspace services: up"
