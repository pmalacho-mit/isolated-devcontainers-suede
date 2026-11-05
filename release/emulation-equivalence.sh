#!/usr/bin/env bash
# Is x86 emulation on an aarch64 VM equivalent to real x86? (issue #37)
#
#   emulation-equivalence.sh gen ref <outdir>
#       On REAL x86_64 hardware (a GitHub runner, a workstation): build
#       v86_64's nasm tests and record gdb's view of each -- the fixtures.
#   emulation-equivalence.sh gen emu <outdir>
#       On the aarch64 VM (a desolate devcontainer): the same tests, run under
#       qemu-i386-static, the binary the VM publishes for linux/386.
#   emulation-equivalence.sh compare <emu-dir> <ref-dir> [<ref-dir> ...]
#       Per test: would v86_64's own run.js tell the two apart, and are the
#       raw register bits identical? References are also compared with each
#       other: what two real CPUs disagree on, no emulator can be held to.
#
# Needs Docker. Same V86_COMMIT on every side (pinned below; override with the
# env var). The agent's own emulated output is never the reference.
#
# How the emulated side differs, and why (release/emulation-equivalence/):
# gdb cannot trace a program under qemu-user (it does not implement ptrace),
# so each test runs under `qemu-i386-static -g PORT` and an aarch64
# gdb-multiarch attaches over TCP; nasm, ld and gdb are native, only the test
# binaries are emulated. aarch64 gdb cannot print the x87 encodings MMX leaves
# behind, so the emulated side prints st0-7 from their raw bits with glibc's
# rules (x87print.py). Both sides also dump the raw bits, which is what the
# byte-for-byte comparison uses.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
V86_COMMIT=${V86_COMMIT:-c394574477b57eadfc859f593b4aecb08fa37cb6}
IMAGE=ubuntu:24.04   # qemu-user-static 8.2.2, as on the VM

usage() { sed -n 2,16p "$0" >&2; exit 2; }

case "${1:-}" in
gen)
  MODE=${2:-}; OUT=${3:-}
  [ -n "$OUT" ] || usage
  ARCH=$(docker info --format '{{.Architecture}}')
  case "$MODE" in
    ref) [ "$ARCH" = x86_64 ] || { echo "gen ref needs a real x86_64 Docker host; this one is $ARCH" >&2; exit 2; }
         PLATFORM=linux/amd64 ;;
    emu) case "$ARCH" in aarch64|arm64) ;; *) echo "gen emu is for the aarch64 VM; this Docker host is $ARCH" >&2; exit 2 ;; esac
         PLATFORM=linux/arm64 ;;
    *) usage ;;
  esac
  mkdir -p "$OUT"
  OUT=$(cd "$OUT" && pwd)
  [ -z "$(ls -A "$OUT")" ] || { echo "$OUT is not empty" >&2; exit 2; }
  ENVS=(-e "MODE=$MODE" -e "V86_COMMIT=$V86_COMMIT")
  # Behind desolate's intercepting proxy: let the clone trust it.
  [ -r /desolate/ca/ca.pem ] && ENVS+=(-e "EXTRA_CA_PEM=$(cat /desolate/ca/ca.pem)")
  # Detached, then waited on: an attached run's output can be cut short by a
  # socket relay, and this takes a while.
  CID=$(docker run -d --platform "$PLATFORM" "${ENVS[@]}" \
          -v "$HERE/emulation-equivalence":/eq:ro -v "$OUT":/out \
          "$IMAGE" bash /eq/gen-inner.sh)
  echo "container $CID: generating (this takes a while; docker logs -f $CID to watch)"
  RC=$(docker wait "$CID")
  docker logs "$CID" > "$OUT/LOG" 2>&1 || true
  docker rm "$CID" >/dev/null
  tail -20 "$OUT/LOG"
  [ "$RC" = 0 ] || { echo "FAILED (exit $RC); full log: $OUT/LOG" >&2; exit 1; }
  echo "done: $(ls "$OUT"/*.fixture | wc -l) fixtures in $OUT"
  ;;
compare)
  shift; [ $# -ge 2 ] || usage
  exec python3 "$HERE/emulation-equivalence/compare.py" "$@"
  ;;
*) usage ;;
esac
