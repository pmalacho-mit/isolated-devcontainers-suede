#!/usr/bin/env bash
# The desolate stack, one level down: inside this repo's own devcontainer.
#
# The real stack is a Colima VM running a sysbox dind, with the egress proxy,
# its resolver and the nftables ruleset as VM services. This devcontainer is
# the same shape one level in -- a privileged dind with nft, python3 and sudo --
# so the VM-side pieces run here as plain processes and the stack comes up on
# this container's daemon. That lets the supervisor, the ingress, the broker
# and the editor be exercised from the editor without restarting the real
# stack, which would end the session doing the work.
#
#   ./tests/environments/nested/run.sh up       # build + start, then verify
#   ./tests/environments/nested/run.sh status   # what is running, re-verified
#   ./tests/environments/nested/run.sh exec <container> <cmd...>
#   ./tests/environments/nested/run.sh down [-v]  # stop it all; -v drops volumes
#
# WHAT IT DOES NOT PROVE. Two things differ from the real stack, and both are
# boundaries the design leans on:
#   - the shared dind runs --privileged under runc, not unprivileged under
#     sysbox (compose.nested.yml -- the only change to the stack itself);
#   - there is no Lima: nothing here says what reaches the Mac.
# So every line it prints is stamped APPROXIMATION, and a sysbox- or
# Lima-specific answer still comes from the VM.
#
# Refuses to run against a daemon that has sysbox-runc: that is a real desolate
# VM, and this would put a privileged dind on it.
#
# Needs: sudo, nft, docker, a python with mitmproxy 11.0.2 (DESOLATE_MITMDUMP,
# or the venv tests/README.md describes), and /desolate-ca (this repo's own
# devcontainer has it) to derive a CA-trusting build base. Installs dnsmasq-base
# with apt if it is missing. Creates the `desolate-proxy` system user if it is
# missing, and removes it again on `down` only if it created it.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
RELEASE="$ROOT/release"
STATE=${DESOLATE_NESTED_STATE:-/tmp/desolate-nested}
CONFDIR=/var/lib/desolate-proxy        # compose mounts $CONFDIR/public as /desolate-ca
INGRESS_ROOT=/run/desolate-ingress     # desolate-ingress.tmpfiles
PROXY_USER=desolate-proxy
INGRESS_USER=desolate-ingress
BUILD_BASE=debian:bookworm-slim         # the one FROM in release/vscode-image/Dockerfile

exec > >(sed -u 's/^/APPROXIMATION (runc, no Lima) | /') 2>&1

