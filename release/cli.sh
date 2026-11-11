#!/bin/bash
# desolate: the only command you run on the host. This launcher finds a node that can run
# desolate's TypeScript directly (>= 22.18) and hands over to host/cli.ts.
set -euo pipefail
SOURCE=${BASH_SOURCE[0]}
while [ -L "$SOURCE" ]; do
  DIR=$(cd -P "$(dirname "$SOURCE")" && pwd)
  SOURCE=$(readlink "$SOURCE")
  case $SOURCE in /*) ;; *) SOURCE=$DIR/$SOURCE ;; esac
done
HERE=$(cd -P "$(dirname "$SOURCE")" && pwd)
NODE=${DESOLATE_NODE:-}
if [ -z "$NODE" ]; then
  for candidate in "${DESOLATE_HOME:-$HOME/.desolate}/tools/node/bin/node" "$(command -v node 2>/dev/null || true)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    NODE=$candidate
    break
  done
fi
if [ -z "$NODE" ]; then
  echo "desolate: node was not found. It needs node >= 22.18 on the host." >&2
  echo "  fix: brew install node   (macOS)   or set DESOLATE_NODE=/path/to/node" >&2
  exit 1
fi
if ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  echo "desolate: $NODE is $("$NODE" --version); desolate needs node >= 22.18 (it runs TypeScript directly)." >&2
  echo "  fix: brew upgrade node   or set DESOLATE_NODE=/path/to/a/newer/node" >&2
  exit 1
fi
exec "$NODE" --disable-warning=ExperimentalWarning "$HERE/host/cli.ts" "$@"
