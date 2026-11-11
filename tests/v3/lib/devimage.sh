#!/bin/bash
# A small devcontainer image for the tests, made INSIDE a workspace VM from the VM's own
# files, so no test needs a registry: a glibc userland (bash, coreutils, git, and the
# libraries the editor's own node needs), a user `dev` with uid 1000, nothing else.
#   devimage.sh <image tag>
set -euo pipefail
TAG=${1:?usage: devimage.sh <image tag>}
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT"/{usr/bin,usr/lib,usr/lib64,etc,tmp,root,home/dev,workspaces,var/tmp,proc,sys,dev,run}
ln -s usr/bin "$ROOT/bin"; ln -s usr/bin "$ROOT/sbin"; ln -s usr/lib "$ROOT/lib"; ln -s usr/lib64 "$ROOT/lib64"
BINS="bash dash sh cat ls id sleep getent uname sed grep env mkdir rm cp mv chmod chown touch echo printf test true false head tail wc sort tr cut tee date pwd readlink dirname basename which ps kill find xargs stat ln whoami hostname mktemp awk tar gzip curl git nproc seq od sha256sum python3 setsid nohup"
copy() {  # a file, with the directories above it, following symlinks to the real file
  local src=$1 real
  real=$(readlink -f "$src")
  mkdir -p "$ROOT$(dirname "$real")" "$ROOT$(dirname "$src")"
  [ -e "$ROOT$real" ] || cp -a "$real" "$ROOT$real"
  [ "$src" = "$real" ] || [ -e "$ROOT$src" ] || ln -s "$real" "$ROOT$src"
}
for name in $BINS; do
  path=$(command -v "$name" 2>/dev/null) || continue
  case "$(readlink -f "$path")" in /usr/bin/*|/usr/sbin/*) ;; *) continue ;; esac
  copy "/usr/bin/$name" 2>/dev/null || copy "$path"
done
# Every library those need, and the ones the editor's node needs.
for binary in "$ROOT"/usr/bin/* /opt/desolate/editor/node; do
  [ -f "$binary" ] || continue
  { ldd "$binary" 2>/dev/null || true; } | awk '/=> \//{print $3} /^\t\/.* \(/{print $1}' | while read -r lib; do copy "$lib"; done
done
# git's helpers, python's library, name lookups, certificates.
for extra in /usr/lib/git-core /usr/lib/python3 /usr/lib/python3.12 /etc/ssl/certs /usr/share/ca-certificates /etc/nsswitch.conf /usr/lib/x86_64-linux-gnu/libnss_files.so.2 /usr/lib/aarch64-linux-gnu/libnss_files.so.2; do
  [ -e "$extra" ] && { mkdir -p "$ROOT$(dirname "$extra")"; cp -a "$extra" "$ROOT$(dirname "$extra")/"; }
done
printf 'root:x:0:0:root:/root:/bin/bash\ndev:x:1000:1000:dev:/home/dev:/bin/bash\n' >"$ROOT/etc/passwd"
printf 'root:x:0:\ndev:x:1000:\n' >"$ROOT/etc/group"
echo "desolate-test-devimage" >"$ROOT/etc/desolate-test-image"
chmod 1777 "$ROOT/tmp" "$ROOT/var/tmp"; chown -R 1000:1000 "$ROOT/home/dev"
tar -C "$ROOT" -c . | docker import - "$TAG" >/dev/null
docker image inspect -f '{{.Size}}' "$TAG"
