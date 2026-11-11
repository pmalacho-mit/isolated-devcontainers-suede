#!/bin/bash
# desolate v3, Phase 0, round 3: the numbers and behaviours the Lima/vz backend is built on,
# that only a Mac can give. Independent of the egress probes.
#
#   bash phase0-mac-backend.sh        # ~7 minutes; reuses the cached Ubuntu image; needs the network
#
#   A. template -> workspace (section 4.7's 15 s target, caches C1 and C3):
#      build one VM with dockerd and a built devcontainer, then CLONE it with a DIFFERENT set
#      of shares, boot the clone, and time until its devcontainer is up again.
#   B. many shares: 12 virtiofs mounts, ten of them read-only and nested under one parent
#      (a domain's mirrors).
#   C. the forwarder's way in: a TCP stream to a guest port over Lima's ssh (ssh -W), its
#      latency, and 20 at once.
#   D. the egress path's throughput: guest -> a listener on the Mac's loopback.
#
# Results: ~/desolate-phase0-results/backend-<time>/results.md (+ raw.log). Send both back.
set -u
TPL=dp0-tpl
WS=dp0-wsc
WORK=$HOME/.desolate-phase0-backend
OUT=$HOME/desolate-phase0-results/backend-$(date +%Y%m%d-%H%M%S)
mkdir -p "$WORK" "$OUT"
RAW=$OUT/raw.log; : >"$RAW"; : >"$OUT/rows.md"
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
since() { perl -e 'printf "%.1f", $ARGV[1]-$ARGV[0]' "$1" "$(now)"; }
rec() { printf '| %s | %s | %s |\n' "$1" "$2" "$3" >>"$OUT/rows.md"; printf '  [%s] %s: %s\n' "$1" "$2" "$3" | tee -a "$RAW" >&2; }
check() { local got; if [ "$4" = 0 ]; then got=ok; else got=refused; fi
  if [ "$got" = "$3" ]; then rec "$1" "$2" "as expected ($got)"; else rec "$1" "$2" "**UNEXPECTED: $got, wanted $3**"; fi; }
g() { local vm=$1; shift; limactl shell --workdir / "$vm" "$@" 2>>"$RAW"; }
finish() {
  kill "${SRV:-}" 2>/dev/null
  { echo "# desolate v3 Phase 0, round 3: the Lima/vz backend (macOS $(sw_vers -productVersion), $(limactl --version 2>&1))"; echo
    echo "| part | measure | value |"; echo "|---|---|---|"; cat "$OUT/rows.md"; } >"$OUT/results.md"
  rm -f "$OUT/rows.md"
  limactl delete -f $TPL $WS >/dev/null 2>&1; rm -rf "$WORK"
  echo; echo "Results: $OUT/results.md  (and raw.log beside it)"
}
command -v limactl >/dev/null 2>&1 || { echo "brew install lima" >&2; exit 3; }
limactl delete -f $TPL $WS >/dev/null 2>&1

# ---- shares: the template's (2) and the workspace's (12)
mkdir -p "$WORK/tpl-rw" "$WORK/release" "$WORK/ws-rw" "$WORK/mirrors"
echo release >"$WORK/release/marker"; echo tpl >"$WORK/tpl-rw/marker"; echo ws >"$WORK/ws-rw/marker"
WS_MOUNTS="{\"location\": \"$WORK/release\", \"mountPoint\": \"/desolate/release\", \"writable\": false}, {\"location\": \"$WORK/ws-rw\", \"mountPoint\": \"/workspaces\", \"writable\": true}"
i=1
while [ $i -le 10 ]; do
  mkdir -p "$WORK/mirrors/owner$i/repo$i.git"; echo "mirror $i" >"$WORK/mirrors/owner$i/repo$i.git/HEAD"
  WS_MOUNTS="$WS_MOUNTS, {\"location\": \"$WORK/mirrors/owner$i/repo$i.git\", \"mountPoint\": \"/desolate/mirrors/owner$i/repo$i.git\", \"writable\": false}"
  i=$((i + 1))
