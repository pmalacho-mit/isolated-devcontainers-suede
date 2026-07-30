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
#   ./isolated-devcontainers-suede/cli.sh shell                     # bash in the editor container
#   ./isolated-devcontainers-suede/cli.sh down | logs | ps | preflight | observe
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
  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

COMPOSE_NET=desolate_devnet
PINNED_BRIDGE=br-desolate

# The bridge the LIVE network actually uses.
#
# Deliberately NOT read from docker-compose.yml. driver_opts are applied when
# the network is CREATED, so a network that predates the pin keeps docker's
# br-<hash> name and `docker network inspect` reports Options:{}. Trusting the
# pin there would arm nftables on an interface that does not exist -- rules
# load fine (iifname is a name match, not an ifindex) and match nothing, which
# is exactly the silent no-interception failure we are trying to prevent.
live_bridge() {
  local gw
  gw=$(docker network inspect "$COMPOSE_NET" \
        -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null) || return 1
  [ -n "$gw" ] || return 1
  vm ip -br addr 2>/dev/null | awk -v gw="$gw" '$3 ~ "^"gw"/" {print $1; exit}'
}

# Interface the installed ruleset is armed for ("" if never installed).
armed_bridge() {
  vm sudo sed -n 's/^define DESOLATE_IF = "\(.*\)"$/\1/p' \
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

  local live armed
  live=$(live_bridge || true)
  if [ -z "$live" ]; then
    echo "cli.sh: could not resolve the bridge for '$COMPOSE_NET' -- skipping the" >&2
    echo "        egress check. preflight will report whether interception is on." >&2
    return 0
  fi

  armed=$(armed_bridge || true)
  local why=""
  if [ -z "$armed" ]; then
    why="the egress proxy is not installed in the VM"
  elif [ "$armed" != "$live" ]; then
    why="rules are armed for '$armed' but the stack is on '$live'"
  elif ! vm sudo nft list table inet desolate >/dev/null 2>&1; then
    why="the nftables ruleset is not loaded"
  elif ! vm systemctl is-active --quiet desolate-proxy desolate-nft desolate-proxy-ca desolate-dnsmasq; then
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
    armed=$(armed_bridge || true)
    [ "$armed" = "$live" ] || {
      echo "cli.sh: still armed for '$armed', expected '$live' -- see 'cli.sh preflight'" >&2
      return 1
    }
    echo "cli.sh: egress interception armed for $live"
  fi

  # Pinning exists so the bridge name survives down/up. A network created
  # before the pin keeps br-<hash>, so every recreate silently re-breaks the
  # rules until the network itself is recreated.
  if [ "$live" != "$PINNED_BRIDGE" ]; then
    cat <<EOF
cli.sh: NOTE -- this stack is on '$live', not the pinned '$PINNED_BRIDGE'.
        The network predates the bridge-name pin, so its name will change on
        every recreate and the nftables rules will go stale each time. Fix it
        once with:  ./cli.sh down && ./cli.sh up
EOF
  fi
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

# VSCODE_PORT must not land inside the range dind publishes: both are published on
# 127.0.0.1 on the same daemon, so they would fight over the same address. dind
# starts first (vscode depends_on it), so the loser is the EDITOR -- and the
# symptom is "the editor container is not running" long after the port numbers
# have gone out of mind. Refuse before starting instead.
require_free_vscode_port() {
  local port min max
  port=$(vscode_port)
  min=$(env_value DESOLATE_PORT_MIN); min=${min:-8080}
  max=$(env_value DESOLATE_PORT_MAX); max=${max:-8090}
  case "$port" in
    ''|*[!0-9]*)
      echo "cli.sh: VSCODE_PORT='$port' is not a port number (1-65535)" >&2; exit 1 ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "cli.sh: VSCODE_PORT=$port is out of range (1-65535)" >&2; exit 1
  fi
  if [ "$port" -ge "$min" ] && [ "$port" -le "$max" ]; then
    cat >&2 <<EOF
cli.sh: VSCODE_PORT=$port is inside DESOLATE_PORT_MIN..MAX ($min-$max).

dind publishes that whole range on 127.0.0.1 for dev-server relays, and the
editor would be publishing the same address -- they cannot both have it, and the
editor is the one that loses (it starts after dind).

Fix either side in $SCRIPT_DIR/.env, then './cli.sh up':
  VSCODE_PORT=3000                       # outside $min-$max
  DESOLATE_PORT_MIN / DESOLATE_PORT_MAX  # move the range instead
EOF
    exit 1
  fi
}

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
             compose down "$@" ;;

  build)     compose build "$@" ;;
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
                 [ "${#NAME}" -ge 12 ] || { echo "cli.sh: placeholder must be >=12 chars (avoids substring collisions)" >&2; exit 1; }
                 # HOSTS is interpolated into a remote shell command via `colima ssh`,
                 # and lands inside a JSON document. Restrict it to what a hostname
                 # glob can legitimately contain so neither can be broken out of.
                 case "$HOSTS" in *[!A-Za-z0-9.*_,-]*)
                   echo "cli.sh: --hosts may only contain [A-Za-z0-9.*_-] and commas" >&2; exit 1 ;; esac
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
                   jq --arg n "$1" --arg v "$V" --argjson h "$2" \
                      ".secrets[\$n] = {value: \$v, hosts: \$h}" "$F" > "$T" \
                     && install -m 0600 -o desolate-proxy -g desolate-proxy "$T" "$F" \
                     && echo "stored"' _ "$NAME" "$HOSTS_JSON"
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
                 NAME="${1:?usage: cli.sh secret rm NAME}"
                 case "$NAME" in *[!A-Za-z0-9._-]*) echo "cli.sh: placeholder must be [A-Za-z0-9._-]" >&2; exit 1 ;; esac
                 vm sudo sh -c 'umask 077; F=/etc/desolate-proxy/settings.json; T=$(mktemp); trap "rm -f \"$T\"" EXIT INT TERM
                   jq --arg n "$1" "del(.secrets[\$n])" "$F" > "$T" \
                   && install -m 0600 -o desolate-proxy -g desolate-proxy "$T" "$F" && echo removed' _ "$NAME"
                 ;;
               *) echo "usage: cli.sh secret {add NAME --hosts a,b | list | rm NAME}" >&2; exit 1 ;;
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
                        echo "live bridge:  $(live_bridge || echo "(network not up)")"
                        echo "armed bridge: $(armed_bridge || echo "(proxy not installed)")"
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
                       echo "-- leak detection (expects 403):"
                       docker exec "$ORCHESTRATOR" with-ca sh -c \
                         'curl -s -o /dev/null -w "%{http_code}\n" https://example.com -H "X-Exfil: DESOLATE-SELFTEST-PLACEHOLDER"' ;;
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

  desolate)  ensure_running
             # From the Mac we use the DIRECT runner in the orchestrator (the
             # Mac is already trusted). Inside the editor, `desolate` is a
             # broker client -- the editor has no daemon access.
             exec docker exec "${TTY[@]}" "$ORCHESTRATOR" desolate-run "$@" ;;

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
