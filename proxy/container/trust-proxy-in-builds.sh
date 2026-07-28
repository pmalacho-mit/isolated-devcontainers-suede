#!/bin/sh
# trust-proxy-in-builds.sh -- let `docker build` reach the internet from inside
# a devcontainer, by giving a base image the egress proxy's CA and pointing a
# compose service's build at it.
#
# Sibling of install-ca.sh, which trusts the proxy in the container you are
# standing in. This one trusts it in the containers your BUILDS run in.
#
# Usage, from your own terminal inside the devcontainer:
#
#   /desolate-ca/trust-proxy-in-builds.sh --service api --image python:3.12-slim
#   /desolate-ca/trust-proxy-in-builds.sh --image node:22-slim   # derive only
#   /desolate-ca/trust-proxy-in-builds.sh --service api --image python:3.12-slim \
#       --compose ./deploy/compose.yml
#
#   --force         rebuild even if the derived image already trusts this CA
#   --print-recipe  show the Dockerfile that WOULD be used, then stop
#   --no-gitignore  do not add the override file to .gitignore
#
# WHY THIS IS NEEDED
#
# All container egress is redirected through an intercepting proxy, which
# presents certificates signed by a private CA. A container trusts CAs from its
# own image's filesystem -- so a stock base image does not trust the proxy, and
# anything it fetches over HTTPS during `docker build` fails:
#
#   fatal: unable to access 'https://...': SSL certificate problem:
#          unable to get local issuer certificate
#
# This builds a thin derivative of the base with the CA installed, then points
# the service's build at it via BuildKit's named build contexts, which override
# the image an existing `FROM` resolves to. Your Dockerfile is never modified,
# and the override file is a development artifact that must not reach
# production -- it is gitignored by default.
set -eu

CA_DIR=/desolate-ca
CA_PEM="$CA_DIR/ca.pem"
TAG_PREFIX=desolate-ca
MARKER='# managed by /desolate-ca/trust-proxy-in-builds.sh'

IMAGE=""
SERVICE=""
COMPOSE=""
NO_GITIGNORE=0
FORCE=0
PRINT_ONLY=0

die() { echo "trust-proxy: $*" >&2; exit 1; }

usage() {
    # Anchored on the WHY marker, not a line range. A hardcoded range silently
    # truncates the moment the header grows -- which it just did, dropping
    # --no-gitignore from --help without any sign that it had.
    sed -n '2,/^# WHY THIS IS NEEDED/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --image)        IMAGE="${2:-}"; shift 2 || die "--image needs a value" ;;
        --service)      SERVICE="${2:-}"; shift 2 || die "--service needs a value" ;;
        --compose)      COMPOSE="${2:-}"; shift 2 || die "--compose needs a value" ;;
        --no-gitignore) NO_GITIGNORE=1; shift ;;
        --force)        FORCE=1; shift ;;
        --print-recipe) PRINT_ONLY=1; FORCE=1; shift ;;
        -h|--help)      usage 0 ;;
        *)              die "unknown option '$1' (try --help)" ;;
    esac
done

[ -n "$IMAGE" ] || die "--image is required (try --help)"

# ---------------------------------------------------------------------------
# Preconditions -- each failure names what to do about it.
# ---------------------------------------------------------------------------
[ -f "$CA_PEM" ] || die "no CA at $CA_PEM.
       This container has no proxy CA mounted, which means either the egress
       proxy is not installed in the VM, or this project was not started by
       desolate. Nothing to derive against."

command -v docker >/dev/null 2>&1 || die "no docker CLI in this container.
       Deriving a base image needs a daemon of your own -- add the
       docker-in-docker feature to devcontainer.json:
         \"features\": { \"ghcr.io/devcontainers/features/docker-in-docker:2\": {} }"

docker info >/dev/null 2>&1 || die "the docker CLI is here but no daemon answers.
       The docker-in-docker feature starts one with the container; if you just
       added it, rebuild:  desolate --rebuild <project>"

# ---------------------------------------------------------------------------
# CA fingerprint. The derived image is TAGGED by a readable name (so it can be
# written into compose by hand) rather than by a content hash -- which means the
# tag alone cannot tell us whether it trusts the CURRENT CA. Regenerate the CA
# and a stale derivative would sit there under the right name trusting a cert
# that no longer exists. The fingerprint goes in a label instead, and is checked
# below, so the name stays readable AND the image self-invalidates.
# ---------------------------------------------------------------------------
ca_fingerprint() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$CA_PEM" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$CA_PEM" | cut -d' ' -f1
    elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$CA_PEM" | awk '{print $NF}'
    else
        # NOT a fallback value. A constant here would make every derived image
        # compare equal forever, so regenerating the CA would silently reuse an
        # image trusting the old one -- the exact staleness the fingerprint
        # exists to prevent, now invisible. Refuse instead.
        die "no sha256 tool in this image (need sha256sum, shasum or openssl).
       The derived image is keyed on the CA's fingerprint so it rebuilds when
       the CA changes; without a hash there is no safe way to detect that."
    fi
}
FINGERPRINT=$(ca_fingerprint)
TAG="$TAG_PREFIX/$IMAGE"

