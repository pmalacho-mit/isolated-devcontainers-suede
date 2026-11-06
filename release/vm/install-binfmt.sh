#!/usr/bin/env bash
# x86 emulation installer. Runs INSIDE the Colima VM, as root, from install.sh.
#
# On an Apple Silicon Mac the VM is aarch64, so every container on every daemon
# in it is too: `docker run --platform linux/amd64 ...` fails with "exec format
# error" unless qemu-user is registered with the kernel's binfmt_misc.
#
# This does three things:
#   1. installs qemu-user-static (the x86_64 and i386 interpreters);
#   2. PUBLISHES those two static binaries and binfmt-register.sh under
#      /var/lib/desolate-proxy/public/binfmt -- the directory every dind mounts
#      read-only at /desolate -- so each dind registers them in ITS OWN
#      binfmt_misc table from its entrypoint. That is where it has to happen:
#      sysbox gives every container its own (empty) table on kernels >= 6.7,
#      so a VM-level registration never reaches the inner daemon's containers
#      (binfmt-register.sh explains; docs/x86-emulation.md has the measurement);
#   3. registers them in the VM too, for `docker run --platform` on the VM's
#      own daemon, persisted in /etc/binfmt.d.
#
# No container is privileged for any of this: a sysbox container is root in its
# own user namespace, which owns its table. (`tonistiigi/binfmt --install` is
# the privileged route, and is refused.)
#
# Idempotent. No-op on an x86 VM. For tests: BINFMT_NO_PACKAGE=1 skips apt,
# PUBLIC_DIR and INTERP_SRC redirect the publish step, and binfmt-register.sh's
# own variables pass through (BINFMT_ROOT, BINFMT_D, NATIVE_PROBE,
# BINFMT_SKIP_ARCH_CHECK).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PUBLIC_DIR="${PUBLIC_DIR:-/var/lib/desolate-proxy/public}"
INTERP_SRC="${INTERP_SRC:-/usr/bin}"     # where the package puts qemu-*-static
BINFMT_D="${BINFMT_D:-/etc/binfmt.d}"

if [ "${BINFMT_SKIP_ARCH_CHECK:-0}" != 1 ]; then
    case "$(uname -m)" in
        aarch64|arm64) ;;
        *) echo "binfmt: VM is $(uname -m), x86 runs natively -- nothing to do"; exit 0 ;;
    esac
fi
if [ "${BINFMT_NO_PACKAGE:-0}" != 1 ] && [ "$(id -u)" != 0 ]; then
    echo "install-binfmt.sh: must run as root" >&2; exit 1
fi

echo "==> qemu-user-static"
if [ "${BINFMT_NO_PACKAGE:-0}" != 1 ]; then
    if [ -x "$INTERP_SRC/qemu-x86_64-static" ] && [ -x "$INTERP_SRC/qemu-i386-static" ]; then
        echo "    already installed"
    else
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        # The package's own registrations (binfmt-support/systemd) are replaced
        # below by ours; we only want the binaries.
        apt-get install -y -qq qemu-user-static
    fi
fi
for i in "$INTERP_SRC/qemu-x86_64-static" "$INTERP_SRC/qemu-i386-static"; do
    if [ ! -x "$i" ]; then echo "    ERROR: $i missing after install" >&2; exit 1; fi
done

# Published BEFORE the proxy installer lays out the rest of the public dir
# (install.sh runs this step first); that installer only adds to it. Copies,
# not symlinks: the dind resolves the path inside its own rootfs.
echo "==> publish to $PUBLIC_DIR/binfmt (mounted at /desolate/binfmt in every dind)"
install -d -m 0755 "$PUBLIC_DIR/binfmt"
install -m 0755 "$INTERP_SRC/qemu-x86_64-static" "$PUBLIC_DIR/binfmt/qemu-x86_64-static"
install -m 0755 "$INTERP_SRC/qemu-i386-static"   "$PUBLIC_DIR/binfmt/qemu-i386-static"
install -m 0755 "$HERE/binfmt-register.sh"       "$PUBLIC_DIR/binfmt/register.sh"
echo "    qemu-x86_64-static qemu-i386-static register.sh"

echo "==> binfmt_misc (the VM's own table)"
mkdir -p "$BINFMT_D" 2>/dev/null || true
INTERP_DIR="$INTERP_SRC" BINFMT_D="$BINFMT_D" sh "$HERE/binfmt-register.sh"
if [ "${BINFMT_NO_PACKAGE:-0}" != 1 ]; then
    "$INTERP_SRC/qemu-x86_64-static" --version | head -1 | sed 's/^/    /'
fi
echo "x86 emulation published and registered. Each dind registers it at start; verify end to end: ./cli.sh preflight (section 6b)"
