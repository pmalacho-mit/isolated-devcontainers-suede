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
# Tiers t2 and t3 need more than a devcontainer can give (a Docker daemon the tests may drive,
# the base image, Lima and QEMU): see tests/v3/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> apt: jq, shellcheck, git-lfs, chromium (tier T2 opens a workspace's editor in a real browser)"
sudo apt-get update -qq
sudo apt-get install -y -qq jq shellcheck git-lfs
sudo apt-get install -y -qq chromium || echo "    no chromium package here: install Chrome or Chromium and set DESOLATE_CHROME to its path"

echo "==> npm install (typescript, @types/node)"
npm install --no-audit --no-fund --loglevel=error

for c in node npm jq shellcheck git-lfs; do
  command -v "$c" >/dev/null || { echo "setup-test-tools: '$c' is still missing" >&2; exit 1; }
done
echo "==> ready: ./tests/v3/run.sh t1"
