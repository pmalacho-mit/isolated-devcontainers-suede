#!/bin/bash
# desolate v3, Phase 0: substrate probes for a Mac (move-to-vms.md section 13.4, item 0).
#
#   bash phase0-mac.sh              # everything; 20-40 minutes, needs the network
#   bash phase0-mac.sh --quick      # skips the npm and devcontainer probes; ~10 minutes
#   bash phase0-mac.sh --only git   # one probe (names below); VMs are reused if they exist
#   bash phase0-mac.sh --keep       # leave the VMs and the work directory in place
#   bash phase0-mac.sh --clean      # delete the probe's VMs and work directory, and stop
#
# Needs: macOS on Apple Silicon or Intel, Lima >= 2.0 (`brew install lima`).
# It creates three Lima VMs named dp0-root, dp0-ws1 and dp0-ws2 (2 CPUs, 2 GiB each) and
# a work directory at ~/.desolate-phase0. It touches nothing else, and deletes both at the
# end unless --keep is given.
#
# Results: ~/desolate-phase0-results/<time>/results.md (the table to read) and raw.log,
# also packed as results.tar.gz. Send that file back.
#
# Rules this script holds to (P6):
#   - a probe that could not run is recorded as "DID NOT RUN", never as a pass;
#   - every negative check ("root cannot write the mirror") sits beside a positive control
#     ("the same write works on the writable share"), so a broken probe cannot pass.
#
# Written for bash 3.2 (the one macOS ships): no associative arrays, no mapfile.

set -u

PREFIX=dp0
ROOT_VM=$PREFIX-root
WS1=$PREFIX-ws1
WS2=$PREFIX-ws2
WORK=$HOME/.desolate-phase0
STAMP=$(date +%Y%m%d-%H%M%S)
OUT=$HOME/desolate-phase0-results/$STAMP
QUICK=0
KEEP=0
ONLY=""
CLEAN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --keep) KEEP=1 ;;
    --clean) CLEAN=1 ;;
    --only) shift; ONLY="${1:-}" ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 64 ;;
  esac
  shift
done

now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
since() { perl -e 'printf "%.1f", $ARGV[1]-$ARGV[0]' "$1" "$(now)"; }

cleanup_vms() {
  for i in $ROOT_VM $WS1 $WS2; do
    limactl delete -f "$i" >/dev/null 2>&1
  done
}

if [ "$CLEAN" = 1 ]; then
  cleanup_vms
  rm -rf "$WORK"
  echo "removed the probe's VMs and $WORK"
  exit 0
fi

mkdir -p "$OUT" "$WORK/mirrors" "$WORK/domain/.probe" "$WORK/yaml"
RAW=$OUT/raw.log
RES=$OUT/results.md
: >"$RAW"

log() { printf '%s\n' "$*" | tee -a "$RAW" >&2; }
# rec <probe> <measure> <value> : one row of the results table
rec() {
  printf '| %s | %s | %s |\n' "$1" "$2" "$3" >>"$OUT/rows.md"
  log "  [$1] $2: $3"
}
# guest <vm> <command...> : run in the VM as the Lima user; output to the raw log too
guest() {
  local vm=$1; shift
  limactl shell --workdir / "$vm" "$@" 2>>"$RAW"
}
# gscript <vm> <script-name> [args] : run a script this file wrote into the shared directory
gscript() {
  local vm=$1 s=$2; shift 2
  limactl shell --workdir / "$vm" bash "/desolate/domain/.probe/$s" "$@" 2>>"$RAW"
}
# expect_fail / expect_ok: record a check with its outcome; "FAIL" rows are findings.
check() { # check <probe> <label> <want: ok|refused> <actual exit code>
  local got
  if [ "$4" = 0 ]; then got=ok; else got=refused; fi
  if [ "$got" = "$3" ]; then rec "$1" "$2" "as expected ($got)"
  else rec "$1" "$2" "**UNEXPECTED: $got, wanted $3**"; fi
}
want() { case ",$ONLY," in ",,"|*",$1,"*) return 0 ;; *) return 1 ;; esac; }
run_probe() { # run_probe <name> <function>
  want "$1" || return 0
  log ""
  log "=== probe: $1 ==="
  local t0; t0=$(now)
  ( set +e; "$2" )
  local rc=$?
  if [ $rc -ne 0 ]; then
    rec "$1" "probe status" "**DID NOT RUN to the end (exit $rc); see raw.log. Not a pass.**"
  fi
  rec "$1" "probe took" "$(since "$t0") s"
}

