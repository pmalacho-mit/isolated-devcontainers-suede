#!/usr/bin/env bash
# The containment properties that are decided by docker-compose.yml alone.
#
# These are the ones nobody notices breaking: nothing errors when the editor
# gains a docker socket or a port starts listening on 0.0.0.0 -- it just works,
# more than it should.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

if ! docker compose version >/dev/null 2>&1; then
  skip "compose invariants" "docker compose not available"
  summary; exit $?
fi
if ! command -v jq >/dev/null 2>&1; then
  skip "compose invariants" "jq not installed (brew install jq)"
  summary; exit $?
fi

CFG=$(cd "$RELEASE" && VSCODE_TOKEN=test-token docker compose -f docker-compose.yml config --format json 2>/dev/null)
if [ -z "$CFG" ]; then
  fail "docker-compose.yml renders" "docker compose config produced nothing"
  summary; exit $?
fi
pass "docker-compose.yml renders"

q() { printf '%s' "$CFG" | jq -r "$1"; }

group "the editor has no path to the inner daemon"
assert_eq "vscode has no DOCKER_HOST" \
  "$(q '.services.vscode.environment.DOCKER_HOST // "unset"')" "unset"
assert_eq "vscode does not mount inner-run" \
  "$(q '[.services.vscode.volumes[]? | select(.source == "inner-run")] | length')" "0"
assert_eq "vscode reaches the broker socket" \
  "$(q '[.services.vscode.volumes[]? | select(.source == "broker-run")] | length')" "1"
assert_eq "orchestrator holds the daemon socket" \
  "$(q '[.services.orchestrator.volumes[]? | select(.source == "inner-run")] | length')" "1"

group "the host docker socket is mounted nowhere"
assert_eq "no /var/run/docker.sock bind anywhere" \
  "$(q '[.services[].volumes[]? | select(.source == "/var/run/docker.sock")] | length')" "0"

group "published ports stay on loopback"
for svc in dind vscode; do
  bad_binds=$(q "[.services.\"$svc\".ports[]? | select((.host_ip // \"0.0.0.0\") != \"127.0.0.1\")] | length")
  assert_eq "$svc publishes only on 127.0.0.1" "$bad_binds" "0"
done

group "the inner daemon API is published nowhere"
# A GET-only socket proxy on 127.0.0.1:2375 used to live here. It was removed:
# read-only constrained only the Mac (already the trust root, and able to reach
# the inner daemon through the orchestrator anyway), while an unauthenticated
# HTTP port on loopback is reachable from a browser via DNS rebinding, which a
# unix socket is not. Re-adding one should be a deliberate act, so it fails here.
assert_eq "no service publishes 2375" \
  "$(q '[.services[].ports[]? | select(.published == "2375" or .target == 2375)] | length')" "0"
assert_eq "no service mounts inner-run except the orchestrator" \
  "$(q '[.services | to_entries[] | select(.key != "orchestrator" and .key != "dind" and .key != "volume-init")
        | select(.value.volumes[]?.source == "inner-run")] | length')" "0"

group "the dind port publish and the allocator's range cannot drift apart"
# desolate.ts allocates relay ports from DESOLATE_PORT_MIN..MAX; dind publishes
# a range to the Mac. If the allocator's range is the WIDER of the two, relays
# bind fine inside dind's netns and are unreachable from the Mac -- a probe
# timeout with nothing in any log. Both must come from the same two variables.
DIND_MIN=$(q '[.services.dind.ports[]?.target] | min')
DIND_MAX=$(q '[.services.dind.ports[]?.target] | max')
DIND_N=$(q '[.services.dind.ports[]?.target] | length')
assert_eq "orchestrator's PORT_MIN matches dind's lowest published port" \
  "$(q '.services.orchestrator.environment.DESOLATE_PORT_MIN')" "$DIND_MIN"
assert_eq "orchestrator's PORT_MAX matches dind's highest published port" \
  "$(q '.services.orchestrator.environment.DESOLATE_PORT_MAX')" "$DIND_MAX"
