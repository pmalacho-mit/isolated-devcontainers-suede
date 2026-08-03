#!/usr/bin/env bash
# Where private keys are, and — more importantly — where they are not.
#
# The property this file defends is one sentence: raw private key material
# exists in the keyring container and nowhere else. Everything below is a
# restatement of that in a form the CI can check, because the failure mode is
# silent — a key in the editor still works perfectly, and nothing about the
# stack behaves differently until the day a project reads it.
#
# Why the editor is the container that must not have them: it shares
# /workspaces read-write with every devcontainer, and a repo's own .git/config
# (core.fsmonitor, core.pager, core.hooksPath, filter.*.clean) and
# .gitattributes are executable configuration. The editor runs git against
# project content, so any project can eventually execute code there. That path
# is a shared filesystem, not a socket — no nftables rule reaches it.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

COMPOSE="$RELEASE/docker-compose.yml"
KEYRING="$RELEASE/vscode-image/keyring.ts"
NEWREPO="$RELEASE/vscode-image/newrepo.ts"

if ! command -v docker >/dev/null 2>&1; then
  skip "keyring compose wiring" "docker not installed (needed for compose config)"
else
  CFG=$(cd "$RELEASE" && docker compose config --format json 2>/dev/null)
  if [ -z "$CFG" ]; then
    skip "keyring compose wiring" "docker compose config produced nothing"
  else
    q() { printf '%s' "$CFG" | jq -r "$1" 2>/dev/null; }

    group "the private-key volume is mounted in exactly one place"
    HOLDERS=$(q '[.services | to_entries[]
                  | select(any(.value.volumes[]?; .source == "keyring-keys"))
                  | .key] | sort | join(",")')
    assert_eq "only 'keyring' mounts keyring-keys" "$HOLDERS" "keyring"

    group "the editor gets the socket, never the keys"
    VSVOLS=$(q '[.services.vscode.volumes[]?.source] | join(",")')
    assert_contains "the editor mounts keyring-run (agent socket)" "$VSVOLS" "keyring-run"
    assert_not_contains "the editor does NOT mount keyring-keys" "$VSVOLS" "keyring-keys"
    assert_eq "the editor points at the stack's agent" \
      "$(q '.services.vscode.environment.SSH_AUTH_SOCK')" "/run/keyring/agent.sock"

    group "the keyring reads no project content and drives nothing"
    # If it mounted /workspaces it would be running git against project content,
    # which is the exact exposure the keys were moved away from.
    KRVOLS=$(q '[.services.keyring.volumes[]?.source] | join(",")')
    assert_not_contains "the keyring does NOT mount workspaces" "$KRVOLS" "workspaces"
    assert_not_contains "the keyring has no inner daemon socket" "$KRVOLS" "inner-run"
    assert_not_contains "the keyring has no broker socket" "$KRVOLS" "broker-run"
    assert_eq "the keyring publishes no ports" \
      "$(q '[.services.keyring.ports[]?] | length')" "0"
    assert_eq "the keyring stays on devnet (unreachable from dind)" \
      "$(q '[.services.keyring.networks | keys[]] | join(",")')" "devnet"

    group "dind cannot see either keyring volume"
    DINDVOLS=$(q '[.services.dind.volumes[]?.source] | join(",")')
    assert_not_contains "dind does NOT mount keyring-keys" "$DINDVOLS" "keyring-keys"
    assert_not_contains "dind does NOT mount keyring-run" "$DINDVOLS" "keyring-run"
  fi
fi

group "the control socket has no way to hand back a private key"
# The guarantee is 'usable but not copyable'. An export/read/dump operation
# would undo it in one line, so the absence is asserted rather than trusted.
for banned in '"export"' '"read"' '"dump"' '"private"' '"reveal"'; do
  assert_not_contains "no ${banned} operation in the keyring protocol" \
    "$(grep -oE 'op === "[a-z]+"' "$KEYRING" | sort -u | tr '\n' ' ')" "$banned"
done
assert_contains "the refusal names why, for whoever wants to add one" \
  "$(cat "$KEYRING")" "no operation that"

group "the editor never writes or names a private key"
assert_not_contains "newrepo does not run ssh-keygen locally" \
  "$(grep -v '^\s*//' "$NEWREPO")" "ssh-keygen"
# A .pub as IdentityFile is correct and required; a bare deploy_<alias> is a
# private key path and must not appear.
assert_not_contains "newrepo names no private key path" \
  "$(grep -oE 'deploy_\$\{[a-z.]+\}[^.]' "$NEWREPO" | tr '\n' ' ')" "deploy_"
assert_contains "identities are pinned by PUBLIC key" "$(cat "$NEWREPO")" \
  'pub/deploy_${alias}.pub'
assert_contains "and pinned per host alias" "$(cat "$NEWREPO")" "IdentitiesOnly yes"

summary
