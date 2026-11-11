#!/bin/bash
# Run a command where this workspace's work happens: in its devcontainer if it has one that
# is up, otherwise in the VM itself. `desolate exec` and the editor's terminal both come
# through here, so an agent, a person's shell and a script all see the same environment.
#   enter.sh [--vm] <directory> -- <command> [args...]     (--here: the current directory)
set -euo pipefail
VM=0
if [ "${1:-}" = "--vm" ]; then VM=1; shift; fi
DIR=${1:?usage: enter.sh [--vm] <directory> -- <command> [args...]}
[ "$DIR" = "--here" ] && DIR=$PWD
[ "${2:-}" = "--" ] || { echo "usage: enter.sh [--vm] <directory> -- <command> [args...]" >&2; exit 64; }
shift 2
STATE=/run/desolate/devcontainer.json
if [ "$VM" = 0 ] && [ -s "$STATE" ] && [ "$(jq -r .state "$STATE" 2>/dev/null)" = up ]; then
  ID=$(jq -r .containerId "$STATE")
  if [ "$(docker inspect -f '{{.State.Running}}' "$ID" 2>/dev/null)" = true ]; then
    # A compose service sees the project where its own spec mounted it, not at the VM's path.
    [ "$(jq -r .compose "$STATE")" = true ] && DIR=$(jq -r .folder "$STATE")
    # `devcontainer exec` and not `docker exec`: it gives the command the environment the
    # spec describes (remoteEnv, the user's own shell environment), as the ecosystem's
    # tools do. It starts in the spec's folder; the directory asked for is entered here.
    exec devcontainer exec --workspace-folder "$(jq -r .checkout "$STATE")" --config "$(jq -r .config "$STATE")" \
      --override-config "$(jq -r .override "$STATE")" \
      sh -c 'cd "$1" && shift && exec "$@"' sh "$DIR" "$@"
  fi
  echo "desolate: this workspace's devcontainer is not running; running in the VM itself" >&2
fi
cd "$DIR"
exec "$@"
