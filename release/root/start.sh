#!/bin/bash
# Start (or confirm) the root VM's services. Run as root in the root VM, by the host, on
# bootstrap and on every start. Idempotent: a service already running is left alone.
#   start.sh <uid of the root's unprivileged user>
set -euo pipefail
USER_UID=${1:?usage: start.sh <uid>}
HERE=$(cd "$(dirname "$0")" && pwd)
STATE=/var/lib/desolate        # the ordinary user's (rootd, the state service, the proxies)
SYS=/var/lib/desolate-root     # root's: what root and the keyring rely on
RUN=/run/desolate
USER_NAME=$(getent passwd "$USER_UID" | cut -d: -f1)
USER_GROUP=$(id -gn "$USER_NAME")
USER_HOME=$(getent passwd "$USER_UID" | cut -d: -f6)
NODE="node --disable-warning=ExperimentalWarning"
# Everything in $STATE is made by the user, as the user: the user owns that directory and
# could have made any name in it a link, so root never opens, creates or changes a path
# there. (Before: `install -d -o <user> $STATE/secrets` as root followed a planted link,
# and gave the user any directory it named, /usr/local/bin included.)
as_user() { runuser -u "$USER_NAME" -- "$@"; }

# THE ORDINARY USER IS NOT ROOT. Lima gives its login user `NOPASSWD: ALL` (cloud-init, at
# boot). That user runs every program here that reads what a domain wrote: git on its
# packs, the proxies on its traffic, the state service. With sudo, a bug in any of them was
# a bug with the write keys and every secret behind it. Undone here, before any of them
# starts; the host reaches root by ssh as root, with a key only the host holds
# (host/vm/lima.ts), never through this user.
# cloud-init writes its rule again at every boot, so the rule that takes it away is a file
# of desolate's that sorts after it: in sudoers the last match wins. Checked by trying.
for rule in /etc/sudoers.d/*; do
  case $rule in */99-desolate) continue ;; esac
  [ -f "$rule" ] && grep -qE "^[[:space:]]*\"?$USER_NAME\"?[[:space:]]" "$rule" && rm -f "$rule"
done
printf '# desolate (root/start.sh): this user runs what reads a domain'"'"'s data. It is never root.\n%s ALL=(ALL) !ALL\n' "$USER_NAME" >/etc/sudoers.d/99-desolate.new
chmod 0440 /etc/sudoers.d/99-desolate.new
visudo -qcf /etc/sudoers.d/99-desolate.new && mv /etc/sudoers.d/99-desolate.new /etc/sudoers.d/99-desolate
for group in sudo admin wheel docker lxd; do
  id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx "$group" && gpasswd -q -d "$USER_NAME" "$group" >/dev/null
done
if runuser -u "$USER_NAME" -- sudo -n true 2>/dev/null; then
  echo "start.sh: $USER_NAME can still sudo; refusing to start anything that reads a domain's data" >&2
  exit 1
fi

id desolate-keyring >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin desolate-keyring
# The keyring runs with the root user's GROUP, so the sockets it creates are connectable by
# the root's user (which must be able to ask for signatures) at mode 0660. Its keys (0600 in
# a 0700 directory) and its approvals socket (0600) are the keyring user's alone.

install -d -m 0755 -o root -g root "$SYS" "$RUN"
# The places above are layout 2. Services an older desolate started use the old places
# (a keyring that went on making keys in the user's directory): stopped here, and started
# again below.
LAYOUT=2
if [ "$(cat "$SYS/layout" 2>/dev/null)" != "$LAYOUT" ]; then
  for svc in rootd stated; do
    [ -f "$RUN/$svc.pid" ] && kill -- "-$(cat "$RUN/$svc.pid")" 2>/dev/null
    rm -f "$RUN/$svc.pid"
  done
  pkill -u desolate-keyring 2>/dev/null || true
  rm -rf "$RUN/keyring" "$RUN/keyring.pid"
  sleep 1
fi
install -d -m 0755 -o "$USER_NAME" -g "$USER_GROUP" "$STATE"
# Keys made before the keyring moved out of $STATE: taken across once, and only if what is
# there is the keyring's own directory (the user could have swapped it for one of its own).
if [ ! -e "$SYS/keyring" ] && [ -d "$STATE/keyring" ] && [ ! -L "$STATE/keyring" ]; then
  mv "$STATE/keyring" "$SYS/keyring.moving"
  if [ "$(stat -c %U "$SYS/keyring.moving")" = desolate-keyring ] && [ ! -L "$SYS/keyring.moving" ]; then
    mv "$SYS/keyring.moving" "$SYS/keyring"
  else
    echo "start.sh: $STATE/keyring was not the keyring's own directory; set aside in $SYS, not used" >&2
    mv "$SYS/keyring.moving" "$SYS/keyring.refused-$(date +%s)"
  fi
