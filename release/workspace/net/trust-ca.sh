#!/bin/bash
# Trust this domain's secrets proxy (Phase 4). Run as root in a workspace VM: by start.sh on
# every start, and by the host when the domain gets its first secret. Idempotent.
#
# A domain with secrets has a CA, made in the root and never leaving it; its certificate
# arrives in the inbox, which this VM cannot write. Only connections to the hosts of the
# domain's secrets are ever signed with it (root/proxy/proxy.ts decides, outside this VM):
# trusting it here gives the proxy nothing it could not already do to those connections,
# and gives nothing to anyone else, who does not hold its key.
set -euo pipefail
SRC=/desolate/inbox/ca.pem
DST=/usr/local/share/ca-certificates/desolate-domain.crt
if [ -s "$SRC" ]; then
  if ! cmp -s "$SRC" "$DST" 2>/dev/null; then
    install -m 0644 "$SRC" "$DST"
    update-ca-certificates >/dev/null 2>&1
  fi
  # Tools that do not read the system store by default are pointed at it.
  cat >/etc/profile.d/desolate-ca.sh <<'P'
export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/desolate-domain.crt
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt
P
  echo "domain CA: trusted"
elif [ -e "$DST" ]; then
  rm -f "$DST" /etc/profile.d/desolate-ca.sh
  update-ca-certificates --fresh >/dev/null 2>&1
  echo "domain CA: removed"
fi
