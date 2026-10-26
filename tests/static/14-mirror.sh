#!/usr/bin/env bash
# A project dind's mirror (#11): the address and image trust-proxy-in-builds.sh
# uses are the ones dind.ts lists in every project dind's daemon.json, and the
# name it pushes a derivative under is the one the daemon will ask the mirror
# for -- the base's own Docker Hub repository, and nothing for any other.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

SCRIPT="$RELEASE/proxy/container/trust-proxy-in-builds.sh"
DIND_TS="$RELEASE/vscode-image/dind.ts"

group "the script and dind.ts agree on the mirror"
assert_eq "its address" \
  "$(sed -n 's/^MIRROR_ADDRESS=//p' "$SCRIPT")" "$(sed -n 's/^  address: "\(.*\)",$/\1/p' "$DIND_TS")"
assert_eq "its image, pinned by digest" \
  "$(sed -n 's/^MIRROR_IMAGE=//p' "$SCRIPT")" "$(sed -n 's/^  image: "\(.*\)",$/\1/p' "$DIND_TS")"
assert_contains "the image is a digest" "$(sed -n 's/^MIRROR_IMAGE=//p' "$SCRIPT")" "@sha256:"
assert_contains "it listens on the dind's loopback alone" "$(cat "$SCRIPT")" '-p "$MIRROR_ADDRESS:5000"'

group "a base's name in the mirror"
eval "$(sed -n '/^mirror_path() {/,/^}/p' "$SCRIPT")"
path_of() { mirror_path "$1" || echo "(none)"; }
assert_eq "a library image"           "$(path_of node:22)" "library/node:22"
assert_eq "spelled with docker.io"    "$(path_of docker.io/library/node:22-slim)" "library/node:22-slim"
assert_eq "an owner's image, no tag"  "$(path_of owner/img)" "owner/img:latest"
assert_eq "an owner's image, tagged"  "$(path_of owner/img:1.2)" "owner/img:1.2"
assert_eq "another registry: none"    "$(path_of ghcr.io/x/y:1)" "(none)"
assert_eq "a local registry: none"    "$(path_of localhost:5000/a)" "(none)"
assert_eq "by digest: none"           "$(path_of node@sha256:abc)" "(none)"
assert_eq "a name that is no name: none" "$(path_of 'evil;x')" "(none)"
assert_eq "nor one with a substitution in it" "$(path_of 'a$(x)')" "(none)"

summary
