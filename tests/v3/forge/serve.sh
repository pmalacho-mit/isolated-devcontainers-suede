#!/bin/bash
# Run the forge: sshd (git and git-lfs-authenticate, by forced command) and the LFS server.
# As root, inside a container of desolate's base image or on a Linux host.
#   serve.sh <state dir> <advertised host> [<ssh port> [<lfs port>]]
set -euo pipefail
umask 022
STATE=$1 HOST=$2 SSH_PORT=${3:-22} LFS_PORT=${4:-8080}
HERE=$(cd "$(dirname "$0")" && pwd)
id git >/dev/null 2>&1 || useradd -m -s /bin/bash git
# A new account is locked; sshd refuses a locked account even for key logins.
usermod -p '*' git
# Seeds and repositories here are owned by more than one user; this is a test server.
git config --system --replace-all safe.directory '*'
mkdir -p "$STATE/repos" "$STATE/lfs" /run/sshd
chmod 0755 /run/sshd
[ -f "$STATE/hostkey" ] || ssh-keygen -q -t ed25519 -N "" -f "$STATE/hostkey"
[ -f "$STATE/secret" ] || head -c 32 /dev/urandom | base64 >"$STATE/secret"
[ -f "$STATE/keys.json" ] || echo '[]' >"$STATE/keys.json"
touch "$STATE/authorized_keys" "$STATE/access.log" "$STATE/pushes.log" "$STATE/pulls.log"
printf '{"host":"%s","lfsPort":%s}\n' "$HOST" "$LFS_PORT" >"$STATE/config.json"
printf '[%s]:%s %s\n' "$HOST" "$SSH_PORT" "$(cut -d' ' -f1,2 "$STATE/hostkey.pub")" >"$STATE/known_hosts"
[ "$SSH_PORT" = 22 ] && printf '%s %s\n' "$HOST" "$(cut -d' ' -f1,2 "$STATE/hostkey.pub")" >>"$STATE/known_hosts"
chown -R git:git "$STATE/repos" "$STATE/lfs" "$STATE/access.log" "$STATE/pushes.log" "$STATE/pulls.log"
chmod 0644 "$STATE/secret" "$STATE/keys.json" "$STATE/config.json"
cat >"$STATE/sshd_config" <<C
Port $SSH_PORT
HostKey $STATE/hostkey
AuthorizedKeysFile $STATE/authorized_keys
AllowUsers git
PasswordAuthentication no
KbdInteractiveAuthentication no
StrictModes no
PidFile $STATE/sshd.pid
LogLevel VERBOSE
C
FORGE_STATE=$STATE FORGE_LFS_PORT=$LFS_PORT node --disable-warning=ExperimentalWarning "$HERE/lfs.ts" >>"$STATE/lfs.log" 2>&1 &
exec /usr/sbin/sshd -D -e -f "$STATE/sshd_config" >>"$STATE/sshd.log" 2>&1
