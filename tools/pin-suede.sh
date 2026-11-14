#!/bin/bash
# Move desolate's pin of suede's upstream (docs/v3/decisions.md, "`desolate upstream`"):
#
#   tools/pin-suede.sh <full commit of pmalacho-mit/suede>
#
# Fetches scripts/upstream.sh (what https://suede.sh/upstream serves) at that commit, writes it
# to release/git/suede-upstream.sh, and sets SUEDE_COMMIT and SUEDE_UPSTREAM_SHA256 in
# release/pins.env. Read the diff before committing it: this is code the git VM will run.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
commit=${1:-}
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: tools/pin-suede.sh <full commit>" >&2; exit 64; }
target="$ROOT/release/git/suede-upstream.sh"
curl -fsSL -o "$target.new" "https://raw.githubusercontent.com/pmalacho-mit/suede/$commit/scripts/upstream.sh"
mv "$target.new" "$target"
sum=$(shasum -a 256 "$target" | cut -d' ' -f1)
sed -i.bak -e "s/^SUEDE_COMMIT=.*/SUEDE_COMMIT=$commit/" -e "s/^SUEDE_UPSTREAM_SHA256=.*/SUEDE_UPSTREAM_SHA256=$sum/" "$ROOT/release/pins.env"
rm -f "$ROOT/release/pins.env.bak"
echo "pinned suede's upstream at $commit (sha256 $sum). Now: update the comment above SUEDE_COMMIT in release/pins.env, read the diff, and run make test."
