# The orchestrator's toolchain: node plus a real docker CLI.
#
# This is the only environment given a daemon. It exists because the argv in
# docker.ts is a contract with a program this repo does not control -- the unit
# suite pins what we MEANT to send, and only a real CLI says whether it is
# accepted.
#
# Keep these ARGs in step with release/vscode-image/Dockerfile.
ARG NODE_VERSION=24.18.0
FROM node:${NODE_VERSION}-bookworm-slim

ARG DOCKER_VERSION=29.6.2
ARG TSX_NPM_VERSION=4.23.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# The static CLI only. The daemon it drives is whatever socket run.sh mounts.
RUN set -eux; \
  case "$(uname -m)" in \
    aarch64|arm64) DOCKER_ARCH=aarch64 ;; \
    x86_64)        DOCKER_ARCH=x86_64 ;; \
    *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_VERSION}.tgz" \
  | tar xz --strip-components=1 -C /usr/local/bin docker/docker; \
  docker --version

RUN npm install -g "tsx@${TSX_NPM_VERSION}" && npm cache clean --force

# Build context is the REPO ROOT -- see the note in runtime/Dockerfile.
WORKDIR /repo
COPY release/vscode-image /repo/release/vscode-image
COPY tests /repo/tests
# The policy suite validates the repo's own example projects against the policy.
COPY samples /repo/samples

COPY tests/environments/daemon/run.sh /usr/local/bin/run-environment
RUN chmod +x /usr/local/bin/run-environment

CMD ["run-environment"]
