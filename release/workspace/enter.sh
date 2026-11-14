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
    # (A compose service has the VM's /workspaces at the same path, as a single container
    # does: devcontainer.ts.)
    # The environment the spec describes (remoteEnv, the user's own shell environment), as
    # `devcontainer exec` gives it: worked out once, when the container came up
    # (devcontainer.ts), and given here to `docker exec`, which takes 20 ms where the CLI
    # takes 300 to 400 (measured on the M1). Without it, the devcontainer CLI itself.
    EXEC_ENV=$HOME/.desolate-devcontainer/exec-env.json
    if [ -s "$EXEC_ENV" ] && [ "$(jq -r .containerId "$EXEC_ENV")" = "$ID" ]; then
      ARGS=(-i -u "$(jq -r .user "$EXEC_ENV")" -w "$DIR")
      [ -t 0 ] && [ -t 1 ] && ARGS+=(-t -e "TERM=${TERM:-xterm-256color}")
      while IFS= read -r -d '' entry; do ARGS+=(-e "$entry"); done < <(jq -j '.env[] + "\u0000"' "$EXEC_ENV")
      exec docker exec "${ARGS[@]}" "$ID" "$@"
    fi
    exec devcontainer exec --workspace-folder "$(jq -r .checkout "$STATE")" --config "$(jq -r .config "$STATE")" \
      --override-config "$(jq -r .override "$STATE")" \
      sh -c 'cd "$1" && shift && exec "$@"' sh "$DIR" "$@"
  fi
  echo "desolate: this workspace's devcontainer is not running; running in the VM itself" >&2
fi
cd "$DIR"
exec "$@"