mk_yaml() { # mk_yaml <file> <mirrors writable: true|false>
  cat >"$1" <<EOF
minimumLimaVersion: 2.0.0
base:
- template:_images/ubuntu-24.04
vmType: vz
mountType: virtiofs
cpus: 2
memory: 2GiB
disk: 20GiB
containerd:
  system: false
  user: false
mounts:
- location: "$WORK/domain"
  mountPoint: /desolate/domain
  writable: true
- location: "$WORK/mirrors"
  mountPoint: /desolate/mirrors
  writable: $2
EOF
}

vm_exists() { limactl list -q 2>/dev/null | grep -qx "$1"; }
vm_running() { limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null | grep -qx "$1 Running"; }
ensure_running() {
  vm_exists "$1" || return 1
  vm_running "$1" || limactl start --tty=false "$1" >>"$RAW" 2>&1
}

# ---------------------------------------------------------------- guest scripts
write_guest_scripts() {
  cat >"$WORK/domain/.probe/provision.sh" <<'EOF'
#!/bin/bash
# packages every probe needs; idempotent
set -e
export DEBIAN_FRONTEND=noninteractive
if ! command -v git-lfs >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq git git-lfs curl iproute2 iputils-ping python3 >/dev/null
fi
sudo git config --system --replace-all safe.directory '*'
sudo git config --system user.email probe@desolate.invalid
sudo git config --system user.name probe
sudo git config --system init.defaultBranch main
echo provisioned
EOF

  cat >"$WORK/domain/.probe/git-worker.sh" <<'EOF'
#!/bin/bash
# one workspace's share of the concurrency test: its own worktree on the shared .git,
# N commits, and a worktree add/remove every 25 commits.
repo=$1; name=$2; n=$3
err=/desolate/domain/.probe/git-$name.err
: >"$err"
cd "$repo" || exit 9
git worktree add -q -b "$name" ".worktrees/$name" 2>>"$err" || { echo "worktree-add-failed"; exit 8; }
cd ".worktrees/$name" || exit 9
fail=0
for i in $(seq 1 "$n"); do
  echo "$name $i" >"f-$name.txt"
  { git add "f-$name.txt" && git commit -q -m "$name $i"; } 2>>"$err" || fail=$((fail+1))
  if [ $((i % 25)) -eq 0 ]; then
    { git worktree add -q -b "$name-t$i" "../$name-t$i" \
      && git worktree remove --force "../$name-t$i" \
      && git branch -q -D "$name-t$i"; } 2>>"$err" || fail=$((fail+1))
  fi
done
echo "failed_ops=$fail commits=$(git rev-list --count "$name" ^main)"
EOF

  cat >"$WORK/domain/.probe/ports-serve.sh" <<'EOF'
#!/bin/bash
# serve a page that says which VM this is: ports-serve.sh <bind> <port> <who>
d=$(mktemp -d); echo "$3" >"$d/who"
cd "$d" && exec python3 -m http.server "$2" --bind "$1" >/dev/null 2>&1
EOF
  chmod +x "$WORK/domain/.probe/"*.sh
}

# ---------------------------------------------------------------- probes
probe_prereq() {
  rec prereq "macOS" "$(sw_vers -productVersion 2>/dev/null) on $(uname -m), $(sysctl -n hw.ncpu) CPUs, $(( $(sysctl -n hw.memsize) / 1073741824 )) GiB"
  rec prereq "filesystem of \$HOME" "$(diskutil info "$HOME" 2>/dev/null | awk -F: '/File System Personality/{gsub(/^ +/,"",$2); print $2}')"
  if ! command -v limactl >/dev/null 2>&1; then
    rec prereq "lima" "**MISSING: run 'brew install lima' and run this again**"
    return 3
  fi
  rec prereq "lima" "$(limactl --version 2>&1)"
  rec prereq "Apple Container CLI" "$(command -v container >/dev/null 2>&1 && container --version 2>&1 | head -1 || echo 'not installed')"
  rec prereq "microsandbox (msb)" "$(command -v msb >/dev/null 2>&1 && msb --version 2>&1 | head -1 || echo 'not installed')"
  rec prereq "colima (v2's VM), for reference" "$(command -v colima >/dev/null 2>&1 && colima version 2>&1 | head -1 || echo 'not installed')"
}

