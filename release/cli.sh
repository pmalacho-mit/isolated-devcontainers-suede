#!/usr/bin/env bash
# cli.sh -- drive the desolate stack from anywhere on your Mac.
#
#   ./isolated-devcontainers-suede/cli.sh vm install               # provision the VM: sysbox + egress proxy
#   ./isolated-devcontainers-suede/cli.sh up                       # build + start + print editor URL
#   ./isolated-devcontainers-suede/cli.sh desolate <project>       # open a project as an isolated IDE
#   ./isolated-devcontainers-suede/cli.sh url                       # print + copy the editor URL
#   ./isolated-devcontainers-suede/cli.sh secret add NAME --hosts a.com,b.com   # secret -> VM only
#   ./isolated-devcontainers-suede/cli.sh secret list | rm NAME
#   ./isolated-devcontainers-suede/cli.sh proxy status | logs | test
#   ./isolated-devcontainers-suede/cli.sh repo add owner/repo       # per-repo deploy key + clone
#   ./isolated-devcontainers-suede/cli.sh worktree add owner/repo wip   # a branch in its own devcontainer
#   ./isolated-devcontainers-suede/cli.sh worktree list | remove owner/repo wip
#   ./isolated-devcontainers-suede/cli.sh export owner/repo [path]  # copy files out (tar when piped)
#   ./isolated-devcontainers-suede/cli.sh shell                     # bash in the editor container
#   ./isolated-devcontainers-suede/cli.sh down | logs | ps | preflight | observe
#   ./isolated-devcontainers-suede/cli.sh reset-inner               # recover a wedged inner daemon
#   ./isolated-devcontainers-suede/cli.sh dind list | reset <project> | df | gc   # project daemons
#   ./isolated-devcontainers-suede/cli.sh <any command...>          # runs in the editor container
#
# Requires Colima + sysbox (see README "Setup"). `up` refuses to start if the
# Docker daemon does not expose the sysbox-runc runtime.
set -euo pipefail

CONTAINER=desolate-vscode
ORCHESTRATOR=desolate-orchestrator
COLIMA_PROFILE="${COLIMA_PROFILE:-desolate}"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