# ---------------------------------------------------------------------------
# Derive
# ---------------------------------------------------------------------------
existing_fp=$(docker image inspect --format '{{ index .Config.Labels "desolate.ca.fingerprint" }}' \
                "$TAG" 2>/dev/null || true)

if [ "$FORCE" = 0 ] && [ -n "$existing_fp" ] && [ "$existing_fp" = "$FINGERPRINT" ]; then
    echo "trust-proxy: $TAG already trusts the current CA (skipping build)"
else
    [ -n "$existing_fp" ] && [ "$existing_fp" != "$FINGERPRINT" ] && \
        echo "trust-proxy: $TAG trusts a DIFFERENT CA -- rebuilding"

    # The base must be local before its USER can be read.
    docker image inspect "$IMAGE" >/dev/null 2>&1 || {
        echo "trust-proxy: pulling $IMAGE ..."
        docker pull "$IMAGE" >/dev/null || die "could not pull $IMAGE"
    }
    # Root is needed to run the CA tool, but the base image's own user must be
    # restored -- tooling downstream depends on it.
    BASE_USER=$(docker image inspect --format '{{.Config.User}}' "$IMAGE" 2>/dev/null || true)
    [ -n "$BASE_USER" ] || BASE_USER=root

    # The recipe is BUILT INTO A VARIABLE and printed before it runs. This
    # script modifies the images your code is built from, on your behalf, and
    # "trust us, we added a certificate" is not something a developer should
    # have to take on faith. What you see below is the whole of it -- there is
    # no second file and no hidden step.
    # Many toolchains ignore the system trust store and carry their own bundle --
    # Python/httpx and pip use certifi, node has its own, cargo has its own. The
    # system store alone therefore fixes curl and git while leaving a FastAPI app
    # failing with CERTIFICATE_VERIFY_FAILED. install-ca.sh writes these same vars
    # to /etc/profile.d, but that is sourced only by LOGIN shells -- a container
    # that execs uvicorn never sees them. As image ENV they apply to every process.
    # 
    # All point at the SYSTEM BUNDLE, which now contains the proxy CA plus every
    # public root. That matters: pointing them at the bare proxy cert would trust
    # only it, and is also why these are harmless outside desolate -- the path is
    # the standard Debian/Alpine bundle either way.
    # Both cert locations are written so one recipe covers Debian/Ubuntu/Alpine
    # (update-ca-certificates) and RHEL-family (update-ca-trust). A base with
    # neither tool fails the build loudly: an image that cannot be taught to
    # trust the proxy cannot build anything over HTTPS, and saying so here is
    # far cheaper than an x509 error deep inside a package install.
    DOCKERFILE=$(
        echo "FROM $IMAGE"
        echo "USER root"
        echo "COPY ca.pem /usr/local/share/ca-certificates/desolate-proxy.crt"
        echo "COPY ca.pem /etc/pki/ca-trust/source/anchors/desolate-proxy.crt"
        echo "RUN set -eu; \\"
        echo "    if command -v update-ca-certificates >/dev/null 2>&1; then update-ca-certificates; \\"
        echo "    elif command -v update-ca-trust >/dev/null 2>&1; then update-ca-trust extract; \\"
        echo "    else echo 'trust-proxy: $IMAGE has neither update-ca-certificates nor update-ca-trust;' >&2; \\"
        echo "         echo '         install the ca-certificates package in it first.' >&2; \\"
        echo "         exit 1; fi"
        echo "ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
        echo "ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt"
        echo "ENV CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt"
        echo "ENV GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt"
        echo "ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/desolate-proxy.crt"
        echo "LABEL desolate.ca.fingerprint=$FINGERPRINT"
        echo "USER $BASE_USER"
    )

    echo
    echo "trust-proxy: deriving $TAG"
    echo "             from $IMAGE, using exactly this and nothing else:"
    echo
    printf '%s\n' "$DOCKERFILE" | sed 's/^/    | /'
    echo
    echo "             build context: $CA_DIR  (contains only the public CA cert)"
    echo

    [ "$PRINT_ONLY" = 1 ] && { echo "trust-proxy: --print-recipe given; nothing was built."; exit 0; }

    printf '%s\n' "$DOCKERFILE" | docker build -t "$TAG" -f - "$CA_DIR" >/dev/null \
        || die "could not derive $TAG from $IMAGE (see the build output above)"
    echo "trust-proxy: built $TAG"
fi

CONTEXT_ENTRY="$IMAGE=docker-image://$TAG"

