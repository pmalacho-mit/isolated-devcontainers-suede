#!/usr/bin/env bash
# Every surface by its own host (vscode-image/hosts.ts), and the outer editor
# behind its gate (editor-gate.ts). The names are spelled in four places --
# hosts.ts, ingress.py, cli.sh, preflight.sh -- and must be one name; and the
# editor's server must be reachable through the gate alone.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

IMG="$RELEASE/vscode-image"
COMPOSE="$RELEASE/docker-compose.yml"

group "one name for the outer editor"
TS_HOST=$(sed -n 's/^export const EDITOR_HOST = "\(.*\)";$/\1/p' "$IMG/hosts.ts")
CLI_HOST=$(sed -n 's/^EDITOR_HOST=\(.*\)$/\1/p' "$RELEASE/cli.sh")
assert_eq "  (hosts.ts names it)" "$TS_HOST" "desolate.localhost"
assert_eq "cli.sh's is hosts.ts's" "$CLI_HOST" "$TS_HOST"
assert_contains "cli.sh url prints it" "$(sed -n '/^editor_url()/,/^}/p' "$RELEASE/cli.sh")" 'url="http://$EDITOR_HOST:$port/'
assert_contains "preflight asks the editor by it" "$(cat "$RELEASE/preflight.sh")" '--resolve "desolate.localhost:$VSPORT:127.0.0.1"'

group "one name for each target"
FIXTURE="$ROOT/tests/unit/fixtures/hosts.json"
PREFLIGHT=$(sed -n 's/^PREFLIGHT_HOST=\(.*\)$/\1/p' "$RELEASE/preflight.sh")
assert_eq "preflight's probe host is hosts.ts's, for its owner" "$PREFLIGHT" \
  "$(node -e 'process.stdout.write(require(process.argv[1])["desolate-preflight"])' "$FIXTURE")"
assert_contains "the probe's forward is owned by that name" "$(cat "$RELEASE/preflight.sh")" "desolate-dind:18997 desolate-preflight"
# Every URL the runner prints or exports for a target is built by hosts.ts.
LEFT=$(grep -n 'http://127\.0\.0\.1:\${' "$IMG/desolate.ts" "$IMG/editor.ts" "$IMG/extension/model.mts" | grep -v '?? "127.0.0.1"' || true)
assert_eq "no target URL is built on 127.0.0.1" "$LEFT" ""

group "the editor's server answers through the gate alone"
VSCODE=$(awk '/^  vscode:/ {on=1; print; next} on && /^  [a-z-]+:/ {exit} on' "$COMPOSE")
assert_contains "the server listens on the container's loopback" "$VSCODE" "- --host=127.0.0.1"
assert_not_contains "  and not on every interface" "$VSCODE" "--host=0.0.0.0"
PORTS=$(printf '%s\n' "$VSCODE" | sed -n 's/^ *- --port=\([0-9]*\).*/\1/p')
GATE=$(printf '%s\n' "$VSCODE" | sed -n 's/^ *DESOLATE_EDITOR_GATE: "\([0-9]*\):\([0-9]*\)"$/\1 \2/p')
assert_eq "the gate passes on to the server's port" "${GATE#* }" "$PORTS"
PUBLISHED=$(printf '%s\n' "$VSCODE" | sed -n 's/^ *- "127\.0\.0\.1:\${VSCODE_PORT:-3000}:\([0-9]*\)"$/\1/p')
assert_eq "what compose publishes is the gate's port" "$PUBLISHED" "${GATE% *}"
assert_contains "shell-entry starts the gate" "$(cat "$IMG/shell-entry.sh")" 'node /usr/local/lib/desolate/editor-gate.ts'
assert_contains "the image carries it, root-owned with the rest" "$(cat "$IMG/Dockerfile")" 'COPY *.ts /usr/local/lib/desolate/'

summary