done
cat >"$WORK/tpl.yaml" <<Y
minimumLimaVersion: 2.0.0
base:
- template:_images/ubuntu-24.04
vmType: vz
mountType: virtiofs
cpus: 4
memory: 4GiB
disk: 30GiB
containerd:
  system: false
  user: false
mounts:
- location: "$WORK/release"
  mountPoint: /desolate/release
  writable: false
- location: "$WORK/tpl-rw"
  mountPoint: /desolate/build
  writable: true
portForwards:
- guestIP: 0.0.0.0
  guestPortRange: [1, 65535]
  ignore: true
Y

# ---- A. the template
t0=$(now)
limactl start --tty=false --name=$TPL "$WORK/tpl.yaml" >>"$RAW" 2>&1
check A "template VM: create + boot" ok $?
rec A "template VM: create + boot took" "$(since "$t0") s"
cat >"$WORK/tpl-rw/provision.sh" <<'P'
#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
a=$(uname -m); case $a in aarch64) a=arm64 ;; x86_64) a=x64 ;; esac
sudo apt-get update -qq; sudo apt-get install -y -qq xz-utils socat >/dev/null
curl -fsSL "https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-$a.tar.xz" | sudo tar -xJ -C /usr/local --strip-components=1
curl -fsSL https://get.docker.com | sudo sh >/dev/null 2>&1
sudo npm install -g --silent @devcontainers/cli >/dev/null 2>&1
mkdir -p "$HOME/proj/.devcontainer"
cat >"$HOME/proj/.devcontainer/devcontainer.json" <<'J'
{"image":"mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
 "features":{"ghcr.io/devcontainers/features/node:1":{"version":"22"}},
 "postCreateCommand":"node --version"}
J
sudo devcontainer up --workspace-folder "$HOME/proj" >"$HOME/up1.log" 2>&1
echo provisioned
P
t0=$(now)
g $TPL bash /desolate/build/provision.sh >>"$RAW" 2>&1
check A "template: dockerd, devcontainer CLI, one devcontainer built (image + node feature)" ok $?
rec A "template: provisioning + first devcontainer build took" "$(since "$t0") s"
rec A "template: docker disk" "$(g $TPL sudo du -sm /var/lib/docker | cut -f1) MB"
limactl stop $TPL >>"$RAW" 2>&1
rec A "template VM directory on disk (du -sh)" "$(du -sh "$HOME/.lima/$TPL" | awk '{print $1}')"

# ---- A. clone it, with the workspace's shares instead of the template's
tall=$(now); t0=$(now)
limactl clone --tty=false --set ".mounts = [$WS_MOUNTS]" $TPL $WS >>"$RAW" 2>&1
rc=$?
if [ $rc -ne 0 ]; then
  rec A "clone with --set '.mounts = [...]'" "**exit $rc; trying clone, then 'limactl edit --set'**"
  limactl delete -f $WS >/dev/null 2>&1
  limactl clone --tty=false $TPL $WS >>"$RAW" 2>&1; check A "plain clone" ok $?
  limactl edit --tty=false --set ".mounts = [$WS_MOUNTS]" $WS >>"$RAW" 2>&1; check A "'limactl edit --set' the clone's mounts" ok $?
else
  rec A "clone with --set '.mounts = [...]' (12 shares)" "ok, $(since "$t0") s"
fi
t0=$(now)
limactl start --tty=false $WS >>"$RAW" 2>&1
check A "clone: boot with 12 shares" ok $?
rec A "clone: boot to SSH ready" "$(since "$t0") s"
t0=$(now)
g $WS bash -c 'for i in $(seq 1 100); do sudo docker info >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1'
check A "clone: dockerd answers" ok $?
rec A "clone: wait for dockerd" "$(since "$t0") s"
rec A "clone: the template's image is in the clone's docker (images)" "$(g $WS sudo docker images -q | wc -l | tr -d ' ')"
t0=$(now)
g $WS bash -c 'sudo devcontainer up --workspace-folder "$HOME/proj" >"$HOME/up2.log" 2>&1'
check A "clone: devcontainer up (nothing to build)" ok $?
rec A "clone: devcontainer up took" "$(since "$t0") s"
rec A "**clone -> devcontainer ready, total** (the 15 s target, without the editor)" "$(since "$tall") s"
g $WS bash -c 'sudo devcontainer exec --workspace-folder "$HOME/proj" node --version' >>"$RAW" 2>&1
check A "clone: a command inside its devcontainer" ok $?

