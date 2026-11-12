#!/bin/bash
# The root VM does not reach the Mac's loopback, or the Mac's other private addresses. Run as
# root: by the host at bootstrap (`wall.sh set [--required] <port>...`), by start.sh at every
# start, and by a boot unit before the network and ssh come up (`wall.sh apply`).
#
# Lima's network gives every VM the subnet 192.168.5.0/24, and in it addresses that ARE the
# Mac's loopback: the gateway, 192.168.5.2 (measured on the M1, 2026-11-12: the host daemon's
# approval page answered 200 from the root, and the Mac's own ssh); on QEMU's network every
# address of the prefix but the resolver's, and IPv6 too. The root's user parses what domains
# send; a bug in one of those parsers should not get it to every local service of the Mac.
#
# So, to Lima's subnet: replies in flows the host opened (its ssh in), DNS to the resolver,
# DHCP to the gateway, and nothing else, including flows this VM opened before the wall.
# No private range either (the Mac's LAN address, a VPN's): the root reaches the forge and
# package registries, on the internet. No IPv6 at all but loopback: the root needs none.
# Traffic through the gateway to the internet is to other addresses, and is untouched.
#
# `set` also allows ports on the gateway the host names: a stand-in forge published on the
# Mac's loopback, in tests only (host/bootstrap.ts). `--required`: from then on, a wall that
# cannot be set stops start.sh (a real VM).
set -euo pipefail
SYS=/var/lib/desolate-root
ALLOW="$SYS/gateway-allow"
HOSTS="$SYS/wall-hosts"
REQUIRED="$SYS/wall-required"
NET=192.168.5.0/24
GATEWAY=192.168.5.2
RESOLVERS="192.168.5.2, 192.168.5.3"
case "${1:-}" in
  set)
    shift
    install -d -m 0755 -o root -g root "$SYS"
    required=0
    : >"$ALLOW.new"
    : >"$HOSTS.new"
    while [ $# -gt 0 ]; do
      case $1 in
        --required) required=1 ;;
        --allow-host)
          [[ ${2:-} =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo "wall.sh: '${2:-}' is not an address" >&2; exit 1; }
          echo "$2" >>"$HOSTS.new"; shift ;;
        *)
          [[ $1 =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || { echo "wall.sh: '$1' is not a port" >&2; exit 1; }
          echo "$1" >>"$ALLOW.new" ;;
      esac
      shift
    done
    chmod 0644 "$ALLOW.new" "$HOSTS.new" && mv "$ALLOW.new" "$ALLOW" && mv "$HOSTS.new" "$HOSTS"
    [ "$required" = 1 ] && touch "$REQUIRED"
    # The boot unit, from root's own copy: the release share is not there that early.
    install -m 0755 -o root -g root "$0" "$SYS/wall.sh"
    cat >/etc/systemd/system/desolate-wall.service <<'U'
[Unit]
Description=desolate: the root VM does not reach the Mac's loopback
DefaultDependencies=no
Before=network-pre.target ssh.service systemd-user-sessions.service
Wants=network-pre.target
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash /var/lib/desolate-root/wall.sh apply

[Install]
WantedBy=sysinit.target
U
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl enable desolate-wall.service >/dev/null 2>&1 || true
    ;;
  apply) ;;
  *) echo "usage: wall.sh set [--required] [--allow-host <address>]... <port>... | apply" >&2; exit 64 ;;
esac
# The sshd rule below trusts source port 22 to be root's alone.
sysctl -qw net.ipv4.ip_unprivileged_port_start=1024 2>/dev/null || true
PORTS=$( [ -f "$ALLOW" ] && paste -sd, "$ALLOW" || true)
ALLOWED=$( [ -f "$HOSTS" ] && paste -sd, "$HOSTS" || true)
# A gateway outside Lima's subnet (a container standing in for a VM) is walled off too.
OTHER=$(ip -4 route show default 2>/dev/null | awk '/^default via/ { print $3; exit }')
[[ ${OTHER:-} =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && [[ $OTHER != 192.168.5.* ]] || OTHER=""
{
  echo "table inet desolate_wall"
  echo "delete table inet desolate_wall"
  echo "table inet desolate_wall {"
  echo "  chain out {"
  echo "    type filter hook output priority 0; policy accept;"
  echo "    oifname \"lo\" accept"
  echo "    meta nfproto ipv6 reject"
  # Flows the host opened (its ssh in, its dials through it): their replies. And what this
  # VM's sshd sends, by its port (root's to bind), whatever conntrack makes of a session's
  # last packets (on a fresh VM they were taken for new ones, and bootstrap hung: T4).
  echo "    ip daddr $NET ct direction reply accept"
  echo "    ip daddr $NET tcp sport 22 accept"
  echo "    ip daddr { $RESOLVERS } udp dport 53 accept"
  echo "    ip daddr { $RESOLVERS } tcp dport 53 accept"
  echo "    ip daddr $GATEWAY udp dport 67 accept"
  [ -n "$PORTS" ] && echo "    ip daddr $GATEWAY tcp dport { $PORTS } accept"
  echo "    ip daddr $NET reject"
  [ -n "$OTHER" ] && echo "    ip daddr $OTHER ct direction reply accept" && echo "    ip daddr $OTHER udp dport { 53, 67 } accept" && echo "    ip daddr $OTHER reject"
  # A stand-in forge at a private address, in tests only (the host names it).
  [ -n "$ALLOWED" ] && echo "    ip daddr { $ALLOWED } accept"
  echo "    ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10 } ct direction reply accept"
  echo "    ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10 } reject"
  echo "  }"
  echo "}"
} | nft -f -
echo "root: the Mac's loopback and private addresses are walled off${PORTS:+ (allowed on the gateway, for tests: $PORTS)}${ALLOWED:+ (allowed, for tests: $ALLOWED)}"
