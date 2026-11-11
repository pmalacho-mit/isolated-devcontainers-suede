#!/bin/bash
# Build desolate's base image from the Ubuntu archive alone (debootstrap), on a Linux host.
#
#   sudo image/build.sh --out <dir> [--node-from <dir>] [--subrepo-from <dir>] [--editor-from <dir>]
#                       [--build-ca <bundle.pem>]
#
# --build-ca: a CA bundle the BUILD trusts, for a builder behind a proxy that re-signs TLS.
# It is used while provisioning and is not left in the image.
#
# Writes into <dir>:
#   rootfs.tar        the provisioned root filesystem
#   disk.raw          the same as a bootable ext4 disk (label desolate-root), for the qemu backend
#   vmlinuz, initrd   its kernel, booted directly (no bootloader on the disk)
#   manifest.json     sha256 of each, and the versions inside
# and, with docker on PATH, imports rootfs.tar as the image desolate/base:<sha12> for the
# fake backend.
#
# This is the route for hosts with no hypervisor to provision in: CI, and an agent's sandbox,
# which can reach the Ubuntu archive and npm but not nodejs.org or GitHub releases (hence
# --*-from: tools already on the builder are staged instead of downloaded). On a Mac the Lima
# backend provisions a pinned Ubuntu cloud image with the same image/provision.sh instead.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="" NODE_FROM="" SUBREPO_FROM="" EDITOR_FROM="" BUILD_CA="" DISK_GB=8
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT=$2; shift ;;
    --node-from) NODE_FROM=$2; shift ;;
    --subrepo-from) SUBREPO_FROM=$2; shift ;;
    --editor-from) EDITOR_FROM=$2; shift ;;
    --disk-gb) DISK_GB=$2; shift ;;
    --build-ca) BUILD_CA=$2; shift ;;
    *) echo "build.sh: unknown flag $1" >&2; exit 64 ;;
  esac
  shift
done
[ -n "$OUT" ] || { echo "build.sh: --out <dir> is required" >&2; exit 64; }
[ "$(id -u)" = 0 ] || { echo "build.sh: needs root (debootstrap, chroot). Run it with sudo." >&2; exit 1; }
for t in debootstrap mkfs.ext4 chroot; do
  command -v "$t" >/dev/null || { echo "build.sh: '$t' is missing. Install it: apt-get install debootstrap e2fsprogs" >&2; exit 1; }
done
# shellcheck disable=SC1091
. "$HERE/../pins.env"
case "$(uname -m)" in
  x86_64) DEB_ARCH=amd64; MIRROR=http://archive.ubuntu.com/ubuntu ;;
  aarch64) DEB_ARCH=arm64; MIRROR=http://ports.ubuntu.com/ubuntu-ports ;;
  *) echo "build.sh: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
R=$OUT/rootfs
umount_all() { for m in dev/pts dev proc sys; do umount -l "$R/$m" 2>/dev/null || true; done; }
trap umount_all EXIT
umount_all; rm -rf "$R"

echo "==> debootstrap $UBUNTU_SUITE ($DEB_ARCH)"
debootstrap --arch="$DEB_ARCH" --variant=minbase --components=main,universe \
  --include=ca-certificates "$UBUNTU_SUITE" "$R" "$MIRROR" >"$OUT/debootstrap.log" 2>&1 \
  || { tail -20 "$OUT/debootstrap.log" >&2; exit 1; }
cat >"$R/etc/apt/sources.list" <<S
deb $MIRROR $UBUNTU_SUITE main universe
deb $MIRROR $UBUNTU_SUITE-updates main universe
deb $MIRROR $UBUNTU_SUITE-security main universe
S
mount -t proc proc "$R/proc"; mount -t sysfs sys "$R/sys"
mount --bind /dev "$R/dev"; mount --bind /dev/pts "$R/dev/pts"
cp /etc/resolv.conf "$R/etc/resolv.conf"
# Nothing the packages install may start during the build.
printf '#!/bin/sh\nexit 101\n' >"$R/usr/sbin/policy-rc.d"; chmod +x "$R/usr/sbin/policy-rc.d"

mkdir -p "$R/opt/desolate-build/image" "$R/opt/desolate-stage"
cp "$HERE/../pins.env" "$R/opt/desolate-build/pins.env"
cp "$HERE/provision.sh" "$R/opt/desolate-build/image/provision.sh"
[ -z "$NODE_FROM" ] || { mkdir -p "$R/opt/desolate-stage/node/bin" "$R/opt/desolate-stage/node/lib/node_modules"
  cp -aL "$NODE_FROM/bin/node" "$R/opt/desolate-stage/node/bin/node"
  cp -a "$NODE_FROM/lib/node_modules/npm" "$R/opt/desolate-stage/node/lib/node_modules/npm"; }
