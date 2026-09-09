#!/usr/bin/env bash
# PROBE -- not a test. Answers capability questions about the environment so a
# design decision can be made; it asserts no invariant and gates nothing.
#
# QUESTION: five numbers and facts that `SPEC-per-project-dind-v2.md` currently
# guesses at, each of which changes what gets built:
#
#   B1  SUBPATH   `volume-subpath` is the whole of v2's containment -- it is
#                 what keeps a project dind's /workspaces to ONE project, and
#                 `tests/probes/sibling-docker.sh` Q6 showed the socket gives
#                 root over whatever that daemon can see. It needs Docker >= 26.
#                 Does the VM have it, and does it actually work?
#   B2  COST      the spec says "dockerd + containerd idle is roughly 150-250 MB"
#                 and then says to confirm it here rather than trust it. This is
#                 the per-project number the whole memory argument rests on.
#   B3  HEADROOM  how much memory the VM has to spend, which is what turns B2
#                 into a real ceiling for DESOLATE_MAX_DINDS instead of the
#                 spec's suggested 4.
#   B4  SCALE     how many projects and worktrees exist, and how many run AT
#                 ONCE. The count of projects decided that this spec is worth
#                 doing; the concurrent count is what it has to be sized for,
#                 and they are very different numbers.
#   B5  BRIDGES   per-project bridges have to be picked up by the VM's nftables
#                 interception, which matches on interface name. What does the
#                 ruleset match on today, and would `br-d-*` be covered?
#
# Read-only except B1, which creates and removes one throwaway volume.
#
# ---------------------------------------------------------------------------
# HOW TO RUN -- on your Mac, with the stack UP (B2 and B4 read the live stack):
#
#   ./cli.sh up
#   ./tests/probes/v2-baseline.sh
#
# It re-execs itself inside the Colima VM. Paste the SUMMARY block back.
set -uo pipefail

PROFILE="${COLIMA_PROFILE:-desolate}"

if [ "${DESOLATE_BASELINE_INVM:-}" != 1 ]; then
  if ! command -v colima >/dev/null 2>&1; then
    echo "This probe must run from the Mac (colima not found on PATH)." >&2
    echo "If you are already inside the VM, re-run with DESOLATE_BASELINE_INVM=1." >&2
    exit 1
  fi
  echo "== entering the Colima VM (profile '$PROFILE') =="
  exec colima ssh -p "$PROFILE" -- env DESOLATE_BASELINE_INVM=1 bash -s < "$0"
  exit 1
fi

# ---- inside the VM: `docker` is the daemon that would host project dinds ----

DIND=desolate-dind
ORCH=desolate-orchestrator
SUBPATH_VOL=desolate-baseline-subpath

B1="UNKNOWN"; B2="UNKNOWN"; B3="UNKNOWN"; B4="UNKNOWN"; B5="UNKNOWN"
ENGINE=""; PROJECTS=""; RUNNING=""

note() { printf '      %s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }

# The INNER daemon, where devcontainers live, reached the way observe.sh does.
inner() { docker exec "$ORCH" docker "$@"; }

cleanup() { docker volume rm -f "$SUBPATH_VOL" >/dev/null 2>&1; }
trap cleanup EXIT INT TERM

stack_is_up() { docker inspect "$DIND" >/dev/null 2>&1; }

# --- B1: volume-subpath, the containment ------------------------------------

# Mount ONE subdirectory of a volume and check the others are not visible. A
# version check alone is not the answer: the flag has to work on this daemon,
# on this storage driver, for the mount to be load-bearing.
check_volume_subpath() {
  ENGINE=$(docker version --format '{{.Server.Version}}' 2>/dev/null)
  note "engine: ${ENGINE:-unknown} (volume-subpath needs >= 26)"

  docker volume create "$SUBPATH_VOL" >/dev/null 2>&1
  docker run --rm -v "$SUBPATH_VOL:/w" alpine:3 sh -c \
    'mkdir -p /w/mine /w/theirs && echo MINE > /w/mine/f && echo THEIRS > /w/theirs/f' >/dev/null 2>&1

  local seen
  seen=$(docker run --rm \
    --mount "type=volume,source=$SUBPATH_VOL,target=/workspaces/mine,volume-subpath=mine" \
    alpine:3 sh -c 'cat /workspaces/mine/f 2>/dev/null; ls -A /workspaces 2>/dev/null | tr "\n" " "' \
    2>&1 | tr -d '\r' | tr '\n' ' ')

  case "$seen" in
    *MINE*THEIRS*) bad "the subpath mount exposed the sibling directory too"
                   B1="NO -- leaked ($seen)" ;;
    *MINE*)        ok "volume-subpath works and exposes ONLY its subdirectory"
                   B1="YES -- engine ${ENGINE:-?}" ;;
    *)             bad "the subpath mount did not work"
                   note "docker said: $seen"
                   B1="NO -- ${seen:-no output}" ;;
  esac
}

# --- B2: what a daemon actually costs ---------------------------------------

