#!/usr/bin/env bash
# The blast-radius acceptance test (T5.2): what ONE project's daemon can reach.
#
#   ./tests/integration/stack/blast-radius.sh [--max N] [--keep]
#
# Runs on the Mac against the RUNNING stack (Phases 0-4 deployed), in the
# checkout of this repo. Creates throwaway projects blast-1 .. blast-N (N=10)
# with docker-outside-of-docker, starts them, and purges them -- dind, image
# store and directory -- on exit unless --keep. Expect 20-40 min the first
# time: every project dind pulls its own base image.
#
# A = blast-1 and B = blast-2. Each G is one way the containment fails:
#
#   G1  VISIBILITY  `docker ps` in A's devcontainer lists A's own container and
#                   nothing of B's.
#   G2  FILES       a container A starts with `-v /workspaces/blast-2:/x` never
#                   shows B's files (a random canary), and `-v /workspaces:/x`
#                   shows A alone. The same bind of A's own path does show A's.
#   G3  NETWORK     A's devcontainer reaches neither B's devcontainer, B's dind,
#                   nor the editor -- while it does reach the internet through
#                   the proxy, so a refused connect is the wall, not a dead net.
#   G4  WEDGE       A's dockerd held in SIGSTOP: B still builds, and the editor
#                   still answers.
#   G5  RECOVERY    `cli.sh dind reset blast-1` brings A's daemon back, and
#                   B's devcontainer was never restarted.
#   G6  MEMORY      each dind's `docker stats` memory, and the VM's
#                   MemAvailable, with 2, 5 and N projects open.
#
# DESOLATE_BLAST_NESTED=1 runs it in tests/environments/nested/ instead, where
# it is an APPROXIMATION (runc, no Lima) and says so on every line it prints.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
# shellcheck source=../../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"
CLI=${DESOLATE_CLI:-$ROOT/release/cli.sh}
export DESOLATE_NO_COMPLETION_INSTALL=1

MAX=10 KEEP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --max)  MAX=${2:?--max takes a number}; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *)      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
  esac
done
[ "$MAX" -ge 2 ] 2>/dev/null || { echo "--max must be at least 2" >&2; exit 2; }

STAMP=""
if [ -n "${DESOLATE_BLAST_NESTED:-}" ]; then
  STAMP="APPROXIMATION (runc, no Lima) | "
elif ! docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q sysbox-runc; then
  echo "blast-radius: this daemon has no sysbox-runc, so it is not the desolate VM." >&2
  echo "              In the nested harness, set DESOLATE_BLAST_NESTED=1." >&2
  exit 1
fi
say() { printf '%s%s\n' "$STAMP" "$*"; }
for c in desolate-vscode desolate-orchestrator desolate-supervisor; do
  docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null | grep -qx running \
    || { echo "blast-radius: $c is not running -- start the stack: ./cli.sh up" >&2; exit 1; }
done

project() { echo "blast-$1"; }
A=$(project 1) B=$(project 2)
SPEC='{ "name": "%s", "image": "mcr.microsoft.com/devcontainers/base:bookworm",
  "features": { "ghcr.io/devcontainers/features/docker-outside-of-docker:1": {} } }'