probe_boot() {
  local t0
  mk_yaml "$WORK/yaml/root.yaml" true
  mk_yaml "$WORK/yaml/ws.yaml" false
  if ! vm_exists $ROOT_VM; then
    t0=$(now)
    limactl start --tty=false --name=$ROOT_VM "$WORK/yaml/root.yaml" >>"$RAW" 2>&1 || return 4
    rec boot "first VM ever: create + boot (includes the image download)" "$(since "$t0") s"
  fi
  ensure_running $ROOT_VM || return 4
  gscript $ROOT_VM provision.sh >>"$RAW" || return 5
  if ! vm_exists $WS1; then
    t0=$(now)
    limactl start --tty=false --name=$WS1 "$WORK/yaml/ws.yaml" >>"$RAW" 2>&1 || return 4
    rec boot "second VM: create + first boot (image cached)" "$(since "$t0") s"
  fi
  ensure_running $WS1 || return 4
  gscript $WS1 provision.sh >>"$RAW" || return 5
  local n
  for n in 1 2 3; do
    limactl stop $WS1 >>"$RAW" 2>&1
    t0=$(now)
    limactl start --tty=false $WS1 >>"$RAW" 2>&1 || return 4
    rec boot "warm boot $n: 'limactl start' of a stopped VM, to SSH ready" "$(since "$t0") s"
  done
  t0=$(now)
  guest $WS1 true
  rec boot "one 'limactl shell' round trip" "$(since "$t0") s"
}

probe_idle() {
  ensure_running $WS1 || return 4
  sleep 30
  rec idle "guest memory after 30 s idle (free -m: total used free)" "$(guest $WS1 free -m | awk '/^Mem:/{print $2, $3, $4}')"
  rec idle "host processes for the VM (rss MB, command)" "$(ps -axo rss=,command= | grep -E "hostagent.*$WS1|Virtualization.VirtualMachine|limactl.*$WS1" | grep -v grep | awk '{printf "%d MB %s; ", $1/1024, $2}')"
  rec idle "VM directory on disk (du -sh)" "$(du -sh "$HOME/.lima/$WS1" 2>/dev/null | awk '{print $1}')"
  rec idle "VM directory, files" "$(ls -l "$HOME/.lima/$WS1" 2>/dev/null | awk 'NR>1{printf "%s=%dMB ", $NF, $5/1048576}')"
}

probe_clone() {
  vm_exists $WS1 || return 4
  limactl stop $WS1 >>"$RAW" 2>&1
  local t0 free0 free1
  if ! vm_exists $WS2; then
    free0=$(df -k "$HOME" | awk 'NR==2{print $4}')
    t0=$(now)
    limactl clone --tty=false $WS1 $WS2 >>"$RAW" 2>&1 || return 6
    rec clone "'limactl clone' of a stopped VM" "$(since "$t0") s"
    free1=$(df -k "$HOME" | awk 'NR==2{print $4}')
    rec clone "free space the clone consumed (df delta; near 0 means copy-on-write)" "$(( (free0 - free1) / 1024 )) MB"
  fi
  local disk
  disk=$(ls "$HOME/.lima/$WS1"/diffdisk "$HOME/.lima/$WS1"/disk 2>/dev/null | head -1)
  if [ -n "$disk" ]; then
    t0=$(now)
    cp -c "$disk" "$WORK/clonefile-test" 2>>"$RAW"
    check clone "APFS clonefile ('cp -c') of the VM disk" ok $?
    rec clone "'cp -c' of the VM disk ($(( $(stat -f %z "$disk") / 1048576 )) MB apparent)" "$(since "$t0") s"
    rm -f "$WORK/clonefile-test"
  else
    rec clone "VM disk file" "**not found under ~/.lima/$WS1 (looked for diffdisk, disk)**"
  fi
  t0=$(now)
  limactl start --tty=false $WS2 >>"$RAW" 2>&1 || return 4
  rec clone "the clone's first boot" "$(since "$t0") s"
  rec clone "the clone has what the original installed (git-lfs)" "$(guest $WS2 git lfs version 2>&1 | head -1)"
  limactl start --tty=false $WS1 >>"$RAW" 2>&1 || return 4
}

