#!/bin/bash
# desolate v3, Phase 0, egress round 2. Round 1 showed that running Lima's host process under
# sandbox-exec cuts a vz VM's TCP and UDP egress from outside the VM, and left three things:
#   1. `limactl start` exited non-zero under the sandbox (the VM did come up): the profile
#      also refused Lima's own ssh to the VM's forwarded port. Here that one port is allowed.
#   2. DNS still resolved through Lima's resolver: a query that leaves the Mac is a channel.
#   3. ping to the LAN router was answered: ICMP was not covered. An echo's payload is a channel.
# This tries four profiles, each on a fresh start of the same VM, and reports per profile.
#
#   bash phase0-mac-egress2.sh          # ~6 minutes; reuses the cached Ubuntu image
#
# Results: ~/desolate-phase0-results/egress2-<time>/results.md. Send that file back
# (raw.log beside it too, if a row says UNEXPECTED).
set -u
VM=dp0-egress2
WORK=$HOME/.desolate-phase0-egress2
OUT=$HOME/desolate-phase0-results/egress2-$(date +%Y%m%d-%H%M%S)
PROXY_PORT=47700 OTHER_PORT=47701 SSH_PORT=47722
mkdir -p "$WORK" "$OUT"
RAW=$OUT/raw.log; : >"$RAW"; : >"$OUT/rows.md"
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
since() { perl -e 'printf "%.1f", $ARGV[1]-$ARGV[0]' "$1" "$(now)"; }
rec() { printf '| %s | %s | %s |\n' "$1" "$2" "$3" >>"$OUT/rows.md"; printf '  [%s] %s: %s\n' "$1" "$2" "$3" | tee -a "$RAW" >&2; }
check() { local got; if [ "$4" = 0 ]; then got=ok; else got=refused; fi
  if [ "$got" = "$3" ]; then rec "$1" "$2" "as expected ($got)"; else rec "$1" "$2" "**UNEXPECTED: $got, wanted $3**"; fi; }
guest() { limactl shell --workdir / $VM "$@" 2>>"$RAW"; }
command -v limactl >/dev/null 2>&1 || { echo "brew install lima" >&2; exit 3; }

cat >"$WORK/vm.yaml" <<Y
minimumLimaVersion: 2.0.0
base:
- template:_images/ubuntu-24.04
vmType: vz
mountType: virtiofs
cpus: 2
memory: 2GiB
disk: 10GiB
mounts: []
containerd:
  system: false
  user: false
ssh:
  localPort: $SSH_PORT
portForwards:
- guestIP: 0.0.0.0
  guestPortRange: [1, 65535]
  ignore: true
Y

BASE="(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote unix-socket))
(allow network-outbound (remote ip \"localhost:$PROXY_PORT\"))
(allow network-outbound (remote ip \"localhost:$SSH_PORT\"))"
NODNS='(deny network-outbound (literal "/private/var/run/mDNSResponder"))
(deny network-outbound (literal "/var/run/mDNSResponder"))'
profile() { # profile <name>
  case "$1" in
    P1-ssh) printf '%s\n' "$BASE" ;;
    P2-ssh-nodns) printf '%s\n%s\n' "$BASE" "$NODNS" ;;
    P3-nodns-bind) printf '%s\n%s\n%s\n' "$BASE" "$NODNS" '(deny network-bind (local ip "*:*"))
(allow network-bind (local ip "localhost:*"))' ;;
    P4-nodns-icmpsock) printf '%s\n%s\n%s\n' "$BASE" "$NODNS" '(deny system-socket (socket-domain AF_INET) (socket-protocol 1))
(deny system-socket (socket-domain AF_INET6) (socket-protocol 58))' ;;
  esac
}