created=()
create() {   # a project directory, its spec, and a canary only it holds
  local p=$1
  printf "$SPEC\n" "$p" | docker exec -i desolate-vscode sh -c \
    "mkdir -p /workspaces/$p/.devcontainer && cat > /workspaces/$p/.devcontainer/devcontainer.json"
  docker exec desolate-vscode sh -c "head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > /workspaces/$p/CANARY"
  created+=("$p")
}
canary() { docker exec desolate-vscode cat "/workspaces/$1/CANARY"; }
start() { "$CLI" desolate "$1" >"$LOGS/$1.log" 2>&1; }
dind_of() { echo "desolate-dind-$1"; }
container_of() {
  docker exec "$(dind_of "$1")" docker ps -q --no-trunc --filter "label=devcontainer.local_folder=/workspaces/$1" 2>/dev/null | head -1
}
# A command in a project's devcontainer, as its user, through its own daemon.
inside() { local p=$1; shift; docker exec "$(dind_of "$p")" docker exec -u 1000 "$(container_of "$p")" sh -c "$*"; }
reaches() { inside "$1" "timeout 5 bash -c '</dev/tcp/$2/$3' 2>/dev/null"; }   # exit 0: connected
address_of() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$1" 2>/dev/null | awk '{print $1}'; }
# Whether the VM itself connects: where a target that A must not reach is
# shown to be listening at all, so A's refusal is the wall and not an empty port.
vm_reaches() {
  if [ -n "${DESOLATE_BLAST_NESTED:-}" ]; then timeout 5 bash -c "</dev/tcp/$1/$2" 2>/dev/null
  else colima ssh -p "${COLIMA_PROFILE:-desolate}" -- timeout 5 nc -z "$1" "$2" 2>/dev/null; fi
}
mem_available() {
  if [ -n "${DESOLATE_BLAST_NESTED:-}" ]; then awk '/^MemAvailable/ {print $2}' /proc/meminfo
  else colima ssh -p "${COLIMA_PROFILE:-desolate}" -- awk '/^MemAvailable/ {print $2}' /proc/meminfo; fi
}

LOGS=$(mktemp -d)
cleanup() {
  [ -n "$KEEP" ] && { say "kept: ${created[*]:-} (logs in $LOGS)"; return; }
  for p in "${created[@]:-}"; do
    [ -n "$p" ] || continue
    "$CLI" desolate --stop "$p" >/dev/null 2>&1
    "$CLI" desolate --purge "$p" >/dev/null 2>&1
    docker exec desolate-vscode rm -rf "/workspaces/$p"
  done
  rm -rf "$LOGS"
}
trap cleanup EXIT

declare -a MEMORY=()
record_memory() {   # <label>
  local line total=0 used
  while read -r line; do
    used=$(printf '%s' "$line" | awk '{print $2}')
    MEMORY+=("  $1  ${line}")
    case "$used" in
      *GiB) total=$(awk -v t="$total" -v u="${used%GiB}" 'BEGIN{print t + u*1024}') ;;
      *MiB) total=$(awk -v t="$total" -v u="${used%MiB}" 'BEGIN{print t + u}') ;;
    esac
  done < <(docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' $(docker ps --filter label=desolate.dind --format '{{.Names}}' | grep '^desolate-dind-blast-') 2>/dev/null)
  MEMORY+=("  $1  TOTAL $(printf '%.0f' "$total") MiB across project dinds; VM MemAvailable $(( $(mem_available) / 1024 )) MiB")
}

# --- two projects --------------------------------------------------------------
group "${STAMP}two projects, both on daemons of their own"
for p in "$A" "$B"; do
  create "$p"
  if start "$p" && [ -n "$(container_of "$p")" ]; then pass "$p started on $(dind_of "$p")"
  else fail "$p started on $(dind_of "$p")" "$(tail -3 "$LOGS/$p.log")"; summary; exit 1; fi
done
record_memory 2

group "${STAMP}G1 visibility"
seen=$(inside "$A" 'docker ps -aq --no-trunc')
assert_contains "A's docker lists A's own devcontainer" "$seen" "$(container_of "$A")"
assert_not_contains "and not B's" "$seen" "$(container_of "$B")"

group "${STAMP}G2 files"
# /workspaces first: a bind of a path the daemon does not have makes it create
# that path, empty, and a later listing would show the empty directory.
assert_eq "a bind of /workspaces shows A alone" \
  "$(inside "$A" "docker run --rm -v /workspaces:/x busybox:1.37 ls -A /x" | tr '\n' ' ')" "$A "
assert_eq "A's own path is A's directory (control)" \
  "$(inside "$A" "docker run --rm -v /workspaces/$A:/x busybox:1.37 cat /x/CANARY")" "$(canary "$A")"
assert_eq "a bind of B's path is an empty directory, never B's" \
  "$(inside "$A" "docker run --rm -v /workspaces/$B:/x busybox:1.37 ls -A /x" 2>&1)" ""

