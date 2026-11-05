#!/usr/bin/env bash
# Runs INSIDE the container started by ../emulation-equivalence.sh gen.
# Builds v86_64's nasm tests at $V86_COMMIT and records, for every test, the
# state gdb sees when it reaches `loop` -- the same .fixture v86_64's own
# gen_fixtures.js writes -- plus, after the JSON, the raw register bits (gdb's
# `(raw 0x...)`), and a gdb single-step trace of the $TRACE_TESTS.
#
#   MODE=ref  real x86: native gdb runs the 32-bit test binaries (ptrace).
#   MODE=emu  aarch64: each test runs under qemu-i386-static -g PORT and an
#             aarch64 gdb-multiarch attaches over TCP. gdb inside a
#             linux/amd64 container cannot do this: qemu-user does not
#             implement ptrace ("ptrace: Function not implemented").
#             Only the test binaries are emulated; nasm, ld and gdb are native.
#
# Output in /out: <test>.fixture, <test>.trace, IMG_SHA256 (the inputs, which
# must match across runs), TOOLCHAIN (what produced it).
set -euo pipefail
: "${MODE:?ref or emu}" "${V86_COMMIT:?}"
TRACE_TESTS=${TRACE_TESTS:-"fyl2x f2xm1 fptan fsincos fprem fscale fsqrt"}
PORT=${PORT:-12345}

export DEBIAN_FRONTEND=noninteractive
PKGS="git ca-certificates nasm nodejs"
case "$MODE" in
  ref) PKGS="$PKGS gdb binutils" ;;
  emu) PKGS="$PKGS gdb-multiarch binutils-x86-64-linux-gnu qemu-user-static" ;;
  *) echo "MODE must be ref or emu" >&2; exit 2 ;;
esac
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends $PKGS >/dev/null
# Behind an intercepting proxy (a desolate devcontainer), trust its CA for the
# clone. Transport only: nothing it touches reaches a fixture.
if [ -n "${EXTRA_CA_PEM:-}" ]; then
  printf '%s\n' "$EXTRA_CA_PEM" > /usr/local/share/ca-certificates/extra-ca.crt
  update-ca-certificates >/dev/null 2>&1
fi

if [ "$MODE" = ref ]; then
  [ "$(uname -m)" = x86_64 ] || { echo "MODE=ref needs real x86_64 hardware, not $(uname -m)" >&2; exit 2; }
  if grep -qi 'qemu\|tcg' /proc/cpuinfo; then echo "MODE=ref: /proc/cpuinfo says this CPU is emulated" >&2; exit 2; fi
else
  # create_tests.js and gen_fixtures.js call `ld` and `gdb` by name.
  mkdir -p /shim
  ln -sf "$(command -v gdb-multiarch)" /shim/gdb
  ln -sf "$(command -v x86_64-linux-gnu-ld)" /shim/ld
  export PATH=/shim:$PATH
fi

git clone -q https://github.com/portlandhodl/v86_64 /src
git -C /src checkout -q "$V86_COMMIT"
cd /src/tests/nasm

# --- the gdb command file: upstream's, plus the raw dump; emu swaps `run` ---
RAW_REGS="eax ecx edx ebx esp ebp esi edi eip eflags st0 st1 st2 st3 st4 st5 st6 st7 fctrl fstat ftag fop mxcsr"
raw_block() {
  echo '  printf "---BEGIN RAW---\n"'
  for r in $RAW_REGS; do echo "  info registers $r"; done
  for i in 0 1 2 3 4 5 6 7; do echo "  printf \"xmm$i \"" ; echo "  p/x \$xmm$i.v4_int32"; done
  echo '  printf "---END RAW---\n"'
}
if [ "$MODE" = emu ]; then
  START="  shell /usr/bin/qemu-i386-static -g $PORT \$arg0 >/dev/null 2>&1 &
  target remote :$PORT
  continue"
