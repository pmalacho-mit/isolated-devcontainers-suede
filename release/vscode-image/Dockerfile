# VSCodium Web Host (reh-web) + docker CLI + devcontainer CLI  (multi-arch: arm64 + amd64)
# The docker CLI here talks ONLY to the inner dockerd (DOCKER_HOST is set in
# compose). No host socket exists in this container.
#
# The editor server is a PINNED, CHECKSUMMED tarball rather than someone else's
# base image. It was gitpod/openvscode-server:latest, which is the one thing
# this file did not pin -- and that tag has not moved since VS Code 1.109.5
# (Feb 2026), so builds were already frozen, just implicitly and by a tag this
# project does not control. VSCodium's reh-web is the same upstream server
# component (MIT, Open VSX by default, `--connection-token` and the `?tkn=` URL
# unchanged), published per-release with sha256 sums.

FROM debian:bookworm-slim

USER root

# Pin software versions installed by this image (while other images can 'float').
# VSCODIUM_* pins the editor server; the sums are the ones published beside the
# release tarballs, and a mismatch must fail the build rather than warn.
# Can upgrade once the following bug is resolved: https://github.com/VSCodium/vscodium/issues/2927
ARG VSCODIUM_VERSION=1.116.02821
ARG VSCODIUM_SHA256_X64=72e59e9946e48278e4b407ca0ee6a21cbb13d6f04855e0989f6d879953d93c07
ARG VSCODIUM_SHA256_ARM64=691ca7cf7df94ac1f9cb249af34e125db932aba162a2cd2a8e337be8c3d3dbd1
ARG VSCODE_WEBVIEW_SW_VERSION=4
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

