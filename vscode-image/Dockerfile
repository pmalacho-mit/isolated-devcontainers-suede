# OpenVSCode Server + docker CLI + devcontainer CLI  (multi-arch: arm64 + amd64)
# The docker CLI here talks ONLY to the inner dockerd (DOCKER_HOST is set in
# compose). No host socket exists in this container.

FROM gitpod/openvscode-server:latest

USER root

# Pin software versions installed by this image (while other images canb 'float').
# DOCKER_VERSION is the CLI only -- the daemon it drives is docker-compose.yml's `docker:#-dind`
ARG DOCKER_VERSION=29.6.2
ARG COMPOSE_VERSION=5.3.1
ARG BUILDX_VERSION=0.35.0
ARG NODE_VERSION=24.18.0
ARG GIT_LFS_VERSION=3.7.1
# Install git subrepo to use [suede](https://suede.sh/) workflows
ARG GIT_SUBREPO_VERSION=0.4.9
ARG DEVCONTAINERS_CLI_NPM_VERSION=0.88.0
ARG TSX_NPM_VERSION=4.23.1

RUN apt-get update && apt-get install -y --no-install-recommends \
  git openssh-client curl ca-certificates jq xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Install node
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

# Install docker CLI, compose, and buildx
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

# Install git-lfs.
# `--system` writes the clean/smudge filters to /etc/gitconfig instead of
# ~/.gitconfig. That is to avoid ambiguity between this image's $HOME 
# (/home/workspace) and its passwd entry (/home/openvscode-server) disagree.
RUN set -eux; \
  case "$(uname -m)" in \
  aarch64|arm64) LFS_ARCH=arm64 ;; \
  x86_64)        LFS_ARCH=amd64 ;; \
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/git-lfs/git-lfs/releases/download/v${GIT_LFS_VERSION}/git-lfs-linux-${LFS_ARCH}-v${GIT_LFS_VERSION}.tar.gz" \
  | tar xz -C /tmp; \
  install -m 0755 "/tmp/git-lfs-${GIT_LFS_VERSION}/git-lfs" /usr/local/bin/git-lfs; \
  rm -rf "/tmp/git-lfs-${GIT_LFS_VERSION}"; \
  git lfs install --system; \
  git lfs version

# Install git-subrepo.
# It's a set of bash scripts, so it lives in /opt and is put on
# PATH; GIT_SUBREPO_ROOT is how it finds its own lib/ and man/.
RUN set -eux; \
  git clone --quiet --depth 1 --branch "${GIT_SUBREPO_VERSION}" \
  https://github.com/ingydotnet/git-subrepo /opt/git-subrepo; \
  rm -rf /opt/git-subrepo/.git
ENV GIT_SUBREPO_ROOT=/opt/git-subrepo
ENV PATH=/opt/git-subrepo/lib:$PATH

# Install devcontainer CLI + tsx.
RUN npm install -g \ 
  "@devcontainers/cli@${DEVCONTAINERS_CLI_NPM_VERSION}" \
  "tsx@${TSX_NPM_VERSION}

# /workspaces must be writable by uid 1000; 
# the volume-init service enforces this on the volume too.
RUN mkdir -p /workspaces && chown 1000:1000 /workspaces

# Create executable wrapper for certificate authority (ca) usage.
# with-ca grants proxy-CA trust by EXPORTING env vars (NODE_EXTRA_CA_CERTS,
# CURL_CA_BUNDLE, GIT_SSL_CAINFO...) and exec'ing. Exported variables live only
# in the process tree that inherited them -- and `docker exec` starts a fresh
# process from the image config, inheriting nothing the entrypoint exported.
COPY with-ca.sh /usr/local/bin/with-ca
RUN chmod +x /usr/local/bin/with-ca

# Copy over all supporting scripts; this image is used across two containers
# with distinct roles:
#   orchestrator -- runs broker.ts; the ONLY container with the daemon socket
#   vscode       -- runs openvscode-server; no socket, talks to the broker
COPY --chown=1000:1000 \
  broker.ts \ 
  desolate-client.ts \ 
  desolate.ts \
  devcontainer.ts \
  jsonc.ts \
  newrepo.ts \ 
  policy.ts \
  projects.ts \
  utils.ts \
  /usr/local/lib/desolate/

# Create wrappers for supporting scripts so they can be invoked plainly.
# Every wrapper goes through `with-ca` so `docker exec` from the mac works.
#   desolate      (vscode)       -> broker client over the unix socket
#   desolate-run  (orchestrator) -> the real thing; useless without the socket
#   newrepo       (vscode)       -> git only, no daemon access needed
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