else
  START="  run"
fi
# Through ENVIRON, not -v: awk -v would turn the "\n" in gdb's printf into a newline.
START="$START" RAW="$(raw_block)" awk '
  /^  run$/                 { print ENVIRON["START"]; next }
  ENVIRON["MODE"] == "emu" && /^    printf "    %\.100e,\\n", \$st[0-7]$/ { print "    x87-print-st " substr($NF, 4); next }
  /^  printf "---END JSON---\\n"$/ { print; print ENVIRON["RAW"]; next }
  /^  set logging off$/     { print; if (ENVIRON["MODE"] == "emu") print "  kill"; next }
  { print }' gdb-extract-def > gdb-extract-def.new
grep -q -- '---BEGIN RAW---' gdb-extract-def.new || { echo "gdb-extract-def changed upstream; patch did not apply" >&2; exit 1; }
if [ "$MODE" = emu ]; then
  [ "$(grep -c '^    x87-print-st [0-7]$' gdb-extract-def.new)" = 8 ] || { echo "gdb-extract-def changed upstream; st patch did not apply" >&2; exit 1; }
  printf 'source /eq/x87print.py\n%s\n' "$(cat gdb-extract-def.new)" > gdb-extract-def.new2 && mv gdb-extract-def.new2 gdb-extract-def.new
fi
mv gdb-extract-def.new gdb-extract-def

node create_tests.js >/dev/null
( cd build && sha256sum ./*.img | sort -k2 ) > /out/IMG_SHA256
SYNC_GDB_EXECUTION=1 node gen_fixtures.js | tail -3
cp build/*.fixture /out/

# --- gdb single-step traces: every instruction from _start to `loop` ---
# Stop at the first instruction, then stepi until `loop`, dumping the raw state
# before each step. 2000 steps is far more than any of these tests.
cat > /tmp/trace.gdb <<'EOF'
set $n = 0
while $pc != &loop && $n < 2000
  printf "---STEP %d---\n", $n
  info registers eip eflags eax ecx edx ebx esp ebp esi edi st0 st1 st2 fstat ftag
  stepi
  set $n = $n + 1
end
printf "---END TRACE %d---\n", $n
kill
EOF
for t in $TRACE_TESTS; do
  img=build/$t.img; [ -e "$img" ] || { echo "trace: no $img" >&2; exit 1; }
  if [ "$MODE" = emu ]; then
    /usr/bin/qemu-i386-static -g "$PORT" "$img" >/dev/null 2>&1 &
    START_CMDS=(-ex "target remote :$PORT")
  else
    START_CMDS=(-ex "set disable-randomization off" -ex "starti")
  fi
  gdb -batch -nx -ex "file $img" "${START_CMDS[@]}" -x /tmp/trace.gdb > "/out/$t.trace" 2>&1 || true
  grep -q -- '---END TRACE' "/out/$t.trace" || { echo "trace $t did not finish:"; tail -5 "/out/$t.trace"; exit 1; }
done

{
  echo "mode: $MODE"
  echo "v86_64: $V86_COMMIT"
  echo "uname -m: $(uname -m)"
  grep -m1 '^vendor_id' /proc/cpuinfo || true
  grep -m1 '^model name' /proc/cpuinfo || true
  grep -m1 -E '^(cpu family|model\s)' /proc/cpuinfo || true
  grep -m1 '^stepping' /proc/cpuinfo || true
  grep -m1 '^microcode' /proc/cpuinfo || true
  [ "$MODE" = emu ] && echo "emulator: $(/usr/bin/qemu-i386-static --version | head -1)"
  echo "gdb: $(gdb --version | head -1)"
  echo "nasm: $(nasm -v)"
  echo "ld: $(ld --version | head -1)"
  echo "node: $(node --version)"
  echo "tests: $(ls build/*.img | wc -l)"
} > /out/TOOLCHAIN
cat /out/TOOLCHAIN