probe_git() {
  ensure_running $WS1 || return 4
  ensure_running $WS2 || return 4
  local repo=/desolate/domain/shared-repo n=500 t0 r1 r2
  guest $WS1 bash -c "rm -rf $repo /desolate/domain/.probe/*.err; git init -q $repo && cd $repo && git config gc.auto 0 && echo seed >README && git add README && git commit -q -m seed" || return 7
  rec git "who owns the shared files, seen from a VM (uid:gid), and the VM user" "$(guest $WS1 stat -c '%u:%g' $repo) / $(guest $WS1 id -u):$(guest $WS1 id -g)"
  t0=$(now)
  gscript $WS1 git-worker.sh $repo ws1 $n >"$OUT/git-ws1.out" &
  local p1=$!
  gscript $WS2 git-worker.sh $repo ws2 $n >"$OUT/git-ws2.out" &
  local p2=$!
  wait $p1; wait $p2
  r1=$(cat "$OUT/git-ws1.out"); r2=$(cat "$OUT/git-ws2.out")
  rec git "two VMs, one .git over virtiofs: $n commits each + 20 worktree add/remove each" "$(since "$t0") s"
  rec git "VM 1 result (want failed_ops=0 commits=$n)" "$r1"
  rec git "VM 2 result (want failed_ops=0 commits=$n)" "$r2"
  rec git "lock or other errors logged (lines)" "ws1: $(wc -l <"$WORK/domain/.probe/git-ws1.err" | tr -d ' '), ws2: $(wc -l <"$WORK/domain/.probe/git-ws2.err" | tr -d ' ')"
  cat "$WORK/domain/.probe/"git-ws*.err >>"$RAW" 2>/dev/null
  guest $WS1 git -C $repo fsck --full --strict >>"$RAW" 2>&1
  check git "git fsck --full from VM 1 after the run" ok $?
  guest $WS2 git -C $repo fsck --full --strict >>"$RAW" 2>&1
  check git "git fsck --full from VM 2 after the run" ok $?
  rec git "each VM sees the other's branch tip (ws1 sees ws2 / ws2 sees ws1)" "$(guest $WS1 git -C $repo rev-list --count ws2 ^main) / $(guest $WS2 git -C $repo rev-list --count ws1 ^main)"
  # control: the error counter does count. A commit while index.lock is held must fail.
  guest $WS1 bash -c "cd $repo/.worktrees/ws1 && g=\$(git rev-parse --git-dir) && touch \$g/index.lock && echo x >c && git add c 2>/dev/null; rc=\$?; rm -f \$g/index.lock; exit \$rc"
  check git "control: a commit under a held index.lock is refused" refused $?
}

probe_readonly() {
  ensure_running $ROOT_VM || return 4
  ensure_running $WS1 || return 4
  local m=/desolate/mirrors
  guest $ROOT_VM bash -c "set -e; rm -rf $m/r.git /tmp/seed; mkdir /tmp/seed; cd /tmp/seed; git init -q; git lfs install --local >/dev/null; git lfs track '*.bin' >/dev/null; head -c 200000 /dev/urandom >big.bin; echo hi >README; git add -A; git commit -q -m seed; git clone -q --bare /tmp/seed $m/r.git; mkdir -p $m/r.git/lfs; cp -a .git/lfs/objects $m/r.git/lfs/; sha256sum big.bin | cut -d' ' -f1 >$m/big.sha" || return 7
  check readonly "control: the root VM (writable share) writes the mirror" ok $?
  guest $WS1 touch $m/by-user 2>/dev/null
  check readonly "workspace VM, as its user: create a file in the mirror" refused $?
  guest $WS1 sudo touch $m/by-root 2>/dev/null
  check readonly "workspace VM, as root: create a file in the mirror" refused $?
  guest $WS1 sudo sh -c "echo x >>$m/r.git/HEAD" 2>/dev/null
  check readonly "workspace VM, as root: append to the mirror's HEAD" refused $?
  guest $WS1 sudo mount -o remount,rw $m >>"$RAW" 2>&1
  rec readonly "workspace VM, as root: 'mount -o remount,rw' exit code (0 = the guest agreed)" "$?"
  guest $WS1 sudo touch $m/after-remount 2>/dev/null
  check readonly "workspace VM, as root, after remount,rw: create a file (host must still refuse)" refused $?
  guest $WS1 sudo sh -c "echo mirror-tag=\$(awk '\$2==\"$m\"{print \$1}' /proc/mounts); umount $m 2>/dev/null; mkdir -p /mnt/again; for t in \$(awk '\$3==\"virtiofs\"{print \$1}' /proc/mounts | sort -u); do mount -t virtiofs \$t /mnt/again 2>/dev/null && touch /mnt/again/by-remount-\$t 2>/dev/null && echo wrote-through-\$t; umount /mnt/again 2>/dev/null; done; true" >"$OUT/remount.out" 2>>"$RAW"
  rec readonly "workspace VM, as root: mount every virtiofs tag afresh and write (want the mirror's tag NOT among 'wrote-through'; the other tag is the control)" "$(tr '\n' ' ' <"$OUT/remount.out")"
  rec readonly "files that appeared in the mirror on the Mac (want only big.sha and r.git)" "$(ls "$WORK/mirrors" | tr '\n' ' ')"
  limactl stop $WS1 >>"$RAW" 2>&1; limactl start --tty=false $WS1 >>"$RAW" 2>&1 || return 4
  # alternates and LFS through the read-only share
  local c=/desolate/domain/lfsclone
  guest $WS1 bash -c "set -e; rm -rf $c; GIT_LFS_SKIP_SMUDGE=1 git clone -q --shared $m/r.git $c; cd $c; git count-objects -v | tr '\n' ' '" >"$OUT/alt.out" 2>>"$RAW"
  check readonly "git clone --shared from the read-only mirror" ok $?
  rec readonly "the clone's own objects (want count: 0 and in-pack: 0)" "$(cat "$OUT/alt.out")"
  guest $WS1 bash -c "set -e; cd $c; git lfs install --local >/dev/null; git config lfs.url file://$m/r.git; git lfs pull; test \"\$(sha256sum big.bin | cut -d' ' -f1)\" = \"\$(cat $m/big.sha)\"" >>"$RAW" 2>&1
  check readonly "LFS object smudged from the read-only mirror (lfs.url=file://), sha256 matches" ok $?
  guest $WS1 bash -c "set -e; cd $c; echo more >>README; git commit -q -am local; git fetch -q origin; git count-objects -v | head -1" >>"$RAW" 2>&1
  check readonly "commit in the clone, then 'git fetch origin' from the mirror" ok $?
  guest $WS1 bash -c "cd $c && git push -q origin HEAD:refs/heads/from-workspace" >>"$RAW" 2>&1
  check readonly "push from the clone into the read-only mirror" refused $?
  guest $ROOT_VM bash -c "git -C $m/r.git fsck --full >/dev/null 2>&1 && test -z \"\$(git -C $m/r.git for-each-ref refs/heads/from-workspace)\""
  check readonly "the mirror is intact and has no branch from the workspace" ok $?
}

