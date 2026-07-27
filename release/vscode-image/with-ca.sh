#!/bin/sh
# Trust the desolate-proxy CA without root: concatenate it onto the system bundle
# in a writable location and point the usual env vars there, then exec the real
# command. No-op when /desolate-ca is not mounted (proxy not installed yet).
set -eu
BUNDLE=/tmp/desolate-ca-bundle.pem
if [ -f /desolate-ca/ca.pem ]; then
    cat /etc/ssl/certs/ca-certificates.crt /desolate-ca/ca.pem > "$BUNDLE" 2>/dev/null || \
        cp /desolate-ca/ca.pem "$BUNDLE"
    export SSL_CERT_FILE="$BUNDLE"
    export REQUESTS_CA_BUNDLE="$BUNDLE"
    export CURL_CA_BUNDLE="$BUNDLE"
    export GIT_SSL_CAINFO="$BUNDLE"
    export NODE_EXTRA_CA_CERTS=/desolate-ca/ca.pem
fi
exec "$@"
