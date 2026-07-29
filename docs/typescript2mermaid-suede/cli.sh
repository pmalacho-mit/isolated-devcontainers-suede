#!/usr/bin/env sh
# typescript2mermaid CLI.
#
#   ./cli.sh <files...> [--out report.md] [--embed doc.md] [--check]
#
# Runs cli.ts through tsx, so there is no build step and no installed binary.
# Arguments pass straight through, and `exec` keeps the exit code intact — which
# `--check` depends on to fail a CI job.
set -e

dir=$(dirname "$0")

# Prefer a tsx already installed next to this folder (or above it) so the script
# works from any working directory and without a network round-trip; `npx` is
# the fallback for a checkout whose dependencies were never installed.
for bin in "$dir/node_modules/.bin/tsx" "$dir/../node_modules/.bin/tsx"; do
  if [ -x "$bin" ]; then
    exec "$bin" "$dir/cli.ts" "$@"
  fi
done

exec npx tsx "$dir/cli.ts" "$@"