usage() {
  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

compose() {
  docker compose --project-directory "$SCRIPT_DIR" -f "$SCRIPT_DIR/docker-compose.yml" "$@"
}

running() {
  docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null | grep -qx running
}

ensure_running() {
  running || { echo "cli.sh: stack is not running -- start it with: $0 up" >&2; exit 1; }
}

require_sysbox() {
  if ! docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q sysbox-runc; then
    cat >&2 <<'EOF'
cli.sh: the sysbox-runc runtime is not available on the current Docker daemon.

This setup runs ONLY on Colima + sysbox (the inner Docker daemon must be
unprivileged; sysbox is what makes that safe). Fix:

  1. docker context use colima-desolate         # make sure you're on the Colima VM
  2. If sysbox still isn't listed, install it inside the VM --
     run: ./cli.sh vm install

Verify with:  docker info | grep -A2 Runtimes   (must list sysbox-runc)
EOF
    exit 1
  fi
}

vm() { colima ssh -p "$COLIMA_PROFILE" -- "$@"; }

# This script drives the VM through TWO channels: `docker` (whatever the current
# context points at) and `colima ssh -p $COLIMA_PROFILE`. Nothing forces those to
# be the same machine, and when they diverge every symptom is baffling: `down`
# removes containers the installer cannot see, `vm install` provisions a VM the
# stack is not running on, preflight reports on neither. Compare the hostnames
# and say so plainly instead.
require_matching_vm() {
  local ctx_host vm_host
  ctx_host=$(docker info --format '{{.Name}}' 2>/dev/null || true)
  vm_host=$(vm hostname 2>/dev/null | tr -d '\r' || true)
  [ -n "$ctx_host" ] && [ -n "$vm_host" ] || return 0   # can't tell; don't block
  [ "$ctx_host" = "$vm_host" ] && return 0
  cat >&2 <<EOF
cli.sh: your docker context and the Colima profile are different machines.

  docker context -> $ctx_host          (where 'docker'/'compose'/'down' act)
  COLIMA_PROFILE=$COLIMA_PROFILE -> $vm_host   (where 'vm install' acts)

Anything you do here would land half on each. Point them at the same VM:
  docker context use colima-$COLIMA_PROFILE
or select the other profile:
  COLIMA_PROFILE=<name> $0 ...          (colima list shows them)
EOF
  return 1
}

# jq program for `secret list`. NO double quotes and NO spaces, on purpose: it
# travels as a bare argument through `colima ssh -- ...`, which re-parses the
# command line remotely. The version this replaces tried to survive that by
# escaping its quotes, which made it invalid jq -- \" is not legal inside a
# \(...) interpolation -- so `secret list` never worked at all. Emitting TSV and
# formatting on the Mac leaves the remote side nothing to misparse.
# tests/static/05-cli-queries.sh executes this against a fixture.
SECRET_LIST_JQ='.secrets|to_entries[]|[.key]+.value.hosts|@tsv'

# `export`, run INSIDE the editor where the files are:
#   sh -c "$EXPORT_TAR_SH" sh <workspaces> <project> <relative-path>
# writes a tar of that path to stdout, or exits 2 (no such project), 3 (no such
# path) or 4 (it resolves outside the project). A project is one or two
# segments, neither starting with a dot, and must BE /workspaces/<project> --
# not a link to some other project. Symlinks in the path are followed for the
# check, and then the archive is made from the parent directory, entered and
# re-checked first: tar works relative to that pinned directory and archives a
# link as a link, so swapping a component after the check gains nothing.
# tests/static/05-cli-queries.sh executes it against a fixture tree.
EXPORT_TAR_SH='
  case "$2" in ""|/*|*/|*//*|*/*/*|.*|*/.*) exit 2 ;; esac
  base=$(realpath -e "$1") || exit 2
  root=$(realpath -e "$1/$2" 2>/dev/null) || exit 2
  [ "$root" = "$base/$2" ] || exit 2
  path=$(realpath -e "$root/$3" 2>/dev/null) || exit 3
  case "$path" in "$root"|"$root"/*) ;; *) exit 4 ;; esac
  cd "$(dirname "$path")" || exit 3
  case "$(pwd -P)/" in "$root"/*|"$(dirname "$root")"/) ;; *) exit 4 ;; esac
  exec tar -cf - -- "$(basename "$path")"'

# Existing placeholders that OVERLAP the one being added ($n): either contains
# the other. Same quoting discipline as SECRET_LIST_JQ -- it travels as a bare
# argument through `colima ssh`. Also executed by tests/static/05-cli-queries.sh.
#
# The proxy substitutes by plain string replace and detects by plain substring
# search, so MY_KEY and MY_KEY2 cannot coexist: a request carrying MY_KEY2 is
# judged against MY_KEY's allowlist and gets MY_KEY's value with a stray "2"
# glued on. addon.py drops both if they ever reach it; refusing here is how you
# find out at the moment you can still pick another name.
#
# `inside($n)` rather than the obvious `$n|contains(.)`: piping into $n rebinds
# `.` to $n itself, so that spelling asks whether $n contains $n and reports
# every stored name as a collision. `inside` takes the container as an argument
# instead, so nothing is rebound. (And `[a,b]|any` rather than `a or b`, because
# `or` needs spaces around it.)
SECRET_COLLISION_JQ='(.secrets//{})|keys[]|select(.!=$n)|select([contains($n),inside($n)]|any)'

SELFTEST_FIXTURE=DESOLATE-SELFTEST-PLACEHOLDER

explain_selftest_fixture_is_not_a_secret() {
  echo "cli.sh: $SELFTEST_FIXTURE is preflight's self-test fixture," >&2
  echo "        not a secret -- its value is fake and its allowlist pins" >&2
  echo "        httpbin.org. Removing it does not remove a secret; it removes" >&2
  echo "        preflight's ability to prove leak detection is live, and the" >&2
  echo "        probes then fail claiming the addon is broken." >&2
  echo "        Restore it with: $0 vm install --proxy-only" >&2
  echo "        If you really mean it: $0 secret rm $SELFTEST_FIXTURE --force" >&2
}

# Whether a --hosts entry PINS a destination. "*" is not an allowlist, it is the
# absence of one spelled so it looks deliberate: the secret becomes a bearer
# token any container may post anywhere, and the proxy's leak detection has
# nothing left to catch. Wildcards are allowed only where a TLS certificate
# allows them -- one leading label, over a name with two or more literal labels.
# addon.py applies the same rule when it loads settings.json.
host_pattern_pins_a_destination() {
  case "$1" in
    '')    return 1 ;;
    *'*'*) ;;                                    # a wildcard: keep checking
    *)     return 0 ;;                           # a literal name pins itself
  esac
  case "$1" in '*.'*) ;; *) return 1 ;; esac     # ...only as the FIRST label,
  local rest="${1#\*.}"                          # because '*' does not stop at
  case "$rest" in *'*'*) return 1 ;; esac        # a dot: '*foo.com' matches
  case "$rest" in                                # 'evilfoo.com' too.
    *..*|.*|*.) return 1 ;;                      # no empty labels
    *.*)        return 0 ;;                      # >= 2 labels ('*.com' is a TLD)
    *)          return 1 ;;
  esac
}

COMPOSE_NET=desolate_devnet
PINNED_BRIDGE=br-desolate
# The stack spans TWO bridges (see docker-compose.yml networks:). Both have to
# be armed, and both have to be checked for drift: arming only the editor's
# would leave the container world with unfiltered egress and no lateral wall.
COMPOSE_DIND_NET=desolate_dindnet
PINNED_DIND_BRIDGE=br-desolate-in

# The bridge the LIVE network actually uses.
#
# Deliberately NOT read from docker-compose.yml. driver_opts are applied when
# the network is CREATED, so a network that predates the pin keeps docker's
# br-<hash> name and `docker network inspect` reports Options:{}. Trusting the
# pin there would arm nftables on an interface that does not exist -- rules
# load fine (iifname is a name match, not an ifindex) and match nothing, which
# is exactly the silent no-interception failure we are trying to prevent.
live_bridge() {
  local net="${1:-$COMPOSE_NET}" gw
  gw=$(docker network inspect "$net" \
        -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null) || return 1
  [ -n "$gw" ] || return 1
  vm ip -br addr 2>/dev/null | awk -v gw="$gw" '$3 ~ "^"gw"/" {print $1; exit}'
}

# Interface the installed ruleset is armed for ("" if never installed).
# Takes the nft symbol so both halves of the split can be read back.
armed_bridge() {
  local symbol="${1:-DESOLATE_IF}"
  vm sudo sed -n "s/^define $symbol = \"\(.*\)\"\$/\1/p" \
    /etc/desolate-proxy/nftables-desolate.conf 2>/dev/null
}

# Repo path as seen from inside the VM. The VM is started with `--mount <repo>`,
# and Colima mounts at the same path it has on the Mac, so SCRIPT_DIR resolves
# identically on both sides. Without that mount the VM sees nothing of the repo.
vm_repo_visible() { vm test -d "$SCRIPT_DIR/vm" >/dev/null 2>&1; }

vm_install() {
  require_matching_vm || return 1
  vm_repo_visible || {
    cat >&2 <<EOF
cli.sh: the repo is not visible inside the VM at
  $SCRIPT_DIR
The VM was not started with a mount covering this directory. Recreate it with:
  colima delete $COLIMA_PROFILE
  cd $SCRIPT_DIR && colima start $COLIMA_PROFILE --mount "\$PWD" <other flags>
Or run this by hand after copying it in:
  colima ssh -p $COLIMA_PROFILE
  cd <repo>/vm && sudo ./install.sh
EOF
    return 1
  }
  # Neither `colima ssh` nor sudo forwards the environment, so the pins have to
  # be handed over explicitly or they silently fall back to the script defaults.
  local envs=()
  local v
  for v in SYSBOX_VERSION MITMPROXY_VERSION DESOLATE_NET; do
    [ -n "${!v:-}" ] && envs+=("$v=${!v}")
  done
  vm sudo env ${envs[@]+"${envs[@]}"} "$SCRIPT_DIR/vm/install.sh" "$@"
}

# Verify the VM's egress interception is armed for the bridge the stack is
# actually on, and re-arm it if not. Called by `up` AFTER compose, because the
# network has to exist before its bridge can be resolved.
#
# This replaces the old "remember to re-run install.sh after your first up"
# note in the README: drift is detected rather than left to the operator.
ensure_vm_proxy() {
  [ "${DESOLATE_SKIP_VM_CHECK:-0}" = 1 ] && {
    echo "cli.sh: skipping VM proxy check (DESOLATE_SKIP_VM_CHECK=1)"; return 0; }

  local live armed live_dind armed_dind
  live=$(live_bridge "$COMPOSE_NET" || true)
  live_dind=$(live_bridge "$COMPOSE_DIND_NET" || true)
  # Resolve what we can. Skipping the WHOLE check because one network is
  # missing would be a fail-open on exactly the upgrade path this split
  # creates: devnet already exists, dindnet does not exist yet, and the editor
  # check that used to run would go quiet at the moment it is most needed.
  if [ -z "$live" ]; then
    echo "cli.sh: could not resolve the bridge for '$COMPOSE_NET' -- skipping the" >&2
    echo "        egress check. preflight will report whether interception is on." >&2
    return 0
  fi
  if [ -z "$live_dind" ]; then
    echo "cli.sh: NOTE -- '$COMPOSE_DIND_NET' does not exist yet. The container" >&2
    echo "        world is still sharing the editor's bridge, so there is no" >&2
    echo "        lateral wall. Recreate the stack to split them:" >&2
    echo "          ./cli.sh down && ./cli.sh up" >&2
  fi

  armed=$(armed_bridge DESOLATE_IF || true)
  armed_dind=$(armed_bridge DESOLATE_DIND_IF || true)
  local why=""
  if [ -z "$armed" ]; then
    why="the egress proxy is not installed in the VM"
  elif [ "$armed" != "$live" ]; then
    why="rules are armed for '$armed' but the editor bridge is '$live'"
  elif [ -n "$live_dind" ] && [ "$armed_dind" != "$live_dind" ]; then
    # This one is easy to miss and expensive to get wrong: it is the interface
    # every devcontainer's traffic arrives on, so if it is stale the container
    # world has no egress filter and no lateral drop at all. Only compared when
    # the network exists -- an absent dindnet is the note printed above, not a
    # drift that re-provisioning would repair.
    why="rules are armed for '$armed_dind' but the container bridge is '$live_dind'"
  elif [ "$live" = "$live_dind" ]; then
    why="both networks resolve to '$live' -- the editor/container split is gone"
  elif ! vm sudo nft list table inet desolate >/dev/null 2>&1; then
    why="the nftables ruleset is not loaded"
  elif ! vm systemctl is-active --quiet desolate-proxy desolate-nft desolate-proxy-ca desolate-dnsmasq desolate-ingress; then
    why="a VM proxy unit is not active"
  fi

  if [ -n "$why" ]; then
    echo "cli.sh: egress interception needs attention -- $why."
    echo "cli.sh: re-provisioning the VM proxy layer..."
    # --proxy-only: the sysbox step restarts docker, which would kill the stack
    # we just started. sysbox is already verified by require_sysbox above.
    vm_install --proxy-only || {
      cat >&2 <<EOF

cli.sh: FAILED to arm egress interception.

Containers are running with UNFILTERED egress: no secret substitution, no
leak scrubbing, no host allowlist. Bring the stack down, fix the VM install,
then start again:
  ./cli.sh down
  ./cli.sh vm install
Override this check (NOT recommended) with DESOLATE_SKIP_VM_CHECK=1.
EOF
      return 1
    }
    armed=$(armed_bridge DESOLATE_IF || true)
    armed_dind=$(armed_bridge DESOLATE_DIND_IF || true)
    [ "$armed" = "$live" ] && { [ -z "$live_dind" ] || [ "$armed_dind" = "$live_dind" ]; } || {
      echo "cli.sh: still armed for '$armed'/'$armed_dind', expected" >&2
      echo "        '$live'/'${live_dind:-(dindnet not created)}' -- see 'cli.sh preflight'" >&2
      return 1
    }
    echo "cli.sh: egress interception armed for $live and ${live_dind:-(dindnet pending)}"
  fi

  # Pinning exists so the bridge name survives down/up. A network created
  # before the pin keeps br-<hash>, so every recreate silently re-breaks the
  # rules until the network itself is recreated.
  if [ -n "$live_dind" ] && [ "$live_dind" != "$PINNED_DIND_BRIDGE" ]; then
    cat <<EOF
cli.sh: NOTE -- the container bridge is '$live_dind', not the pinned
        '$PINNED_DIND_BRIDGE'. Same cause and same fix as below.
EOF
  fi
  if [ "$live" != "$PINNED_BRIDGE" ]; then
    cat <<EOF
cli.sh: NOTE -- this stack is on '$live', not the pinned '$PINNED_BRIDGE'.
        The network predates the bridge-name pin, so its name will change on
        every recreate and the nftables rules will go stale each time. Fix it
        once with:  ./cli.sh down && ./cli.sh up
EOF
  fi
}

# ── reset-inner: recovering a wedged inner daemon ──────────────────────────
#
# The recovery used to be folklore -- "delete desolate_dind-sysbox-data" -- which
# is the image store for every project, and lived in the memory of whoever hit it
# last. Here it is a ladder instead, climbed one rung at a time and stopped at
# the first rung that leaves a daemon answering. The cheap rung is usually
# enough, and a single hammer teaches people to reach for the hammer.
DIND_SERVICE=dind
DIND=desolate-dind
# The image store for EVERY project. Written out rather than derived, the way
# observe.sh names desolate_inner-run; tests/static/11 asserts it against what
# compose actually renders, so the two cannot drift.
DIND_DATA_VOLUME=desolate_dind-sysbox-data
# The classifier dind's healthcheck runs, in the volume both can reach. Running
# the same file is the point: "wedged" must not mean two things.
INNER_HEALTH=/desolate-health/inner-health.sh
INNER_SOCKET=unix:///run/inner/docker.sock
# What a query gets inside dind before it is abandoned. A wedged daemon answers
# nothing, and this command must not inherit that.
INNER_PATIENCE=20
# How long a restarted daemon gets to answer before the next rung is offered.
SETTLE_SECONDS=60
RESET_DATA_ROOT_FLAG=--reset-data-root

# The ladder below acts on whichever daemon these name. They start out naming
# the shared one, for `reset-inner`; `dind reset <project>` points them at that
# project's own (select_project_dind), and every rung is the same code for both.
DIND_KIND=shared
DIND_PROJECT=""
RESET_COMMAND=reset-inner
DIND_DATA_SCOPE="the image store shared by every project"

SUPERVISOR=desolate-supervisor
# Run where the supervisor's socket is: the supervisor's own container.
supervisor() { docker exec "$SUPERVISOR" tsx /usr/local/lib/desolate/supervisor.ts "$@"; }

require_supervisor() {
  docker inspect -f '{{.State.Status}}' "$SUPERVISOR" 2>/dev/null | grep -qx running && return 0
  echo "cli.sh: $SUPERVISOR is not running -- project dinds are its to drive. Start the stack:  $0 up" >&2
  exit 1
}

# What projects.ts accepts, closely enough to refuse anything that would make
# a different docker name: `name` or `owner/name`, no leading dot, no `__`.
# A worktree has no dind of its own; it shares its project's.
valid_project() {
  printf '%s' "$1" | grep -Eqx '[A-Za-z0-9_][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)?' \
    && case "$1" in *__*) false ;; esac
}

# Point the ladder at one project's dind (dind.ts names; supervisor.ts drives).
select_project_dind() {
  valid_project "$1" || {
    echo "cli.sh: '$1' is not a project name (name or owner/name; a worktree uses its project's dind)" >&2
    exit 1
  }
  DIND_KIND=project
  DIND_PROJECT=$1
  DIND=desolate-dind-${1//\//__}
  DIND_DATA_VOLUME=dind-data-${1//\//__}
  INNER_SOCKET=unix:///run/dind-sock/docker.sock
  RESET_COMMAND="dind reset $1"
  DIND_DATA_SCOPE="$1's own image store (no other project's)"
}

dind_running() {
  docker inspect -f '{{.State.Status}}' "$DIND" 2>/dev/null | grep -qx running
}

require_dind() {
  docker inspect "$DIND" >/dev/null 2>&1 && return 0
  echo "cli.sh: $DIND does not exist -- there is no inner daemon to recover." >&2
  if [ "$DIND_KIND" = shared ]; then
    echo "        Start the stack first:  $0 up" >&2
  else
    echo "        $DIND_PROJECT gets one the first time it starts:  $0 desolate $DIND_PROJECT" >&2
  fi
  exit 1
}

# A stack older than the classifier would report every state as "not answering",
# and recommending a data-root reset because a FILE is missing is exactly the
# superstition this command exists to replace.
require_classifier() {
  dind_running || return 0   # nothing to ask; rung 1 will say it is down
  docker exec "$DIND" test -e "$INNER_HEALTH" 2>/dev/null && return 0
  echo "cli.sh: $DIND does not carry $INNER_HEALTH." >&2
  echo "        It is seeded into a volume at start, so this stack predates it." >&2
  echo "        Recreate the daemon first -- nothing is lost:  $0 up" >&2
  exit 1
}

# One line, and the classifier's verdict as this function's status.
inner_health() {
  dind_running || { echo "inner daemon: down -- $DIND is not running"; return 1; }
  docker exec -e "DESOLATE_INNER_SOCKET=${INNER_SOCKET#unix://}" "$DIND" sh "$INNER_HEALTH"
}

# Inner-daemon queries go through dind and NOT through the orchestrator that
# observe.sh uses: the orchestrator depends_on dind being healthy, so on the
# boot this command exists for, it never started at all.
inner_docker() {
  docker exec "$DIND" timeout "$INNER_PATIENCE" docker -H "$INNER_SOCKET" "$@"
}

# Container ids carrying a label, in any of the given states.
inner_ids() {
  local label=$1 state
  local filters=()
  shift
  for state in "$@"; do filters+=(--filter "status=$state"); done
  # Same guard as vm_install's `envs`: `set -u` and an EMPTY array is an
  # "unbound variable" on the bash a Mac ships (3.2), not an empty expansion.
  inner_docker ps -aq --filter "label=$label" ${filters[@]+"${filters[@]}"} 2>/dev/null
}

# "3 running, 2 exited, 1 dead", from one column of container states.
count_by_state() {
  printf '%s\n' "$1" | sed '/^$/d' | sort | uniq -c \
    | awk '{ printf "%s%s %s", sep, $1, $2; sep=", " }
           END { if (!sep) printf "none"; printf "\n" }'
}

# What a restart would have to reconcile. A daemon that cannot answer `ps` says
# so: reporting "no containers" would be a lie in the one state that matters.
inner_container_states() {
  local states
  states=$(inner_docker ps -a --format '{{.State}}' 2>/dev/null) \
    || { echo "cannot say -- the daemon did not answer 'ps' either"; return 0; }
  count_by_state "$states"
}

# Rung 1. Printed always, before anything is touched, so the next choice is
# informed rather than superstitious.
report_inner_daemon() {
  local verdict=0
  echo "-- rung 1: what the inner daemon is doing --"
  inner_health || verdict=$?
  echo "  containers: $(inner_container_states)"
  return "$verdict"
}

sweep_inner() {
  local what=$1 ids=$2
  if [ -z "${ids//[[:space:]]/}" ]; then
    echo "  no stale $what"
    return 0
  fi
  echo "  removing $(printf '%s\n' "$ids" | wc -l | tr -d ' ') stale $what"
  # shellcheck disable=SC2086  # several ids, deliberately word-split
  inner_docker rm -f $ids >/dev/null 2>&1 || echo "  ...some of them would not go"
}

# The daemon's container alone. A project dind is the supervisor's: it
# withdraws the dind from the ingress first and republishes it once healthy.
restart_dind() {
  if [ "$DIND_KIND" = shared ]; then
    compose restart "$DIND_SERVICE"
  else
    supervisor ask reset "$DIND_PROJECT" >/dev/null
  fi
}

# Rung 2. Remove what reconciliation is choking on, then restart the daemon
# alone -- the editor, the keyring and every other project stay up.
sweep_and_restart_dind() {
  echo "-- rung 2: sweeping stale objects, then restarting $DIND --"
  sweep_inner "relays that are no longer running" \
    "$(inner_ids desolate.relay created exited dead restarting)"
  # `dead` only. A STOPPED devcontainer is one `desolate --stop` deliberately
  # kept so the next start is fast; `dead` is what docker leaves behind when it
  # could not finish removing one, and that is the object reconciliation trips on.
  sweep_inner "devcontainers the daemon could not finish removing" \
    "$(inner_ids devcontainer.local_folder dead)"
  echo "  restarting $DIND (nothing else in the stack is touched)"
  restart_dind || echo "cli.sh: the restart itself failed" >&2
}

data_root_reset_requested() { [ "${1:-}" = "$RESET_DATA_ROOT_FLAG" ]; }

explain_data_root_reset() {
  cat >&2 <<EOF
cli.sh: the sweep did not bring the inner daemon back.

What is left is deleting its data root, $DIND_DATA_VOLUME -- $DIND_DATA_SCOPE.
That is not something to arrive at by falling through, so ask for it:
  $0 $RESET_COMMAND $RESET_DATA_ROOT_FLAG
EOF
}

confirm_data_root_reset() {
  cat <<EOF
This DELETES $DIND_DATA_VOLUME, $DIND_DATA_SCOPE. Every base image in it is
pulled again and its build cache is gone; every devcontainer inside it is
recreated from its spec on the next start, so anything written in one outside
/workspaces goes with it. /workspaces is a separate volume and is NOT touched.
EOF
  local answer
  read -r -p "Type 'yes' to confirm: " answer
  [ "$answer" = yes ]
}

# Rung 3, and the only rung that destroys anything. It refuses ITSELF without
# the flag rather than trusting the ladder above to have checked, which is what
# tests/static/11 executes it to prove.
reset_data_root() {
  data_root_reset_requested "${1:-}" || { explain_data_root_reset; return 1; }
  confirm_data_root_reset || return 1
  echo "-- rung 3: resetting the inner daemon's data root --"
  delete_data_root
}

delete_data_root() {
  if [ "$DIND_KIND" = project ]; then
    # purge: container, image store and bridge; ensure: a new one, admitted
    # and healthy, exactly as the project's next start would make it.
    supervisor ask purge "$DIND_PROJECT" >/dev/null || return 1
    supervisor ask ensure "$DIND_PROJECT" >/dev/null
    return
  fi
  # Removed, not stopped: a volume with a container still referencing it cannot
  # be deleted, and a half-done rung 3 is the worst state of all.
  compose rm -sf "$DIND_SERVICE" || return 1
  docker volume rm "$DIND_DATA_VOLUME" || return 1
  compose up -d "$DIND_SERVICE"
}

# ── dind df | gc: what the daemons hold, and giving it back (#14) ──────────

# Every daemon a project can be on, running, one per line: "<container> <socket>".
running_daemons() {
  dind_running && echo "$DIND /run/inner/docker.sock"
  docker ps --filter "label=desolate.dind" --filter status=running --format '{{.Names}}' \
    | sort | sed 's|$| /run/dind-sock/docker.sock|'
}

stopped_project_dinds() {
  docker ps -a --filter "label=desolate.dind" --filter status=exited --filter status=created \
    --format '{{.Names}}' | sort
}

# On ONE daemon, by its container: the docker CLI each dind image carries,
# pointed at the socket that daemon listens on.
daemon_docker() {
  local name=$1 socket=$2
  shift 2
  docker exec "$name" docker -H "unix://$socket" "$@"
}

dind_df() {
  local name socket usage
  printf '%-40s %-14s %-10s %s\n' DAEMON TYPE SIZE RECLAIMABLE
  while read -r name socket; do
    [ -n "$name" ] || continue
    # Bounded, like every query here: one wedged daemon must not hide the rest.
    if ! usage=$(docker exec "$name" timeout "$INNER_PATIENCE" docker -H "unix://$socket" \
                   system df --format '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}' 2>/dev/null); then
      printf '%-40s %s\n' "$name" "(did not answer -- see: $0 dind list)"
      continue
    fi
    printf '%s\n' "$usage" | while IFS=$'\t' read -r type size reclaimable; do
      printf '%-40s %-14s %-10s %s\n' "$name" "$type" "$size" "$reclaimable"
    done
  done < <(running_daemons)
  for name in $(stopped_project_dinds); do
    printf '%-40s %s\n' "$name" "(stopped -- its image store size is in: $0 dind list)"
  done
}

# Build cache, then dangling images, then ANONYMOUS volumes nothing uses.
# `volume prune` without -a has left named volumes alone since docker 23, and
# the dinds run 29: a project's declared volumes survive this, and /workspaces
# is not a volume on any of these daemons at all.
gc_daemon() {
  local name=$1 socket=$2
  echo "-- $name --"
  daemon_docker "$name" "$socket" builder prune -af | tail -n 1
  daemon_docker "$name" "$socket" image prune -f | tail -n 1
  daemon_docker "$name" "$socket" volume prune -f | tail -n 1
}

# The nested daemons docker-in-docker used to start kept their state in these,
# on the SHARED daemon. No project can start one any more (policy.ts refuses
# the feature), so every one left is an orphan; one still referenced by a
# container -- a stopped devcontainer from before -- is refused by docker
# itself, and said so, rather than forced.
gc_orphans() {
  local volumes volume
  volumes=$(inner_docker volume ls -q 2>/dev/null | grep -E '^dind-var-lib-(docker|containerd)-' || true)
  if [ -z "$volumes" ]; then
    echo "cli.sh: no docker-in-docker volumes are left on $DIND."
    return 0
  fi
  echo "These are the volumes docker-in-docker features kept on $DIND, the shared daemon:"
  printf '%s\n' "$volumes" | sed 's/^/  /'
  local answer
  read -r -p "Type 'yes' to delete them: " answer
  [ "$answer" = yes ] || { echo "cli.sh: nothing deleted."; return 1; }
  for volume in $volumes; do
    inner_docker volume rm "$volume" >/dev/null 2>&1 \
      && echo "  removed $volume" \
      || echo "  kept $volume: something still uses it ($(inner_docker ps -aq --filter "volume=$volume" | paste -sd, -))"
  done
}

# Poll quietly, then print the verdict once -- a line per probe would bury it.
inner_daemon_settles() {
  local remaining=$SETTLE_SECONDS
  while [ "$remaining" -gt 0 ]; do
    inner_health >/dev/null 2>&1 && break
    sleep 2
    remaining=$((remaining - 2))
  done
  inner_health
}

reset_inner() {
  if report_inner_daemon; then
    echo "cli.sh: the inner daemon is answering -- nothing to recover."
    return 0
  fi

  sweep_and_restart_dind
  if inner_daemon_settles; then
    echo "cli.sh: recovered without touching the data root."
    return 0
  fi

  reset_data_root "${1:-}" || return 1
  if inner_daemon_settles; then
    echo "cli.sh: recovered. Base images pull again on demand."
    return 0
  fi

  echo "cli.sh: the inner daemon is still not answering after a full reset." >&2
  if [ "$DIND_KIND" = shared ]; then
    echo "        Its own log is the next thing to read:  $0 logs $DIND_SERVICE" >&2
  else
    echo "        Its own log is the next thing to read:  docker logs $DIND" >&2
  fi
  return 1
}

# Read one key out of .env the way compose's env_file does -- so what we print
# matches what the stack is actually running with.
#
# README says to append a re-rolled token (`>> .env`), so several VSCODE_TOKEN
# lines is a normal state and the LAST one wins -- hence tail, not head. Anchoring
# rules out '#VSCODE_TOKEN=' and 'OLD_VSCODE_TOKEN='. '#*=' keeps everything after
# the FIRST '=' so a value containing '=' survives. Surrounding quotes come off
# the same way compose strips them, and a trailing CR is dropped for .env files
# edited on Windows.
#
# Factored out rather than duplicated per key: every one of those rules is a bug
# someone already hit once, and a second hand-rolled copy would not have all five.
env_value() {
  local v
  v=$(grep "^$1=" "$SCRIPT_DIR/.env" 2>/dev/null | tail -n 1)
  v=${v#*=}
  v=${v%$'\r'}
  case $v in
    \"*\") v=${v#\"}; v=${v%\"} ;;
    \'*\') v=${v#\'}; v=${v%\'} ;;
  esac
  printf '%s' "$v"
}

# The editor's host port, defaulting exactly as docker-compose.yml does.
vscode_port() {
  local p
  p=$(env_value VSCODE_PORT)
  printf '%s' "${p:-3000}"
}

editor_url() {
  local tok port url
  tok=$(env_value VSCODE_TOKEN)
  [ -n "$tok" ] || { echo "cli.sh: no VSCODE_TOKEN in .env -- run '$0 up' first" >&2; return 1; }
  port=$(vscode_port)
  url="http://127.0.0.1:$port/?tkn=$tok&folder=/workspaces"
  echo "$url"
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$url" | pbcopy && echo "(copied to clipboard)"
  fi
}

# Before a start: does THIS Mac already listen on a port the target had last
# time? Lima then forwards nothing for it, and never retries once the Mac lets
# go (tests/probes/vm-loopback-forward.sh L6) -- so the URL would just not
# answer. Said before the start, with the command that moves it. Only a start
# is checked; every other op passes through untouched, and so does a target
# with nothing saved yet.
warn_if_the_mac_holds_saved_ports() {
  local project="" worktree="" arg
  while [ $# -gt 0 ]; do
    arg=$1; shift
    case "$arg" in
      --stop|--ports|--purge|--list|--uncommitted|--populate|-h|--help) return 0 ;;
      --worktree) worktree=${1:-}; shift ;;
      --config|--branch) shift ;;
      -*) ;;
      *) project=$arg ;;
    esac
  done
  [ -n "$project" ] && command -v lsof >/dev/null 2>&1 || return 0
  local where=("$project"); [ -n "$worktree" ] && where+=(--worktree "$worktree")
  docker exec "$ORCHESTRATOR" desolate-run --ports "${where[@]}" 2>/dev/null \
    | awk '/-> http:\/\/127\.0\.0\.1:/ { label=$1; sub(/^container:/, "", label);
                                          n=split($NF, a, ":"); print label, a[n] }' \
    | while read -r label port; do
        if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
          echo "cli.sh: WARNING -- something on this Mac already listens on $port ($label's port)." >&2
          echo "        Lima will not forward it, so that URL will not answer. Move it:" >&2
          echo "          ./cli.sh desolate --ports ${where[*]} --move $label <a free port>" >&2
        fi
      done
}

# The stack bind-mounts the ingress's two directories out of the VM, so they
# must exist BEFORE compose runs -- or `up` dies with "bind source path does not
# exist" and says nothing about why. They come with desolate-ingress, which a
# VM provisioned before it does not have: install it first (--proxy-only, so
# docker is not restarted), and refuse if that does not take.
require_vm_ingress() {
  [ "${DESOLATE_SKIP_VM_CHECK:-0}" = 1 ] && return 0
  if vm test -d /run/desolate-ingress/ports && vm test -d /run/desolate-ingress/dinds \
     && vm systemctl is-active --quiet desolate-ingress; then
    return 0
  fi
  echo "cli.sh: the VM has no desolate-ingress yet (dev-server ports reach the Mac through it)."
  echo "cli.sh: installing the VM proxy layer, which carries it..."
  vm_install --proxy-only && vm test -d /run/desolate-ingress/ports \
    && vm systemctl is-active --quiet desolate-ingress && return 0
  echo "cli.sh: FAILED to install desolate-ingress -- see the installer output above." >&2
  echo "        Fix it, then:  ./cli.sh vm install --proxy-only && ./cli.sh up" >&2
  return 1
}

# A malformed VSCODE_PORT fails here, in words, rather than as a compose error.
require_free_vscode_port() {
  local port
  port=$(vscode_port)
  case "$port" in
    ''|*[!0-9]*)
      echo "cli.sh: VSCODE_PORT='$port' is not a port number (1-65535)" >&2; exit 1 ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "cli.sh: VSCODE_PORT=$port is out of range (1-65535)" >&2; exit 1
  fi
}

# Tab completion is a per-shell registration -- `complete -F` binds a function
# in the shell that runs it and nowhere else -- so it has to be re-established
# in every new terminal, which means a line in the user's rc file. cli.sh adds
# that line itself, once, rather than leaving it to a README step nobody
# performs.
#
# The guards below are what make writing to someone else's rc file defensible:
#
#   - a marker, so re-running is a grep and not a second copy
#   - `[ -t 1 ]`, so a script or CI job driving cli.sh never edits a dotfile
#   - `[ -r ]` around the emitted source line, so moving or deleting this repo
#     makes completion go quiet instead of printing an error at the top of
#     every shell, forever, from a file the user did not write
#   - an env var to decline, and a printed line saying what changed and how to
#     undo it. A tool that silently edits your shell config is a tool you stop
#     trusting the first time you find out.
COMPLETION_MARKER='# added by desolate cli.sh -- tab completion'
 
# Which rc file the LOGIN shell reads. Keyed off $SHELL, not the shell cli.sh
# is running under: that one is bash from the shebang no matter what the user
# actually uses, and on a Mac they almost certainly use zsh.
completion_rc() {
  case "${SHELL##*/}" in
    zsh)
      printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      # Terminal.app and iTerm open LOGIN shells. Login bash reads
      # ~/.bash_profile and NOT ~/.bashrc, so on a Mac with a .bash_profile
      # already present, ~/.bashrc is the file where the line would sit and
      # never be read -- the failure mode being "I installed it and nothing
      # happened".
      if [ "$(uname -s)" = Darwin ] && [ -f "$HOME/.bash_profile" ]; then
        printf '%s' "$HOME/.bash_profile"
      else
        printf '%s' "$HOME/.bashrc"
      fi ;;
    *)
      return 1 ;;   # fish, nushell, something else: not ours to edit
  esac
}
 
