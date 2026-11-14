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
# A scratch directory on the VM's own disk, at the same path in the devcontainer: what a
# docker-outside-of-docker container is given with -v must be a path the VM's docker has, and
# /workspaces is a share (virtiofs refuses chmod on a socket; /run is noexec). Like /tmp:
# anyone's, sticky; everything in this VM is the domain's (P5). Kept across restarts.
install -d -m 1777 /desolate/scratch
# Lima runs every command from the host over one ssh connection per VM, and sshd allows ten
# sessions on a connection by default: a workspace's link, the dashboard and desolate's own
# commands are each one, and the eleventh was refused (an audit on the M1). Raised; a
# connection made before keeps the old number, so the host makes a new one when this says so.
mkdir -p /etc/ssh/sshd_config.d
if [ "$(cat /etc/ssh/sshd_config.d/50-desolate.conf 2>/dev/null)" != "MaxSessions 1000" ]; then
  echo "MaxSessions 1000" >/etc/ssh/sshd_config.d/50-desolate.conf
  systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || true
  echo "desolate: sessions raised"
fi
# git's safe.directory guards one user against a repository another user planted. In a
# workspace VM there is no such other user: the VM's user, root and the devcontainer are
# all the domain's, and the VM is the boundary (P5). And on vz, ownership as the guest sees
# it is not the host's: a share's root can report uid 0 just after it is mounted, and a file
# root made or chowned in a share reports uid 0 from then on, while on the Mac it stays the
# user's (measured on the M1). A devcontainer that runs as root makes such files in the
# checkouts all the time, and git then refused the user its own clone. So: every directory.
# (Not in the root VM, whose git has settings of its own: root/start.sh.)
git config --system --replace-all safe.directory '*'
# The domain's package caches (C4) for what runs in the VM itself (a devcontainer is given
# them by devcontainer.ts): only where the share is there to hold them.
if mountpoint -q /desolate/cache; then
  cat >/etc/profile.d/desolate-cache.sh <<'C'
export npm_config_cache=/desolate/cache/npm npm_config_store_dir=/desolate/cache/pnpm YARN_CACHE_FOLDER=/desolate/cache/yarn
export PIP_CACHE_DIR=/desolate/cache/pip UV_CACHE_DIR=/desolate/cache/uv GOMODCACHE=/desolate/cache/go-mod
C
else
  rm -f /etc/profile.d/desolate-cache.sh
fi
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
# containerd's Kubernetes plugin (CRI), which docker does not use, listens on a random
# loopback port for its streams: desolate saw a listener and forwarded it to the Mac as a
# dev server (found on the M1). Off, before docker first starts containerd.
if [ ! -s /etc/containerd/config.toml ] || ! grep -q 'io.containerd.grpc.v1.cri' /etc/containerd/config.toml; then
  install -d -m 0755 /etc/containerd
  printf 'version = 2\ndisabled_plugins = ["io.containerd.grpc.v1.cri"]\n' >/etc/containerd/config.toml
fi
if [ -d /run/systemd/system ]; then
  systemctl start docker.socket >/dev/null 2>&1 || true
elif [ "${3:-}" = docker ] && ! docker info >/dev/null 2>&1; then
  setsid nohup dockerd >>/var/lib/desolate/dockerd.log 2>&1 </dev/null &
fi
