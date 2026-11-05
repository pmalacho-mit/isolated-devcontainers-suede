#!/usr/bin/env bash
# x86 emulation installer. Runs INSIDE the Colima VM, as root.
#
# On an Apple Silicon Mac the VM is aarch64, so every container on every daemon
# in it is too: `docker run --platform linux/amd64 ...` fails with "exec format
# error". This registers qemu-user for x86_64 and i386 (incl. i486+) with the
# kernel's binfmt_misc, here, at provisioning time, by the human-run CLI -- so
# nothing in the stack ever needs a privileged container to do it (the
# `tonistiigi/binfmt --install` route is exactly that, and is refused).
#
# The `F` (fix-binary) flag makes the kernel open the interpreter at
# registration, in the VM's own mount namespace. The registration then works
# for a process in ANY mount namespace, including a container whose rootfs has
# no qemu in it, and a sandboxed one (sysbox). Nothing is mounted into any
# container and no container gets a new capability.
#
# Fail-closed: the package is not trusted. The kernel's own registry is read
# back and the install fails unless both entries are enabled, fix-binary, and
# point at an interpreter that runs.
#
# Idempotent. No-op on an x86 VM (which needs none of this).
#
# For tests: BINFMT_ROOT (default /proc/sys/fs/binfmt_misc) and
# BINFMT_NO_PACKAGE=1 (skip apt) let the logic run against a scratch directory.
set -euo pipefail

BINFMT_ROOT="${BINFMT_ROOT:-/proc/sys/fs/binfmt_misc}"
INTERP_X86_64="${INTERP_X86_64:-/usr/bin/qemu-x86_64-static}"
INTERP_I386="${INTERP_I386:-/usr/bin/qemu-i386-static}"
BINFMT_D="${BINFMT_D:-/etc/binfmt.d}"
# Any native binary; it must keep exec'ing after each registration. /bin/true on
# the VM (Ubuntu); /usr/bin/true is where macOS keeps it, for running the tests.
if [ -z "${NATIVE_PROBE:-}" ]; then
    for NATIVE_PROBE in /bin/true /usr/bin/true; do [ -x "$NATIVE_PROBE" ] && break; done
fi

# name | e_machine, ELF class bytes (from qemu's scripts/qemu-binfmt-conf.sh)
ELF64='\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00'
ELF32='\x7fELF\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00'
MASK='\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff'
# name:magic:interpreter
ENTRIES="
qemu-x86_64|${ELF64}\x3e\x00|$INTERP_X86_64
qemu-i386|${ELF32}\x03\x00|$INTERP_I386
qemu-i486|${ELF32}\x06\x00|$INTERP_I386
"

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
    if [ -x "$INTERP_X86_64" ] && [ -x "$INTERP_I386" ]; then
        echo "    already installed"
    else
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        # binfmt-support/systemd registrations the package makes are replaced
        # below by ours (same names, fix-binary); we only want the binaries.
        apt-get install -y -qq qemu-user-static
    fi
fi
for i in "$INTERP_X86_64" "$INTERP_I386"; do
    if [ ! -x "$i" ]; then echo "    ERROR: $i missing after install" >&2; exit 1; fi
done

echo "==> binfmt_misc"
if [ ! -e "$BINFMT_ROOT/register" ]; then
    mount -t binfmt_misc binfmt_misc "$BINFMT_ROOT" 2>/dev/null || true
fi
if [ ! -e "$BINFMT_ROOT/register" ]; then
    echo "    ERROR: binfmt_misc is not available at $BINFMT_ROOT (kernel without CONFIG_BINFMT_MISC?)" >&2
    exit 1
fi

# Is name registered the way we want? enabled, F flag, right interpreter.
# Bash builtins only: a bad registration can make every native binary on the
# VM un-exec-able (see below), and this check is what has to catch that.
good() {
    local f="$BINFMT_ROOT/$1" line en= ip= fl=
    [ -e "$f" ] || return 1
    while IFS= read -r line; do
        case "$line" in
            enabled)          en=1 ;;
            "interpreter $2") ip=1 ;;
            flags:\ *F*)       fl=1 ;;
        esac
    done < "$f"
    [ -n "$en" ] && [ -n "$ip" ] && [ -n "$fl" ]
}

# Undo this run's registrations and leave the VM as it was. The kernel removes
# an entry on "-1" and `echo` is a builtin, so this works even when no binary
# can be exec'd any more.
OURS=
cleanup() {
    local n
    for n in $OURS; do
        [ -e "$BINFMT_ROOT/$n" ] && echo -1 > "$BINFMT_ROOT/$n"
        rm -f "$BINFMT_D/$n.conf" 2>/dev/null || true
    done
}
trap 'rc=$?; if [ "$rc" != 0 ]; then cleanup; fi' EXIT

mkdir -p "$BINFMT_D" 2>/dev/null || true
while IFS='|' read -r name magic interp; do
    [ -n "$name" ] || continue
    if good "$name" "$interp"; then
        echo "    $name: already registered (fix-binary)"
    else
        # An entry of this name from elsewhere (Colima's own binfmt step, the
        # package) without the F flag would work on the VM but not in a
        # container: replace it.
        if [ -e "$BINFMT_ROOT/$name" ]; then
            echo "    $name: registered differently -- replacing"
            echo -1 > "$BINFMT_ROOT/$name"
        fi
        OURS="$OURS $name"
        # The magic and mask go to the kernel as the LITERAL "\xHH" text: the
        # kernel unquotes them itself (fs/binfmt_misc.c, unquote()) and that
        # unquoting stops at the first NUL byte. Pre-decoding them here
        # (printf %b) hands it raw bytes, the magic is cut to "\x7fELF\x02\x01\x01"
        # and every 64-bit ELF on the VM, grep and sudo included, is then run
        # through qemu -- which is itself a 64-bit ELF, so exec loops (ELOOP,
        # "Too many levels of symbolic links") and the VM is dead until reboot.
        line=":$name:M::$magic:$MASK:$interp:F"
        printf '%s' "$line" > "$BINFMT_ROOT/register" 2>/dev/null \
          || { echo "    ERROR: kernel refused the $name registration" >&2; exit 1; }
        echo "    $name: registered"
        # A native binary must still exec: a self-matching entry is caught here,
        # before the next one is written, and undone by the EXIT trap.
        if ! "$NATIVE_PROBE" 2>/dev/null; then
            echo "    ERROR: after registering $name a native binary ($NATIVE_PROBE) no longer runs -- the entry matches the VM's own ELFs; undoing it" >&2
            exit 1
        fi
    fi
    # Survive a reboot (systemd-binfmt reads this; /etc beats the package's /usr/lib).
    [ -d "$BINFMT_D" ] && printf '%s\n' ":$name:M::$magic:$MASK:$interp:F" > "$BINFMT_D/$name.conf" || true
done <<< "$ENTRIES"

echo "==> verify (read back from the kernel, not from the package)"
for pair in "qemu-x86_64 $INTERP_X86_64" "qemu-i386 $INTERP_I386" "qemu-i486 $INTERP_I386"; do
    # shellcheck disable=SC2086
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
    echo "    $1 OK"
done
if [ "${BINFMT_NO_PACKAGE:-0}" != 1 ]; then
    "$INTERP_X86_64" --version | head -1 | sed 's/^/    /'
fi
echo "x86 emulation registered. Verify end to end: ./cli.sh preflight (section 6b)"
