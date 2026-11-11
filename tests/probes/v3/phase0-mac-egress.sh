#!/bin/bash
# desolate v3, Phase 0: can a Lima/vz VM's egress be cut from OUTSIDE the VM (P5)?
#
#   bash phase0-mac-egress.sh          # ~5 minutes; uses the Ubuntu image phase0-mac.sh cached
#   bash phase0-mac-egress.sh --keep   # leave the VM in place
#
# The idea under test. Lima's default network for a vz VM is a user-mode stack that lives
# in Lima's own host process (the "hostagent"): every connection the guest makes leaves the
# Mac as a socket that process opens. So if the hostagent runs under a macOS sandbox
# (sandbox-exec) whose profile allows outbound connections to ONE loopback port, the proxy's,
# then nothing in the guest, root included, can reach anything else: the refusal happens in
# the Mac's kernel, on a process the guest cannot touch. (devvm's docs describe a VM that
# "runs on its confined process" and re-check it on every launch; this looks like the same
# approach.)
#
# What it measures, each with its control:
#   - sandboxed: guest reaches the allowed loopback port (the "proxy");
#   - sandboxed: guest is refused another loopback port, the internet, the LAN router;
#   - sandboxed: does DNS still resolve (a resolver that answers is an exfiltration channel);
#   - sandboxed: `limactl shell`, a read-only virtiofs mount and a clean stop still work;
#   - control: the SAME VM started without the sandbox reaches the internet.
#
# Results: ~/desolate-phase0-results/egress-<time>/results.md. Send that file back.

set -u
VM=dp0-egress
WORK=$HOME/.desolate-phase0-egress
OUT=$HOME/desolate-phase0-results/egress-$(date +%Y%m%d-%H%M%S)
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
PROXY_PORT=47700
OTHER_PORT=47701

mkdir -p "$WORK/share" "$OUT"
RAW=$OUT/raw.log; : >"$RAW"; : >"$OUT/rows.md"
rec() { printf '| %s | %s |\n' "$1" "$2" >>"$OUT/rows.md"; printf '  %s: %s\n' "$1" "$2" | tee -a "$RAW" >&2; }
check() { # check <label> <want: ok|refused> <exit code>
  local got; if [ "$3" = 0 ]; then got=ok; else got=refused; fi
  if [ "$got" = "$2" ]; then rec "$1" "as expected ($got)"; else rec "$1" "**UNEXPECTED: $got, wanted $2**"; fi
}
guest() { limactl shell --workdir / $VM "$@" 2>>"$RAW"; }
finish() {
  kill "${S1:-}" "${S2:-}" 2>/dev/null
  { echo "# desolate v3 Phase 0: egress cut from outside a Lima/vz VM"; echo
    echo "macOS $(sw_vers -productVersion), $(limactl --version 2>&1)"; echo
    echo "| check | result |"; echo "|---|---|"; cat "$OUT/rows.md"; } >"$OUT/results.md"
  rm -f "$OUT/rows.md"
  if [ "$KEEP" = 0 ]; then limactl delete -f $VM >/dev/null 2>&1; rm -rf "$WORK"; fi
  echo; echo "Results: $OUT/results.md"
}

command -v limactl >/dev/null 2>&1 || { rec "lima" "**MISSING: brew install lima**"; finish; exit 3; }
command -v sandbox-exec >/dev/null 2>&1 || { rec "sandbox-exec" "**MISSING on this macOS; the idea DID NOT RUN**"; finish; exit 3; }

cat >"$WORK/vm.yaml" <<EOF
minimumLimaVersion: 2.0.0
base:
- template:_images/ubuntu-24.04
vmType: vz
mountType: virtiofs
cpus: 2
memory: 2GiB
disk: 10GiB
containerd:
  system: false
  user: false
mounts:
- location: "$WORK/share"
  mountPoint: /desolate/share
  writable: false
# No automatic forwards of guest ports onto the Mac: desolate's forwarder is the only way in.
portForwards:
- guestIP: 0.0.0.0
  guestPortRange: [1, 65535]
  ignore: true
EOF

# The profile: everything a process normally does, except that outbound network connections
# are refused unless they go to the proxy's loopback port or to a unix socket (Lima's own
# sockets, the system resolver). In SBPL the LAST matching rule wins.
cat >"$WORK/confine.sb" <<EOF
(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote unix-socket))
(allow network-outbound (remote ip "localhost:$PROXY_PORT"))
EOF

echo marker >"$WORK/share/marker"
mkdir -p "$WORK/www-proxy" "$WORK/www-other"
echo "the-proxy" >"$WORK/www-proxy/who"; echo "another-host-service" >"$WORK/www-other/who"
( cd "$WORK/www-proxy" && exec python3 -m http.server $PROXY_PORT --bind 127.0.0.1 >/dev/null 2>&1 ) & S1=$!
( cd "$WORK/www-other" && exec python3 -m http.server $OTHER_PORT --bind 127.0.0.1 >/dev/null 2>&1 ) & S2=$!
sleep 1
curl -s -m 3 "http://127.0.0.1:$PROXY_PORT/who" | grep -q the-proxy
check "control: the Mac's stand-in proxy answers on 127.0.0.1:$PROXY_PORT" ok $?

