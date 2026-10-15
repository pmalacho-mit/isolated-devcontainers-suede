#!/bin/sh
# trust-proxy-in-builds.sh -- let `docker build` reach the internet from inside
# a devcontainer, by giving a base image the egress proxy's CA and pointing your
# builds at it.
#
# Sibling of install-ca.sh, which trusts the proxy in the container you are
# standing in. This one trusts it in the containers your BUILDS run in.
#
# Usage, from your own terminal inside the devcontainer:
#
#   /desolate-ca/trust-proxy-in-builds.sh --service api --image python:3.12-slim
#   /desolate-ca/trust-proxy-in-builds.sh --image node:22-slim --shadow
#   /desolate-ca/trust-proxy-in-builds.sh --image node:22-slim   # derive only
#   /desolate-ca/trust-proxy-in-builds.sh --service api --image python:3.12-slim \
#       --compose ./deploy/compose.yml
#
#   --shadow        also point the base image's OWN tag at the derivative, so
#                   `FROM <image>` in this daemon resolves to it. Covers the
#                   classic builder and `docker build`/`docker compose build`;
#                   does NOT cover a build posted to the Engine API asking for
#                   BuildKit (version=2), which resolves the tag at the registry
#                   and never looks here -- the run itself says so, and says
#                   what to do instead. Not with --service.
#   --unshadow      undo that: put the upstream image back under its own tag.
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
# Not always that fast, and not always that clear: npm and pip retry with
# backoff first, so the symptom is a 60-90 second HANG and only then an error.
# A build step that seems to stall on a package install is this, not a slow
# registry.
#
# This builds a thin derivative of the base with the CA installed, then delivers
# it one of two ways. By default, via BuildKit's named build contexts, which
# override the image an existing `FROM` resolves to: your Dockerfile is never
# modified, and the override file is a development artifact that must not reach
# production -- it is gitignored by default. With --shadow, by retagging the
# base in this daemon, for a builder that cannot take a build context at all.
#
# WHAT --shadow DOES NOT COVER
#
# A local tag only wins where the builder ASKS the local image store first.
# Three builders, two answers:
#
#   docker build / docker compose build  -- shadow wins. The CLI asks BuildKit
#                                           to prefer a local image.
#   POST /build?version=1 (classic)      -- shadow wins. The classic builder
#                                           only ever reads the local store.
#   POST /build?version=2 (BuildKit)     -- shadow LOSES. This path does not
#                                           ask for local-first, so BuildKit
#                                           resolves the tag at the registry
#                                           and pins `FROM ...@sha256:<their
#                                           digest>`. Retagging here changes
#                                           nothing it looks at.
#
# The last one is an SDK's default in some clients (dockerode with
# version: "2", and anything wrapping it). Nothing in the build output says the
# shadow was skipped: you get the pristine base, a long download of an image
# you already have a derivative of, and then the certificate failure above --
# which is a HANG first and an error much later, if at all.
#
# Two things do work there, and both are printed after a --shadow run: build
# FROM the derivative's own tag (desolate-ca/<image>, which exists in no
# registry, so BuildKit falls back to this store), or ask that build for the
# classic builder instead.
#
# What does NOT fix this, and is the obvious thing to reach for: a CA in the
# daemon's buildkitd.toml. That configures BuildKit's own REGISTRY client -- how
# it pulls images -- and has no effect on the HTTPS traffic your RUN steps make.
# Nor do the daemon's registry-mirrors: `docker pull` honours them, and the
# BuildKit inside the same daemon ignores them, so a mirror serving derivatives
# cannot stand in for the shadow either.
set -eu

CA_DIR=/desolate-ca
CA_PEM="$CA_DIR/ca.pem"
TAG_PREFIX=desolate-ca
MARKER='# managed by /desolate-ca/trust-proxy-in-builds.sh'
FINGERPRINT_LABEL=desolate.ca.fingerprint
BASE_LABEL=desolate.ca.shadowed-from

IMAGE=""
SERVICE=""
COMPOSE=""
NO_GITIGNORE=0
FORCE=0
PRINT_ONLY=0
SHADOW=0
UNSHADOW=0

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
        --shadow)       SHADOW=1; shift ;;
        --unshadow)     UNSHADOW=1; shift ;;
        -h|--help)      usage 0 ;;
        *)              die "unknown option '$1' (try --help)" ;;
    esac