probe_network() {
  ensure_running $WS1 || return 4
  ensure_running $WS2 || return 4
  local port=47611 gw lan
  ( cd "$WORK/yaml" && exec python3 -m http.server $port --bind 127.0.0.1 >/dev/null 2>&1 ) &
  local srv=$!
  sleep 1
  curl -s -m 3 -o /dev/null "http://127.0.0.1:$port/"
  check network "control: the Mac reaches its own loopback listener" ok $?
  rec network "guest addresses" "$(guest $WS1 ip -4 -o addr | awk '{printf "%s=%s ", $2, $4}')"
  rec network "guest default route" "$(guest $WS1 ip route | head -1)"
  rec network "guest resolver" "$(guest $WS1 grep -E '^nameserver' /etc/resolv.conf | tr '\n' ' ')"
  guest $WS1 curl -s -m 5 -o /dev/null "http://host.lima.internal:$port/"
  check network "guest reaches a listener on the MAC'S LOOPBACK via host.lima.internal (want refused)" refused $?
  gw=$(guest $WS1 ip route | awk '/^default/{print $3; exit}')
  guest $WS1 curl -s -m 5 -o /dev/null "http://$gw:$port/"
  check network "guest reaches the Mac's loopback listener via its gateway $gw (want refused)" refused $?
  lan=$(route -n get default 2>/dev/null | awk '/gateway:/{print $2}')
  if [ -n "$lan" ]; then
    guest $WS1 ping -c 1 -W 2 "$lan" >/dev/null 2>&1
    check network "guest pings the LAN's router $lan (want refused)" refused $?
    guest $WS1 curl -s -m 4 -o /dev/null "http://$lan/"
    check network "guest opens TCP 80 on the LAN's router $lan (want refused)" refused $?
  else
    rec network "LAN router" "none found; LAN checks DID NOT RUN"
  fi
  guest $WS1 curl -s -m 8 -o /dev/null https://example.com/
  check network "guest reaches the internet directly (want refused once egress is forced; today's default)" refused $?
  local ip2
  ip2=$(guest $WS2 ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
  guest $WS1 ping -c 1 -W 2 "$ip2" >/dev/null 2>&1
  rec network "VM 1 pings VM 2's address $ip2 (0 = answered; with user-mode nets both often hold the same address, so it answers itself)" "$?"
  kill $srv 2>/dev/null
  rec network "lima networks available" "$(limactl network list 2>&1 | tr '\n' ';')"
}

probe_ports() {
  ensure_running $WS1 || return 4
  ensure_running $WS2 || return 4
  local p=5173 i got t0
  gscript $WS1 ports-serve.sh 127.0.0.1 $p ws1 &
  t0=$(now); got="never"
  for i in $(seq 1 50); do
    if curl -s -m 1 "http://127.0.0.1:$p/who" 2>/dev/null | grep -q ws1; then got="$(since "$t0") s"; break; fi
    sleep 0.2
  done
  rec ports "guest listener on 127.0.0.1:$p appears on the Mac's 127.0.0.1:$p after" "$got"
  rec ports "what holds $p on the Mac (lsof)" "$(lsof -nP -iTCP:$p -sTCP:LISTEN 2>/dev/null | awk 'NR>1{printf "%s %s; ", $1, $9}')"
  gscript $WS2 ports-serve.sh 127.0.0.1 $p ws2 &
  sleep 4
  rec ports "same port in a second VM: who answers on the Mac's 127.0.0.1:$p" "$(curl -s -m 2 "http://127.0.0.1:$p/who" 2>/dev/null)"
  rec ports "listeners on the Mac for $p now" "$(lsof -nP -iTCP:$p -sTCP:LISTEN 2>/dev/null | awk 'NR>1{printf "%s %s; ", $1, $9}')"
  guest $WS1 pkill -f "http.server $p" ; guest $WS2 pkill -f "http.server $p"
  sleep 2
  gscript $WS1 ports-serve.sh 0.0.0.0 $p ws1 &
  sleep 4
  rec ports "guest listener on 0.0.0.0:$p: Mac-side listen address (want 127.0.0.1, never *)" "$(lsof -nP -iTCP:$p -sTCP:LISTEN 2>/dev/null | awk 'NR>1{printf "%s; ", $9}')"
  guest $WS1 pkill -f "http.server $p"
  guest $WS1 sudo bash -c "nohup /desolate/domain/.probe/ports-serve.sh 0.0.0.0 80 ws1-80 >/dev/null 2>&1 &"
  sleep 4
  rec ports "guest port 80 (below 1024): listeners on the Mac (want none)" "$(lsof -nP -iTCP:80 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{printf "%s %s; ", $1, $9}')"
  guest $WS1 sudo pkill -f "http.server 80"
  # a port the Mac already holds
  ( cd "$WORK/yaml" && exec python3 -m http.server 5180 --bind 127.0.0.1 >/dev/null 2>&1 ) &
  local srv=$!
  sleep 1
  gscript $WS1 ports-serve.sh 127.0.0.1 5180 ws1-5180 &
  sleep 4
  rec ports "a port the Mac holds (5180): who answers on the Mac (want the Mac's own listing, not 'ws1-5180')" "$(curl -s -m 2 http://127.0.0.1:5180/who 2>/dev/null | head -c 40 | tr '\n' ' ')"
  kill $srv 2>/dev/null
  guest $WS1 pkill -f "http.server 5180"
}

probe_suspend() {
  ensure_running $WS2 || return 4
  local t0 out
  out=$(limactl snapshot create $WS2 --tag p0 2>&1); rec suspend "'limactl snapshot create' on a vz VM (exit $?)" "$(printf '%s' "$out" | tail -1 | head -c 160)"
  rec suspend "'limactl stop --help' mentions save/suspend" "$(limactl stop --help 2>&1 | grep -ciE 'save|suspend')"
  rec suspend "'limactl start --help' mentions restore/resume" "$(limactl start --help 2>&1 | grep -ciE 'restore|resume')"
  local pid
  pid=$(cat "$HOME/.lima/$WS2/ha.pid" 2>/dev/null)
  if [ -n "$pid" ]; then
    kill -STOP "$pid" 2>>"$RAW"; sleep 5
    t0=$(now); kill -CONT "$pid" 2>>"$RAW"
    guest $WS2 true
    check suspend "SIGSTOP the host agent 5 s, SIGCONT, then a shell round trip" ok $?
    rec suspend "round trip after SIGCONT" "$(since "$t0") s"
  fi
}

probe_npm() {
  [ "$QUICK" = 1 ] && { rec npm "skipped" "--quick"; return 0; }
  ensure_running $WS1 || return 4
  cat >"$WORK/domain/.probe/npm.sh" <<'EOF'
#!/bin/bash
set -e
now() { date +%s.%N; }
el() { echo "$(echo "$(now) - $1" | bc)"; }
sudo apt-get install -y -qq bc xz-utils >/dev/null
a=$(uname -m); case $a in aarch64) a=arm64 ;; x86_64) a=x64 ;; esac
if ! command -v node >/dev/null; then
  curl -fsSL "https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-$a.tar.xz" | sudo tar -xJ -C /usr/local --strip-components=1