note() { printf '      %s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }
die()  { bad "$*"; exit 1; }

compose() {
  docker compose -p desolate --project-directory "$RELEASE" \
    -f "$RELEASE/docker-compose.yml" -f "$HERE/compose.nested.yml" \
    --env-file "$STATE/.env" "$@"
}

as_proxy() {   # run a command as the proxy's own uid, detached, logging to $1
  as_user "$PROXY_USER" "$@"
}

as_user() {   # <user> <log> <command...>
  local user=$1 log=$2; shift 2
  sudo setpriv --reuid="$user" --regid="$user" --init-groups \
    env HOME="$CONFDIR" DESOLATE_SETTINGS="$STATE/settings.json" PYTHONUNBUFFERED=1 \
    DESOLATE_INGRESS_ROOT="$INGRESS_ROOT" \
    setsid "$@" >"$log" 2>&1 </dev/null &
  echo $!
}

ensure_user() {   # created here only if missing, and then removed on `down`
  id "$1" >/dev/null 2>&1 && return
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$1" || die "could not create the $1 user"
  echo "$1" >> "$STATE/created-users"
}

alive() { [ -f "$1" ] && sudo kill -0 "$(cat "$1")" 2>/dev/null; }

find_mitmdump() {
  for candidate in "${DESOLATE_MITMDUMP:-}" /opt/desolate-proxy/venv/bin/mitmdump \
                   /tmp/desolate-test312/bin/mitmdump /tmp/desolate-test/bin/mitmdump; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
}

refuse_a_real_vm() {
  docker info >/dev/null 2>&1 || die "no docker daemon reachable"
  if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q sysbox-runc; then
    die "this daemon has sysbox-runc -- it is a real desolate VM, and this harness
      puts a PRIVILEGED dind on whatever daemon it is pointed at. Refusing."
  fi
  command -v colima >/dev/null 2>&1 && die "colima is on PATH -- this is a Mac, not a devcontainer. Refusing."
  sudo -n true 2>/dev/null || die "needs passwordless sudo (nft, the proxy's uid, dnsmasq)"
}

# --- up ------------------------------------------------------------------------

start_proxy() {
  local mitmdump
  mitmdump=$(find_mitmdump)
  [ -n "$mitmdump" ] || die "no mitmdump: set DESOLATE_MITMDUMP, or build the venv tests/README.md describes"

  ensure_user "$PROXY_USER"
  sudo install -d -m 0750 -o "$PROXY_USER" -g "$PROXY_USER" "$CONFDIR"
  sudo install -d -m 0755 -o "$PROXY_USER" -g "$PROXY_USER" "$CONFDIR/public"
  [ -f "$STATE/settings.json" ] || \
    sudo install -m 0600 -o "$PROXY_USER" -g "$PROXY_USER" \
      "$RELEASE/proxy/vm/settings.example.json" "$STATE/settings.json"

  # Installed, as install.sh installs it into /opt: the proxy's uid has to be
  # able to read it, and a checkout under a private directory is not.
  sudo install -m 0644 "$RELEASE/proxy/vm/addon.py" "$STATE/addon.py"

  if alive "$STATE/proxy.pid"; then
    ok "the proxy is already running (pid $(cat "$STATE/proxy.pid"))"
  else
    # The unit's own flags, plus one: this container's egress is intercepted
    # by the OUTER proxy, so upstream certificates are signed by its CA, which
    # is in the system store and not in mitmproxy's certifi bundle.
    as_proxy "$STATE/proxy.log" "$mitmdump" --mode transparent \
      --listen-host 0.0.0.0 --listen-port 18080 \
      --set confdir="$CONFDIR" --set block_global=false \
      --set connection_strategy=eager --set ssl_insecure=false \
      --set ssl_verify_upstream_trusted_ca=/etc/ssl/certs/ca-certificates.crt \
      -s "$STATE/addon.py" > "$STATE/proxy.pid"
  fi
  # Its own "listening" line, not the CA file: mitmproxy writes the CA BEFORE
  # it loads the addon, so a proxy that is about to die of a bad script has
  # one too.
  for _ in $(seq 1 60); do grep -q "listening at" "$STATE/proxy.log" 2>/dev/null && break; sleep 0.5; done
  grep -q "listening at" "$STATE/proxy.log" 2>/dev/null && alive "$STATE/proxy.pid" \
    || { tail -5 "$STATE/proxy.log"; die "the proxy did not come up"; }
  # While STARTING: up to its listening line. A proxy that has been carrying
  # traffic for hours has logged upstream errors of its own, and those say
  # nothing about whether it started.
  awk '/listening at/ {exit} {print}' "$STATE/proxy.log" | grep -qi "error" \
    && { tail -5 "$STATE/proxy.log"; die "the proxy logged an error while starting"; }
  ok "mitmproxy + addon.py on :18080 as $PROXY_USER ($mitmdump)"

  # desolate-proxy-ca.service: the cert and the two scripts, never the key.
  sudo install -m 0644 "$CONFDIR/mitmproxy-ca-cert.pem" "$CONFDIR/public/ca.pem"
  sudo install -m 0755 "$RELEASE/proxy/container/install-ca.sh" "$CONFDIR/public/install-ca.sh"
  sudo install -m 0755 "$RELEASE/proxy/container/trust-proxy-in-builds.sh" "$CONFDIR/public/trust-proxy-in-builds.sh"
  sudo install -m 0755 "$RELEASE/proxy/container/desolate-net" "$CONFDIR/public/desolate-net"
  if ! alive "$STATE/ca.pid"; then
    as_proxy "$STATE/ca.log" "$(dirname "$mitmdump")/python3" -m http.server 18081 \
      --directory "$CONFDIR/public" > "$STATE/ca.pid"
  fi
  ok "CA published at $CONFDIR/public (and :18081)"
}

start_resolver() {
  command -v dnsmasq >/dev/null 2>&1 || {
    note "installing dnsmasq-base (apt over plain http)"
    sudo apt-get update -qq >/dev/null 2>&1
    sudo apt-get install -y -qq dnsmasq-base >/dev/null 2>&1 || die "could not install dnsmasq-base"
  }
  sed "s|^pid-file=.*|pid-file=$STATE/dnsmasq.pid|" "$RELEASE/proxy/vm/dnsmasq-desolate.conf" > "$STATE/dnsmasq.conf"
  if ! alive "$STATE/dnsmasq.pid"; then
    sudo setsid dnsmasq -k -C "$STATE/dnsmasq.conf" >"$STATE/dnsmasq.log" 2>&1 </dev/null &
    for _ in $(seq 1 20); do [ -s "$STATE/dnsmasq.pid" ] && break; sleep 0.25; done
  fi
  alive "$STATE/dnsmasq.pid" || { tail -5 "$STATE/dnsmasq.log"; die "dnsmasq did not start"; }
  ok "container resolver (dnsmasq) on :5353"
}

start_ingress() {
  local python
  python="$(dirname "$(find_mitmdump)")/python3"
  ensure_user "$INGRESS_USER"
  # desolate-ingress.tmpfiles, applied by hand: dinds/ is the supervisor's
  # (root), ports/ the orchestrator's (uid 1000).
  sudo install -d -m 0755 -o root -g root "$INGRESS_ROOT" "$INGRESS_ROOT/dinds"
  sudo install -d -m 0755 -o 1000 -g 1000 "$INGRESS_ROOT/ports"
  # A running ingress keeps the code it started with, so a changed file is a
  # restart: otherwise `up` verifies yesterday's ingress against today's tree.
  if alive "$STATE/ingress.pid" && ! sudo cmp -s "$RELEASE/proxy/vm/ingress.py" "$STATE/ingress.py"; then
    sudo kill "$(cat "$STATE/ingress.pid")"
    for _ in $(seq 1 20); do alive "$STATE/ingress.pid" || break; sleep 0.25; done
    sudo truncate -s 0 "$STATE/ingress.log"
    ok "ingress.py changed: restarting the ingress"
  fi
  sudo install -m 0644 "$RELEASE/proxy/vm/ingress.py" "$STATE/ingress.py"
  if ! alive "$STATE/ingress.pid"; then
    as_user "$INGRESS_USER" "$STATE/ingress.log" "$python" "$STATE/ingress.py" > "$STATE/ingress.pid"
  fi
  for _ in $(seq 1 20); do grep -q "desolate-ingress watching" "$STATE/ingress.log" 2>/dev/null && break; sleep 0.25; done
  alive "$STATE/ingress.pid" && grep -q "desolate-ingress watching" "$STATE/ingress.log" \
    || { tail -5 "$STATE/ingress.log"; die "the ingress did not start"; }
  ok "desolate-ingress watching $INGRESS_ROOT as $INGRESS_USER"
}

load_ruleset() {
  ensure_user "$INGRESS_USER"   # the ruleset names it; nft refuses an unknown uid
  # install.sh's substitution, with the names compose pins. iifname is a
  # string match, so the ruleset can load before the bridges exist.
  sed -e 's|define DESOLATE_IF = ".*"|define DESOLATE_IF = "br-desolate"|' \
      -e 's|define DESOLATE_DIND_IF = ".*"|define DESOLATE_DIND_IF = "br-desolate-in"|' \
      "$RELEASE/proxy/vm/nftables-desolate.conf" > "$STATE/nftables-desolate.conf"
  sudo nft -f "$STATE/nftables-desolate.conf" || die "nft refused the ruleset"
  sudo nft list table inet desolate >/dev/null 2>&1 || die "the ruleset loaded but no 'inet desolate' table exists"
  ok "nftables 'inet desolate' loaded"
}

shadow_build_base() {
  [ -x /desolate-ca/trust-proxy-in-builds.sh ] || die "no /desolate-ca/trust-proxy-in-builds.sh: this is not a desolate devcontainer"
  /desolate-ca/trust-proxy-in-builds.sh --image "$BUILD_BASE" --shadow >"$STATE/shadow.log" 2>&1 \
    || { tail -5 "$STATE/shadow.log"; die "could not derive a CA-trusting $BUILD_BASE"; }
  touch "$STATE/shadowed"
  ok "$BUILD_BASE shadowed with the outer proxy's CA, for the image build"
}

up() {
  refuse_a_real_vm
  mkdir -p "$STATE"
  [ -f "$STATE/.env" ] || printf 'VSCODE_TOKEN=%s\n' "$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')" > "$STATE/.env"

  echo "== VM-side services, as processes =="
  start_proxy
  start_resolver
  load_ruleset          # names both uids, so after start_proxy made them...
  start_ingress         # ...and before the ingress dials anything
  shadow_build_base

  echo "== the stack, on this container's daemon =="
  compose up -d --build >"$STATE/compose-up.log" 2>&1 || { tail -20 "$STATE/compose-up.log"; die "compose up failed"; }
  ok "compose up"
  verify
}

# --- status / verify -------------------------------------------------------------

verify() {
  local failed=0 code line
  echo "== verify =="
  for pid in proxy ca dnsmasq ingress; do
    if alive "$STATE/$pid.pid"; then ok "$pid is running"; else bad "$pid is NOT running"; failed=1; fi
  done
  if sudo nft list table inet desolate >/dev/null 2>&1; then ok "nftables table present"
  else bad "nftables table missing"; failed=1; fi
  for c in desolate-dind desolate-orchestrator desolate-vscode desolate-keyring desolate-supervisor; do
    state=$(docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null)
    case "$state" in running|running/healthy) ok "$c $state" ;; *) bad "$c ${state:-absent}"; failed=1 ;; esac
  done
  # Interception actually happened -- not merely that the pieces are up. A
  # request from the editor bridge must show up in the addon's own audit log.
  marker="desolate-nested-$(date +%s)-$$"
  code=$(docker exec desolate-orchestrator with-ca curl -s -o /dev/null -w '%{http_code}' \
           --max-time 15 "https://example.com/$marker" 2>/dev/null)
  sleep 1
  line=$(sudo grep -a "AUDIT .* path=/$marker " "$STATE/proxy.log" | tail -n 1)
  if [ -n "$line" ]; then ok "egress from the stack went through addon.py (HTTP $code): ${line#*AUDIT }"
  else bad "a request from the orchestrator (HTTP ${code:-none}) never reached addon.py"; failed=1; fi
  verify_ingress || failed=1
  # The supervisor answers, from the one container allowed to ask it.
  if docker exec desolate-orchestrator node -e '
       const s = require("net").createConnection("/run/supervisor/supervisor.sock");
       s.on("connect", () => s.write(JSON.stringify({ op: "status" }) + "\n"));
       let out = ""; s.on("data", (d) => (out += d));
       s.on("end", () => process.exit(JSON.parse(out.trim().split("\n").pop()).ok ? 0 : 1));
       s.on("error", () => process.exit(1));' 2>/dev/null; then
    ok "the supervisor answers status from the orchestrator"
  else bad "the supervisor did not answer status"; failed=1; fi
  return "$failed"
}

