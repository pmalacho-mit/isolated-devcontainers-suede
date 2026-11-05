#!/bin/sh
# Register qemu-user for x86_64 and i386 (incl. i486+) in the binfmt_misc of
# THIS user namespace. POSIX sh: it runs in the VM (from install-binfmt.sh) and
# inside every dind (Alpine, busybox sh) from the dind's entrypoint, out of the
# read-only /desolate mount.
#
# Why inside each dind: since Linux 6.7 binfmt_misc is per user namespace -- a
# namespace that mounts it gets its own, EMPTY table, and the kernel only falls
# back to the parent's table for namespaces that never mounted one. sysbox
# (>= 0.6.7) mounts it in every container it starts, so the VM's registrations
# are invisible to dind and to every container on the inner daemon. Measured on
# sysbox 0.7.1 / Ubuntu 24.04 (6.8): see docs/x86-emulation.md. Registering here
# needs no privilege: dind is root in its own user namespace, which owns this
# table.
#
# The `F` (fix-binary) flag makes the kernel open the interpreter now, in this
# mount namespace. The registration then works for a process in any mount
# namespace below -- a container whose rootfs has no qemu in it -- and nothing
# is mounted into any container and no container gets a new capability.
#
# The magic and mask go to the kernel as LITERAL "\xHH" text: the kernel
# unquotes them itself (fs/binfmt_misc.c, unquote()) and that unquoting stops at
# the first NUL byte. Pre-decoded bytes (printf %b) truncate the x86_64 magic to
# the ELF64 prefix, every 64-bit ELF then matches, qemu (a 64-bit ELF itself)
# matches again, and exec fails with ELOOP for every binary on the system.
# Hence the probe after each registration and the undo on failure.
#
# Fail-closed: the kernel's own registry is read back and this exits 1 unless
# every entry is enabled, fix-binary, and points at the interpreter. Checks use
# shell builtins only, because after a bad registration no binary can exec.
# Idempotent. No-op on an x86 host.
#
#   INTERP_DIR   where qemu-x86_64-static and qemu-i386-static are (/desolate/binfmt)
#   BINFMT_ROOT  the binfmt_misc mount (/proc/sys/fs/binfmt_misc)
#   BINFMT_D     if set: also write systemd binfmt.d files there (reboot persistence)
#   NATIVE_PROBE a native binary that must keep exec'ing; BINFMT_SKIP_ARCH_CHECK=1 for tests
set -eu

BINFMT_ROOT=${BINFMT_ROOT:-/proc/sys/fs/binfmt_misc}
INTERP_DIR=${INTERP_DIR:-/desolate/binfmt}
BINFMT_D=${BINFMT_D:-}
if [ -z "${NATIVE_PROBE:-}" ]; then
    for NATIVE_PROBE in /bin/true /usr/bin/true; do [ -x "$NATIVE_PROBE" ] && break; done
fi

# e_machine + ELF class bytes, from qemu's scripts/qemu-binfmt-conf.sh.
ELF64='\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00'
ELF32='\x7fELF\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00'
MASK='\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff'

if [ "${BINFMT_SKIP_ARCH_CHECK:-0}" != 1 ]; then
    case "$(uname -m)" in
        aarch64|arm64) ;;
        *) echo "binfmt: $(uname -m) runs x86 natively -- nothing to do"; exit 0 ;;
    esac
fi

if [ ! -e "$BINFMT_ROOT/register" ]; then
    mount -t binfmt_misc binfmt_misc "$BINFMT_ROOT" 2>/dev/null || true
fi
if [ ! -e "$BINFMT_ROOT/register" ]; then
    echo "binfmt: no binfmt_misc at $BINFMT_ROOT (not mounted, or the kernel lacks it)" >&2
    exit 1
fi

# enabled, F flag, right interpreter? Builtins only (see above).
good() {
    f="$BINFMT_ROOT/$1"; en=; ip=; fl=
    [ -e "$f" ] || return 1
    while IFS= read -r line; do
        case "$line" in
            enabled)          en=1 ;;
            "interpreter $2") ip=1 ;;
            "flags: "*F*)     fl=1 ;;
        esac
    done < "$f"
    [ -n "$en" ] && [ -n "$ip" ] && [ -n "$fl" ]
}

# Undo this run's registrations ("-1" removes an entry; echo is a builtin).
OURS=
cleanup() {
    for n in $OURS; do
        [ -e "$BINFMT_ROOT/$n" ] && echo -1 > "$BINFMT_ROOT/$n"
        [ -n "$BINFMT_D" ] && rm -f "$BINFMT_D/$n.conf" 2>/dev/null
    done
    return 0
}
trap 'rc=$?; [ "$rc" = 0 ] || cleanup' EXIT

register() { # name magic interp
    if good "$1" "$3"; then
        echo "    $1: already registered (fix-binary)"
    else
        if [ ! -x "$3" ]; then echo "    ERROR: interpreter $3 missing" >&2; exit 1; fi
        # An entry of this name from elsewhere (the package, Colima) without F
        # would work here but not in a container below: replace it.
        if [ -e "$BINFMT_ROOT/$1" ]; then
            echo "    $1: registered differently -- replacing"
            echo -1 > "$BINFMT_ROOT/$1"
        fi
        OURS="$OURS $1"
        printf '%s' ":$1:M::$2:$MASK:$3:F" > "$BINFMT_ROOT/register" 2>/dev/null \
          || { echo "    ERROR: kernel refused the $1 registration" >&2; exit 1; }
        echo "    $1: registered"
        if ! "$NATIVE_PROBE" 2>/dev/null; then
            echo "    ERROR: after registering $1 a native binary ($NATIVE_PROBE) no longer runs -- the entry matches this system's own ELFs; undoing it" >&2
            exit 1
        fi
    fi
    if [ -n "$BINFMT_D" ] && [ -d "$BINFMT_D" ]; then
        printf '%s\n' ":$1:M::$2:$MASK:$3:F" > "$BINFMT_D/$1.conf"
    fi
}

register qemu-x86_64 "${ELF64}\x3e\x00" "$INTERP_DIR/qemu-x86_64-static"
register qemu-i386   "${ELF32}\x03\x00" "$INTERP_DIR/qemu-i386-static"
register qemu-i486   "${ELF32}\x06\x00" "$INTERP_DIR/qemu-i386-static"

# Read back from the kernel, not from what was written.
for pair in "qemu-x86_64 $INTERP_DIR/qemu-x86_64-static" \
            "qemu-i386 $INTERP_DIR/qemu-i386-static" \
            "qemu-i486 $INTERP_DIR/qemu-i386-static"; do
    set -- $pair
    if ! good "$1" "$2"; then
        echo "    ERROR: $1 is not enabled with fix-binary and interpreter $2:" >&2
        if [ -e "$BINFMT_ROOT/$1" ]; then
            while IFS= read -r l; do echo "           $l"; done < "$BINFMT_ROOT/$1" >&2
        else
            echo "           (absent)" >&2
        fi
        exit 1
    fi
done
echo "    x86_64, i386, i486 -> qemu-user (fix-binary) in this namespace"
