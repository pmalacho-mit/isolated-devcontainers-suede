#!/bin/bash
# What a desolate VM image contains. One script, two callers:
#   - image/build.sh, in a chroot of a fresh debootstrap (Linux hosts, CI, the agent's sandbox);
#   - the Lima backend, on the first boot of a pinned Ubuntu cloud image (a Mac).
# Run as root inside the target. Idempotent. Root and workspace VMs boot the same image:
# what a VM is, is decided by what the host starts in it, never by the image.
#
#   DESOLATE_IMAGE_KIND=vm|container   container: no kernel, no cloud-init (the fake backend)
#   /opt/desolate-stage/               optional pre-fetched tools (see "stage" below), for a
#                                      builder with no route to nodejs.org or GitHub
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LC_ALL=C
KIND=${DESOLATE_IMAGE_KIND:-vm}
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
. "$HERE/../pins.env"
STAGE=/opt/desolate-stage
case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "provision: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
say() { printf '==> %s\n' "$*"; }
pin() { eval "printf '%s' \"\${$1_$ARCH:-}\""; }
# fetch <url> <sha256> <dest>: download and verify, or refuse.
fetch() {
  [ -n "$2" ] || { echo "provision: no checksum pinned for $1; refusing to fetch it unverified" >&2; exit 1; }
  curl -fsSL -o "$3" "$1"
  echo "$2  $3" | sha256sum -c - >/dev/null || { echo "provision: checksum mismatch for $1" >&2; rm -f "$3"; exit 1; }
}

say "packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  systemd systemd-sysv dbus udev kmod sudo openssh-server openssh-client ca-certificates curl \
  git git-lfs jq iproute2 iputils-ping nftables dnsmasq-base python3 python3-venv xz-utils \
  less procps psmisc locales netbase socat rsync file bc \
  docker.io docker-buildx docker-compose-v2 >/dev/null
if [ "$KIND" = vm ]; then
  apt-get install -y -qq --no-install-recommends \
    linux-image-virtual initramfs-tools cloud-init cloud-guest-utils e2fsprogs \
    sshfs fuse3 netplan.io systemd-resolved systemd-timesyncd >/dev/null
fi
apt-get clean

say "node $NODE_VERSION"
if ! /usr/local/bin/node --version 2>/dev/null | grep -qx "v$NODE_VERSION"; then
  if [ -x "$STAGE/node/bin/node" ]; then
    # A staged node need not be the pinned version (the sandbox has no route to nodejs.org),
    # so its version is recorded and `doctor` reports the difference.
    cp -a "$STAGE/node/bin/node" /usr/local/bin/node
    rm -rf /usr/local/lib/node_modules/npm
    mkdir -p /usr/local/lib/node_modules
    cp -a "$STAGE/node/lib/node_modules/npm" /usr/local/lib/node_modules/npm
    ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
    ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
  else
    fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.xz" "$(pin NODE_SHA256)" /tmp/node.tar.xz
    # --no-same-owner: as root, tar keeps the archive's owner (uid 1001 for node's), and
    # /usr/local/bin and node itself, which root runs, would belong to a uid anyone made
    # later could be given (release/docs/incidents.md).
    tar -xJ -C /usr/local --strip-components=1 --no-same-owner -f /tmp/node.tar.xz
    rm -f /tmp/node.tar.xz
  fi
fi
node --version

say "devcontainer CLI $DEVCONTAINERS_CLI_VERSION"
if ! devcontainer --version 2>/dev/null | grep -qx "$DEVCONTAINERS_CLI_VERSION"; then
  npm install -g --loglevel=error --no-fund --no-audit "@devcontainers/cli@$DEVCONTAINERS_CLI_VERSION"
fi

say "mitmproxy $MITMPROXY_VERSION (the root's proxies)"
if ! /opt/desolate/proxy-venv/bin/mitmdump --version 2>/dev/null | grep -q "Mitmproxy: $MITMPROXY_VERSION"; then
  mkdir -p /opt/desolate
  python3 -m venv /opt/desolate/proxy-venv
  /opt/desolate/proxy-venv/bin/pip install --quiet --disable-pip-version-check "mitmproxy==$MITMPROXY_VERSION"
fi

say "git-subrepo $GIT_SUBREPO_VERSION (for desolate upstream)"
if [ ! -f /opt/git-subrepo/lib/git-subrepo ]; then
  if [ -d "$STAGE/git-subrepo/lib" ]; then
    cp -a "$STAGE/git-subrepo" /opt/git-subrepo
  else
    git init --quiet /opt/git-subrepo
    git -C /opt/git-subrepo fetch --quiet --depth 1 https://github.com/ingydotnet/git-subrepo "$GIT_SUBREPO_COMMIT"
    git -C /opt/git-subrepo checkout --quiet FETCH_HEAD
    [ "$(git -C /opt/git-subrepo rev-parse HEAD)" = "$GIT_SUBREPO_COMMIT" ]
    rm -rf /opt/git-subrepo/.git
  fi
fi

say "editor server (VSCodium $VSCODIUM_VERSION)"
if [ ! -x /opt/desolate/editor/bin/codium-server ]; then
  if [ -d "$STAGE/editor/bin" ]; then
    mkdir -p /opt/desolate && cp -a "$STAGE/editor" /opt/desolate/editor
  else
    url="https://github.com/VSCodium/vscodium/releases/download/$VSCODIUM_VERSION/vscodium-reh-web-linux-$ARCH-$VSCODIUM_VERSION.tar.gz"
    [ -n "$(pin VSCODIUM_SHA256)" ] || { echo "provision: no checksum pinned for the editor server" >&2; exit 1; }
    if curl -fsSL -m 600 -o /tmp/reh.tar.gz "$url"; then
      # It came: then it must be the pinned one. A wrong checksum is a failure, never a skip.
      echo "$(pin VSCODIUM_SHA256)  /tmp/reh.tar.gz" | sha256sum -c - >/dev/null || { echo "provision: checksum mismatch for $url" >&2; rm -f /tmp/reh.tar.gz; exit 1; }
      mkdir -p /opt/desolate/editor && tar -xz -C /opt/desolate/editor -f /tmp/reh.tar.gz && rm -f /tmp/reh.tar.gz
      rm -f /opt/desolate/EDITOR-MISSING
    else
      # No route to the release (the agent's sandbox). The image is still usable for everything
      # but P1's editor, and says so: nothing may claim an editor that is not there.
      mkdir -p /opt/desolate && echo "the editor server could not be fetched when this image was built" >/opt/desolate/EDITOR-MISSING
      echo "    NOT INSTALLED: could not download $url"
    fi
  fi
fi

say "git: system settings a domain clone needs (section 4.2)"
git lfs install --system >/dev/null
# safe.directory for the mirrors is set per VM, by exact path, by workspace/start.sh: the
# image's git (2.43) ignores "<dir>/*", so a pattern here would be config that does nothing.
git config --system init.defaultBranch main
git config --system protocol.file.allow always

say "desolate's directories and identity"
mkdir -p /desolate /workspaces /run/desolate /var/lib/desolate
printf 'kind=%s\nnode=%s\nbuilt=%s\n' "$KIND" "$(node --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/opt/desolate/image-info
# dockerd is started by the workspace role, not at boot: the root VM runs no containers.
systemctl disable docker.service docker.socket containerd.service >/dev/null 2>&1 || true
rm -rf "$STAGE"
say "done"
