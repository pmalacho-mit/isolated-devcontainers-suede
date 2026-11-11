#!/bin/bash
# desolate v3's tests, by tier (move-to-vms.md section 13.2). Test names carry their tier,
# and a T2 test is never taken as proof of a boundary.
#
#   tests/v3/run.sh t1      static and unit. Seconds, anywhere, no Docker.
#   tests/v3/run.sh t2      end to end on the fake backend (containers standing in for VMs).
#                           Minutes. Needs Docker, the base image, and a non-root user.
#   tests/v3/run.sh t3      end to end on real VMs (the qemu backend: KVM if /dev/kvm exists,
#                           software emulation if not). Tens of minutes under emulation.
#   tests/v3/run.sh t4      the same end-to-end boundary tests on a Mac (the vz backend).
#                           NEVER RUN YET: see docs/v3/HANDOFF.md.
#   tests/v3/run.sh all     t1, t2, t3
#
# A tier whose needs are not met FAILS and says what to install: it does not skip, because a
# suite that did not run is not a suite that passed.
#
#   UPDATE_TRANSCRIPTS=1    accept changed command output (review the diff first)
#   DESOLATE_IMAGE_DIR      where release/image/build.sh wrote the base image (t2, t3)
#   DESOLATE_TIMINGS=<file> append each step's wall-clock time
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT" || exit 1
NODE=${DESOLATE_NODE:-node}
need() { echo "tests/v3: $1" >&2; echo "  fix: $2" >&2; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null \
  || need "node >= 22.18 is required (found: $("$NODE" --version 2>/dev/null || echo none))" "install a newer node, or set DESOLATE_NODE"
run_node_tests() { "$NODE" --disable-warning=ExperimentalWarning --test --test-concurrency=1 --test-reporter="${DESOLATE_TEST_REPORTER:-spec}" "$@"; }

t1() {
  echo "== T1: static and unit"
  local failed=0
  if [ -x node_modules/.bin/tsc ]; then
    node_modules/.bin/tsc -p . || failed=1
  else
    # node strips types without checking them: unchecked, the four sides of desolate can
    # silently disagree. Not installing typescript must not look like a pass.
    need "typescript is not installed, so nothing checks that the TypeScript agrees with itself" "npm install"
  fi
  for script in release/cli.sh release/image/*.sh release/root/*.sh release/root/hooks/* release/root/keyring-askpass release/root/git-remote-desolate release/workspace/*.sh release/workspace/desolate release/host/vm/*.sh tests/v3/*.sh tests/v3/forge/*.sh tests/probes/v3/*.sh; do
    bash -n "$script" || { echo "syntax: $script" >&2; failed=1; }
  done
  if command -v shellcheck >/dev/null 2>&1; then
    shellcheck -S warning release/cli.sh release/image/*.sh release/root/*.sh release/workspace/*.sh release/host/vm/*.sh tests/v3/*.sh tests/v3/forge/*.sh tests/probes/v3/*.sh || failed=1
  else
    echo "   (shellcheck not installed: shell scripts were syntax-checked only)"
  fi
  run_node_tests tests/v3/t1/*.test.ts || failed=1
  return $failed
}

docker_ready() {
  [ "$(id -u)" != 0 ] || need "the end-to-end tiers refuse to run as root: the stack's unprivileged user would be root, and nothing about users could be tested" "run as an ordinary user who can use Docker"
  docker info >/dev/null 2>&1 || need "no Docker daemon answers (the stand-in forge and the fake backend run in containers)" "start Docker, and make sure this user can reach it"
  docker image inspect desolate/base:latest >/dev/null 2>&1 || need "the base image desolate/base:latest is not in Docker's image store" "sudo release/image/build.sh --out <dir>   (on Linux; it imports the image)"
  command -v git-lfs >/dev/null 2>&1 || need "git-lfs is needed on this machine to make the test repositories" "apt-get install git-lfs  /  brew install git-lfs"
  command -v python3 >/dev/null 2>&1 || need "python3 is needed (tests/v3/lib/person.py plays the person at a terminal)" "install python3"
}

t2() {
  echo "== T2: end to end, fake backend (NOT a test of any VM boundary)"
  docker_ready
  DESOLATE_TIER=T2 run_node_tests tests/v3/t2/*.test.ts
}

t3() {
  echo "== T3: end to end, real VMs (qemu backend)"
  docker_ready
  command -v limactl >/dev/null 2>&1 || need "limactl is not on PATH (the qemu backend drives QEMU through Lima)" "install Lima 2.0 or newer: https://lima-vm.io"
  command -v "qemu-system-$(uname -m)" >/dev/null 2>&1 || need "qemu-system-$(uname -m) is not installed" "apt-get install qemu-system-x86 qemu-utils"
  local image=${DESOLATE_IMAGE_DIR:-$HOME/.desolate/images/$(uname -m)}
  [ -f "$image/disk.raw" ] || need "the base VM image is not at $image" "sudo release/image/build.sh --out <dir>, then DESOLATE_IMAGE_DIR=<dir> tests/v3/run.sh t3"
  [ -e /dev/kvm ] || echo "   no /dev/kvm: software emulation. Each VM takes minutes to boot; this tier takes tens of minutes."
  DESOLATE_TIER=T3 DESOLATE_IMAGE_DIR=$image run_node_tests tests/v3/t3/*.test.ts
}

t4() {
  echo "== T4: end to end, the product backend (vz) on a Mac"
  [ "$(uname -s)" = Darwin ] || need "T4 is the Mac's tier" "run it on macOS; on Linux the real-VM tier is t3"
  docker_ready
  command -v limactl >/dev/null 2>&1 || need "limactl is not on PATH" "brew install lima"
  DESOLATE_TIER=T4 run_node_tests tests/v3/t3/*.test.ts
}

case "${1:-t1}" in
  t1) t1 ;;
  t2) t2 ;;
  t3) t3 ;;
  t4) t4 ;;
  all) t1 && t2 && t3 ;;
  *) sed -n '2,20p' "$0"; exit 64 ;;
esac