fi
mk() { mkdir -p "$1"; cat >"$1/package.json" <<'J'
{"name":"probe","private":true,"version":"0.0.0",
 "dependencies":{"react":"^18.3.1","react-dom":"^18.3.1"},
 "devDependencies":{"vite":"^5.4.0","@vitejs/plugin-react":"^4.3.0","typescript":"^5.6.0","eslint":"^9.0.0","vitest":"^2.1.0","tailwindcss":"^3.4.0","prettier":"^3.3.0"}}
J
}
L=$HOME/npm-local; S=/desolate/domain/npm-share
rm -rf "$L" "$S"; mk "$L"; mk "$S"
cd "$L"; npm install --package-lock-only --silent >/dev/null 2>&1; cp package-lock.json "$S/"
npm cache clean --force >/dev/null 2>&1
t=$(now); npm ci --silent >/dev/null 2>&1; echo "local-disk cold-cache npm ci: $(el $t) s"
echo "packages: $(ls node_modules | wc -l) dirs, $(find node_modules -type f | wc -l) files, $(du -sm node_modules | cut -f1) MB"
rm -rf node_modules
t=$(now); npm ci --silent >/dev/null 2>&1; echo "local-disk warm-cache npm ci: $(el $t) s"
cd "$S"
t=$(now); npm ci --silent >/dev/null 2>&1; echo "virtiofs-share warm-cache npm ci: $(el $t) s"
t=$(now); find node_modules -type f | wc -l >/dev/null; echo "virtiofs-share find node_modules: $(el $t) s"
t=$(now); rm -rf node_modules; echo "virtiofs-share rm -rf node_modules: $(el $t) s"
cd "$L"
t=$(now); find node_modules -type f | wc -l >/dev/null; echo "local-disk find node_modules: $(el $t) s"
t=$(now); rm -rf node_modules; echo "local-disk rm -rf node_modules: $(el $t) s"
EOF
  gscript $WS1 npm.sh >"$OUT/npm.out" 2>>"$RAW" || { cat "$OUT/npm.out" >>"$RAW"; return 8; }
  local line
  while IFS= read -r line; do rec npm "${line%%:*}" "${line#*: }"; done <"$OUT/npm.out"
}