# ---- B. the shares in the clone
rec B "virtiofs mounts in the clone (want 12)" "$(g $WS bash -c "grep -c ' virtiofs ' /proc/mounts")"
g $WS test -e /desolate/build/marker; check B "the template's share is gone from the clone" refused $?
g $WS bash -c 'for i in $(seq 1 10); do grep -q "mirror $i" /desolate/mirrors/owner$i/repo$i.git/HEAD || exit 1; done'; check B "all ten nested read-only shares readable, each its own content" ok $?
g $WS sudo touch /workspaces/w; check B "control: root writes the writable share" ok $?
g $WS sudo touch /desolate/mirrors/owner7/repo7.git/w 2>/dev/null; check B "root writes a nested read-only share" refused $?
g $WS sudo touch /desolate/mirrors/owner7/w 2>/dev/null; rec B "root creates a file in the PARENT of the nested shares (the VM's own disk; exit code)" "$?"
ls "$WORK/mirrors/owner7/" >>"$RAW"
rec B "what the Mac sees in that parent (want only repo7.git)" "$(ls "$WORK/mirrors/owner7/" | tr '\n' ' ')"

# ---- C. a stream into the guest over Lima's ssh
g $WS bash -c 'mkdir -p /tmp/www && echo inside >/tmp/www/who && cd /tmp/www && nohup python3 -m http.server 8000 --bind 127.0.0.1 >/dev/null 2>&1 &'
sleep 1
CFG=$HOME/.lima/$WS/ssh.config
dial() { printf 'GET /who HTTP/1.0\r\n\r\n' | ssh -F "$CFG" "lima-$WS" -W 127.0.0.1:8000 2>>"$RAW" | tail -1; }
[ "$(dial)" = inside ]; check C "ssh -W into the guest's 127.0.0.1:8000 returns the page" ok $?
t0=$(now); n=0; while [ $n -lt 20 ]; do dial >/dev/null; n=$((n + 1)); done
rec C "20 sequential streams over ssh -W" "$(since "$t0") s total"
t0=$(now); n=0; while [ $n -lt 20 ]; do dial >"$WORK/c$n.out" & n=$((n + 1)); done; wait
rec C "20 concurrent streams over ssh -W" "$(since "$t0") s total, $(cat "$WORK"/c*.out | grep -c inside) of 20 answered"
printf 'x' | ssh -F "$CFG" "lima-$WS" -W 127.0.0.1:8999 >/dev/null 2>&1
check C "ssh -W to a guest port nobody listens on" refused $?
t0=$(now); g $WS true; rec C "for comparison: one 'limactl shell' round trip" "$(since "$t0") s"

# ---- D. throughput of the egress path
mkdir -p "$WORK/blob"; dd if=/dev/zero of="$WORK/blob/b" bs=1m count=300 2>/dev/null
( cd "$WORK/blob" && exec python3 -m http.server 47710 --bind 127.0.0.1 >/dev/null 2>&1 ) & SRV=$!
sleep 1
rec D "guest downloads 300 MB from the Mac's loopback via host.lima.internal (bytes/s)" "$(g $WS curl -s -m 120 -o /dev/null -w '%{speed_download}' http://host.lima.internal:47710/b)"
rec D "same, 8 downloads at once (bytes/s each)" "$(g $WS bash -c 'for i in 1 2 3 4 5 6 7 8; do curl -s -m 120 -o /dev/null -w "%{speed_download} " http://host.lima.internal:47710/b & done; wait')"
finish
grep -c 'UNEXPECTED' "$OUT/results.md" | sed 's/^/rows needing a look: /'
