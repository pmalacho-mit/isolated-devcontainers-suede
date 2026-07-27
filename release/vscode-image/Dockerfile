# OpenVSCode Server + docker CLI + devcontainer CLI  (multi-arch: arm64 + amd64)
# The docker CLI here talks ONLY to the inner dockerd (DOCKER_HOST is set in
# compose). No host socket exists in this container.

FROM gitpod/openvscode-server:latest

USER root

# Pinned so that two people running `cli.sh up` months apart get the SAME
# toolchain -- an image that drifts under you is an image whose failures are not
# reproducible. Bump these deliberately; `docker compose build --no-cache
# vscode` then `./cli.sh preflight` is the check.
#
# NOTE the pinning is partial by design, not by oversight: the base image,
# the npm globals below, and the two runtime images (alpine/socat,
# lscr.io/linuxserver/socket-proxy) all float. Reproducibility here is
# "the tools I install", not "the whole image".
#
# DOCKER_VERSION is the CLI only -- the daemon it drives is `docker:NN-dind` in
# docker-compose.yml. The two are independent; the CLI negotiates the API
# version down, and Docker 29 refuses anything below API 1.44.
ARG DOCKER_VERSION=29.6.2
ARG COMPOSE_VERSION=5.3.1
ARG BUILDX_VERSION=0.35.0
# Node 20 ("Iron") is EOL. 24 ("Krypton") is the current LTS line; preflight
# asserts >=18 because that is the devcontainer CLI's floor.
ARG NODE_VERSION=24.18.0

RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates jq xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node.js LTS from nodejs.org -- NOT apt's nodejs, which is ancient (v12) and
# crashes @devcontainers/cli with "SyntaxError: Unexpected token '?'"
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      aarch64|arm64) NODE_ARCH=arm64 ;; \
      x86_64)        NODE_ARCH=x64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1; \
    node --version; npm --version

# Static docker CLI + plugins, selecting the right arch (M1/M2 -> aarch64/arm64)
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      aarch64|arm64) DOCKER_ARCH=aarch64; COMPOSE_ARCH=aarch64; BUILDX_ARCH=arm64 ;; \
      x86_64)        DOCKER_ARCH=x86_64;  COMPOSE_ARCH=x86_64;  BUILDX_ARCH=amd64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_VERSION}.tgz" \
      | tar xz --strip-components=1 -C /usr/local/bin docker/docker; \
    mkdir -p /usr/local/lib/docker/cli-plugins; \
    curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
      "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}"; \
    curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-buildx \
      "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-${BUILDX_ARCH}"; \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
             /usr/local/lib/docker/cli-plugins/docker-buildx

# devcontainer CLI + tsx (TypeScript runner for desolate)
RUN npm install -g @devcontainers/cli tsx && npm cache clean --force \
    && devcontainer --version && tsx --version

# /workspaces must be writable by uid 1000; the volume-init service enforces
# this on the volume too, this covers the bare-image case.
RUN mkdir -p /workspaces && chown 1000:1000 /workspaces

# One image, two roles (compose picks via entrypoint):
#   orchestrator -- runs broker.ts; the ONLY container with the daemon socket
#   editor       -- runs openvscode-server; no socket, talks to the broker
#
#   desolate      (editor)       -> broker client over the unix socket
#   desolate-run  (orchestrator) -> the real thing; useless without the socket
#   newrepo       (editor)       -> git only, no daemon access needed
COPY --chown=1000:1000 desolate.ts newrepo.ts broker.ts desolate-client.ts policy.ts \
     /usr/local/lib/desolate/
COPY with-ca.sh /usr/local/bin/with-ca
RUN chmod +x /usr/local/bin/with-ca
# EVERY wrapper goes through `with-ca`, not just the compose entrypoint.
#
# with-ca grants proxy-CA trust by EXPORTING env vars (NODE_EXTRA_CA_CERTS,
# CURL_CA_BUNDLE, GIT_SSL_CAINFO...) and exec'ing. Exported variables live only
# in the process tree that inherited them -- and `docker exec` starts a fresh
# process from the image config, inheriting nothing the entrypoint exported.
#
# So without this, the same operation SUCCEEDS from the editor and FAILS from
# the Mac: the broker inherits the entrypoint's env and passes it to its child,
# while `cli.sh desolate` (docker exec -> desolate-run) gets a bare environment
# and the devcontainer CLI dies fetching a Feature with "unable to verify the
# first certificate". Making each wrapper self-sufficient removes the
# dependence on how it was entered. with-ca is idempotent, so the broker path
# re-applying it costs nothing.
RUN printf '#!/bin/sh\nexec /usr/local/bin/with-ca tsx /usr/local/lib/desolate/desolate-client.ts "$@"\n' > /usr/local/bin/desolate \
    && printf '#!/bin/sh\nexec /usr/local/bin/with-ca tsx /usr/local/lib/desolate/desolate.ts "$@"\n' > /usr/local/bin/desolate-run \
    && printf '#!/bin/sh\nexec /usr/local/bin/with-ca tsx /usr/local/lib/desolate/newrepo.ts "$@"\n' > /usr/local/bin/newrepo \
    && chmod +x /usr/local/bin/desolate /usr/local/bin/desolate-run /usr/local/bin/newrepo

# Optional: pre-bake pinned extensions from Open VSX instead of letting the
# running editor pull them ad hoc. Example:
# RUN /home/.openvscode-server/bin/openvscode-server \
#       --install-extension ms-python.python@2024.22.0 || true

USER 1000
WORKDIR /workspaces