# The shared dind is one dockerd + one containerd with every project's images,
# which is the closest thing running to what ONE project dind would be.
check_daemon_cost() {
  stack_is_up || { B2="UNKNOWN -- stack is not up"; note "start it: ./cli.sh up"; return; }
  local usage images
  usage=$(docker stats --no-stream --format '{{.MemUsage}}' "$DIND" 2>/dev/null | tr -d '\r')
  images=$(inner images -q 2>/dev/null | grep -c . )
  note "desolate-dind memory: ${usage:-unknown}"
  note "images it holds     : ${images:-unknown}"
  B2="${usage:-unknown} with ${images:-?} images"

  note "--- every container on the VM daemon ---"
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}' 2>/dev/null | sed 's/^/        /'
}

# --- B3: what the VM has to spend -------------------------------------------

check_headroom() {
  local total available
  total=$(awk '/MemTotal/{printf "%.1f GB", $2/1048576}' /proc/meminfo 2>/dev/null)
  available=$(awk '/MemAvailable/{printf "%.1f GB", $2/1048576}' /proc/meminfo 2>/dev/null)
  note "VM memory: ${total:-?} total, ${available:-?} available"
  note "VM cpus  : $(nproc 2>/dev/null)"
  B3="${available:-?} available of ${total:-?}"
}

# --- B4: how many projects, and how many at once ----------------------------

# The count that justified this spec is how many projects COULD need a daemon.
# The count it has to be sized for is how many are up at the same time.
check_scale() {
  stack_is_up || {
    B4="UNKNOWN -- stack is not up"
    note "the stack is not up, so there is nothing to count"
    return
  }

  # A project is at /workspaces/<p> or /workspaces/<owner>/<repo>, and its spec
  # is one of two filenames one level further down -- so the deepest a project's
  # spec sits is four. An earlier maxdepth of 3 could not see a NESTED project's
  # spec at all and reported 0 while one was running.
  PROJECTS=$(docker exec "$ORCH" sh -c '
    find /workspaces -mindepth 2 -maxdepth 4 \
         \( -name devcontainer.json -o -name .devcontainer.json \) \
         -not -path "*/.worktrees/*" 2>/dev/null |
      sed "s#/workspaces/##; s#/\.devcontainer/devcontainer\.json$##; s#/\.devcontainer\.json$##" |
      sort -u | grep -c .' 2>/dev/null | tr -d '\r')

  local worktrees
  worktrees=$(docker exec "$ORCH" sh -c \
    'find /workspaces -mindepth 2 -maxdepth 4 -type d -name .worktrees -exec ls -1 {} \; 2>/dev/null | grep -c .' \
    2>/dev/null | tr -d '\r')

  RUNNING=$(inner ps --filter 'label=devcontainer.local_folder' --format '{{.Names}}' 2>/dev/null | grep -c .)

  note "projects with a devcontainer spec: ${PROJECTS:-?}"
  note "worktree directories             : ${worktrees:-?}"
  note "devcontainers running RIGHT NOW  : ${RUNNING:-?}"
  note "(the last number is what DESOLATE_MAX_DINDS has to cover)"
  B4="${PROJECTS:-?} projects, ${worktrees:-?} worktrees, ${RUNNING:-?} running now"
}

# --- B5: would a per-project bridge be intercepted --------------------------

# The proxy's rules match on interface name. A new bridge per project is a new
# interface, and one the ruleset does not name is a project whose egress is not
# intercepted -- which fails OPEN, silently.
check_bridge_interception() {
  local configured bridges
  configured=$(sudo nft list ruleset 2>/dev/null | grep -oE 'iifname "[^"]+"' | sort -u | tr '\n' ' ')
  bridges=$(ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | grep '^br-' | tr '\n' ' ')
  note "bridges on the VM      : ${bridges:-none}"
  note "iifname matches in nft : ${configured:-none readable (try with sudo)}"
  case "$configured" in
    *'br-d-'*|*'br-d*'*) ok "the ruleset already names a per-project bridge pattern"
                         B5="already covered" ;;
    "")                  B5="UNKNOWN -- could not read the ruleset" ;;
    *)                   note "no br-d-* match, so per-project bridges would NOT be intercepted"
                         note "as they stand -- an interface set is the spec's answer"
                         B5="not covered: $configured" ;;
  esac
}

summary() {
  echo
  echo "=============== SUMMARY (paste this back) ==============="
  echo "  VM kernel            : $(uname -r 2>/dev/null)"
  echo "  B1 volume-subpath    : $B1"
  echo "  B2 daemon cost       : $B2"
  echo "  B3 VM headroom       : $B3"
  echo "  B4 scale             : $B4"
  echo "  B5 bridge intercept  : $B5"
  echo "========================================================="
}

echo
echo "== B1. volume-subpath, which is what keeps one dind to one project =="
check_volume_subpath
echo
echo "== B2. what one daemon actually costs here =="
check_daemon_cost
echo
echo "== B3. what the VM has to spend =="
check_headroom
echo
echo "== B4. how many projects, and how many at once =="
check_scale
echo
echo "== B5. would a per-project bridge be intercepted =="
check_bridge_interception
summary
echo
