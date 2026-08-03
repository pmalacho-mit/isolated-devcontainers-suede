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
    # Connecting to a unix socket is an inode permission check, not a write, so
    # ro costs the editor nothing -- and it stops a compromised editor rewriting
    # an exported .pub, which is what every IdentityFile line points at.
    assert_eq "the editor's copy of keyring-run is READ-ONLY" \
      "$(q '[.services.vscode.volumes[]? | select(.source == "keyring-run") | .read_only] | join(",")')" \
      "true"

    group "the keyring reads no project content and drives nothing"
    # If it mounted /workspaces it would be running git against project content,
    # which is the exact exposure the keys were moved away from.
    KRVOLS=$(q '[.services.keyring.volumes[]?.source] | join(",")')
    assert_not_contains "the keyring does NOT mount workspaces" "$KRVOLS" "workspaces"
    assert_not_contains "the keyring has no inner daemon socket" "$KRVOLS" "inner-run"
    assert_not_contains "the keyring has no broker socket" "$KRVOLS" "broker-run"
    assert_eq "the keyring publishes no ports" \
      "$(q '[.services.keyring.ports[]?] | length')" "0"
    # It was on devnet, the editor's bridge, kept apart from the editor only by
    # a VM-side nftables rule -- a host install step, not a property of this
    # file. devnet is also the bridge carrying the pre-authorised egress to
    # GitHub :22, so the key holder was the one container with a way out.
    assert_eq "the keyring has no network at all" \
      "$(q '.services.keyring.network_mode')" "none"
    assert_eq "the keyring joins no bridge" \
      "$(q '[.services.keyring.networks? // {} | keys[]] | length')" "0"

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
  'pub/${alias}.pub'
assert_contains "and pinned per host alias" "$(cat "$NEWREPO")" "IdentitiesOnly yes"

group "one key per OWNER and repo, not per repo name"
# `tag` is owner__repo; `alias` is the bare repo name. Keying the keyring on
# alias made acme/widgets and other/widgets share one keypair -- and `create` is
# idempotent, so the second repo was handed the first repo's public key to
# register. The host alias was already built from tag, so the two drifted apart
# silently and only a second owner with the same repo name would show it.
assert_contains "the keyring is keyed on owner__repo" "$(cat "$NEWREPO")" \
  'op: "create", alias: repo.tag'
assert_contains "and the identity file is the same key" "$(cat "$NEWREPO")" \
  "identityFile(repo.tag)"
assert_not_contains "the bare repo name never reaches the keyring" \
  "$(grep -oE 'repo\.alias' "$NEWREPO" | tr '\n' ' ')" "repo.alias"

group "the control socket cannot be used to kill the keyring"
# The editor is the only thing that can reach these sockets and it is the least
# trusted container in the stack. Without a byte cap, a client that connects and
# never sends a newline grows the buffer until this process dies -- and it dying
# takes git down for every project at once. broker.ts guards the identical loop.
assert_contains "the control socket caps how much it will buffer" \
  "$(cat "$KEYRING")" "limits.control.bytes"
assert_contains "and how many clients may connect at once" \
  "$(cat "$KEYRING")" "limits.control.concurrent"

group "the keyring holds no private key in its own process"
# ssh-agent is a separate process that this one starts; the private halves are
# read from disk into IT, never into node's heap. `createKey` reads back only
# the .pub. If a future refactor reads a private key here to do something clever
# with it, that key is then in a process the control socket also serves.
# Every read must name a .pub. Asserted line-wise rather than by matching the
# call's arguments: `readFileSync(`${keyPath(alias)}.pub`)` has a nested paren,
# so a regex bounded by the first `)` stops before the .pub and passes whatever
# it is shown.
assert_eq "keyring.ts reads only public halves" \
  "$(grep -n 'readFileSync' "$KEYRING" | grep -vc '\.pub')" "0"

group "private keys are not identified by filename"
# A layout that encodes the alias in the filename and parses it back is how a
# private key ended up being served as a public one (see keyring.test.ts). The
# directory boundary is the fix; assert it did not get flattened back.
assert_contains "keys live one directory per alias" "$(cat "$KEYRING")" \
  'path.join(KEYS, alias, "id")'
assert_not_contains "no alias is parsed back out of a filename" \
  "$(grep -v '^\s*\*' "$KEYRING" | grep -v '^\s*//')" 'deploy_(.+)'

summary
