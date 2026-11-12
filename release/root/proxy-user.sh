#!/bin/bash
# A domain's proxies' user, and the two directories that are its domain's and its own.
# Run as root in the root VM, by the host (it asks before a domain's proxies first start).
#   proxy-user.sh <uid of the root's user> <domain>       prints the user's name
#
# Each domain's proxies (proxy.ts for each workspace, mitmproxy for its secrets) run as a
# user of that domain's own, so a bug in one, reached from one domain's workspace, reads that
# domain's secrets and policy and nothing of another's (proxy/as-proxy.ts):
#   /var/lib/desolate-proxies/domains/<domain>  the root's user's, group: the domain's proxies,
#                                               2750. Policy, secret values, the handoff
#                                               token, where the secrets proxy listens.
#   /var/lib/desolate-proxies/out/<domain>      the domain's proxies', group: the root's user's,
#                                               2750. Their audit log and the domain's CA.
# Every directory on the way is root's, so nothing can be planted where these are made.
set -euo pipefail
USER_UID=${1:?usage: proxy-user.sh <uid> <domain>}
DOMAIN=${2:?usage: proxy-user.sh <uid> <domain>}
# A domain's name is a slug (shared/names.ts): checked again here, before it is a path.
[[ $DOMAIN =~ ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$ ]] && [[ $DOMAIN != *--* ]] || { echo "proxy-user.sh: '$DOMAIN' is not a domain name" >&2; exit 2; }
USER_NAME=$(getent passwd "$USER_UID" | cut -d: -f1)
USER_GROUP=$(id -gn "$USER_NAME")
NAME="dsp-$(printf '%s' "$DOMAIN" | sha256sum | cut -c1-10)"
getent group desolate-proxies >/dev/null || groupadd --system desolate-proxies
if ! id "$NAME" >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --shell /usr/sbin/nologin --comment "desolate proxies of the domain $DOMAIN" -G desolate-proxies "$NAME"
fi
P=/var/lib/desolate-proxies
install -d -m 0755 -o root -g root "$P" "$P/domains" "$P/out"
install -d -m 2750 -o "$USER_NAME" -g "$NAME" "$P/domains/$DOMAIN"
install -d -m 2750 -o "$NAME" -g "$USER_GROUP" "$P/out/$DOMAIN"
echo "$NAME"
