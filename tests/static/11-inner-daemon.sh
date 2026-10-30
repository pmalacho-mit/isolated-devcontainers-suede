#!/usr/bin/env bash
# The one daemon every project shares: what it reports about itself, how it is
# recovered, and what is not allowed to restart into its way.
#
# All three are things that only show up in an incident, which is the worst
# moment to be discovering that the classifier says one thing and cli.sh
# another, or that the destructive rung of the ladder can be reached by falling
# through to it. So the classifier is EXECUTED here against a stub daemon, and
# so is the rung that deletes every project's images.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

CLI="$RELEASE/cli.sh"
HEALTH="$RELEASE/vscode-image/inner-health.sh"
DOCKER_TS="$RELEASE/vscode-image/docker.ts"

# Define one of cli.sh's own functions HERE, so what the assertions below run is
# what ships rather than a copy of it that agreed at the time it was written.
define_from_cli() {
  local body
  body=$(sed -n "/^$1()/,/^}/p" "$CLI")
  if [ -z "$body" ]; then
    fail "found $1 in cli.sh" "sed matched nothing -- was it renamed?"
    return 1
  fi
  pass "found $1 in cli.sh"
  eval "$body"
}

define_from_cli_constant() {
  local line
  line=$(sed -n "s/^\($1=.*\)$/\1/p" "$CLI")
  [ -n "$line" ] || { fail "found $1 in cli.sh" "sed matched nothing -- was it renamed?"; return 1; }
  eval "$line"
}

group "a relay carries no restart policy"
# A relay is socat pointed at an ADDRESS, read when it was created. A restart
# policy outlives what makes that address true: on a daemon restart docker
# brings every relay back before the devcontainers they dial, so each one fails,
# restarts, and adds its own churn to the startup reconciliation this file is
# about -- and a devcontainer recreated on a different address leaves its old
# relay forwarding a host port to whatever now holds the old one.
assert_ok "the relay argv is still built in docker.ts" \
  grep -q 'tcp-listen:' "$DOCKER_TS"
RESTART_FLAG=$(grep -n '"--restart"' "$DOCKER_TS" || true)
assert_eq "no docker argv in docker.ts passes --restart" "${RESTART_FLAG:-none}" "none"

group "everything that asks runs the same classifier"
# Two copies would be two opinions about what "wedged" means, which is the one
# thing this classifier exists to prevent. Three things name the file: the
# healthcheck that decides dind's status, the command that recovers it, and the
# preflight line that used to say "wait, or check logs" without knowing which.
COMPOSE_PATH=$(grep -oE '/desolate-health/[a-z-]+\.sh' "$RELEASE/docker-compose.yml" | sort -u)
assert_eq "docker-compose.yml names exactly one classifier" \
  "$(printf '%s\n' "$COMPOSE_PATH" | grep -c .)" "1"
assert_eq "cli.sh runs the file the healthcheck runs" \
  "$(sed -n 's/^INNER_HEALTH=\(.*\)$/\1/p' "$CLI")" "$COMPOSE_PATH"
assert_eq "preflight.sh runs it too" \
  "$(grep -oE '/desolate-health/[a-z-]+\.sh' "$RELEASE/preflight.sh" | sort -u)" "$COMPOSE_PATH"
assert_ok "and volume-init is what puts it there" \
  grep -q 'install -m 0555 /usr/local/lib/desolate/inner-health.sh' \
  "$RELEASE/docker-compose.yml"

group "the classifier tells booting from wedged"
# The distinction the healthcheck's exit code could not carry: a daemon that is
# booting normally and one that will never finish reconciling were the same
# `unhealthy`, two minutes later, and two minutes of a stack that might be fine
# is long enough to start pulling on things.
STUB=$(mktemp -d)
trap 'rm -rf "$STUB"' EXIT
mkdir -p "$STUB/bin"