probe_devcontainer() {
  [ "$QUICK" = 1 ] && { rec devcontainer "skipped" "--quick"; return 0; }
  ensure_running $WS1 || return 4
  cat >"$WORK/domain/.probe/devc.sh" <<'EOF'
#!/bin/bash
set -e
now() { date +%s.%N; }
el() { echo "$(echo "$(now) - $1" | bc)"; }
sudo apt-get install -y -qq bc xz-utils >/dev/null
a=$(uname -m); case $a in aarch64) a=arm64 ;; x86_64) a=x64 ;; esac
command -v node >/dev/null || curl -fsSL "https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-$a.tar.xz" | sudo tar -xJ -C /usr/local --strip-components=1
t=$(now)
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sudo sh >/dev/null 2>&1
sudo usermod -aG docker "$USER" || true
echo "install dockerd in the VM: $(el $t) s"
echo "dockerd: $(sudo docker info --format '{{.ServerVersion}} {{.Driver}} {{.CgroupDriver}}')"
command -v devcontainer >/dev/null || sudo npm install -g --silent @devcontainers/cli >/dev/null 2>&1
echo "devcontainer CLI: $(devcontainer --version)"
W=$HOME/devc; rm -rf "$W"; mkdir -p "$W/img/.devcontainer" "$W/df/.devcontainer" "$W/co/.devcontainer"
cat >"$W/img/.devcontainer/devcontainer.json" <<'J'
{"image":"mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
 "features":{"ghcr.io/devcontainers/features/node:1":{"version":"22"},
             "ghcr.io/devcontainers/features/docker-in-docker:2":{}},
 "postCreateCommand":"node --version && docker --version"}
