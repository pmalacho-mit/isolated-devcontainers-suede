#!/bin/bash
# Bring a workspace VM's own services up. Run as root in the VM, by the host, on every start.
# Idempotent. Nothing here is a boundary: the VM's shares, link and forwarded ports are
# decided outside it (P5); this only makes the inside convenient.
#   start.sh <uid of the workspace user> <link>     link: unix:/path or tcp:host:port[#token]
# The checkouts (init.ts), the devcontainer (devcontainer.ts) and the editor (editor.sh)
# follow, as the workspace's user, each started by the host.
set -euo pipefail
USER_UID=${1:?usage: start.sh <uid> <link>}
LINK=${2:?usage: start.sh <uid> <link>}
HERE=$(cd "$(dirname "$0")" && pwd)
USER_NAME=$(getent passwd "$USER_UID" | cut -d: -f1)
install -d -m 0755 /run/desolate /var/lib/desolate
# The mirrors this VM was shown, by their exact paths, as directories git may read although
# its user does not own them. Needed on vz, where a virtiofs share's root can report uid 0
# for a while after it is mounted, and git then refuses the mirror (release/docs/incidents.md).
# Exact paths: the image's git (2.43) does not understand "<dir>/*", which came in 2.46.
git config --system --unset-all safe.directory 2>/dev/null || true
# (A repository's name is [A-Za-z0-9._-], so a mirror's path never needs /proc's escapes.)
awk '$2 ~ "^/desolate/mirrors/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+[.]git$" { print $2 }' /proc/mounts | while read -r mirror; do
  git config --system --add safe.directory "$mirror"
done
# `desolate` and `/desolate/status` inside a workspace: its own small CLI.
ln -sf "$HERE/desolate" /usr/local/bin/desolate
"$HERE/net/up.sh" "$LINK"
"$HERE/net/trust-ca.sh"
# /desolate/status: say how the work is going (v2's, unchanged).
ln -sf "$HERE/status" /desolate/status
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
chown "$USER_NAME" /run/desolate
if ! alive /run/desolate/wsd.pid; then
  setsid runuser -u "$USER_NAME" -- node --disable-warning=ExperimentalWarning "$HERE/wsd.ts" >>/var/lib/desolate/wsd.log 2>&1 </dev/null &
  echo $! >/run/desolate/wsd.pid
fi
for _ in $(seq 1 100); do [ -S /run/desolate/wsd.sock ] && break; sleep 0.1; done
[ -S /run/desolate/wsd.sock ] || { echo "start.sh: the workspace daemon did not start; see /var/lib/desolate/wsd.log" >&2; tail -5 /var/lib/desolate/wsd.log >&2; exit 1; }
echo "workspace services: up"
# The VM's own docker daemon: for the project's devcontainer (devcontainer.ts) and for
# whatever the work itself runs. It is not started at boot (the root VM, made from the same
# image, runs no containers), and here it is started only when something asks for it: a
# workspace that runs no container should not pay a daemon's memory.
#   - with systemd (a real VM): docker.socket, so the first `docker` command starts it;
#   - without (the fake backend): `start.sh <uid> <link> docker` starts it, and the host
#     runs that when a checkout has a devcontainer.json.
getent group docker >/dev/null && usermod -aG docker "$USER_NAME"
if [ -d /run/systemd/system ]; then
  systemctl start docker.socket >/dev/null 2>&1 || true
elif [ "${3:-}" = docker ] && ! docker info >/dev/null 2>&1; then
  setsid nohup dockerd >>/var/lib/desolate/dockerd.log 2>&1 </dev/null &
fi