if [ -z "$SERVICE" ]; then
    cat <<EOF

Built only -- no --service given, so nothing was wired up. Add this yourself:

services:
  <service>:
    build:
      additional_contexts:
        - "$CONTEXT_ENTRY"

Or re-run with:  $0 --service <name> --image $IMAGE
EOF
    exit 0
fi

# ---------------------------------------------------------------------------
# Locate the compose file. Compose's own precedence order.
# ---------------------------------------------------------------------------
if [ -n "$COMPOSE" ]; then
    [ -f "$COMPOSE" ] || die "no such compose file: $COMPOSE"
    BASE_FILE="$COMPOSE"
else
    BASE_FILE=""
    for f in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
        [ -f "./$f" ] && { BASE_FILE="./$f"; break; }
    done
    [ -n "$BASE_FILE" ] || die "no compose file in $(pwd).
       Run this from the directory holding it, or pass --compose <file>."
fi

DIR=$(dirname "$BASE_FILE")
NAME=$(basename "$BASE_FILE")
STEM=${NAME%.*}
EXT=${NAME##*.}
# The override name must match the base name, or compose will not auto-load it.
OVERRIDE="$DIR/$STEM.override.$EXT"

# ---------------------------------------------------------------------------
# Merge. This script OWNS the override file: it regenerates it wholesale from
# the entries it can read back, which is only safe because it wrote them. A file
# without our marker was written by a human and is not ours to rewrite, so we
# refuse rather than silently destroying hand-written dev settings.
# ---------------------------------------------------------------------------
if [ -f "$OVERRIDE" ] && ! grep -qF "$MARKER" "$OVERRIDE"; then
    cat >&2 <<EOF
trust-proxy: $OVERRIDE exists but was not generated by this script, so it will not
         be rewritten. Add this to it by hand:

services:
  $SERVICE:
    build:
      additional_contexts:
        - "$CONTEXT_ENTRY"
EOF
    exit 1
fi

PAIRS=$(
    if [ -f "$OVERRIDE" ]; then
        awk '
            /^  [^ ].*:$/            { svc=$0; sub(/^  /,"",svc); sub(/:$/,"",svc); next }
            /^        - "/           {
                e=$0; sub(/^        - "/,"",e); sub(/"$/,"",e)
                i=index(e,"=")
                if (i>0 && svc!="") print svc "\t" substr(e,1,i-1)
            }
        ' "$OVERRIDE"
    fi
    printf '%s\t%s\n' "$SERVICE" "$IMAGE"
)

TMP="$OVERRIDE.tmp.$$"
trap 'rm -f "$TMP"' EXIT INT TERM

{
    cat <<EOF
$MARKER
#
# DEVELOPMENT ARTIFACT -- do not deploy this file.
#
# Compose auto-merges it beside $NAME, so \`docker compose up --build\` picks it
# up here and nowhere else. It redirects each service's base image to a
# derivative that trusts the desolate egress proxy's CA, because every build
# step's HTTPS traffic is intercepted and a stock base image does not trust the
# interceptor. Your Dockerfile is unchanged and stays production-clean.
#
# In production this file is absent, \`FROM\` resolves to the real upstream
# image, and nothing here applies. If it DOES reach production, builds fail --
# the desolate-ca/* images exist only inside this devcontainer.
#
# Regenerate after adding a service or base image:
#   $0 --service <name> --image <image>
EOF
    printf '%s\n' "$PAIRS" | sort -u | awk -F'\t' '
        BEGIN { print "" ; print "services:" }
        $1 != cur { cur=$1; printf "  %s:\n    build:\n      additional_contexts:\n", cur }
        { printf "        - \"%s=docker-image://'"$TAG_PREFIX"'/%s\"\n", $2, $2 }
    '
} > "$TMP"

mv "$TMP" "$OVERRIDE"
trap - EXIT INT TERM
echo "trust-proxy: wired $SERVICE -> $TAG in $OVERRIDE"

# ---------------------------------------------------------------------------
# Keep it out of git. It is a development artifact and it BREAKS production if
# it ships, so the default is to ignore it rather than trust everyone to notice.
# ---------------------------------------------------------------------------
if [ "$NO_GITIGNORE" = 0 ]; then
    GI="$DIR/.gitignore"
    ENTRY=$(basename "$OVERRIDE")
    if [ ! -f "$GI" ] || ! grep -qxF "$ENTRY" "$GI"; then
        printf '%s\n' "$ENTRY" >> "$GI"
        echo "trust-proxy: added $ENTRY to $GI"
    fi
fi

cat <<EOF

Done. Build it:
    cd $DIR && docker compose build $SERVICE

Note: do NOT pass --pull. It makes BuildKit try to fetch $TAG from a registry,
where it does not exist, and the build fails with "pull access denied".
EOF