# The forward the Mac will use, minus Lima: a listener on the shared dind's
# INNER daemon (no outer publish), its address under dinds/, a ports/ file,
# and a fetch from this container's 127.0.0.1. What preflight's self-test is.
inner_docker() { docker exec -e DOCKER_HOST=unix:///run/inner/docker.sock desolate-dind docker "$@"; }

verify_ingress() {
  local dind_ip inner=desolate-nested-ingress-selftest body host_port=18996 port=18997
  dind_ip=$(docker inspect -f '{{(index .NetworkSettings.Networks "desolate_dindnet").IPAddress}}' desolate-dind 2>/dev/null)
  [ -n "$dind_ip" ] || { bad "the shared dind has no address on desolate_dindnet"; return 1; }
  inner_docker rm -f "$inner" >/dev/null 2>&1
  inner_docker run -d --rm --name "$inner" -p "$port:$port" alpine/socat \
    "TCP-LISTEN:$port,fork,reuseaddr" "SYSTEM:echo desolate-ingress-selftest" >/dev/null 2>&1 \
    || { bad "could not start the self-test listener in the shared dind"; return 1; }
  # The supervisor publishes the shared dind's address; this only checks it did.
  local published=""
  for _ in $(seq 1 20); do
    published=$(cat "$INGRESS_ROOT/dinds/desolate-dind" 2>/dev/null) && [ -n "$published" ] && break
    sleep 0.5
  done
  if [ "$published" = "$dind_ip" ]; then
    ok "the supervisor published the shared dind's address ($published)"
  else
    bad "dinds/desolate-dind is '${published:-missing}', the dind is at $dind_ip"; return 1
  fi
  printf 'desolate-dind:%s\n' "$port" > "$INGRESS_ROOT/ports/$host_port"
  for _ in $(seq 1 20); do
    # --http0.9: the target answers with a bare line, not HTTP.
    body=$(curl -s --http0.9 -m 1 "http://127.0.0.1:$host_port/" 2>/dev/null) && [ -n "$body" ] && break
    sleep 0.25
  done
  rm -f "$INGRESS_ROOT/ports/$host_port"
  inner_docker rm -f "$inner" >/dev/null 2>&1
  case "$body" in
    *desolate-ingress-selftest*) ok "the ingress forwarded 127.0.0.1:$host_port -> $dind_ip:$port (an inner publish, no outer one)" ;;
    *) bad "nothing came back through the ingress (got '${body:-nothing}'):"; tail -3 "$STATE/ingress.log"; return 1 ;;
  esac

  # The second wall, which does not trust ingress.py: as the ingress's own
  # uid, a NEW connection anywhere but a dind bridge is dropped by nftables.
  # The VM side of the editor bridge stands in for "the VM's own services".
  local editor_gw drops_before drops_after
  editor_gw=$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' desolate_devnet 2>/dev/null)
  ingress_drops() {
    sudo nft list chain inet desolate output 2>/dev/null \
      | awk -v uid="$(id -u "$INGRESS_USER")" '$0 ~ "skuid " uid " counter packets" {for (i=1;i<=NF;i++) if ($i=="packets") print $(i+1)}'
  }
  drops_before=$(ingress_drops)
  for destination in "1.1.1.1:80" "${editor_gw:-172.18.0.1}:18080"; do
    if sudo setpriv --reuid="$INGRESS_USER" --regid="$INGRESS_USER" --init-groups \
         curl -s -o /dev/null -m 3 "http://$destination/" 2>/dev/null; then
      bad "as $INGRESS_USER, $destination was REACHABLE -- the output rule is not holding"; return 1
    fi
    ok "as $INGRESS_USER, $destination is unreachable"
  done
  # Unreachable is not enough: from here 1.1.1.1:80 WOULD answer, through the
  # outer proxy. The rule's own counter says it was this rule that refused.
  drops_after=$(ingress_drops)
  if [ -n "$drops_after" ] && [ "${drops_after:-0}" -gt "${drops_before:-0}" ]; then
    ok "and the ingress uid's drop counter rose ${drops_before:-0} -> $drops_after: it was the rule"
  else
    bad "the ingress uid's drop counter did not move (${drops_before:-?} -> ${drops_after:-?})"; return 1
  fi
}