done

[ -n "$IMAGE" ] || die "--image is required (try --help)"

# --shadow and --service are two DELIVERY mechanisms for the same derivative,
# and doing both silently is worse than either: the override file says the build
# is redirected, the tag says it does not need to be, and removing one leaves a
# build that still works for a reason nobody can see.
[ "$SHADOW" = 1 ] && [ -n "$SERVICE" ] && \
    die "--shadow and --service are alternatives, not a pair.
       --service redirects ONE compose service's build via an override file.
       --shadow redirects EVERY build in this daemon that says 'FROM $IMAGE',
       which is what you want when the builder cannot take a build context.
       Pick one."

[ "$SHADOW" = 1 ] && [ "$UNSHADOW" = 1 ] && die "--shadow and --unshadow are opposites"

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
# Reading an image back.
#
# `index .Config.Labels "x"` prints the literal string `<no value>` when the
# image carries no labels at all, so every caller that treats a non-empty answer
# as "this is one of ours" has to normalise it first -- otherwise every stock
# base image looks labelled.
# ---------------------------------------------------------------------------
image_label() {
    value=$(docker image inspect --format "{{ index .Config.Labels \"$2\" }}" "$1" 2>/dev/null || true)
    if [ "$value" = "<no value>" ]; then value=""; fi
    printf '%s' "$value"
}

is_local() { docker image inspect "$1" >/dev/null 2>&1; }

# The repository half of a reference: `node:22-slim` -> `node`, and
# `ghcr.io/o/r@sha256:..` -> `ghcr.io/o/r`. A tag is only a tag when the colon is
# in the LAST path segment -- `localhost:5000/img` is a host and a port.
image_repo() {
    ref=${1%%@*}
    case "${ref##*/}" in
        *:*) ref=${ref%:*} ;;
    esac
    printf '%s' "$ref"
}

# The registry digest a local image was pulled under, in $2's repository. ""
# for an image that was built here and never pushed.
#
# The repository is a PARAMETER rather than being read off $1, because the image
# asked about is not always named after the repository wanted: the pristine copy
# is a tag of ours (`desolate-ca/pristine/node:...`) over an image that came from
# `node`, and matching on its own name would find nothing every time.
repo_digest() {
    docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$1" 2>/dev/null \
        | awk -v repo="$2" -F@ '$1 == repo { print; exit }'
}

TAG="$TAG_PREFIX/$IMAGE"
IMAGE_REPO=$(image_repo "$IMAGE")
# A tag WE own that keeps pointing at the pristine base after --shadow has
# overwritten the base's own tag. It is the only reference to the untouched
# image that survives the retag, so it is also what --unshadow restores from --
# no network, no registry, no guessing.
PRISTINE_ALIAS="$TAG_PREFIX/pristine/$IMAGE"

# ---------------------------------------------------------------------------
# --unshadow: give the tag back.
#
# Shipped with --shadow rather than after it, because shadowing is the one thing
# this script does that escapes both the desolate-ca/* namespace and the
# gitignored override file: it mutates a tag the user did not opt into per
# build. An undo is what makes that honest.
# ---------------------------------------------------------------------------
if [ "$UNSHADOW" = 1 ]; then
    if [ -z "$(image_label "$IMAGE" "$FINGERPRINT_LABEL")" ]; then
        echo "trust-proxy: $IMAGE is not shadowed (nothing to undo)."
        exit 0
    fi

    if is_local "$PRISTINE_ALIAS"; then
        docker tag "$PRISTINE_ALIAS" "$IMAGE" || die "could not retag $PRISTINE_ALIAS as $IMAGE"
        docker rmi "$PRISTINE_ALIAS" >/dev/null 2>&1 || true
        echo "trust-proxy: $IMAGE restored from the pristine copy kept here"
    else
        # The alias is gone (pruned, or the shadow predates it). The digest
        # recorded on the derivative is the second way back, and it needs the
        # network.
        RECORDED=$(image_label "$IMAGE" "$BASE_LABEL")
        case "$RECORDED" in
            *@sha256:*) ;;
            *) die "$IMAGE is shadowed, but neither $PRISTINE_ALIAS nor a recorded
       registry digest is available to restore from. Pull it yourself:
         docker pull $IMAGE" ;;
        esac
        echo "trust-proxy: pulling $RECORDED ..."
        docker pull "$RECORDED" >/dev/null || die "could not pull $RECORDED"
        docker tag "$RECORDED" "$IMAGE" || die "could not retag $RECORDED as $IMAGE"
        echo "trust-proxy: $IMAGE restored from $RECORDED"
    fi

    cat <<EOF

