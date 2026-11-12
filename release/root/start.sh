#!/bin/bash
# Start (or confirm) the root VM's services. Run as root in the root VM, by the host, on
# bootstrap and on every start. Idempotent: a service already running is left alone.
#   start.sh <uid of the root's unprivileged user>
set -euo pipefail
USER_UID=${1:?usage: start.sh <uid>}
HERE=$(cd "$(dirname "$0")" && pwd)
STATE=/var/lib/desolate
RUN=/run/desolate
USER_NAME=$(getent passwd "$USER_UID" | cut -d: -f1)
USER_GROUP=$(id -gn "$USER_NAME")
USER_HOME=$(getent passwd "$USER_UID" | cut -d: -f6)
NODE="node --disable-warning=ExperimentalWarning"

id desolate-keyring >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin desolate-keyring
# The keyring runs with the root user's GROUP, so the sockets it creates are connectable by
# the root's user (which must be able to ask for signatures) at mode 0660. Its keys (0600 in
# a 0700 directory) and its approvals socket (0600) are the keyring user's alone.

install -d -m 0755 "$STATE" "$RUN"
install -d -m 0700 -o desolate-keyring -g "$USER_GROUP" "$STATE/keyring"
install -d -m 0750 -o desolate-keyring -g "$USER_GROUP" "$RUN/keyring"
# Hooks: a directory only root writes, holding desolate's own. Every root clone's
# core.hooksPath points here, so no hook from a repository's content can run.
install -d -m 0755 -o root -g root "$STATE/hooks"
install -m 0755 -o root -g root "$HERE/hooks/pre-push" "$STATE/hooks/pre-push"
install -d -m 0755 -o root -g root "$STATE/mirror-hooks"
printf '#!/bin/sh\necho "desolate: the mirror holds only what the remote published; nothing is pushed into it." >&2\nexit 1\n' >"$STATE/mirror-hooks/pre-receive"
chmod 0755 "$STATE/mirror-hooks/pre-receive"
for f in registry.json forge.json known_hosts gitconfig; do
  [ -e "$STATE/$f" ] || install -m 0644 -o "$USER_NAME" -g "$USER_GROUP" /dev/null "$STATE/$f"
done
[ -s "$STATE/registry.json" ] || echo '{"repos":{}}' >"$STATE/registry.json"
chown "$USER_NAME:$USER_GROUP" "$STATE"
install -d -m 0700 -o "$USER_NAME" -g "$USER_GROUP" "$STATE/secrets" "$STATE/proxy"
# The root's git settings, for desolate's own commands and for the person's shell alike.
# The root's clones hold commits that agents wrote. Nothing here trusts what a commit
# contains:
cat >"$STATE/gitconfig" <<G
[user]
	name = desolate root
	email = root@desolate.invalid
[advice]
	detachedHead = false
# Every object that arrives is checked: a tree with ".git" in it, a .gitmodules that is a
# symlink or names an option, a malformed object, are refused before any ref points at them.
[fetch]
	fsckObjects = true
	recurseSubmodules = false
[transfer]
	fsckObjects = true
[receive]
	fsckObjects = true
# The root's clones are on the Mac's disk, which folds case and normalises Unicode: paths
# that only LOOK different from ".git" must not be checked out there.
[core]
	protectHFS = true
	protectNTFS = true
	fsmonitor = false
# A directory inside a checked-out tree that is shaped like a bare repository (with a
# config of its own) is not a repository: git run from inside it does not read that config.
[safe]
	bareRepository = explicit
# A submodule or a remote can name a transport. Only the ones desolate uses exist here;
# "ext::" (which runs a command) and the rest do not.
[protocol]
	allow = never
[protocol "file"]
	allow = always
[protocol "ssh"]
	allow = always
[protocol "https"]
	allow = always
[protocol "desolate"]
	allow = always
[protocol "desolate-push"]
	allow = always
[submodule]
	recurse = false
G
# The person's shell in the root uses the same git settings as desolate does.
grep -qs GIT_CONFIG_GLOBAL /etc/profile.d/desolate-root.sh 2>/dev/null || cat >/etc/profile.d/desolate-root.sh <<'P'
export GIT_CONFIG_GLOBAL=/var/lib/desolate/gitconfig
export PS1='[desolate root: review and push here; never run a repository'"'"'s own code] \w \$ '
P

# No sudo rule: nothing in this VM can approve a push. An approval is a signature by the
# approver on the HOST, checked against the public key the host installs here (a directory
# and file only root writes; keyring.ts refuses a key anyone else could have replaced).
rm -f /etc/sudoers.d/desolate-keyring
install -d -m 0755 -o root -g root /etc/desolate
# Where a raw `git push` in the root's terminal leaves its request for `desolate approve`.
install -d -m 0700 -o "$USER_NAME" -g "$USER_GROUP" "$STATE/approvals"

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
if ! alive "$RUN/keyring.pid"; then
  setsid runuser -u desolate-keyring -g "$USER_GROUP" -- \
    $NODE "$HERE/keyring.ts" >>"$STATE/keyring.log" 2>&1 </dev/null &
  echo $! >"$RUN/keyring.pid"
fi
for _ in $(seq 1 100); do [ -S "$RUN/keyring/control.sock" ] && break; sleep 0.1; done
[ -S "$RUN/keyring/control.sock" ] || { echo "start.sh: the keyring did not start; see $STATE/keyring.log" >&2; tail -5 "$STATE/keyring.log" >&2; exit 1; }
ln -sf "$HERE/git-remote-desolate" /usr/local/bin/git-remote-desolate
ln -sf "$HERE/git-remote-desolate-push" /usr/local/bin/git-remote-desolate-push
install -d -m 0755 -o "$USER_NAME" -g "$USER_GROUP" "$STATE/push-locks"
# rootd and the state service are kept running: if one ends, it is started again and its
# log says so. (The keyring is not: a keyring that has stopped signs nothing, which is the
# safe way for it to be wrong, and `desolate doctor` says it is down.)
kept() { # kept <name> <script>
  setsid runuser -u "$USER_NAME" -- env HOME="$USER_HOME" GIT_CONFIG_GLOBAL="$STATE/gitconfig" \
    bash -c 'name=$1; shift; while :; do "$@"; echo "$name: ended with $? at $(date -u +%FT%TZ); starting it again" >&2; sleep 2; done' \
    _ "$1" $NODE "$HERE/$2" >>"$STATE/$1.log" 2>&1 </dev/null &
  echo $! >"$RUN/$1.pid"
}
alive "$RUN/rootd.pid" || kept rootd rootd.ts
# The state service: what the dashboard draws from (stated.ts).
alive "$RUN/stated.pid" || kept stated stated.ts
echo "root services: keyring, rootd and the state service up"