ensure_completion() {
  if [ "${DESOLATE_NO_COMPLETION_INSTALL:-0}" = 1 ]; then return 0; fi
  # STDERR, not stdout: this is the fd the announcement below goes to, so
  # testing it is the same question as "can we tell them what we changed?".
  # Testing stdout instead would skip the install for `./cli.sh up > log.txt`
  # -- a human at a terminal who merely redirected output -- while still
  # firing for a CI job that happened to leave stdout attached.
  if [ ! -t 2 ]; then return 0; fi
 
  local script="$SCRIPT_DIR/completion.sh" rc
  if [ ! -r "$script" ]; then return 0; fi
  if ! rc=$(completion_rc); then return 0; fi
 
  if [ -f "$rc" ] && grep -Fq "$COMPLETION_MARKER" "$rc"; then return 0; fi
 
  {
    printf '\n%s\n' "$COMPLETION_MARKER"
    printf '[ -r "%s" ] && . "%s"\n' "$script" "$script"
  } >> "$rc" || {
    echo "cli.sh: could not write $rc -- add this line yourself for completion:" >&2
    echo "        . \"$script\"" >&2
    return 0
  }
 
  echo "cli.sh: tab completion installed in $rc." >&2
  echo "        Active in NEW shells; for this one:  . \"$script\"" >&2
  echo "        Undo by deleting those two lines. Skip with" >&2
  echo "        DESOLATE_NO_COMPLETION_INSTALL=1." >&2
}
 
