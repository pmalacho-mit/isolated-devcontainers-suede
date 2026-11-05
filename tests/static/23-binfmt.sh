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

group "install.sh / preflight wiring"
assert_ok "install.sh runs install-binfmt.sh" grep -q 'install-binfmt.sh' "$RELEASE/vm/install.sh"
assert_ok "preflight checks linux/amd64 and linux/386" bash -c "grep -q 'linux/amd64:x86_64' '$RELEASE/preflight.sh' && grep -q 'linux/386:i686' '$RELEASE/preflight.sh'"
assert_ok "installer registers with the F flag" grep -q ':F"' "$S"

summary