# A daemon that behaves however the case under test needs it to.
stub_docker() {
  printf '#!/bin/sh\n%s\n' "$1" > "$STUB/bin/docker"
  chmod +x "$STUB/bin/docker"
}

# Runs the classifier against $STUB/bin/docker; echoes "<status> <output>".
classify() {
  local out status
  out=$(PATH="$STUB/bin:$PATH" DESOLATE_INNER_SOCKET="$1" DESOLATE_INNER_PATIENCE=1 \
          sh "$HEALTH" 2>&1)
  status=$?
  printf '%s %s' "$status" "$out"
}

stub_docker 'exit 0'
assert_contains "no socket yet is booting, and normal" \
  "$(classify "$STUB/absent.sock")" "1 inner daemon: booting"

if ! command -v node >/dev/null 2>&1; then
  skip "the socket-bound states" "needs node to bind a unix socket"
elif ! command -v timeout >/dev/null 2>&1; then
  # dind is busybox and always has one; a bare Mac may not.
  skip "the socket-bound states" "needs 'timeout' (brew install coreutils)"
else
  SOCK="$STUB/docker.sock"
  node -e 'require("net").createServer().listen(process.argv[1],()=>process.exit(0))' "$SOCK"

  stub_docker 'sleep 30'
  assert_contains "a bound socket that does not answer is wedged" \
    "$(classify "$SOCK")" "2 inner daemon: wedged"

  stub_docker 'exit 0'
  assert_contains "info answering is still the definition of healthy" \
    "$(classify "$SOCK")" "0 inner daemon: healthy"

  # A daemon that refuses the connection outright is not booting either: the
  # socket is there, and nothing behind it is serving.
  stub_docker 'exit 1'
  assert_contains "a bound socket that refuses is wedged too" \
    "$(classify "$SOCK")" "2 inner daemon: wedged"
fi

group "reset-inner is reachable"
HELP=$(bash "$CLI" help 2>&1)
assert_contains "cli.sh help lists it" "$HELP" "reset-inner"
# Completion is EXTRACTED from cli.sh's dispatch, so the verb comes for free and
# the flag does not -- it is a flag, not a subcommand, and the extraction skips
# it on purpose. Source the real file and ask it.
# shellcheck source=../../release/completion.sh
. "$RELEASE/completion.sh"
assert_contains "tab completion offers the verb" \
  "$(_desolate_cli_verbs | tr '\n' ' ')" "reset-inner"
COMP_WORDS=(cli.sh reset-inner ""); COMP_CWORD=2; _desolate_cli
assert_contains "tab completion offers the flag" \
  "${COMPREPLY[*]:-}" "--reset-data-root"

group "rung 1 says what a restart would have to reconcile"
# An awk program is a program in another language embedded in this one: `bash -n`
# sees a valid script whatever it says, and this repo has shipped three
# unrunnable jq programs on exactly that basis.
if define_from_cli count_by_state; then
  assert_eq "states are counted and named" \
    "$(count_by_state "$(printf 'running\nexited\nrunning\ndead\n')")" \
    "1 dead, 1 exited, 2 running"
  # The distinction that matters in a report: a daemon holding nothing must not
  # print as a blank where a count belongs.
  assert_eq "nothing to reconcile reads as 'none'" "$(count_by_state "")" "none"
fi

group "rung 2 does not guess on a daemon that will not answer"
# Wedged is the state rung 2 exists for, and a wedged daemon answers no `ps`:
# "no stale relays" there would be a claim nobody measured.
if define_from_cli sweep_inner && define_from_cli inner_ids; then
  inner_docker() { sleep 0; return 124; }
  assert_contains "an unanswered listing is said to be one" \
    "$(sweep_inner "relays" desolate.relay exited)" "cannot sweep relays: the daemon did not answer"
  inner_docker() { return 0; }
  assert_contains "an empty answer is still 'none'" \
    "$(sweep_inner "relays" desolate.relay exited)" "no stale relays"
  unset -f inner_docker
fi