Builds that say \`FROM $IMAGE\` now get the upstream image again, which does not
trust the proxy CA -- so anything they fetch over HTTPS fails (as a hang, then a
certificate error). $TAG is untouched and still available.
EOF
    exit 0
fi

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

# ---------------------------------------------------------------------------
# Derive
# ---------------------------------------------------------------------------
existing_fp=$(image_label "$TAG" "$FINGERPRINT_LABEL")

if [ "$FORCE" = 0 ] && [ -n "$existing_fp" ] && [ "$existing_fp" = "$FINGERPRINT" ]; then
    echo "trust-proxy: $TAG already trusts the current CA (skipping build)"
else
    [ -n "$existing_fp" ] && [ "$existing_fp" != "$FINGERPRINT" ] && \
        echo "trust-proxy: $TAG trusts a DIFFERENT CA -- rebuilding"

    # -----------------------------------------------------------------------
    # What to build FROM.
    #
    # Once $IMAGE has been shadowed its tag names OUR derivative, so a rebuild
    # that resolves the tag would derive from the derived: --force would stack a
    # second CA layer, and a CA rotation would bake both the old certificate and
    # the new one into the result. Neither is fatal -- the old CA is inert -- but
    # it is layer creep for no reason, and it compounds every run.
    #
    # So the pristine image is pinned, in the order it can be trusted: the alias
    # we kept when we shadowed, then the registry digest recorded on the
    # derivative, then the tag itself (which is only the base's when nothing has
    # been shadowed yet). PRISTINE_DIGEST is carried forward from the existing
    # derivative when there is one, so the record survives re-derivation.
    # -----------------------------------------------------------------------
    PRISTINE_DIGEST=""
    if is_local "$PRISTINE_ALIAS"; then
        BASE_REF="$PRISTINE_ALIAS"
        PRISTINE_DIGEST=$(image_label "$TAG" "$BASE_LABEL")
        [ -n "$PRISTINE_DIGEST" ] || PRISTINE_DIGEST=$(repo_digest "$PRISTINE_ALIAS" "$IMAGE_REPO")
    elif [ -n "$(image_label "$IMAGE" "$FINGERPRINT_LABEL")" ]; then
        # Shadowed, with no pristine copy left here: the recorded digest is the
        # only way back to the base, and it has to come over the network.
        PRISTINE_DIGEST=$(image_label "$IMAGE" "$BASE_LABEL")
        case "$PRISTINE_DIGEST" in
            *@sha256:*) ;;
            *) die "$IMAGE is already a desolate-ca derivative (it is shadowed), and
       nothing here records which image it was derived from, so re-deriving
       would build a CA layer on top of a CA layer. Put the base back first:
         docker pull $IMAGE" ;;
        esac
        BASE_REF="$PRISTINE_DIGEST"
        is_local "$BASE_REF" || {
            echo "trust-proxy: pulling $BASE_REF ..."
            docker pull "$BASE_REF" >/dev/null || die "could not pull $BASE_REF"
        }
    else
        # The base must be local before its USER can be read.
        is_local "$IMAGE" || {
            echo "trust-proxy: pulling $IMAGE ..."
            docker pull "$IMAGE" >/dev/null || die "could not pull $IMAGE"
        }
        PRISTINE_DIGEST=$(repo_digest "$IMAGE" "$IMAGE_REPO")
        # Build from the digest when there is one, so the layer is reproducible
        # and so the tag being reassigned underneath us later cannot change what
        # was built. An image built locally has no registry digest; its tag is
        # all there is.
        BASE_REF="${PRISTINE_DIGEST:-$IMAGE}"
    fi

    # Root is needed to run the CA tool, but the base image's own user must be
    # restored -- tooling downstream depends on it.
    BASE_USER=$(docker image inspect --format '{{.Config.User}}' "$BASE_REF" 2>/dev/null || true)
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
    # (update-ca-certificates) and RHEL-family (update-ca-trust).
    #
    # A base with NEITHER tool is the common case, not the exotic one: every
    # Debian -slim image and bare Alpine ship without ca-certificates, and
    # node:*-slim and python:*-slim are most of the world's base images. So when
    # a package manager is present the package is installed here rather than
    # being demanded of the developer. Two things make that possible before any
    # trust exists:
    #
    #   * Debian's default sources are plain HTTP, which the proxy passes
    #     through untouched. Do not "fix" them to HTTPS -- that reintroduces a
    #     chicken-and-egg this branch exists to break.
    #   * Alpine's are HTTPS, and ARE intercepted -- but alpine ships the CA
    #     BUNDLE (ca-certificates-bundle) without the tool that maintains it, so
    #     appending the proxy CA to the bundle first is enough to make apk work.
    #     update-ca-certificates rewrites that file wholesale afterwards, from
    #     /usr/local/share/ca-certificates, so the append leaves no duplicate.
    #     The append is conditional on the bundle already existing: creating one
    #     where the base has none (Debian -slim) buys nothing -- apt does not
    #     need it -- and leaves a half-built trust store for update-ca-certificates
    #     to trip over.
    #
    # An image with no package manager at all -- distroless, scratch -- still
    # fails the build loudly, with the message it always had: an image that
    # cannot be taught to trust the proxy cannot build anything over HTTPS, and
    # saying so here is far cheaper than an x509 error deep inside a package
    # install.
    DOCKERFILE=$(
        echo "FROM $BASE_REF"
        echo "USER root"
        echo "COPY ca.pem /usr/local/share/ca-certificates/desolate-proxy.crt"
        echo "COPY ca.pem /etc/pki/ca-trust/source/anchors/desolate-proxy.crt"
        echo "# no trust tool? install one -- over plain-HTTP apt, or over apk with the"
        echo "# proxy CA appended to the bundle alpine already ships."
        echo "RUN set -eu; \\"
        echo "    if ! command -v update-ca-certificates >/dev/null 2>&1 \\"
        echo "    && ! command -v update-ca-trust >/dev/null 2>&1; then \\"
        echo "        if [ -f /etc/ssl/certs/ca-certificates.crt ]; then \\"
        echo "            cat /usr/local/share/ca-certificates/desolate-proxy.crt >> /etc/ssl/certs/ca-certificates.crt; fi; \\"
        echo "        if   command -v apt-get  >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*; \\"
        echo "        elif command -v apk      >/dev/null 2>&1; then apk add --no-cache ca-certificates; \\"
        echo "        elif command -v microdnf >/dev/null 2>&1; then microdnf install -y ca-certificates; \\"
        echo "        elif command -v dnf      >/dev/null 2>&1; then dnf install -y ca-certificates; \\"
        echo "        elif command -v yum      >/dev/null 2>&1; then yum install -y ca-certificates; \\"
        echo "        else echo 'trust-proxy: $IMAGE has neither update-ca-certificates nor update-ca-trust;' >&2; \\"
        echo "             echo '         install the ca-certificates package in it first.' >&2; \\"
        echo "             exit 1; fi; \\"
        echo "    fi; \\"
        echo "    if command -v update-ca-certificates >/dev/null 2>&1; then update-ca-certificates; \\"
        echo "    elif command -v update-ca-trust >/dev/null 2>&1; then update-ca-trust extract; \\"
        echo "    else echo 'trust-proxy: ca-certificates went in but left no trust tool behind;' >&2; \\"
        echo "         echo '         install it in $IMAGE yourself first.' >&2; \\"
        echo "         exit 1; fi"
        echo "ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
        echo "ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt"
        echo "ENV CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt"
        echo "ENV GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt"
        echo "ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/desolate-proxy.crt"
        echo "LABEL $FINGERPRINT_LABEL=$FINGERPRINT"
        [ -n "$PRISTINE_DIGEST" ] && echo "LABEL $BASE_LABEL=$PRISTINE_DIGEST"
        echo "USER $BASE_USER"
    )

    echo
    echo "trust-proxy: deriving $TAG"
    echo "             from $BASE_REF, using exactly this and nothing else:"
    echo
    printf '%s\n' "$DOCKERFILE" | sed 's/^/    | /'
    echo
    echo "             build context: $CA_DIR  (contains only the public CA cert)"
    echo

    [ "$PRINT_ONLY" = 1 ] && { echo "trust-proxy: --print-recipe given; nothing was built."; exit 0; }

    printf '%s\n' "$DOCKERFILE" | docker build -t "$TAG" -f - "$CA_DIR" >/dev/null \
        || die "could not derive $TAG from $BASE_REF (see the build output above)"
    echo "trust-proxy: built $TAG"

    # Keep the pristine copy reachable BEFORE anything can overwrite its tag.
    # Only under --shadow: nothing else takes the tag away, and an extra name in
    # `docker images` that explains nothing is its own kind of confusing.
    if [ "$SHADOW" = 1 ] && ! is_local "$PRISTINE_ALIAS"; then
        docker tag "$BASE_REF" "$PRISTINE_ALIAS" \
            || die "could not keep a pristine copy of $IMAGE as $PRISTINE_ALIAS"
    fi
fi

# ---------------------------------------------------------------------------
# --shadow: deliver by retagging, for builders that cannot take a build context.
# ---------------------------------------------------------------------------
if [ "$SHADOW" = 1 ]; then
    # The guard above may have skipped the build entirely, in which case the
    # pristine copy was never taken. Take it now, while $IMAGE may still be the
    # base -- if it is already the derivative, there is nothing to preserve and
    # the alias (or the recorded digest) is already what stands in for it.
    if ! is_local "$PRISTINE_ALIAS" && [ -z "$(image_label "$IMAGE" "$FINGERPRINT_LABEL")" ] \
       && is_local "$IMAGE"; then
        docker tag "$IMAGE" "$PRISTINE_ALIAS" \
            || die "could not keep a pristine copy of $IMAGE as $PRISTINE_ALIAS"
    fi

    docker tag "$TAG" "$IMAGE" || die "could not retag $TAG as $IMAGE"
    echo "trust-proxy: $IMAGE now resolves to $TAG in this daemon"

    cat <<EOF

Done. Builds in THIS daemon that say
    FROM $IMAGE
now get the CA-trusting derivative, with your Dockerfile unchanged. That covers
\`docker build\`, \`docker compose build\`, and any build posted to the Engine
API that does not ask for BuildKit.

It does NOT cover a build posted to the Engine API that DOES ask for BuildKit
(\`/build?version=2\` -- dockerode with version: "2", and tools built on it).
That path resolves the tag at the registry and pins the digest it gets back, so
it never reads this one. You get the pristine base with no CA, no message
saying so, and a build that hangs on its first HTTPS fetch. If that is your
build, one of these:

  * build FROM the derivative directly:  FROM $TAG
    It exists in no registry, so BuildKit falls back to this image store and
    the tag binds. Development-only -- keep it out of what you deploy.
  * or ask that build for the classic builder (version: "1" in dockerode,
    DOCKER_BUILDKIT=0 for a CLI wrapper), which reads this store and nothing
    else.

That blast radius is worth reading as a warning as much as a feature: this is
EVERY build here that resolves locally, not just yours. In a devcontainer's own
disposable daemon that is the point.

  * Lifetime: the tag lives in this devcontainer's inner image store and is
    lost when the container is rebuilt. Re-run this after
    \`desolate --rebuild\`, or declare it once and forget it:
        "customizations": { "desolate": { "shadowImages": ["$IMAGE"] } }

  * \`docker pull $IMAGE\` silently puts the untrusting upstream image back --
    and so does anything that runs one for you, or a \`docker image prune\`
    that collects the tag. The next build then fails with a certificate error
    (or that 60-90 second hang) and nothing points back here. If a build starts
    failing again, suspect a pull first and just re-run this.

  * Undo:  $0 --image $IMAGE --unshadow
EOF
    exit 0
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

If your build does not go through compose at all -- an SDK talking to the Engine
API, or plain \`docker build\` with no buildx -- there is no build context to
override. Point the tag itself at the derivative instead:

    $0 --image $IMAGE --shadow

That covers the classic builder and the CLI. A build that posts to the Engine
API asking for BuildKit (\`/build?version=2\`) resolves \`$IMAGE\` at the
registry and ignores local tags, so for that one build FROM $TAG directly, or
ask it for the classic builder. --shadow says the same when you run it.
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
       Run this from the directory holding it, or pass --compose <file>.
       If there is no compose file because the build does not use compose,
       deliver the derivative by retagging instead:  --image $IMAGE --shadow"
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
