#!/usr/bin/env bash
# Everything ./tests/v3/run.sh t1 needs that the base image and features do not give.
#
# Run as the devcontainer's postCreateCommand. Idempotent.
#
#   shellcheck          t1 lints release/'s shell scripts with it when it is there
#   npm install         the pinned TypeScript: node runs desolate's .ts files by STRIPPING
#                       types, so `tsc -p .` is the only thing that checks them, and t1
#                       FAILS (it does not skip) when TypeScript is missing
#
# Tier t2 also runs in a desolate workspace, on the VM's docker (docker-outside-of-docker):
# docker build -t desolate/base:latest -f release/image/Dockerfile release, once per VM.
# Tier t3 needs Lima and QEMU, under emulation in a VM: see tests/v3/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> apt: jq, shellcheck, git-lfs, chromium (tier T2 opens a workspace's editor in a real browser)"
sudo apt-get update -qq
sudo apt-get install -y -qq jq shellcheck git-lfs
sudo apt-get install -y -qq chromium || true
# Ubuntu's chromium package is a stub for a snap, which a container cannot run: Playwright's
# build instead (arm64 included), where tests/v3/run.sh finds it. In a desolate workspace on
# the VM's disk (/desolate/scratch), so a rebuilt container keeps it.
if ! chromium --version >/dev/null 2>&1 && ! google-chrome --version >/dev/null 2>&1; then
  if [ -w /desolate/scratch ]; then export PLAYWRIGHT_BROWSERS_PATH=/desolate/scratch/playwright; fi
  npx -y playwright@1.49.1 install --with-deps chromium >/dev/null \
    || echo "    no Chromium: install Chrome or Chromium and set DESOLATE_CHROME to its path"
fi

echo "==> npm install (typescript, @types/node)"
npm install --no-audit --no-fund --loglevel=error

for c in node npm jq shellcheck git-lfs; do
  command -v "$c" >/dev/null || { echo "setup-test-tools: '$c' is still missing" >&2; exit 1; }
done
echo "==> ready: ./tests/v3/run.sh t1"