group "a project's daemon cannot make the sweep expand globs here"
# On a project's dind, what `ps` prints comes from binaries the project can
# replace. An unquoted `$ids` expanded a printed `*` against THIS machine's
# files and handed the matches back to that daemon as argv -- the names of
# files on the Mac, to a process the project owns (found in review, measured
# with this stub). Only container ids reach `rm`, and the rest is said.
if define_from_cli sweep_inner && define_from_cli inner_ids; then
  HERE_FILES=$(mktemp -d)
  touch "$HERE_FILES/id_ed25519" "$HERE_FILES/known_hosts"
  REMOVED=""
  inner_docker() {
    case "$1" in
      ps) printf '%s\n' "$HERE_FILES/*" '*' 0123456789ab ;;
      *) shift 2; REMOVED="$*" ;;
    esac
  }
  OUT=$(cd "$HERE_FILES" && sweep_inner "relays" desolate.relay exited; printf 'REMOVED=%s' "$REMOVED")
  assert_contains "only the container id reaches the daemon" "$OUT" "REMOVED=0123456789ab"
  assert_not_contains "no file name from this machine does" "$OUT" "id_ed25519"
  assert_contains "and what was dropped is said" "$OUT" "ignored 2 entries in the listing that are not container ids"
  unset -f inner_docker
  rmdir_files() { find "$HERE_FILES" -type f -delete; rmdir "$HERE_FILES"; }
  rmdir_files
fi

group "the rung that deletes every project's images needs asking for"
# EXECUTED, not read: rung 3 is today's folklore ("delete the data root") turned
# into a command, and the whole reason to have it as a command is that the
# ladder above it must not be able to fall through into it.
for constant in RESET_DATA_ROOT_FLAG DIND_DATA_VOLUME DIND_SERVICE; do
  define_from_cli_constant "$constant"
done
for fn in data_root_reset_requested explain_data_root_reset reset_data_root; do
  define_from_cli "$fn"
done

# If the refusal ever stops refusing, these are what it would reach for. They
# report loudly instead of running.
BREACHED=""
compose() { BREACHED="compose $*"; }
docker()  { BREACHED="docker $*"; }
# Declining, which is the other half of the guard: the flag asks, the answer
# decides, and "no" has to stop the same way a missing flag does.
confirm_data_root_reset() { BREACHED="prompted for confirmation"; return 1; }

for spelling in "" "--reset" "--reset-data-root=1" "-r" "reset-data-root"; do
  BREACHED=""
  if reset_data_root "$spelling" >/dev/null 2>&1; then
    fail "'${spelling:-(no flag)}' does not reach rung 3" "it returned success"
  elif [ -n "$BREACHED" ]; then
    fail "'${spelling:-(no flag)}' does not reach rung 3" "it ran: $BREACHED"
  else
    pass "'${spelling:-(no flag)}' does not reach rung 3"
  fi
done

# ...and the flag is not merely ignored: the exact spelling gets as far as the
# confirmation, and no further than a refused one.
BREACHED=""
reset_data_root "$RESET_DATA_ROOT_FLAG" >/dev/null 2>&1
assert_eq "the flag reaches the confirmation, and a refusal stops there" \
  "$BREACHED" "prompted for confirmation"
# The stubs shadow the real commands, and the next group needs the real ones.
unset -f compose docker confirm_data_root_reset

group "a project's dind climbs the same ladder"
# `dind reset <project>` is the same functions pointed elsewhere, so what is
# asserted here is the pointing: the names it derives are dind.ts's, a name
# that would derive a different docker object is refused, and each rung that
# acts goes through the supervisor rather than past it.
for fn in valid_project select_project_dind restart_dind delete_data_root; do
  define_from_cli "$fn"
done
for bad in "../etc" "a/b/c" ".hidden" "a__b" "" "a b" "a;rm" "-rf" "acme/widgets@wt" "_x" "acme/-w"; do
  if (select_project_dind "$bad") >/dev/null 2>&1; then
    fail "'$bad' is refused as a project" "it was accepted"
  else
    pass "'$bad' is refused as a project"
  fi