J
cat >"$W/df/.devcontainer/Dockerfile" <<'J'
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git && rm -rf /var/lib/apt/lists/*
J
echo '{"build":{"dockerfile":"Dockerfile"},"postCreateCommand":"git --version"}' >"$W/df/.devcontainer/devcontainer.json"
cat >"$W/co/.devcontainer/compose.yml" <<'J'
services:
  app:
    image: ubuntu:24.04
    command: sleep infinity
    volumes: ["..:/workspace"]
  db:
    image: redis:7-alpine
J
echo '{"dockerComposeFile":"compose.yml","service":"app","workspaceFolder":"/workspace"}' >"$W/co/.devcontainer/devcontainer.json"
for k in img df co; do
  t=$(now)
  if sudo devcontainer up --workspace-folder "$W/$k" >"$W/$k.log" 2>&1; then r=ok; else r="FAILED: $(tail -2 "$W/$k.log" | tr '\n' ' ' | head -c 200)"; fi
  echo "devcontainer up, $k, cold: $(el $t) s, $r"
  t=$(now)
  sudo devcontainer up --workspace-folder "$W/$k" >"$W/$k.2.log" 2>&1 && echo "devcontainer up, $k, again (already built): $(el $t) s"
done
echo "docker-in-docker inside the image+features devcontainer: $(sudo devcontainer exec --workspace-folder "$W/img" docker run --rm hello-world 2>&1 | grep -c 'Hello from Docker') (want 1)"
echo "images on the VM's daemon: $(sudo docker images -q | wc -l), disk $(sudo du -sm /var/lib/docker | cut -f1) MB"
EOF
  gscript $WS1 devc.sh >"$OUT/devc.out" 2>>"$RAW" || { cat "$OUT/devc.out" >>"$RAW"; return 8; }
  local line
  while IFS= read -r line; do rec devcontainer "${line%%:*}" "${line#*: }"; done <"$OUT/devc.out"
}

probe_others() {
  local t0
  if command -v container >/dev/null 2>&1; then
    container system status >>"$RAW" 2>&1
    rec others "Apple Container: 'container system status' exit" "$?"
    t0=$(now); container run --rm docker.io/library/alpine:3.20 /bin/true >>"$RAW" 2>&1
    rec others "Apple Container: run alpine true, first (exit $?)" "$(since "$t0") s"
    t0=$(now); container run --rm docker.io/library/alpine:3.20 /bin/true >>"$RAW" 2>&1
    rec others "Apple Container: run alpine true, again (exit $?)" "$(since "$t0") s"
    mkdir -p "$WORK/ac-ro"; echo x >"$WORK/ac-ro/f"
    container run --rm --mount "type=bind,source=$WORK/ac-ro,target=/m,readonly" docker.io/library/alpine:3.20 sh -c 'touch /m/w' >>"$RAW" 2>&1
    check others "Apple Container: root writes a read-only bind" refused $?
    container run --rm --mount "type=bind,source=$WORK/ac-ro,target=/m" docker.io/library/alpine:3.20 sh -c 'touch /m/w' >>"$RAW" 2>&1
    check others "Apple Container: control, the same write on a writable bind" ok $?
  else
    rec others "Apple Container" "not installed; DID NOT RUN (github.com/apple/container; needs macOS 26 for full networking)"
  fi
  if command -v msb >/dev/null 2>&1; then
    rec others "microsandbox" "$(msb --version 2>&1 | head -1); timing DID NOT RUN (its CLI changes between releases)"
  else
    rec others "microsandbox" "not installed; DID NOT RUN"
  fi
}

# ---------------------------------------------------------------- main
write_guest_scripts
: >"$OUT/rows.md"
T_ALL=$(now)
if ! command -v limactl >/dev/null 2>&1; then
  probe_prereq
else
  run_probe prereq probe_prereq
  run_probe boot probe_boot
  run_probe idle probe_idle
  run_probe clone probe_clone
  run_probe git probe_git
  run_probe readonly probe_readonly
  run_probe network probe_network
  run_probe ports probe_ports
  run_probe suspend probe_suspend
  run_probe npm probe_npm
  run_probe devcontainer probe_devcontainer
  run_probe others probe_others
fi

{
  echo "# desolate v3 Phase 0: measurements on this Mac"
  echo
  echo "Run $STAMP, flags: quick=$QUICK only='${ONLY}'. Total $(since "$T_ALL") s."
  echo
  echo "Rows marked **UNEXPECTED** or **DID NOT RUN** are the ones to read first."
  echo
  echo "| probe | measure | value |"
  echo "|---|---|---|"
  cat "$OUT/rows.md"
} >"$RES"
rm -f "$OUT/rows.md"
cp "$WORK"/yaml/*.yaml "$OUT/" 2>/dev/null
( cd "$OUT/.." && tar -czf "$STAMP/results.tar.gz" --exclude results.tar.gz "$STAMP" 2>/dev/null )

if [ "$KEEP" = 0 ] && [ -z "$ONLY" ]; then
  cleanup_vms
  rm -rf "$WORK"
  echo "removed the probe's VMs and $WORK" >&2
else
  echo "kept the VMs (dp0-*) and $WORK; remove them with: bash $0 --clean" >&2
fi
echo
echo "Results: $RES"
echo "Send back: $OUT/results.tar.gz"
grep -cE 'UNEXPECTED|DID NOT RUN' "$RES" | sed 's/^/rows needing a look: /'
