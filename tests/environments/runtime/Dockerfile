# The vscode-image's node/tsx toolchain, and nothing else.
#
# Deliberately no docker CLI and no socket: a unit test that starts depending on
# a daemon must fail here rather than pass everywhere and hide the dependency.
#
# Keep the two ARGs below in step with release/vscode-image/Dockerfile. The
# check-pins test in this directory fails when they drift.
ARG NODE_VERSION=24.18.0
FROM node:${NODE_VERSION}-bookworm-slim

ARG TSX_NPM_VERSION=4.23.1
RUN npm install -g "tsx@${TSX_NPM_VERSION}" && npm cache clean --force

# Build context is the REPO ROOT (see tests/environments/run.sh): this
# devcontainer uses docker-outside-of-docker, so a bind mount of a path only
# this container can see resolves to an empty directory on the outer daemon.
# Copying is also closer to what the shipped image does with these files.
WORKDIR /repo
COPY release/vscode-image /repo/release/vscode-image
COPY tests /repo/tests
# The policy suite validates the repo's own example projects against the policy.
COPY samples /repo/samples

COPY tests/environments/runtime/run.sh /usr/local/bin/run-environment
RUN chmod +x /usr/local/bin/run-environment

CMD ["run-environment"]