[ -z "$SUBREPO_FROM" ] || cp -a "$SUBREPO_FROM" "$R/opt/desolate-stage/git-subrepo"
[ -z "$EDITOR_FROM" ] || cp -a "$EDITOR_FROM" "$R/opt/desolate-stage/editor"

CA_ENV=()
if [ -n "$BUILD_CA" ]; then
  cp "$BUILD_CA" "$R/opt/desolate-build/build-ca.pem"
  for v in NODE_EXTRA_CA_CERTS SSL_CERT_FILE PIP_CERT REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GIT_SSL_CAINFO; do
    CA_ENV+=("$v=/opt/desolate-build/build-ca.pem")
  done
fi
echo "==> provision"
chroot "$R" env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  "${CA_ENV[@]}" DESOLATE_IMAGE_KIND=vm bash /opt/desolate-build/image/provision.sh 2>&1 | tee "$OUT/provision.log" | grep -E '^(==>|    )' || true
grep -q '^==> done' "$OUT/provision.log" || { echo "build.sh: provisioning did not finish; see $OUT/provision.log" >&2; tail -15 "$OUT/provision.log" >&2; exit 1; }

echo "==> guest settings for a directly booted disk"
echo "LABEL=desolate-root / ext4 defaults,discard 0 1" >"$R/etc/fstab"
echo desolate >"$R/etc/hostname"
# cloud-init: the NoCloud seed Lima attaches, and nothing that waits on a network.
mkdir -p "$R/etc/cloud/cloud.cfg.d"
printf 'datasource_list: [ NoCloud, None ]\n' >"$R/etc/cloud/cloud.cfg.d/90-desolate.cfg"
chroot "$R" systemctl enable ssh.service systemd-networkd.service >/dev/null 2>&1 || true
chroot "$R" systemctl mask systemd-networkd-wait-online.service >/dev/null 2>&1 || true
# An initrd that can find a virtio disk and mount 9p/virtiofs shares, whatever the builder runs.
printf 'virtio_blk\nvirtio_pci\nvirtio_net\nvirtio_scsi\n9p\n9pnet_virtio\nvirtiofs\niso9660\next4\n' >>"$R/etc/initramfs-tools/modules"
sed -i 's/^MODULES=.*/MODULES=most/' "$R/etc/initramfs-tools/initramfs.conf"
KVER=$(ls "$R/lib/modules" | sort -V | tail -1)
chroot "$R" update-initramfs -c -k "$KVER" >>"$OUT/provision.log" 2>&1 || chroot "$R" update-initramfs -u -k "$KVER" >>"$OUT/provision.log" 2>&1
cp "$R/boot/vmlinuz-$KVER" "$OUT/vmlinuz"; cp "$R/boot/initrd.img-$KVER" "$OUT/initrd"
chmod 0644 "$OUT/vmlinuz" "$OUT/initrd"

rm -f "$R/usr/sbin/policy-rc.d" "$R/etc/resolv.conf"
rm -rf "$R/opt/desolate-build" "$R/var/lib/apt/lists"/* "$R/var/cache/apt"/*.bin "$R/root/.npm" "$R/root/.cache"
ln -sf ../run/systemd/resolve/stub-resolv.conf "$R/etc/resolv.conf"
umount_all; trap - EXIT

echo "==> rootfs.tar, disk.raw"
tar -C "$R" --numeric-owner --xattrs -cf "$OUT/rootfs.tar" .
rm -f "$OUT/disk.raw"
truncate -s "${DISK_GB}G" "$OUT/disk.raw"
mkfs.ext4 -q -F -L desolate-root -d "$R" "$OUT/disk.raw"
rm -rf "$R"

sha() { sha256sum "$1" | cut -d' ' -f1; }
ROOTFS_SHA=$(sha "$OUT/rootfs.tar")
cat >"$OUT/manifest.json" <<M
{
  "arch": "$DEB_ARCH",
  "suite": "$UBUNTU_SUITE",
  "kernel": "$KVER",
  "built": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sha256": {
    "rootfs.tar": "$ROOTFS_SHA",
    "disk.raw": "$(sha "$OUT/disk.raw")",
    "vmlinuz": "$(sha "$OUT/vmlinuz")",
    "initrd": "$(sha "$OUT/initrd")"
  }
}
M
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  TAG=desolate/base:${ROOTFS_SHA:0:12}
  # The kernel and its modules are dead weight in a container.
  tar --delete -f "$OUT/rootfs.tar" ./boot ./lib/modules 2>/dev/null || true
  docker import -c 'CMD ["sleep","infinity"]' "$OUT/rootfs.tar" "$TAG" >/dev/null
  docker tag "$TAG" desolate/base:latest
  echo "==> docker image $TAG (also desolate/base:latest)"
fi
echo "==> $OUT/manifest.json"