limactl delete -f $VM >/dev/null 2>&1
limactl create --tty=false --name=$VM "$WORK/vm.yaml" >>"$RAW" 2>&1
check "create the VM (unsandboxed, so the image can download)" ok $?

# --- 1. unsandboxed control first: this VM, started normally, has the internet
limactl start --tty=false $VM >>"$RAW" 2>&1
check "control: start the VM WITHOUT the sandbox" ok $?
guest curl -s -m 10 -o /dev/null https://example.com/
check "control: unsandboxed, the guest reaches the internet" ok $?
guest curl -s -m 5 "http://host.lima.internal:$OTHER_PORT/who" | grep -q another-host-service
check "control: unsandboxed, the guest reaches another loopback service on the Mac" ok $?
limactl stop $VM >>"$RAW" 2>&1

# --- 2. the same VM, its host process sandboxed
sandbox-exec -f "$WORK/confine.sb" limactl start --tty=false $VM >>"$RAW" 2>&1
check "start the VM with its host process under sandbox-exec" ok $?
rec "the hostagent's process (pid, started by)" "$(ps -axo pid=,ppid=,command= | grep -E "hostagent.*$VM" | grep -v grep | awk '{print $1" ppid="$2}' | tr '\n' ' ')"
guest true
check "sandboxed: 'limactl shell' works" ok $?
guest cat /desolate/share/marker >/dev/null
check "sandboxed: the virtiofs share is readable" ok $?
guest sudo touch /desolate/share/w 2>/dev/null
check "sandboxed: root in the guest writes the read-only share" refused $?
guest curl -s -m 5 "http://host.lima.internal:$PROXY_PORT/who" | grep -q the-proxy
check "sandboxed: the guest reaches its proxy's port" ok $?
guest curl -s -m 5 "http://host.lima.internal:$OTHER_PORT/who" | grep -q another-host-service
check "sandboxed: the guest reaches ANOTHER loopback service on the Mac" refused $?
guest curl -s -m 10 -o /dev/null https://example.com/
check "sandboxed: the guest reaches the internet by name" refused $?
guest curl -s -m 10 -o /dev/null https://1.1.1.1/
check "sandboxed: the guest reaches the internet by address" refused $?
guest sudo bash -c 'curl -s -m 10 -o /dev/null https://1.1.1.1/'
check "sandboxed: ROOT in the guest reaches the internet by address" refused $?
guest sudo bash -c 'ip route replace default via 192.168.5.2 2>/dev/null; iptables -F 2>/dev/null; nft flush ruleset 2>/dev/null; curl -s -m 10 -o /dev/null https://1.1.1.1/'
check "sandboxed: root, after rewriting routes and flushing every firewall rule" refused $?
LAN=$(route -n get default 2>/dev/null | awk '/gateway:/{print $2}')
if [ -n "$LAN" ]; then
  guest curl -s -m 4 -o /dev/null "http://$LAN/"
  check "sandboxed: the guest opens TCP 80 on the LAN's router $LAN" refused $?
  guest ping -c 1 -W 2 "$LAN" >/dev/null 2>&1
  check "sandboxed: the guest pings the LAN's router" refused $?
fi
guest getent hosts example.com >/dev/null 2>&1
rec "sandboxed: DNS in the guest resolves example.com (0 = yes: then the resolver must be closed too)" "$?"
guest bash -c 'getent hosts "probe-$(date +%s).desolate-exfil-test.example.com"' >/dev/null 2>&1
rec "sandboxed: DNS resolves a made-up name (exit code; the query leaving the Mac is the channel)" "$?"
rec "sandboxed: a direct UDP DNS query to 1.1.1.1 (empty = no answer)" "$(guest sudo bash -c 'command -v dig >/dev/null && dig +time=3 +tries=1 @1.1.1.1 example.com +short 2>/dev/null | head -1' | tr '\n' ' ')"
limactl stop $VM >>"$RAW" 2>&1
check "sandboxed: a clean stop" ok $?
grep -iE 'sandbox|deny|operation not permitted' "$HOME/.lima/$VM/ha.stderr.log" 2>/dev/null | tail -5 >>"$RAW"
rec "refusals logged by the hostagent (lines mentioning 'not permitted')" "$(grep -ciE 'operation not permitted' "$HOME/.lima/$VM/ha.stderr.log" 2>/dev/null)"

finish
grep -c 'UNEXPECTED' "$OUT/results.md" | sed 's/^/rows needing a look: /'