# min/max agreeing is not enough -- a gap in the middle is the same failure for
# whichever port lands in it.
assert_eq "dind publishes the range with no holes" \
  "$DIND_N" "$((DIND_MAX - DIND_MIN + 1))"

group "dind runs unprivileged under sysbox"
assert_eq "dind runtime is sysbox-runc" "$(q '.services.dind.runtime // "unset"')" "sysbox-runc"
assert_eq "dind is not privileged" "$(q '.services.dind.privileged // false')" "false"
assert_eq "dind exposes no TCP listener" \
  "$(q '.services.dind.command | index("dockerd") as $i | .[$i:] | map(select(startswith("--host="))) | map(select(contains("unix://") | not)) | length')" "0"

group "unprivileged service hardening"
for svc in vscode orchestrator; do
  assert_contains "$svc sets no-new-privileges" \
    "$(q ".services.\"$svc\".security_opt // [] | join(\",\")")" "no-new-privileges:true"
done
for svc in vscode orchestrator; do
  assert_contains "$svc drops all capabilities" \
    "$(q ".services.\"$svc\".cap_drop // [] | join(\",\")")" "ALL"
done

group "the nftables rules and the compose bridge cannot drift apart"
# If these two disagree, egress interception is off and NOTHING reports it:
# traffic flows, TLS succeeds (unintercepted), secrets are never substituted.
BRIDGE=$(q '.networks.devnet.driver_opts."com.docker.network.bridge.name" // "UNPINNED"')
assert_eq "compose pins the bridge name" "$([ "$BRIDGE" = UNPINNED ] && echo no || echo yes)" "yes"
NFT_IF=$(sed -n 's/^define DESOLATE_IF = "\(.*\)"$/\1/p' "$RELEASE/proxy/vm/nftables-desolate.conf")
assert_eq "nftables DESOLATE_IF matches the pinned bridge" "$NFT_IF" "$BRIDGE"
# Linux caps interface names at 15 characters; a longer one is silently rejected.
assert_eq "bridge name fits IFNAMSIZ" "$([ "${#BRIDGE}" -le 15 ] && echo yes || echo no)" "yes"

group "the long-running services start under with-ca"
# The other half of the invariant tested in 01-syntax.sh. Both matter: this one
# gives the broker (and anything it spawns) proxy-CA trust, the wrapper scripts
# cover every `docker exec` entry that bypasses this entrypoint entirely.
for svc in orchestrator vscode; do
  assert_contains "$svc entrypoint goes through with-ca" \
    "$(q ".services.\"$svc\".entrypoint // [] | join(\" \")")" "with-ca"
done

group "the shared editor server cannot be poisoned by a project"
# /server-dist is bind-mounted into EVERY devcontainer as /vscode-server, and
# every devcontainer EXECUTES /vscode-server/bin/openvscode-server. Writable,
# that is cross-project code execution with no privilege required: the volume is
# chowned 1000:1000 and the stock devcontainer user is uid 1000, so project A
# overwrites the binary and project B runs it. Only volume-init, which seeds it,
# may hold it read-write.
for svc in dind orchestrator; do
  assert_eq "$svc mounts server-dist read-only" \
    "$(q "[.services.\"$svc\".volumes[]? | select(.source == \"server-dist\") | .read_only] | first")" "true"
done
assert_eq "volume-init keeps it writable (it does the seeding)" \
  "$(q '[.services."volume-init".volumes[]? | select(.source == "server-dist") | .read_only // false] | first')" "false"
assert_eq "the editor container does not mount it at all" \
  "$(q '[.services.vscode.volumes[]? | select(.source == "server-dist")] | length')" "0"

group "the CA mount carries only the public certificate"
for svc in dind orchestrator vscode; do
  assert_eq "$svc mounts the CA dir read-only" \
    "$(q "[.services.\"$svc\".volumes[]? | select(.source == \"/var/lib/desolate-proxy/public\") | .read_only] | first")" "true"
done

summary