# Checked on EVERY invocation, not just the first: the check is one grep, and
# an rc file the user has since edited or replaced should get the line back.
ensure_completion

TTY=(-i); [ -t 0 ] && [ -t 1 ] && TTY=(-it)

CMD="${1:-help}"; shift || true
case "$CMD" in
  up)        # BEFORE compose, not after: if the docker context and
             # COLIMA_PROFILE are different machines, the stack comes up on one
             # while every VM-side check below inspects the other. The symptoms
             # are baffling and none of them mention the VM -- `down` clears
             # containers the installer cannot see, and volumes you believed you
             # destroyed along with a VM are still there, because the VM you
             # destroyed was not the one holding them.
             require_matching_vm || exit 1
             require_sysbox
             require_free_vscode_port
             require_vm_ingress || exit 1
             compose up -d --build "$@"
             ensure_vm_proxy || exit 1
             if [ -x "$SCRIPT_DIR/preflight.sh" ]; then "$SCRIPT_DIR/preflight.sh" || true; fi
             echo
             echo "Editor:"
             editor_url || true ;;

  down)      if [ "${1:-}" = "-v" ]; then
               echo "This DELETES all workspaces, settings and inner images."
               read -r -p "Type 'yes' to confirm: " a; [ "$a" = yes ] || exit 1
             fi
             compose down "$@"
             # Project dinds are the supervisor's, not compose's, so compose
             # cannot see them. Stopped and removed here with their bridges;
             # their image stores (dind-data-*) stay unless -v, like compose's.
             DINDS=$(docker ps -aq --filter label=desolate.dind)
             if [ -n "$DINDS" ]; then
               echo "cli.sh: removing $(echo "$DINDS" | wc -w | tr -d ' ') project dind(s)"
               # shellcheck disable=SC2086
               docker rm -f $DINDS >/dev/null
             fi
             for net in $(docker network ls -q --filter label=desolate.dind); do
               docker network rm "$net" >/dev/null 2>&1 || echo "cli.sh: network $net still in use; left"
             done
             # Nothing the ingress forwards to is left, and a dind's address is
             # one docker may hand a DIFFERENT dind next time: a stale entry
             # would forward to it. So both directories go with the stack.
             vm sudo sh -c 'rm -f /run/desolate-ingress/ports/* /run/desolate-ingress/dinds/*' 2>/dev/null \
               || echo "cli.sh: could not clear the ingress's files in the VM; the supervisor prunes dinds/ when it starts"
             if [ "${1:-}" = "-v" ]; then
               # shellcheck disable=SC2046
               docker volume rm $(docker volume ls -q --filter name='^dind-data-') >/dev/null 2>&1 || true
             fi ;;

  build)     compose build "$@" ;;

  reset-inner)
             # Deliberately NOT ensure_running: the editor is not what this
             # recovers, and on the boot where dind never came up it is not
             # running either.
             require_dind
             require_classifier
             FLAG="${1:-}"
             if [ -n "$FLAG" ] && ! data_root_reset_requested "$FLAG"; then
               echo "usage: cli.sh reset-inner [$RESET_DATA_ROOT_FLAG]" >&2
               exit 1
             fi
             reset_inner "$FLAG" ;;

  dind)      # Project dinds (supervisor.ts drives them; this asks it). The
             # shared daemon keeps its own commands: reset-inner, and --all.
             SUB="${1:-list}"; shift || true
             case "$SUB" in
               list)
                 require_supervisor
                 supervisor list ;;
               reset)
                 require_supervisor
                 select_project_dind "${1:?usage: cli.sh dind reset <project> [$RESET_DATA_ROOT_FLAG]}"
                 FLAG="${2:-}"
                 if [ -n "$FLAG" ] && ! data_root_reset_requested "$FLAG"; then
                   echo "usage: cli.sh dind reset <project> [$RESET_DATA_ROOT_FLAG]" >&2
                   exit 1
                 fi
                 require_dind
                 require_classifier
                 reset_inner "$FLAG" ;;
               df)
                 dind_df ;;
               gc)
                 # An if-chain, not a case: completion reads this dispatch's
                 # case labels as subcommands, and these are flags.
                 GC="${1:-}"
                 if [ "$GC" = --orphans ]; then
                   dind_running || { echo "cli.sh: $DIND is not running" >&2; exit 1; }
                   gc_orphans
                 elif [ "$GC" = --all ]; then
                   while read -r NAME SOCKET; do
                     [ -n "$NAME" ] && gc_daemon "$NAME" "$SOCKET"
                   done < <(running_daemons)
                 elif [ -z "$GC" ] || [ "${GC#-}" != "$GC" ]; then
                   echo "usage: cli.sh dind gc {<project>|--all|--orphans}" >&2; exit 1
                 else
                   select_project_dind "$GC"
                   dind_running || { echo "cli.sh: $DIND is not running; gc reads a running daemon" >&2; exit 1; }
                   gc_daemon "$DIND" "${INNER_SOCKET#unix://}"
                 fi ;;
               *) echo "usage: cli.sh dind {list|reset <project> [$RESET_DATA_ROOT_FLAG]|df|gc {<project>|--all|--orphans}}" >&2; exit 1 ;;
             esac ;;

  logs)      compose logs "${@:--f --tail=100}" ;;
  ps)        compose ps ;;
  preflight) exec "$SCRIPT_DIR/preflight.sh" ;;
  observe)   exec "$SCRIPT_DIR/observe.sh" "$@" ;;
  url)       editor_url ;;

  secret)    # Secrets live ONLY in the Colima VM, below the sysbox boundary.
             # Containers carry the placeholder NAME; the proxy substitutes the
             # real value in-flight, and only toward the allowlisted hosts.
             SUB="${1:-list}"; shift || true
             case "$SUB" in
               add)
                 NAME="${1:?usage: cli.sh secret add NAME --hosts a.com,b.com}"; shift
                 HOSTS=""
                 while [ $# -gt 0 ]; do
                   case "$1" in --hosts) HOSTS="$2"; shift 2 ;; *) shift ;; esac
                 done
                 [ -n "$HOSTS" ] || { echo "cli.sh: --hosts is required (a secret with no allowlist is refused by the proxy)" >&2; exit 1; }
                 case "$NAME" in *[!A-Za-z0-9._-]*) echo "cli.sh: placeholder must be [A-Za-z0-9._-]" >&2; exit 1 ;; esac
                 # HOSTS is interpolated into a remote shell command via `colima ssh`,
                 # and lands inside a JSON document. Restrict it to what a hostname
                 # glob can legitimately contain so neither can be broken out of.
                 case "$HOSTS" in *[!A-Za-z0-9.*_,-]*)
                   echo "cli.sh: --hosts may only contain [A-Za-z0-9.*_-] and commas" >&2; exit 1 ;; esac
                 # An empty field would reach the VM as "" in the JSON array,
                 # where the loop below can no longer see it.
                 case ",$HOSTS," in *,,*)
                   echo "cli.sh: --hosts has an empty entry (a stray comma?)" >&2; exit 1 ;; esac
                 # Each entry has to name where this secret may go. The charset
                 # check above still lets "*" through, and "*" is the one entry
                 # that undoes the whole substitution model.
                 for H in ${HOSTS//,/ }; do
                   host_pattern_pins_a_destination "$H" || {
                     echo "cli.sh: --hosts entry '$H' does not name a destination." >&2
                     echo "        A secret is only bounded by the hosts it may be sent to, so" >&2
                     echo "        '*' (and '*.com', and '*foo.com' -- a glob does not stop at a" >&2
                     echo "        dot) are refused. Name the hosts, or wildcard one leading" >&2
                     echo "        label: --hosts api.openai.com,*.openai.com" >&2
                     exit 1; }
                 done
                 HOSTS_JSON=$(printf '%s' "$HOSTS" | awk -F, '{printf "["; for(i=1;i<=NF;i++){printf "%s\"%s\"", (i>1?",":""), $i}; printf "]"}')
                 printf 'value for %s (input hidden): ' "$NAME" >&2
                 stty -echo 2>/dev/null; IFS= read -r VALUE; stty echo 2>/dev/null; echo >&2
                 [ -n "$VALUE" ] || { echo "cli.sh: empty value" >&2; exit 1; }
                 # `read -r` strips the trailing newline but KEEPS a carriage
                 # return, so a key pasted from anything CRLF-flavoured is stored
                 # with a trailing \r. The proxy then substitutes it into an
                 # Authorization header, the CR corrupts the request, and the
                 # upstream answers with an opaque HTML 403 that mentions
                 # neither desolate nor the header. Nothing downstream can
                 # diagnose that, so strip it here.
                 VALUE=${VALUE//$'\r'/}
                 VALUE=${VALUE#"${VALUE%%[![:space:]]*}"}   # trim leading space
                 VALUE=${VALUE%"${VALUE##*[![:space:]]}"}   # trim trailing space
                 [ -n "$VALUE" ] || { echo "cli.sh: value was only whitespace" >&2; exit 1; }
                 # Interior whitespace is almost certainly a broken paste; a
                 # secret that silently does not work is worse than a refusal.
                 case "$VALUE" in
                   *[[:space:]]*)
                     echo "cli.sh: the value contains whitespace, which is unusual for an API key." >&2
                     echo "        If your terminal wrapped or truncated the paste, re-run this." >&2
                     echo "        Refusing rather than storing a key that will fail opaquely." >&2
                     exit 1 ;;
                 esac
                 # value travels on stdin, never in argv (so it can't show in ps)
                 # umask 077 first: the temp file holds every secret in the store,
                 # and jq's redirect would otherwise create it 0644 for the window
                 # between write and install.
                 printf '%s\n' "$VALUE" | vm sudo sh -c '
                   umask 077
                   IFS= read -r V
                   F=/etc/desolate-proxy/settings.json
                   T=$(mktemp)
                   trap "rm -f \"$T\"" EXIT INT TERM
                   [ -f "$F" ] || echo "{\"secrets\":{},\"network\":[{\"action\":\"allow\",\"host\":\"*\"}],\"scrub_responses\":true}" > "$F"
                   OVERLAP=$(jq -r --arg n "$1" "$3" "$F" | paste -sd, -)
                   [ -z "$OVERLAP" ] || {
                     echo "cli.sh: placeholder $1 overlaps an existing one: $OVERLAP" >&2
                     echo "        One name contains the other, and the proxy substitutes by plain" >&2
                     echo "        string replace: a request carrying the longer name would be" >&2
                     echo "        judged against the shorter allowlist and receive the wrong" >&2
                     echo "        value, with the leftover characters glued on. Pick a name that" >&2
                     echo "        neither contains nor is contained by those." >&2
                     exit 1; }
                   jq --arg n "$1" --arg v "$V" --argjson h "$2" \
                      ".secrets[\$n] = {value: \$v, hosts: \$h}" "$F" > "$T" \
                     && install -m 0600 -o desolate-proxy -g desolate-proxy "$T" "$F" \
                     && echo "stored"' _ "$NAME" "$HOSTS_JSON" "$SECRET_COLLISION_JQ"
                 echo "Use it by putting the PLACEHOLDER in your devcontainer.json:"
                 echo "  \"containerEnv\": { \"YOUR_ENV_VAR\": \"$NAME\" }"
                 ;;
               list)
                 # Three distinguishable states, deliberately: no settings file
                 # yet, a file with no secrets, and a store we could not read.
                 # The old one printed "(no secrets configured yet)" for all
                 # three, so a broken query looked like an empty store.
                 if ! vm sudo test -f /etc/desolate-proxy/settings.json 2>/dev/null; then
                   echo "  (no secrets configured yet -- run: $0 secret add NAME --hosts ...)"
                   exit 0
                 fi
                 OUT=$(vm sudo jq -r "$SECRET_LIST_JQ" /etc/desolate-proxy/settings.json 2>&1) || {
                   echo "cli.sh: could not read the secret store:" >&2
                   printf '%s\n' "$OUT" >&2
                   exit 1
                 }
                 if [ -z "${OUT//[[:space:]]/}" ]; then
                   echo "  (no secrets stored yet)"
                 else
                   # Formatting happens HERE, on the Mac, where quoting is ours.
                   printf '%s\n' "$OUT" | awk -F'\t' '{
                     hosts=$2; for (i=3; i<=NF; i++) hosts = hosts ", " $i
                     printf "  %s  ->  %s\n", $1, hosts
                   }'
                 fi
                 ;;
               rm)
                 NAME="${1:?usage: cli.sh secret rm NAME}"; shift
                 case "$NAME" in *[!A-Za-z0-9._-]*) echo "cli.sh: placeholder must be [A-Za-z0-9._-]" >&2; exit 1 ;; esac
                 # --force stays reachable: deleting the fixture used to be the
                 # only cure for it 403ing traffic that merely named it, and if
                 # addon.py's narrowed match ever regresses, an undeletable
                 # fixture means an unusable stack.
                 if [ "$NAME" = "$SELFTEST_FIXTURE" ] && [ "${1:-}" != "--force" ]; then
                   explain_selftest_fixture_is_not_a_secret
                   exit 1
                 fi
                 vm sudo sh -c 'umask 077; F=/etc/desolate-proxy/settings.json; T=$(mktemp); trap "rm -f \"$T\"" EXIT INT TERM
                   jq --arg n "$1" "del(.secrets[\$n])" "$F" > "$T" \
                   && install -m 0600 -o desolate-proxy -g desolate-proxy "$T" "$F" && echo removed' _ "$NAME"
                 ;;
               *) echo "usage: cli.sh secret {add NAME --hosts a,b | list | rm NAME [--force]}" >&2; exit 1 ;;
             esac ;;

  vm)        SUB="${1:-status}"; shift || true
             case "$SUB" in
               install) vm_install "$@" ;;
               status)  # Informational: always exits 0. `cli.sh preflight` is the
                        # one that asserts and fails.
                        UNITS=$(vm systemctl is-active desolate-proxy desolate-nft desolate-proxy-ca desolate-dnsmasq \
                                  2>/dev/null | paste -sd' ' - || true)
                        echo "profile:      $COLIMA_PROFILE"
                        echo "docker ctx:   $(docker info --format '{{.Name}}' 2>/dev/null || echo '(no daemon)')"
                        echo "ssh target:   $(vm hostname 2>/dev/null | tr -d '\r' || echo '(unreachable)')"
                        echo "sysbox:       $(docker info --format '{{json .Runtimes}}' 2>/dev/null \
                                               | grep -q sysbox-runc && echo present || echo MISSING)"
                        echo "repo in VM:   $(vm_repo_visible && echo "$SCRIPT_DIR" || echo "not visible")"
                        echo "live bridges:  editor=$(live_bridge "$COMPOSE_NET" || echo "(not up)")" \
                             "containers=$(live_bridge "$COMPOSE_DIND_NET" || echo "(not up)")"
                        echo "armed bridges: editor=$(armed_bridge DESOLATE_IF || echo "(not installed)")" \
                             "containers=$(armed_bridge DESOLATE_DIND_IF || echo "(not installed)")"
                        echo "units:        ${UNITS:-(unreachable)}"
                        # The VM's own resolver, not the containers'. dnsmasq on
                        # :5353 serves containers; something else must answer on
                        # :53 or every image pull the VM makes fails with an
                        # error that reads like a Docker problem.
                        echo "vm dns:       $(vm getent hosts registry-1.docker.io >/dev/null 2>&1 \
                                                && echo "resolving" \
                                                || echo "BROKEN -- nothing answering on :53? see 'cli.sh vm install'")" ;;
               *) echo "usage: cli.sh vm {install [--proxy-only]|status}" >&2; exit 1 ;;
             esac ;;

  proxy)     SUB="${1:-status}"; shift || true
             case "$SUB" in
               status) colima ssh -p "$COLIMA_PROFILE" -- sudo systemctl --no-pager --plain status desolate-proxy | head -8 ;;
               logs)   colima ssh -p "$COLIMA_PROFILE" -- sudo journalctl -u desolate-proxy -n "${1:-50}" --no-pager ;;
               audit)  # What was contacted, and whether a secret went with it.
                       #
                       # Reads the AUDIT lines addon.py emits (one per request,
                       # fixed field order) rather than the prose log lines
                       # beside them, which are for humans and change freely.
                       #
                       # Neither carries a secret VALUE, and neither carries a
                       # query string -- a token in a URL would otherwise end up
                       # in journald, which is not the 0600 file secrets are
                       # supposed to live in. Names only; that is the point of
                       # the column.
                       N="${1:-200}"
                       case "$N" in *[!0-9]*) echo "cli.sh: proxy audit takes a line count" >&2; exit 1 ;; esac
                       colima ssh -p "$COLIMA_PROFILE" -- \
                         sudo journalctl -u desolate-proxy -n "$N" --no-pager -o cat \
                       | grep -a "^AUDIT " \
                       | sed -e 's/^AUDIT //' \
                       | awk '
                           {
                             verdict=""; method=""; host=""; path=""; secrets=""; suspect="";
                             for (i = 1; i <= NF; i++) {
                               split($i, kv, "=");
                               v = substr($i, index($i, "=") + 1);
                               if (kv[1] == "verdict") verdict = v;
                               else if (kv[1] == "method") method = v;
                               else if (kv[1] == "host")  host = v;
                               else if (kv[1] == "path")  path = v;
                               else if (kv[1] == "secrets") secrets = v;
                               else if (kv[1] == "suspect") suspect = v;
                             }
                             if (secrets == "-") secrets = "";
                             if (suspect == "-") suspect = "";
                             printf "%-14s %-6s %s%s%s%s\n", verdict, method, host, path,
                                    (secrets == "" ? "" : "   <- " secrets),
                                    (suspect == "" ? "" : "   NOT substituted: " suspect);
                           }'
                       ;;
               test)   ensure_running
                       # `with-ca` is load-bearing: the orchestrator trusts the
                       # proxy CA via that wrapper's env vars, and `docker exec`
                       # inherits nothing the entrypoint exported. Without it
                       # every HTTPS probe below dies on cert verification and
                       # looks like a dead proxy.
                       echo "-- substitution + response scrubbing (expects the PLACEHOLDER echoed back):"
                       docker exec "$ORCHESTRATOR" with-ca sh -c \
                         'curl -s https://httpbin.org/headers -H "Authorization: Bearer DESOLATE-SELFTEST-PLACEHOLDER"' \
                         | grep -i authorization || echo "   (no response -- is the proxy up?)"
                       # Since #12 the placeholder goes out unsubstituted rather
                       # than being refused, so the evidence is the audit line.
                       echo "-- leak detection (expects the placeholder passed UNSUBSTITUTED, audited LEAK-SUSPECT):"
                       # A path no earlier run used, so a stale line cannot answer.
                       MARK="desolate-proxy-test-$(date +%s)-$$"
                       docker exec "$ORCHESTRATOR" with-ca sh -c \
                         "curl -s -o /dev/null -w '   HTTP %{http_code}\n' https://example.com/$MARK -H 'X-Exfil: DESOLATE-SELFTEST-PLACEHOLDER'"
                       sleep 1
                       colima ssh -p "$COLIMA_PROFILE" -- \
                         sudo journalctl -u desolate-proxy --since -2min --no-pager -o cat \
                       | grep -a "^AUDIT verdict=LEAK-SUSPECT .* path=/$MARK " | tail -n 1 \
                       | sed 's/^/   /' | grep . || echo "   (no LEAK-SUSPECT line -- leak detection is NOT live)" ;;
               *) echo "usage: cli.sh proxy {status|logs [n]|test}" >&2; exit 1 ;;
             esac ;;

  repo)      ensure_running
             SUB="${1:-add}"; shift || true
             case "$SUB" in
               add)
                 OR="${1:?usage: cli.sh repo add owner/repo [alias]}"; AL="${2:-${OR##*/}}"
                 PUB=$(docker exec "$CONTAINER" newrepo key "$OR" "$AL" | tee /dev/stderr \
                        | awk '/^PUBKEY /{sub(/^PUBKEY /,""); print}')
                 [ -n "$PUB" ] || { echo "cli.sh: key setup failed" >&2; exit 1; }
                 TITLE="desolate-$AL"
                 if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
                   echo "cli.sh: registering deploy key via gh as '$TITLE'..."
                   gh api "repos/$OR/keys" --jq ".[] | select(.title==\"$TITLE\") | .id" 2>/dev/null \
                     | while read -r kid; do gh api -X DELETE "repos/$OR/keys/$kid" >/dev/null; done
                   gh api "repos/$OR/keys" -f title="$TITLE" -f key="$PUB" -F read_only=false >/dev/null \
                     && echo "cli.sh: deploy key registered (write access)" \
                     || { echo "cli.sh: gh registration failed (need admin on $OR?) -- add manually:"; echo "  $PUB"; }
                 else
                   command -v pbcopy >/dev/null && printf '%s' "$PUB" | pbcopy \
                     && echo "cli.sh: public key copied to clipboard"
                   echo "Add it at: https://github.com/$OR/settings/keys  (tick 'Allow write access')"
                   command -v open >/dev/null && open "https://github.com/$OR/settings/keys"
                   read -r -p "Press Enter once the key is added..." _
                 fi
                 GN=$(git config --global user.name 2>/dev/null || true)
                 GE=$(git config --global user.email 2>/dev/null || true)
                 docker exec -e GIT_NAME="$GN" -e GIT_EMAIL="$GE" "$CONTAINER" newrepo clone "$OR" "$AL"
                 # Clones land under the owner, so the project is owner/alias.
                 echo "Next: ./cli.sh desolate ${OR%%/*}/$AL" ;;
               status) docker exec "$CONTAINER" newrepo status ;;
               *) echo "usage: cli.sh repo {add owner/repo [alias] | status}" >&2; exit 1 ;;
             esac ;;

  worktree)  ensure_running
             # Creating and removing one runs git in the worktree's sandbox,
             # which the orchestrator starts and which mounts only its project
             # -- never in the editor, which reaches every project
             # (worktrees.ts). `list` runs hardened git in the editor; `add`
             # asks the broker from there, as the editor's own `worktree` does.
             SUB="${1:-list}"; shift || true
             case "$SUB" in
               list|add)
                 exec docker exec "${TTY[@]}" -e DESOLATE_PLANE=mac "$CONTAINER" worktree "$SUB" "$@" ;;
               remove)
                 PROJ="${1:?usage: cli.sh worktree remove <project> <name> [--force]}"
                 NAME="${2:?usage: cli.sh worktree remove <project> <name> [--force]}"
                 case "${3:-}" in
                   "") REMOVE=(--remove-worktree) ;;
                   --force) REMOVE=(--remove-worktree --force) ;;
                   *) echo "usage: cli.sh worktree remove <project> <name> [--force]" >&2; exit 1 ;;
                 esac
                 # Refused if anything in it would be lost (asked in its
                 # sandbox) unless --force; then purged, then removed.
                 exec docker exec -e DESOLATE_PLANE=mac "$ORCHESTRATOR" desolate-run "${REMOVE[@]}" --worktree "$NAME" "$PROJ" ;;
               *) echo "usage: cli.sh worktree {list <project>|add <project> <name> [<branch>]|remove <project> <name> [--force]}" >&2; exit 1 ;;
             esac ;;

  export)    ensure_running
             # Getting files out (#13). /workspaces is one volume the editor
             # mounts, and the editor runs on the daemon this Mac's docker CLI
             # already talks to -- so `docker cp` from it reads the same bytes
             # every devcontainer sees, with no inner daemon involved.
             PROJ="${1:?usage: cli.sh export <project> [<path inside it>]}"
             REL="${2:-.}"
             export_explain() {
               case "$1" in
                 0) return 0 ;;
                 2) echo "cli.sh: no such project: $PROJ" >&2 ;;
                 3) echo "cli.sh: no such path in $PROJ: $REL" >&2 ;;
                 4) echo "cli.sh: '$REL' resolves outside $PROJ (a symlink?); refusing" >&2 ;;
                 *) echo "cli.sh: could not export '$REL' from the editor container (exit $1)" >&2 ;;
               esac
               exit 1
             }
             if [ ! -t 1 ]; then
               # A tar stream, so a pipe or a redirect gets something binary-clean:
               #   ./cli.sh export acme/widgets dist > dist.tar
               set +e
               docker exec "$CONTAINER" with-ca sh -c "$EXPORT_TAR_SH" sh /workspaces "$PROJ" "$REL"
               export_explain $?
               exit 0
             fi
             # On a terminal: unpack beside you, never over something already there.
             # Into a fresh directory first, so the name is the archive's own.
             STAGE=$(mktemp -d ./.desolate-export.XXXXXX)
             trap 'rm -rf "$STAGE"' EXIT
             set +e
             docker exec "$CONTAINER" with-ca sh -c "$EXPORT_TAR_SH" sh /workspaces "$PROJ" "$REL" \
               | tar -xf - -C "$STAGE"
             WHY=("${PIPESTATUS[@]}")
             set -e
             export_explain "${WHY[0]}"
             [ "${WHY[1]}" = 0 ] || { echo "cli.sh: could not unpack the export" >&2; exit 1; }
             NAME=$(ls -A "$STAGE")
             [ -e "./$NAME" ] && { echo "cli.sh: ./$NAME already exists; refusing to overwrite it" >&2; exit 1; }
             mv "$STAGE/$NAME" "./$NAME"
             echo "cli.sh: exported $PROJ/${REL#./} to ./$NAME" ;;

  desolate)  ensure_running
             warn_if_the_mac_holds_saved_ports "$@"
             # From the Mac we use the DIRECT runner in the orchestrator (the
             # Mac is already trusted). Inside the editor, `desolate` is a
             # broker client -- the editor has no daemon access. DESOLATE_PLANE
             # makes the follow-up commands it prints the Mac's spelling (#9).
             exec docker exec "${TTY[@]}" -e DESOLATE_PLANE=mac "$ORCHESTRATOR" desolate-run "$@" ;;

  shell|bash) ensure_running
             # with-ca, because `docker exec` inherits NOTHING the entrypoint
             # exported. A terminal opened in the browser editor is a child of
             # the server process and does get proxy-CA trust; one opened this
             # way would not, so `git lfs`, `curl` and `pip` typed here would
             # fail certificate verification while the same command worked in
             # the browser. Same asymmetry that broke `desolate` from the Mac.
             exec docker exec "${TTY[@]}" -w /workspaces "$CONTAINER" with-ca bash "$@" ;;

  help|-h|--help) usage ;;
  *)         ensure_running
             # Same reason as `shell` above: this runs arbitrary commands in the
             # editor, and plenty of them speak TLS.
             exec docker exec "${TTY[@]}" -w /workspaces "$CONTAINER" with-ca "$CMD" "$@" ;;
esac