fi
install -d -m 0700 -o desolate-keyring -g "$USER_GROUP" "$SYS/keyring"
install -d -m 0750 -o desolate-keyring -g "$USER_GROUP" "$RUN/keyring"
# Hooks: a directory only root writes, holding desolate's own. Every root clone's
# core.hooksPath points here, so no hook from a repository's content can run.
install -d -m 0755 -o root -g root "$SYS/hooks"
install -m 0755 -o root -g root "$HERE/hooks/pre-push" "$SYS/hooks/pre-push"
install -d -m 0755 -o root -g root "$SYS/mirror-hooks"
printf '#!/bin/sh\necho "desolate: the mirror holds only what the remote published; nothing is pushed into it." >&2\nexit 1\n' >"$SYS/mirror-hooks/pre-receive"
chmod 0755 "$SYS/mirror-hooks/pre-receive"
# The old places of the above, in the user's directory: not used any more. (rm does not
# follow a link it is given.)
rm -rf "$STATE/hooks" "$STATE/mirror-hooks"
as_user bash -c '
  set -eu; cd "$1"
  for f in registry.json forge.json known_hosts; do [ -e "$f" ] || : >"$f"; done
  [ -s registry.json ] || echo "{\"repos\":{}}" >registry.json
  # Layout 1 left these: gitconfig is root'"'"'s now, and the logs were opened by root.
  rm -f gitconfig keyring.log
  for log in rootd.log stated.log; do [ -O "$log" ] || { [ -f "$log" ] && cat "$log" >"$log.mine" && mv -f "$log.mine" "$log"; } || rm -f "$log"; done
  mkdir -p -m 0700 secrets proxy approvals
  mkdir -p -m 0755 push-locks
  chmod 0700 secrets proxy approvals' _ "$STATE"
# The root's git settings, for desolate's own commands and for the person's shell alike.
# The root's clones hold commits that agents wrote. Nothing here trusts what a commit
# contains:
cat >"$SYS/gitconfig.new" <<G
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
chmod 0644 "$SYS/gitconfig.new" && mv "$SYS/gitconfig.new" "$SYS/gitconfig"
# The person's shell in the root uses the same git settings as desolate does. (Rewritten
# every time: the file's place moved.)
cat >/etc/profile.d/desolate-root.sh <<'P'
export GIT_CONFIG_GLOBAL=/var/lib/desolate-root/gitconfig
export PS1='[desolate root: review and push here; never run a repository'"'"'s own code] \w \$ '
P

# No sudo rule: nothing in this VM can approve a push. An approval is a signature by the
# approver on the HOST, checked against the public key the host installs here (a directory
# and file only root writes; keyring.ts refuses a key anyone else could have replaced).
rm -f /etc/sudoers.d/desolate-keyring
install -d -m 0755 -o root -g root /etc/desolate
# ($STATE/approvals, where a raw `git push` in the root's terminal leaves its request for
# `desolate approve`, was made above, by the user.)

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
if ! alive "$RUN/keyring.pid"; then
  setsid runuser -u desolate-keyring -g "$USER_GROUP" -- \
    $NODE "$HERE/keyring.ts" >>"$SYS/keyring.log" 2>&1 </dev/null &
  echo $! >"$RUN/keyring.pid"
fi
for _ in $(seq 1 100); do [ -S "$RUN/keyring/control.sock" ] && break; sleep 0.1; done
[ -S "$RUN/keyring/control.sock" ] || { echo "start.sh: the keyring did not start; see $SYS/keyring.log" >&2; tail -5 "$SYS/keyring.log" >&2; exit 1; }
ln -sf "$HERE/git-remote-desolate" /usr/local/bin/git-remote-desolate
ln -sf "$HERE/git-remote-desolate-push" /usr/local/bin/git-remote-desolate-push
# rootd and the state service are kept running: if one ends, it is started again and its
# log says so. (The keyring is not: a keyring that has stopped signs nothing, which is the
# safe way for it to be wrong, and `desolate doctor` says it is down.)
# Its log is opened by the user, in the user's directory: root opens nothing there.
kept() { # kept <name> <script>
  setsid runuser -u "$USER_NAME" -- env HOME="$USER_HOME" GIT_CONFIG_GLOBAL="$SYS/gitconfig" \
    bash -c 'exec >>"$1/$2.log" 2>&1 || exit 1; name=$2; shift 2; while :; do "$@"; echo "$name: ended with $? at $(date -u +%FT%TZ); starting it again" >&2; sleep 2; done' \
    _ "$STATE" "$1" $NODE "$HERE/$2" </dev/null >/dev/null 2>&1 &
  echo $! >"$RUN/$1.pid"
}
alive "$RUN/rootd.pid" || kept rootd rootd.ts
# The state service: what the dashboard draws from (stated.ts).
alive "$RUN/stated.pid" || kept stated stated.ts
echo "$LAYOUT" >"$SYS/layout"
echo "root services: keyring, rootd and the state service up"