status() {
  verify && ok "nested stack healthy" || { bad "nested stack is not healthy"; exit 1; }
}

# --- down ------------------------------------------------------------------------

down() {
  local volumes=()
  [ "${1:-}" = "-v" ] && volumes=(-v)
  echo "== down =="
  # Project dinds are the supervisor's, not compose's -- and they hold the
  # compose volumes, so compose cannot remove those until they are gone. The
  # same sweep cli.sh down makes.
  local dinds
  dinds=$(docker ps -aq --filter label=desolate.dind)
  if [ -n "$dinds" ]; then
    # shellcheck disable=SC2086
    docker rm -f $dinds >/dev/null && ok "removed $(echo "$dinds" | wc -w | tr -d ' ') project dind(s)"
  fi
  for net in $(docker network ls -q --filter label=desolate.dind); do
    docker network rm "$net" >/dev/null 2>&1 || bad "network $net still in use"
  done
  if [ ${#volumes[@]} -gt 0 ]; then
    # shellcheck disable=SC2046
    docker volume rm $(docker volume ls -q --filter name='^dind-data-') >/dev/null 2>&1 && ok "removed the project dinds' image stores"
  fi
  if [ -f "$STATE/.env" ]; then
    compose down "${volumes[@]}" >"$STATE/compose-down.log" 2>&1 && ok "compose down ${volumes[*]}" \
      || { tail -5 "$STATE/compose-down.log"; bad "compose down failed"; }
  fi
  for pid in proxy ca dnsmasq ingress; do
    alive "$STATE/$pid.pid" && sudo kill "$(cat "$STATE/$pid.pid")" 2>/dev/null && ok "stopped $pid"
    rm -f "$STATE/$pid.pid"
  done
  sudo nft delete table inet desolate 2>/dev/null && ok "nftables table removed"
  if [ -f "$STATE/shadowed" ]; then
    /desolate-ca/trust-proxy-in-builds.sh --image "$BUILD_BASE" --unshadow >/dev/null 2>&1 \
      && ok "$BUILD_BASE unshadowed" && rm -f "$STATE/shadowed"
  fi
  sudo rm -rf "$INGRESS_ROOT"
  if [ -f "$STATE/created-users" ]; then
    while read -r user; do
      sudo userdel "$user" 2>/dev/null && ok "removed the $user user this harness created"
    done < "$STATE/created-users"
    rm -f "$STATE/created-users"
  fi
  # The CA and the token outlive a plain `down`, as the VM's do across a
  # restart; -v is the clean slate.
  if [ ${#volumes[@]} -gt 0 ]; then
    sudo rm -rf "$CONFDIR" "$STATE" && ok "removed $CONFDIR and $STATE"
  fi
}

case "${1:-}" in
  up)     up ;;
  status) status ;;
  exec)   shift; docker exec -i "$@" ;;
  down)   shift; down "$@" ;;
  *)      sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