mkdir -p "$WORK/www"; echo the-proxy >"$WORK/www/who"
( cd "$WORK/www" && exec python3 -m http.server $PROXY_PORT --bind 127.0.0.1 >/dev/null 2>&1 ) & S1=$!
( cd "$WORK/www" && exec python3 -m http.server $OTHER_PORT --bind 127.0.0.1 >/dev/null 2>&1 ) & S2=$!
LAN=$(route -n get default 2>/dev/null | awk '/gateway:/{print $2}')
limactl delete -f $VM >/dev/null 2>&1
limactl create --tty=false --name=$VM "$WORK/vm.yaml" >>"$RAW" 2>&1
limactl start --tty=false $VM >>"$RAW" 2>&1
check control "start WITHOUT a sandbox" ok $?
guest ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1; check control "unsandboxed: ping 1.1.1.1 answers (else the ping rows below prove nothing)" ok $?
guest getent hosts example.com >/dev/null 2>&1; check control "unsandboxed: DNS resolves example.com" ok $?
limactl stop $VM >>"$RAW" 2>&1

for P in P1-ssh P2-ssh-nodns P3-nodns-bind P4-nodns-icmpsock; do
  profile "$P" >"$WORK/$P.sb"
  echo "=== $P ===" >>"$RAW"; cat "$WORK/$P.sb" >>"$RAW"
  t0=$(now)
  sandbox-exec -f "$WORK/$P.sb" limactl start --tty=false $VM >>"$RAW" 2>&1
  rc=$?
  rec "$P" "'limactl start' under the sandbox: exit code, time" "$rc, $(since "$t0") s"
  if ! guest true; then
    rec "$P" "the VM" "**did not come up under this profile; the rows for it DID NOT RUN**"
    limactl stop -f $VM >>"$RAW" 2>&1; continue
  fi
  guest curl -s -m 5 "http://host.lima.internal:$PROXY_PORT/who" | grep -q the-proxy; check "$P" "guest reaches its proxy port" ok $?
  guest curl -s -m 5 -o /dev/null "http://host.lima.internal:$OTHER_PORT/who"; check "$P" "guest reaches another loopback port" refused $?
  guest curl -s -m 5 -o /dev/null "http://host.lima.internal:$SSH_PORT/"; rec "$P" "guest opens the Mac's forwarded ssh port (its own sshd; curl exit)" "$?"
  guest sudo curl -s -m 8 -o /dev/null https://1.1.1.1/; check "$P" "root: TCP to the internet" refused $?
  guest sudo ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1; check "$P" "root: ping 1.1.1.1" refused $?
  [ -n "$LAN" ] && { guest sudo ping -c 1 -W 2 "$LAN" >/dev/null 2>&1; check "$P" "root: ping the LAN router $LAN" refused $?; }
  guest sudo ping -c 1 -W 2 192.168.5.2 >/dev/null 2>&1; rec "$P" "root: ping the gateway 192.168.5.2 (answered locally is fine; exit)" "$?"
  guest getent hosts example.com >/dev/null 2>&1; check "$P" "DNS resolves example.com" refused $?
  guest bash -c 'getent hosts "p$(date +%s).desolate-exfil.example.com"' >/dev/null 2>&1; check "$P" "DNS resolves a made-up name" refused $?
  guest sudo bash -c 'command -v dig >/dev/null && dig +time=2 +tries=1 @192.168.5.3 example.com +short | grep -q .'; check "$P" "root: a query straight to Lima's resolver 192.168.5.3" refused $?
  guest sudo bash -c 'command -v dig >/dev/null && dig +time=2 +tries=1 @1.1.1.1 example.com +short | grep -q .'; check "$P" "root: a UDP query straight to 1.1.1.1" refused $?
  t0=$(now); limactl stop $VM >>"$RAW" 2>&1; rec "$P" "clean stop: exit, time" "$?, $(since "$t0") s"
  rec "$P" "refusals in the hostagent's log" "$(grep -ciE 'not permitted' "$HOME/.lima/$VM/ha.stderr.log" 2>/dev/null)"
  tail -40 "$HOME/.lima/$VM/ha.stderr.log" >>"$RAW" 2>/dev/null
done
kill $S1 $S2 2>/dev/null
{ echo "# desolate v3 Phase 0: egress round 2 (macOS $(sw_vers -productVersion), $(limactl --version 2>&1))"; echo
  echo "| profile | check | result |"; echo "|---|---|---|"; cat "$OUT/rows.md"; } >"$OUT/results.md"
rm -f "$OUT/rows.md"
limactl delete -f $VM >/dev/null 2>&1; rm -rf "$WORK"
echo; echo "Results: $OUT/results.md  (and raw.log beside it)"
