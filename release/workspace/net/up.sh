#!/bin/bash
# A workspace VM's network, as seen from inside. Run as root by workspace/start.sh.
#   up.sh <link>        link: unix:/path  or  tcp:host:port   (the workspace's link to its proxy)
#
# Convenience, not a boundary (P5): every name resolves to a placeholder address, ports 80 and
# 443 are redirected to the egress relay, and the relay asks the proxy over the link. A
# program needs no proxy settings. Remove all of it and the VM still reaches nothing but its
# link: the backend sees to that from outside.
set -euo pipefail
LINK=${1:?usage: up.sh <link>}
HERE=$(cd "$(dirname "$0")" && pwd)
PLACEHOLDER=198.18.0.1   # RFC 2544's benchmarking range: never a real destination

# With no interface but loopback (the fake backend) there is no route for a connection to
# take to the redirect. Declaring every address local to loopback gives it one, with no
# kernel module and nothing leaving. (A plain default route through lo is not enough: the
# redirected connection never completes. Measured.)
ip route show default | grep -q . || ip route replace local default dev lo

# Names: one answer for every question. The proxy resolves the real name, outside.
systemctl disable --now systemd-resolved >/dev/null 2>&1 || true
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
if ! alive /run/desolate/dnsmasq.pid; then
  dnsmasq --conf-file=/dev/null --pid-file=/run/desolate/dnsmasq.pid --no-resolv --no-hosts \
    --listen-address=127.0.0.1 --bind-interfaces --address="/#/$PLACEHOLDER" --local-ttl=60 --user=root
fi
# A symlink (systemd's stub) is replaced; a file that cannot be replaced (a container's bind
# mount) is written in place.
[ -L /etc/resolv.conf ] && rm -f /etc/resolv.conf
printf 'nameserver 127.0.0.1\n' >/etc/resolv.conf

nft -f - <<N
table ip desolate
delete table ip desolate
table ip desolate {
  chain output {
    type nat hook output priority -100;
    ip daddr 127.0.0.0/8 return
    tcp dport 443 redirect to :15443
    tcp dport 80 redirect to :15080
  }
  chain prerouting {
    type nat hook prerouting priority -100;
    tcp dport 443 redirect to :15443
    tcp dport 80 redirect to :15080
    udp dport 53 redirect to :53
    tcp dport 53 redirect to :53
  }
}
N

if ! alive /run/desolate/egress.pid || [ "$(cat /run/desolate/link 2>/dev/null)" != "$LINK" ]; then
  alive /run/desolate/egress.pid && kill "$(cat /run/desolate/egress.pid)" 2>/dev/null || true
  setsid node --disable-warning=ExperimentalWarning "$HERE/egress.ts" "$LINK" >>/var/lib/desolate/egress.log 2>&1 </dev/null &
  echo $! >/run/desolate/egress.pid
  echo "$LINK" >/run/desolate/link
fi