group "${STAMP}G3 network"
code=$(inside "$A" "curl -s -o /dev/null -w '%{http_code}' -m 10 https://example.com/" || true)
if [ -n "$code" ] && [ "$code" != 000 ]; then pass "A's requests reach the proxy (control: HTTP $code)"
else fail "A's requests reach the proxy (control)" "got '${code:-nothing}'"; fi
# B's devcontainer has an address only INSIDE B's dind, and every dind numbers
# its bridge alike -- from A, that address is A's own. Outside its dind, B is
# reachable only at B's dind's address, through the forwards it publishes
# there: each one is shown to answer from the VM, then not to answer A.
B_DIND=$(address_of "$(dind_of "$B")")
EDITOR=$(address_of desolate-vscode)
targets=()
for port in $(docker exec desolate-orchestrator sh -c "awk '{print \$2}' /workspaces/.desolate/$B.ports"); do
  targets+=("B's forward=$B_DIND:$port")
done
targets+=("the editor=$EDITOR:3000")
for target in "${targets[@]}"; do
  what=${target%%=*} where=${target#*=}
  if ! vm_reaches "${where%:*}" "${where#*:}"; then
    fail "$what ($where) answers the VM (control)" "nothing answered; A's refusal would prove nothing"; continue
  fi
  if reaches "$A" "${where%:*}" "${where#*:}"; then fail "A cannot reach $what ($where; the VM can)" "it connected"
  else pass "A cannot reach $what ($where; the VM can)"; fi
done

group "${STAMP}G4 a wedged daemon is A's problem alone"
B_STARTED=$(docker exec "$(dind_of "$B")" docker inspect -f '{{.State.StartedAt}}' "$(container_of "$B")")
docker exec "$(dind_of "$A")" pkill -STOP dockerd
assert_contains "dind list says A is wedged" "$("$CLI" dind list 2>&1 | grep "^$A ")" "wedged"
built=$(inside "$B" "printf 'FROM busybox:1.37\nRUN echo blast-\$\$\n' | timeout 300 docker build -q - 2>&1" | tail -1)
assert_contains "B still builds" "$built" "sha256:"
editor=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${VSCODE_PORT:-3000}/" || true)
if [ -n "$editor" ] && [ "$editor" != 000 ]; then pass "the editor still answers (HTTP $editor)"
else fail "the editor still answers" "got '${editor:-nothing}'"; fi

group "${STAMP}G5 recovery, of A alone"
"$CLI" dind reset "$A" >"$LOGS/reset.log" 2>&1
assert_contains "dind reset recovered A" "$(cat "$LOGS/reset.log")" "recovered"
assert_eq "B's devcontainer was never restarted" \
  "$(docker exec "$(dind_of "$B")" docker inspect -f '{{.State.StartedAt}}' "$(container_of "$B")")" "$B_STARTED"
if start "$A" && [ -n "$(container_of "$A")" ]; then pass "A starts again"
else fail "A starts again" "$(tail -3 "$LOGS/$A.log")"; fi

# --- more of them ----------------------------------------------------------------
group "${STAMP}G6 memory, at 2, 5 and $MAX projects"
for n in $(seq 3 "$MAX"); do
  p=$(project "$n")
  create "$p"
  if start "$p"; then pass "$p started"
  else fail "$p started" "$(grep -m1 -iE 'refus|headroom|DESOLATE_' "$LOGS/$p.log" || tail -1 "$LOGS/$p.log")"; break; fi
  [ "$n" = 5 ] && record_memory 5
done
[ "$MAX" -gt 5 ] && record_memory "$MAX"

echo
say "=============== SUMMARY (paste this back) ==============="
say "  daemon: $(docker version --format '{{.Server.Version}}') / runtimes: $(docker info --format '{{range $name, $_ := .Runtimes}}{{$name}} {{end}}')"
say "  G1-G5: $PASS passed, $FAIL failed${FAILED_NAMES[*]:+ -- failed: ${FAILED_NAMES[*]}}"
say "  G6 memory (dind, docker stats MemUsage):"
for line in "${MEMORY[@]}"; do say "$line"; done
say "========================================================="
summary
