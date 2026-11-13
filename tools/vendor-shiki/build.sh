#!/usr/bin/env bash
# Builds release/shared/ui/highlight-worker.js from worker.mjs and a pinned Shiki.
#
#   mkdir /tmp/shiki && cd /tmp/shiki && echo '{"private":true}' > package.json
#   npm install --ignore-scripts --save-exact @shikijs/core@4.6.0 @shikijs/engine-javascript@4.6.0 \
#     @shikijs/langs@4.6.0 @shikijs/themes@4.6.0
#   tools/vendor-shiki/build.sh /tmp/shiki/node_modules
#
# The output is checked in and reviewed like any other change: bumping Shiki is a commit.
set -euo pipefail
modules=${1:?"the node_modules directory Shiki was installed into"}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
out=$repo/release/shared/ui/highlight-worker.js
version=$(node -p "require('$modules/@shikijs/core/package.json').version")
{
  printf '// Shiki %s (MIT, LICENSE-shiki beside this file), bundled by tools/vendor-shiki/build.sh from\n' "$version"
  printf '// tools/vendor-shiki/worker.mjs. Generated: change those, not this.\n'
  NODE_PATH="$modules" "$repo/node_modules/.bin/esbuild" "$here/worker.mjs" --bundle --format=iife --platform=browser --target=es2022 \
    --minify-whitespace --minify-syntax --legal-comments=none --log-level=warning --resolve-extensions=.mjs,.js
} > "$out"
cp "$modules/@shikijs/core/LICENSE" "$repo/release/shared/ui/LICENSE-shiki"
grep -lE 'new Function|\beval\(' "$out" && { echo "build.sh: the bundle evaluates code: refusing it" >&2; rm -f "$out"; exit 1; } || true
echo "built $out ($(wc -c < "$out" | tr -d ' ') bytes, Shiki $version)"