done
# In THIS shell, not a subshell: the harness counts failures in variables, and
# a subshell's would be lost. What it changes is put back at the end.
select_project_dind acme/widgets
NAMES=$(node -e '
  const dind = await import(process.argv[1] + "/vscode-image/dind.ts");
  const { target } = await import(process.argv[1] + "/vscode-image/projects.ts");
  const t = target("/workspaces", "acme/widgets");
  console.log(dind.name(t), dind.volumes(t).data);
' "$RELEASE" 2>/dev/null || true)
if [ -z "$NAMES" ]; then
  skip "cli.sh derives dind.ts's names" "node could not import dind.ts"
else
  assert_eq "cli.sh derives dind.ts's names" "$DIND $DIND_DATA_VOLUME" "$NAMES"
fi
assert_eq "the health check is pointed at the project dind's socket" \
  "${INNER_SOCKET#unix://}" "/run/dind-sock/docker.sock"

CALLS=""
supervisor() { CALLS="$CALLS|$*"; }
compose()    { CALLS="$CALLS|compose $*"; }
docker()     { CALLS="$CALLS|docker $*"; }
restart_dind
assert_eq "rung 2 restarts it through the supervisor, and nothing else" "$CALLS" "|ask reset acme/widgets"
CALLS=""
delete_data_root
assert_eq "rung 3 is the supervisor's purge, then a fresh ensure" "$CALLS" \
  "|ask purge acme/widgets|ask ensure acme/widgets"

# The guard is the same function, and still refuses in this mode.
CALLS=""
confirm_data_root_reset() { CALLS="$CALLS|prompted"; return 1; }
reset_data_root "" >/dev/null 2>&1
assert_eq "rung 3 on a project dind still needs the flag" "${CALLS:-nothing ran}" "nothing ran"
assert_contains "and the refusal names the project's own command" \
  "$(explain_data_root_reset 2>&1)" "dind reset acme/widgets $RESET_DATA_ROOT_FLAG"
assert_contains "and what it would cost: this project's store alone" \
  "$(explain_data_root_reset 2>&1)" "acme/widgets's own image store"
unset -f supervisor compose docker confirm_data_root_reset
define_from_cli_constant DIND_DATA_VOLUME

group "dind is reachable"
assert_contains "cli.sh help lists it" "$(bash "$CLI" help 2>&1)" "dind list"
assert_eq "its subcommands complete, and its flags are not mistaken for them" \
  "$(_desolate_cli_subs dind | tr '\n' ' ')" "list reset df gc "
COMP_WORDS=(cli.sh dind reset acme ""); COMP_CWORD=4; _desolate_cli
assert_contains "tab completion offers the reset flag" "${COMPREPLY[*]:-}" "--reset-data-root"
COMP_WORDS=(cli.sh dind gc ""); COMP_CWORD=3; _desolate_cli
assert_contains "and gc's" "${COMPREPLY[*]:-}" "--orphans"

group "the volume rung 3 deletes is the one compose declares"
# cli.sh names it as a string; compose renders it from its project name. They
# have to be the same volume, and the failure if they are not is a `volume rm`
# that removes something else or nothing at all.
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  skip "the data-root volume name" "docker compose not available"
elif ! command -v jq >/dev/null 2>&1; then
  skip "the data-root volume name" "jq not installed"
else
  CFG=$(cd "$RELEASE" && VSCODE_TOKEN=test-token docker compose -f docker-compose.yml \
          config --format json 2>/dev/null)
  RENDERED=$(printf '%s' "$CFG" | jq -r '.name + "_" + (.volumes | keys[] | select(. == "dind-sysbox-data"))')
  assert_eq "cli.sh names the rendered volume" "$DIND_DATA_VOLUME" "$RENDERED"
fi

summary