# libstdc++6 is not implicit on debian-slim and the server's bundled node links
# against it -- without it the editor dies at exec with a loader error, inside a
# devcontainer, where nobody is looking.
RUN apt-get update && apt-get install -y --no-install-recommends \
  git openssh-client curl ca-certificates jq xz-utils \
  libstdc++6 \
  && rm -rf /var/lib/apt/lists/*

# uid 1000, which dockerd's `--group=1000` grants the inner socket to. HOME is
# set to the same path the passwd entry names: an image where the two disagree
# is exactly the ambiguity the git-lfs `--system` install below works around.
RUN groupadd -g 1000 desolate \
  && useradd -u 1000 -g 1000 -m -d /home/workspace -s /bin/bash desolate
ENV HOME=/home/workspace

# The editor server itself. Extracted flat (the tarball has no top-level
# directory) and stamped with its own version, which volume-init reads to decide
# whether the shared server-dist volume needs reseeding.
ENV DESOLATE_SERVER_ROOT=/home/.desolate-server
RUN set -eux; \
  case "$(uname -m)" in \
  aarch64|arm64) REH_ARCH=arm64; REH_SHA="${VSCODIUM_SHA256_ARM64}" ;; \
  x86_64)        REH_ARCH=x64;   REH_SHA="${VSCODIUM_SHA256_X64}" ;; \
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; \
  esac; \
  tarball="vscodium-reh-web-linux-${REH_ARCH}-${VSCODIUM_VERSION}.tar.gz"; \
  curl -fsSL -o /tmp/reh.tar.gz \
  "https://github.com/VSCodium/vscodium/releases/download/${VSCODIUM_VERSION}/${tarball}"; \
  echo "${REH_SHA}  /tmp/reh.tar.gz" | sha256sum -c -; \
  mkdir -p "${DESOLATE_SERVER_ROOT}"; \
  tar xz -C "${DESOLATE_SERVER_ROOT}" -f /tmp/reh.tar.gz; \
  rm /tmp/reh.tar.gz; \
  printf '%s' "${VSCODIUM_VERSION}" > "${DESOLATE_SERVER_ROOT}/.version"; \
  test -x "${DESOLATE_SERVER_ROOT}/bin/codium-server"; \
  # The reason VSCODIUM_VERSION is held back, in a form that fails the build.
  # Needs no network: the workbench states what it requires, and a release whose
  # requirement has moved past the pin in its own product.json is one where
  # every webview pane renders blank with nothing in any log.
  grep -q "_expectedServiceWorkerVersion=${VSCODE_WEBVIEW_SW_VERSION}" \
  "${DESOLATE_SERVER_ROOT}/out/vs/code/browser/workbench/workbench.js"

# A SECOND tree for the OUTER editor, with the git extensions removed.
#
# The outer editor is the one container that can reach the keyring's agent
# socket, and the built-in git extension is what makes a repository executable
# there: it invokes `git` against project content, and `git` obeys that
# project's own .git/config -- core.fsmonitor, core.pager, core.hooksPath,
# filter.*.clean -- plus .gitattributes selecting filters from the SYSTEM
# gitconfig, which this image populates with git-lfs. Restricted Mode does not
# help: the git extension declares limited untrusted support and runs anyway.
#
# Removing the directory is the control. `--disable-extension` exists in the
# server's argument parser but is undocumented for this server and is a runtime
# flag someone can drop from `command:`; an extension that is not on disk cannot
# be enabled by a setting, a flag, or a workspace.
#
# `cp -al` hardlinks, so the second tree costs a few MB rather than another
# copy, and DESOLATE_SERVER_ROOT stays complete -- devcontainers are seeded from
# it and DO want git in their own editor, where there is no agent socket to
# reach and the project is already trusted with its own source.

ENV DESOLATE_SHELL_ROOT=/home/.desolate-shell
RUN set -eux; \
  cp -al "${DESOLATE_SERVER_ROOT}" "${DESOLATE_SHELL_ROOT}"; \
  for ext in git git-base github github-authentication; do \
  rm -rf "${DESOLATE_SHELL_ROOT}/extensions/$ext"; done; \
  test ! -e "${DESOLATE_SHELL_ROOT}/extensions/git"; \
  test -e "${DESOLATE_SERVER_ROOT}/extensions/git"; \
  test -x "${DESOLATE_SHELL_ROOT}/bin/codium-server"

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

# The keyring runs on openssh-client (installed above): ssh-agent holds the
# private keys, ssh-keygen makes them, ssh-add loads them. Assert the three
# binaries at BUILD time -- a base-image change that drops any of them should
# fail here, not leave the keyring crash-looping with no keys in the stack.
RUN set -eux; \
  for b in ssh-agent ssh-add ssh-keygen; do command -v "$b" >/dev/null || \
  { echo "keyring needs $b -- the ssh client package is missing" >&2; exit 1; }; done

# Install git-lfs.
# `--system` writes the clean/smudge filters to /etc/gitconfig instead of
# ~/.gitconfig, so the filters apply regardless of which user or HOME a given
# entry point runs under. (The passwd entry and $HOME now agree at
# /home/workspace, but every `docker exec` still gets the same git config.)
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
  "tsx@${TSX_NPM_VERSION}"

# /workspaces must be writable by uid 1000;
# the volume-init service enforces this on the volume too.
RUN mkdir -p /workspaces && chown 1000:1000 /workspaces

# The keyring's two volume mountpoints, owned by the uid that mounts them.
#
# A named volume takes its ownership FROM THE IMAGE, and only when it is first
# created. Absent here, docker makes the directory root-owned, and the keyring
# -- uid 1000, cap_drop ALL, no volume-init pass of its own -- can do nothing
# about it: `mkdir -p` on a path that already exists does not chown it. The
# symptom is the container crash-looping on
#   unix_listener: cannot bind to path /run/keyring/agent.sock: Permission denied
# and every `newrepo` failing with "cannot reach the keyring".
#
# The modes match the ones keyring.ts sets: 0755 for the published public half,
# 0700 for the directory holding private keys.
RUN install -d -o 1000 -g 1000 -m 0755 /run/keyring \
  && install -d -o 1000 -g 1000 -m 0700 /var/lib/keyring

# Create executable wrapper for certificate authority (ca) usage.
# with-ca grants proxy-CA trust by EXPORTING env vars (NODE_EXTRA_CA_CERTS,
# CURL_CA_BUNDLE, GIT_SSL_CAINFO...) and exec'ing. Exported variables live only
# in the process tree that inherited them -- and `docker exec` starts a fresh
# process from the image config, inheriting nothing the entrypoint exported.
COPY with-ca.sh /usr/local/bin/with-ca
COPY shell-entry.sh /usr/local/bin/shell-entry
RUN chmod +x /usr/local/bin/with-ca /usr/local/bin/shell-entry

# Copy over all supporting scripts; this image is used across two containers
# with distinct roles:
#   orchestrator -- runs broker.ts; the ONLY container with the daemon socket
#   vscode       -- runs the editor server; no socket, talks to the broker
# Every .ts in the directory, rather than a hand-kept list: a module extracted
# during a refactor and forgotten here does not fail the build, it fails at
# runtime inside the image with "cannot find module".
COPY --chown=1000:1000 *.ts /usr/local/lib/desolate/

# Create wrappers for supporting scripts so they can be invoked plainly.
# Every wrapper goes through `with-ca` so `docker exec` from the mac works.
#   desolate      (vscode)       -> broker client over the unix socket
#   desolate-run  (orchestrator) -> the real thing; useless without the socket
#   newrepo       (vscode)       -> git only, no daemon access needed
#   worktree      (vscode)       -> git only, and git ONLY belongs here: it obeys
#                                   the project's own config and hooks, which the
#                                   orchestrator must never execute
RUN printf '#!/bin/sh\nexec /usr/local/bin/with-ca tsx /usr/local/lib/desolate/desolate-client.ts "$@"\n' > /usr/local/bin/desolate \
  && printf '#!/bin/sh\nexec /usr/local/bin/with-ca tsx /usr/local/lib/desolate/desolate.ts "$@"\n' > /usr/local/bin/desolate-run \
  && printf '#!/bin/sh\nexec /usr/local/bin/with-ca tsx /usr/local/lib/desolate/newrepo.ts "$@"\n' > /usr/local/bin/newrepo \
  && printf '#!/bin/sh\nexec /usr/local/bin/with-ca tsx /usr/local/lib/desolate/worktrees.ts "$@"\n' > /usr/local/bin/worktree \
  && chmod +x /usr/local/bin/desolate /usr/local/bin/desolate-run /usr/local/bin/newrepo /usr/local/bin/worktree

# Optional: pre-bake pinned extensions from Open VSX instead of letting the
# running editor pull them ad hoc. Example:
# RUN "${DESOLATE_SERVER_ROOT}/bin/codium-server" \
#       --install-extension ms-python.python@2024.22.0 || true

USER 1000
WORKDIR /workspaces
