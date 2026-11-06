#!/usr/bin/env bash
# x86 emulation on an aarch64 VM (issue #37): qemu-user is published by the
# human-run CLI and registered by EACH dind in its own binfmt_misc (sysbox gives
# every container its own table on kernels >= 6.7, so the VM's never reaches the
# inner daemon's containers). The registrar must trust the kernel's registry,
# not the package, fail closed, and be POSIX sh (it runs in Alpine's busybox).
# Run against a scratch directory standing in for /proc/sys/fs/binfmt_misc.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

REG="$RELEASE/vm/binfmt-register.sh"
INST="$RELEASE/vm/install-binfmt.sh"
# A strict POSIX shell when there is one; bash in sh mode otherwise.
if command -v dash >/dev/null 2>&1; then SH=dash; else SH="bash --posix"; fi
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
run() { BINFMT_ROOT="$T/bm" BINFMT_D="$T/d" BINFMT_SKIP_ARCH_CHECK=1 INTERP_DIR="$T/bin" \
        "$@" $SH "$REG" 2>&1; }
entry() { # name interp flags
  printf 'enabled\ninterpreter %s\nflags: %s\noffset 0\nmagic 7f\nmask ff\n' "$2" "$3" > "$T/bm/$1"; }
fresh() { rm -rf "$T/bm" "$T/d" "$T/bin"; mkdir -p "$T/bm" "$T/d" "$T/bin"; : > "$T/bm/register"
  printf '#!/bin/sh\n' > "$T/bin/qemu-x86_64-static"; cp "$T/bin/qemu-x86_64-static" "$T/bin/qemu-i386-static"
  chmod +x "$T/bin/"*; }
X64="$T/bin/qemu-x86_64-static"; I386="$T/bin/qemu-i386-static"

group "binfmt-register.sh ($SH)"
fresh
OUT=$(run env); RC=$?
# The scratch 'register' file records but does not create entries, as a kernel
# that accepted a write and registered nothing would: the read-back must catch it.
assert_eq "nothing registered by the kernel => exit 1 (fail closed)" "$RC" "1"
assert_contains "  and says which entry" "$OUT" "qemu-x86_64 is not enabled with fix-binary"
assert_ok "  and the reboot config it wrote is withdrawn" bash -c "! [ -e '$T/d/qemu-x86_64.conf' ]"

# The kernel unquotes "\xHH" itself and stops at the first NUL byte, so the
# magic must reach it as literal backslash text, never as pre-decoded bytes
# (a raw NUL truncates the x86_64 magic to the ELF64 prefix, every native
# binary on the VM then matches, and exec loops with ELOOP). The scratch
# register keeps only the last write (qemu-i486).
assert_ok "magic is written to register as literal \\xHH text" grep -q ':qemu-i486:M::\\x7fELF\\x01\\x01\\x01\\x00' "$T/bm/register"
assert_ok "  and carries no raw NUL byte" bash -c "! grep -qaP '\\x00' '$T/bm/register'"
assert_ok "  and no raw ELF header byte" bash -c "! grep -qaP '\\x7fELF' '$T/bm/register'"
assert_ok "  with the F flag" grep -q ":$I386:F\$" "$T/bm/register"

fresh; entry qemu-x86_64 "$X64" "OCF"; entry qemu-i386 "$I386" "OCF"; entry qemu-i486 "$I386" "OCF"
OUT=$(run env); RC=$?
assert_eq "all three registered with F => exit 0" "$RC" "0"
assert_contains "  idempotent" "$OUT" "already registered (fix-binary)"
assert_ok "  reboot config written for systemd-binfmt" grep -q ":qemu-x86_64:M::.*:$X64:F\$" "$T/d/qemu-x86_64.conf"

fresh; entry qemu-x86_64 "$X64" "OC"; entry qemu-i386 "$I386" "OCF"; entry qemu-i486 "$I386" "OCF"
OUT=$(run env); RC=$?
assert_eq "an entry without F is not accepted" "$RC" "1"
assert_contains "  it is replaced, not kept" "$OUT" "registered differently"

fresh; entry qemu-x86_64 "/elsewhere" "OCF"; entry qemu-i386 "$I386" "OCF"; entry qemu-i486 "$I386" "OCF"
OUT=$(run env); RC=$?
assert_eq "wrong interpreter is not accepted" "$RC" "1"

# A registration that catches the system's own binaries is undone, not left behind.
fresh
OUT=$(run env NATIVE_PROBE=/bin/false); RC=$?
assert_eq "native binary fails to exec after registering => exit 1" "$RC" "1"
assert_contains "  and says so" "$OUT" "no longer runs"
assert_ok "  and the entry's reboot config was removed" bash -c "! [ -e '$T/d/qemu-x86_64.conf' ]"

fresh; rm "$X64"
OUT=$(run env); RC=$?
assert_eq "missing interpreter => exit 1 before touching the kernel" "$RC" "1"
assert_ok "  nothing written to register" bash -c "! [ -s '$T/bm/register' ]"

group "install-binfmt.sh publishes for the dinds"
fresh; mkdir -p "$T/pub"
OUT=$(BINFMT_ROOT="$T/bm" BINFMT_D="$T/d" BINFMT_SKIP_ARCH_CHECK=1 BINFMT_NO_PACKAGE=1 \
      INTERP_SRC="$T/bin" PUBLIC_DIR="$T/pub" bash "$INST" 2>&1); RC=$?
assert_eq "exit 1 while the (scratch) kernel registers nothing" "$RC" "1"
for f in qemu-x86_64-static qemu-i386-static register.sh; do
  assert_ok "published $f (executable)" test -x "$T/pub/binfmt/$f"
done
assert_ok "the published registrar is binfmt-register.sh" cmp -s "$REG" "$T/pub/binfmt/register.sh"
assert_ok "copies, not symlinks (dind resolves them in its own rootfs)" bash -c "! [ -L '$T/pub/binfmt/qemu-x86_64-static' ]"

group "wiring"
assert_ok "install.sh runs install-binfmt.sh" grep -q 'install-binfmt.sh' "$RELEASE/vm/install.sh"
assert_ok "the shared dind's entrypoint runs /desolate/binfmt/register.sh" grep -q '/desolate/binfmt/register.sh' "$RELEASE/docker-compose.yml"
assert_ok "  before dockerd" bash -c "grep -o 'register.sh.*exec dockerd-entrypoint' '$RELEASE/docker-compose.yml' | grep -q ."
assert_ok "project dinds' entrypoint runs it too (docker.ts)" grep -q '/desolate/binfmt/register.sh' "$RELEASE/vscode-image/docker.ts"
assert_ok "  as a no-op when not published ([ -x ] guard)" bash -c "grep -q '\[ -x /desolate/binfmt/register.sh \]' '$RELEASE/docker-compose.yml' '$RELEASE/vscode-image/docker.ts'"
assert_ok "preflight checks linux/amd64 and linux/386" bash -c "grep -q 'linux/amd64:x86_64' '$RELEASE/preflight.sh' && grep -q 'linux/386:i686' '$RELEASE/preflight.sh'"
assert_ok "registrar is POSIX sh (#!/bin/sh)" bash -c "head -1 '$REG' | grep -qx '#!/bin/sh'"
assert_ok "  parses as POSIX sh" $SH -n "$REG"
assert_ok "nothing pre-decodes the magic (printf %b)" bash -c "! grep -q \"printf '%b'\" '$REG' '$INST'"

summary
