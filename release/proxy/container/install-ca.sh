#!/bin/sh
# Install the desolate-proxy CA into this container's trust stores.
# POSIX sh (not bash) so it also runs in Alpine images like docker:dind.
# Run as ROOT: image build, dind entrypoint, or `docker exec -u 0`.
#
# CA source, in order of preference:
#   1. /desolate-ca/ca.pem   -- bind-mount chain (how desolate does it)
#   2. $DESOLATE_CA_URL      -- http://<vm-bridge-gw>:18081/ca.pem
set -eu

SRC=""
if [ -f /desolate-ca/ca.pem ]; then
    SRC=/desolate-ca/ca.pem
elif [ -n "${DESOLATE_CA_URL:-}" ]; then
    command -v curl >/dev/null 2>&1 || {
        echo "desolate-ca: DESOLATE_CA_URL is set but this image has no curl" >&2
        exit 1
    }
    curl -fsS "$DESOLATE_CA_URL" -o /tmp/desolate-ca.pem
    SRC=/tmp/desolate-ca.pem
else
    echo "desolate-ca: no /desolate-ca/ca.pem mount and no DESOLATE_CA_URL set" >&2
    exit 1
fi

# System store (curl, python, go, apt/apk, and any inner docker daemon).
#
# The directory is CREATED, not required. It used to be a precondition
# (`[ -d ... ] && ...`), which meant that on an image where it did not exist --
# some Alpine bases, and dind is Alpine -- the whole branch was skipped and
# nothing was installed, while the script still printed "installed" at the end.
# The dind entrypoint sends this to /dev/null, so the result was a daemon that
# silently did not trust the proxy and failed every pull with an opaque x509
# error. Having the TOOL is the real precondition.
INSTALLED=0
if command -v update-ca-certificates >/dev/null 2>&1; then
    mkdir -p /usr/local/share/ca-certificates
    cp "$SRC" /usr/local/share/ca-certificates/desolate-proxy.crt
    chmod 0644 /usr/local/share/ca-certificates/desolate-proxy.crt
    if update-ca-certificates >/dev/null 2>&1; then
        INSTALLED=1
    else
        echo "desolate-ca: update-ca-certificates failed" >&2
    fi
fi

# Runtimes that ignore the system store and carry their own CA bundle --
# Python/httpx and pip (certifi), node, cargo. The system store above does
# nothing for them.
#
# LIMITATION: /etc/profile.d is sourced only by LOGIN SHELLS. It covers an
# interactive terminal and nothing else -- a container that execs a server
# (uvicorn, gunicorn, node) never sources it, and will still fail with
# CERTIFICATE_VERIFY_FAILED despite the store above being correct. That is why
# the derived base images set these same variables as image ENV, which applies
# to every process: see trust-proxy-in-builds.sh, the sibling of this script.
if [ -d /etc/profile.d ]; then
  cat > /etc/profile.d/desolate-ca.sh <<'EOF'
export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/desolate-proxy.crt
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt
EOF
fi

# Java, if present.
if command -v keytool >/dev/null 2>&1; then
    keytool -importcert -trustcacerts -noprompt -cacerts \
        -storepass changeit -alias desolate-proxy -file "$SRC" >/dev/null 2>&1 || true
fi

if [ "$INSTALLED" = 1 ]; then
    echo "desolate-ca: installed"
else
    # Loudly, and non-zero. Claiming success here is worse than failing: the
    # caller carries on, the daemon or toolchain does not trust the proxy, and
    # the first symptom is an x509 error from something that never mentions CAs.
    cat >&2 <<'EOF'
desolate-ca: FAILED -- no system trust store was updated.
             update-ca-certificates is missing from this image. Install the
             ca-certificates package, or trust /desolate-ca/ca.pem another way;
             every HTTPS request from here will fail certificate verification
             until you do.
EOF
    exit 1
fi
