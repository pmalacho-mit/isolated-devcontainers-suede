#!/usr/bin/env bash
# All integration layers, cheapest first. Each skips cleanly when its
# prerequisites are missing, so this is safe to run anywhere.
#
#   broker  -- the real broker over its unix socket vs the real devcontainer CLI
#              (needs: node >= 22.18, `devcontainer` on PATH)
#   proxy   -- the real addon under transparent mitmproxy with nftables REDIRECT
#              (needs: root, nft, docker, mitmproxy)
#   stack   -- the whole compose stack, attacked from inside the editor
#              (needs: docker daemon with sysbox-runc -- i.e. the Mac + Colima)
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
RC=0

printf '\n\033[1m-- broker (unix socket + real devcontainer CLI) --\033[0m\n'
if ! command -v devcontainer >/dev/null 2>&1; then
  printf '  skip: `devcontainer` not on PATH (npm i -g @devcontainers/cli)\n'
elif ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a>22||(a===22&&b>=18))?0:1)' 2>/dev/null; then
  printf '  skip: needs node >= 22.18 for native type stripping\n'
else
  node --test "$ROOT"/tests/integration/broker/*.test.ts || RC=1
fi

printf '\n\033[1m-- keyring (real ssh-agent behind the real control socket) --\033[0m\n'
if ! command -v ssh-agent >/dev/null 2>&1 || ! command -v ssh-keygen >/dev/null 2>&1; then
  printf '  skip: needs ssh-agent/ssh-add/ssh-keygen (openssh-client)\n'
elif ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a>22||(a===22&&b>=18))?0:1)' 2>/dev/null; then
  printf '  skip: needs node >= 22.18 for native type stripping\n'
else
  node --test "$ROOT"/tests/integration/keyring/*.test.ts || RC=1
fi

printf '\n\033[1m-- proxy (transparent mitmproxy + nftables) --\033[0m\n'
bash "$ROOT/tests/integration/proxy/run.sh" || RC=1

printf '\n\033[1m-- stack (full compose, attacked from the editor) --\033[0m\n'
bash "$ROOT/tests/integration/stack/run.sh" || RC=1

exit "$RC"
