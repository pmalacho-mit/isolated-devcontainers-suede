#!/bin/bash
# desolate v3, Phase 0, egress round 3 (~2 minutes). Round 2 left one question and one flaw:
#
#   ICMP. Under every profile a ping from the guest was "answered", to 1.1.1.1 and to the LAN
#   router. Either echoes really leave the Mac (a channel: an echo carries a payload), or
#   Lima's user-mode network stack answers every echo itself and nothing leaves. This tells
#   them apart: 192.0.2.1 is a documentation address that no host on the internet answers
#   for. If the guest gets a reply from it, the reply was made locally. The Mac's own ping
#   to the same addresses is the control, and the reply times are compared.
#
#   The flaw: round 2's "query straight to 1.1.1.1 / 192.168.5.3" rows matched dig's own
#   error text and so said "ok" whatever happened. Here the answer must be an address.
#
#   bash phase0-mac-egress3.sh
# Results: ~/desolate-phase0-results/egress3-<time>/results.md. Send it back.
set -u
VM=dp0-egress3
WORK=$HOME/.desolate-phase0-egress3
OUT=$HOME/desolate-phase0-results/egress3-$(date +%Y%m%d-%H%M%S)
PROXY_PORT=47700 SSH_PORT=47723
mkdir -p "$WORK" "$OUT"
RAW=$OUT/raw.log; : >"$RAW"; : >"$OUT/rows.md"
rec() { printf '| %s | %s | %s |\n' "$1" "$2" "$3" >>"$OUT/rows.md"; printf '  [%s] %s: %s\n' "$1" "$2" "$3" | tee -a "$RAW" >&2; }
guest() { limactl shell --workdir / $VM "$@" 2>>"$RAW"; }
command -v limactl >/dev/null 2>&1 || { echo "brew install lima" >&2; exit 3; }
cat >"$WORK/vm.yaml" <<Y
minimumLimaVersion: 2.0.0
base:
- template:_images/ubuntu-24.04
vmType: vz
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
cat >"$WORK/p2.sb" <<S
(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote unix-socket))
(deny network-outbound (literal "/private/var/run/mDNSResponder"))
(deny network-outbound (literal "/var/run/mDNSResponder"))
(allow network-outbound (remote ip "localhost:$PROXY_PORT"))
(allow network-outbound (remote ip "localhost:$SSH_PORT"))
S
# ping <where> <address>: "answered <avg ms>" or "no reply"
pingrow() {
  local out
  if [ "$1" = mac ]; then out=$(ping -c 3 -W 2000 "$2" 2>&1); else out=$(guest sudo ping -c 3 -W 2 "$2" 2>&1); fi
  printf '%s\n' "$out" >>"$RAW"
  if printf '%s' "$out" | grep -q ' 0 packets received\| 0 received'; then echo "no reply"
  else echo "answered, $(printf '%s' "$out" | awk -F/ '/min\/avg/{print $5}') ms avg"; fi
}
dnsrow() { # an A record, or nothing
  guest sudo bash -c "dig +time=2 +tries=1 @$1 example.com A +short 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1" | tr -d '\n'
}
rec mac "the Mac itself pings 1.1.1.1 (the real round trip, for comparison)" "$(pingrow mac 1.1.1.1)"
rec mac "the Mac itself pings 192.0.2.1 (a documentation address: must be 'no reply')" "$(pingrow mac 192.0.2.1)"
limactl delete -f $VM >/dev/null 2>&1
limactl create --tty=false --name=$VM "$WORK/vm.yaml" >>"$RAW" 2>&1
for MODE in open sandboxed; do
  if [ "$MODE" = open ]; then limactl start --tty=false $VM >>"$RAW" 2>&1
  else sandbox-exec -f "$WORK/p2.sb" limactl start --tty=false $VM >>"$RAW" 2>&1; fi
  rec "$MODE" "start exit" "$?"
  rec "$MODE" "guest pings 1.1.1.1" "$(pingrow guest 1.1.1.1)"
  rec "$MODE" "guest pings 192.0.2.1 (a reply here was made locally: nothing left the Mac)" "$(pingrow guest 192.0.2.1)"
  rec "$MODE" "guest pings 203.0.113.77 (another documentation address)" "$(pingrow guest 203.0.113.77)"
  rec "$MODE" "guest: an A record from Lima's resolver 192.168.5.3 (empty = none)" "$(dnsrow 192.168.5.3)"
  rec "$MODE" "guest: an A record straight from 1.1.1.1 over UDP (empty = none)" "$(dnsrow 1.1.1.1)"
  rec "$MODE" "guest: a TXT record from Lima's resolver (empty = none)" "$(guest sudo bash -c "dig +time=2 +tries=1 @192.168.5.3 example.com TXT +short 2>/dev/null | grep -c '^\"'" | tr -d '\n')"
  rec "$MODE" "guest: getent hosts example.com (exit code)" "$(guest getent hosts example.com >/dev/null 2>&1; echo $?)"
  limactl stop $VM >>"$RAW" 2>&1
done
{ echo "# desolate v3 Phase 0: egress round 3 (macOS $(sw_vers -productVersion), $(limactl --version 2>&1))"; echo
  echo "Read it as: if 'guest pings 192.0.2.1' is answered while the Mac's own is not, guest pings are"
  echo "answered inside Lima's network stack and ICMP is not a way out. If it is 'no reply' while"
  echo "'guest pings 1.1.1.1' is answered under 'sandboxed', echoes do leave the Mac and must be closed."; echo
  echo "| where | check | result |"; echo "|---|---|---|"; cat "$OUT/rows.md"; } >"$OUT/results.md"
rm -f "$OUT/rows.md"; limactl delete -f $VM >/dev/null 2>&1; rm -rf "$WORK"
echo; echo "Results: $OUT/results.md"
