#!/usr/bin/env bash
# x86 emulation on an aarch64 VM (issue #37): the installer must trust the
# kernel's registry, not the package, and must fail closed. Run against a
# scratch directory standing in for /proc/sys/fs/binfmt_misc.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

S="$RELEASE/vm/install-binfmt.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
run() { BINFMT_ROOT="$T/bm" BINFMT_D="$T/d" BINFMT_NO_PACKAGE=1 BINFMT_SKIP_ARCH_CHECK=1 \
        INTERP_X86_64="$T/x64" INTERP_I386="$T/i386" bash "$S" 2>&1; }
entry() { # name interp flags
  printf 'enabled\ninterpreter %s\nflags: %s\noffset 0\nmagic 7f\nmask ff\n' "$2" "$3" > "$T/bm/$1"; }
fresh() { rm -rf "$T/bm" "$T/d"; mkdir -p "$T/bm"; : > "$T/bm/register"; printf '#!/bin/sh\n' > "$T/x64"; cp "$T/x64" "$T/i386"; chmod +x "$T/x64" "$T/i386"; }

group "install-binfmt.sh"
fresh
OUT=$(run); RC=$?
# The scratch 'register' file records but does not create entries, as a kernel
# that accepted a write and registered nothing would: the read-back must catch it.
assert_eq "nothing registered by the kernel => exit 1 (fail closed)" "$RC" "1"
assert_contains "  and says which entry" "$OUT" "qemu-x86_64 is not enabled with fix-binary"

fresh; for n in qemu-x86_64; do entry $n "$T/x64" "OCF"; done
entry qemu-i386 "$T/i386" "OCF"; entry qemu-i486 "$T/i386" "OCF"
OUT=$(run); RC=$?
assert_eq "all three registered with F => exit 0" "$RC" "0"
assert_contains "  idempotent" "$OUT" "already registered (fix-binary)"

fresh; entry qemu-x86_64 "$T/x64" "OC"; entry qemu-i386 "$T/i386" "OCF"; entry qemu-i486 "$T/i386" "OCF"
OUT=$(run); RC=$?
assert_eq "an entry without F is not accepted" "$RC" "1"
assert_contains "  it is replaced, not kept" "$OUT" "registered differently"

fresh; entry qemu-x86_64 "/elsewhere" "OCF"; entry qemu-i386 "$T/i386" "OCF"; entry qemu-i486 "$T/i386" "OCF"
OUT=$(run); RC=$?
assert_eq "wrong interpreter is not accepted" "$RC" "1"

# The kernel unquotes "\xHH" itself and stops at the first NUL byte, so the
# magic must reach it as literal backslash text, never as pre-decoded bytes
# (a raw NUL truncates the x86_64 magic to the ELF64 prefix, every native
# binary on the VM then matches, and exec loops with ELOOP).
fresh
run >/dev/null   # the scratch register keeps only the last write (qemu-i486)
assert_ok "magic is written to register as literal \\xHH text" grep -q ':qemu-i486:M::\\x7fELF\\x01\\x01\\x01\\x00' "$T/bm/register"
assert_ok "  and carries no raw NUL byte" bash -c "! tr -d '\\000' < '$T/bm/register' | cmp -s - '$T/bm/register' || true; ! grep -qaP '\\x00' '$T/bm/register'"
assert_ok "  and no raw ELF header byte" bash -c "! grep -qaP '\\x7fELF' '$T/bm/register'"

# A registration that catches the VM's own binaries is undone, not left behind.
fresh
OUT=$(NATIVE_PROBE=/bin/false run); RC=$?
assert_eq "native binary fails to exec after registering => exit 1" "$RC" "1"
assert_contains "  and says so" "$OUT" "no longer runs"
assert_ok "  and the entry's reboot config was removed" bash -c "! [ -e '$T/d/qemu-x86_64.conf' ]"

group "install.sh / preflight wiring"
assert_ok "install.sh runs install-binfmt.sh" grep -q 'install-binfmt.sh' "$RELEASE/vm/install.sh"
assert_ok "preflight checks linux/amd64 and linux/386" bash -c "grep -q 'linux/amd64:x86_64' '$RELEASE/preflight.sh' && grep -q 'linux/386:i686' '$RELEASE/preflight.sh'"
assert_ok "installer registers with the F flag" grep -q ':F"' "$S"
assert_ok "installer never pre-decodes the magic (printf %b)" bash -c "! grep -q \"printf '%b'\" '$S'"

summary
