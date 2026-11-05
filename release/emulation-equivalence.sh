#!/usr/bin/env bash
# Is x86 emulation on this aarch64 VM equivalent to real x86? (issue #37)
#
#   emulation-equivalence.sh gen <outdir> [--platform linux/amd64]
#       Generate the v86_64 nasm fixtures from a pinned commit, in a Debian
#       container. On a real x86_64 host (GitHub Actions ubuntu-latest) this is
#       the REFERENCE; on the aarch64 VM with --platform linux/amd64 it is the
#       emulated run. The same command either way -- only the CPU differs.
#   emulation-equivalence.sh diff <reference-dir> <emulated-dir>
#       Byte-compare, and refuse a clean result unless the sensitive cases ran.
#
# V86_COMMIT must be set (a full sha): both runs must be the same commit.
# The agent's own emulated output is never the reference.
set -euo pipefail

SENSITIVE_MARKERS="${SENSITIVE_MARKERS:-fsin fcos fptan fyl2x f2xm1 denormal singlestep}"

case "${1:-}" in
gen)
  OUT=${2:?outdir}; shift 2
  PLAT=()
  [ "${1:-}" = --platform ] && PLAT=(--platform "${2:?}")
  : "${V86_COMMIT:?set V86_COMMIT to a full commit sha of portlandhodl/v86_64}"
  mkdir -p "$OUT"
  docker run --rm "${PLAT[@]}" -v "$(cd "$OUT" && pwd)":/out -e V86_COMMIT debian:bookworm bash -euxc '
    apt-get update -qq && apt-get install -y -qq git nasm gdb binutils nodejs make >/dev/null
    git clone -q https://github.com/portlandhodl/v86_64 /src && git -C /src checkout -q "$V86_COMMIT"
    cd /src
    node tests/nasm/create_tests.js
    node tests/nasm/gen_fixtures.js
    cp -r tests/nasm/build/. /out/ 2>/dev/null || cp -r tests/nasm/. /out/
    { uname -m; gdb --version | head -1; nasm -v; ld --version | head -1; } > /out/TOOLCHAIN
    command -v qemu-x86_64-static >/dev/null && qemu-x86_64-static --version | head -1 >> /out/TOOLCHAIN || true'
  ;;
diff)
  REF=${2:?reference dir}; EMU=${3:?emulated dir}
  # A clean diff over nothing sensitive proves nothing.
  missing=""
  for m in $SENSITIVE_MARKERS; do
    find "$REF" -iname "*$m*" -print -quit | grep -q . || missing="$missing $m"
  done
  if [ -n "$missing" ]; then
    echo "REFUSED: no fixtures matching:$missing -- the comparison would not exercise them" >&2; exit 2
  fi
  if diff -r -x TOOLCHAIN "$REF" "$EMU"; then
    echo "IDENTICAL. Record these with the result:"; cat "$EMU/TOOLCHAIN"
  else
    echo "DIFFERENT -- classify every difference above (undefined result vs emulator inaccuracy)." >&2; exit 1
  fi
  ;;
*) sed -n 2,16p "$0" >&2; exit 1 ;;
esac
