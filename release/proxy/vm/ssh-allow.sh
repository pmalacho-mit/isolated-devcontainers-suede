#!/bin/sh
# ssh-allow.sh -- fill the git-over-SSH allowlist from GitHub's published ranges.
#
# Runs in the VM: at install time, and again from desolate-nft.service after any
# ruleset reload (a reload does `delete table`, which empties the sets).
#
# WHY NOT DNS
#
# These sets used to be filled by dnsmasq's `nftset=` directive, keyed on
# hostname. That never worked, for four independent reasons, each invisible:
#
#   1. dnsmasq started before the table it writes into existed.
#   2. a ruleset reload emptied the sets, and dnsmasq only writes on a cache
#      MISS -- so they stayed empty until every cached name expired.
#   3. the sets carried `flags interval`; dnsmasq adds bare addresses, which an
#      interval set rejects.
#   4. and the one that cannot be patched: containers resolve through Docker's
#      embedded DNS at 127.0.0.11, which forwards upstream from a path the
#      `iifname br-desolate` redirect never sees. dnsmasq therefore never
#      observes the lookups that matter. Verified directly -- a query aimed at
#      1.1.1.1:53 is intercepted and logged, the same name via getent is not.
#
# Every one of those presented as `ssh: connect to github.com port 22:
# Connection timed out`, with DNS working perfectly and a correct-looking
# config. So the allowlist is now a fact fetched at install time rather than a
# side effect of name resolution: no caches, no ordering, no timeouts.
#
# The trade: these are CIDRs, so the allowlist is coarser than one IP per
# resolved name, and it needs a re-run when GitHub rotates ranges (rare, and
# `cli.sh vm install` does it).
set -eu

URL=https://api.github.com/meta
CACHE=/etc/desolate-proxy/github-git-ranges.json
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT INT TERM

command -v jq >/dev/null 2>&1 || { echo "ssh-allow: jq is required" >&2; exit 1; }
command -v nft >/dev/null 2>&1 || { echo "ssh-allow: nft is required" >&2; exit 1; }

# Fetch, falling back to the last good copy. A stale allowlist still works;
# an empty one silently breaks every clone and push.
if curl -fsS --max-time 15 "$URL" -o "$TMP" 2>/dev/null && jq -e '.git|length > 0' "$TMP" >/dev/null 2>&1; then
    install -m 0644 "$TMP" "$CACHE"
    echo "    fetched GitHub's git ranges ($(jq -r '.git|length' "$CACHE") entries)"
elif [ -f "$CACHE" ]; then
    echo "    WARNING: could not reach $URL; using the cached copy from $CACHE" >&2
else
    cat >&2 <<EOF
    ERROR: could not fetch $URL and no cached copy exists.

    The git-over-SSH allowlist would be empty, which means every clone and push
    over SSH fails with a bare connection timeout. Refusing to leave it that
    way silently. Retry with network, or add ranges by hand:
      sudo nft add element inet desolate ssh_allow_v4 { 140.82.112.0/20 }
EOF
    exit 1
fi

# The table must exist -- desolate-nft loads it, and this runs after that.
nft list table inet desolate >/dev/null 2>&1 || {
    echo "ssh-allow: the 'inet desolate' table is not loaded; run desolate-nft first" >&2
    exit 1
}

add_all() {   # add_all <set> <jq filter>
    set_name=$1; filter=$2
    elems=$(jq -r "$filter" "$CACHE" | paste -sd, -)
    [ -n "$elems" ] || { echo "    NOTE: no $set_name entries in the published data" >&2; return 0; }
    nft flush set inet desolate "$set_name"
    nft add element inet desolate "$set_name" "{ $elems }"
    echo "    $set_name: $(jq -r "$filter" "$CACHE" | wc -l | tr -d ' ') ranges"
}

add_all ssh_allow_v4 '.git[] | select(contains(":") | not)'
add_all ssh_allow_v6 '.git[] | select(contains(":"))'

# Assert rather than assume: an empty set here is a silently broken git.
#
# Plain `nft list`, NOT `nft -j | jq`. The jq version of this check was itself
# broken -- `.elem?//empty` parses as jq's `?//` destructuring-alternative
# operator, so the whole expression was a syntax error and the assertion could
# never run. `nft list set` prints `elements = { ... }` only when the set is
# non-empty, which is the entire question, with no second language involved.
if ! nft list set inet desolate ssh_allow_v4 | grep -q 'elements'; then
    echo "ssh-allow: ssh_allow_v4 is still empty after loading -- git over SSH will" >&2
    echo "           time out with no other symptom. Refusing to report success." >&2
    exit 1
fi
