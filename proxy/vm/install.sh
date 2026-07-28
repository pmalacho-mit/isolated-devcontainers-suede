#!/usr/bin/env bash
# desolate-proxy installer -- the egress/secrets layer. Runs INSIDE the Colima
# VM, as root. You normally reach it from the Mac via:
#   ./cli.sh vm install                # this plus the sysbox layer
#   ./cli.sh vm install --proxy-only   # just this
# both of which go through ../../vm/install.sh.
#
# Idempotent. Auto-detects the bridge interface carrying the desolate stack, so
# you should not need to edit nftables-desolate.conf by hand -- and `cli.sh up`
# re-runs this automatically if the live bridge ever drifts from the one the
# rules are armed for.
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE_NET="${DESOLATE_NET:-desolate_devnet}"

echo "==> packages"
apt-get update -qq
# jq is NOT optional here: /etc/desolate-proxy/settings.json is this layer's
# store, and every `cli.sh secret add|list|rm` edits it with jq over `colima
# ssh`. It only ever worked by accident -- install-sysbox.sh installs jq as a
# side effect, but ONLY on the branch that actually installs sysbox. Re-run
# `vm install` on a VM already at the pinned version, or use --proxy-only, and
# jq was never installed at all. The layer that needs a tool installs it.
apt-get install -y -qq python3-venv nftables dnsmasq jq

echo "==> service user"
id desolate-proxy >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin desolate-proxy

echo "==> mitmproxy venv"
# PINNED. The addon is the entire secrets boundary and mitmproxy answers an
# addon exception by forwarding the request unmodified -- so an API change in a
# future release would turn substitution and leak-detection off silently while
# traffic kept flowing. Bump this deliberately, and re-run tests/ afterwards.
MITMPROXY_VERSION="${MITMPROXY_VERSION:-11.0.2}"
install -d /opt/desolate-proxy
NEED_INSTALL=1
if [ -x /opt/desolate-proxy/venv/bin/mitmdump ]; then
    HAVE=$(/opt/desolate-proxy/venv/bin/mitmdump --version 2>/dev/null | awk '/^Mitmproxy:/{print $2}')
    [ "$HAVE" = "$MITMPROXY_VERSION" ] && NEED_INSTALL=0 \
        || echo "    have mitmproxy '$HAVE', want '$MITMPROXY_VERSION' -- reinstalling"
fi
if [ "$NEED_INSTALL" = 1 ]; then
    [ -d /opt/desolate-proxy/venv ] || python3 -m venv /opt/desolate-proxy/venv
    /opt/desolate-proxy/venv/bin/pip install --quiet --upgrade pip
    /opt/desolate-proxy/venv/bin/pip install --quiet "mitmproxy==${MITMPROXY_VERSION}"
fi
install -m 0644 addon.py /opt/desolate-proxy/addon.py
install -m 0755 ../container/install-ca.sh /opt/desolate-proxy/install-ca.sh

echo "==> config (0600, proxy-owned, VM disk only -- never under a Colima mount)"
install -d -m 0750 -o desolate-proxy -g desolate-proxy /etc/desolate-proxy
if [ ! -f /etc/desolate-proxy/settings.json ]; then
    install -m 0600 -o desolate-proxy -g desolate-proxy settings.example.json /etc/desolate-proxy/settings.json
    echo "    wrote example settings -- add real values with: ./cli.sh secret add ..."
fi
install -d -m 0750 -o desolate-proxy -g desolate-proxy /var/lib/desolate-proxy
# Public dir must exist before compose starts (dind bind-mounts it read-only).
install -d -m 0755 -o desolate-proxy -g desolate-proxy /var/lib/desolate-proxy/public
install -m 0755 ../container/install-ca.sh /var/lib/desolate-proxy/public/install-ca.sh
# Published for DEVELOPERS to run from inside their own devcontainer terminal,
# where there is no desolate CLI and no access to the outer daemon. The
# /desolate-ca mount is the only channel into a devcontainer, so anything a
# developer needs to run in there has to arrive this way.
install -m 0755 ../container/trust-proxy-in-builds.sh /var/lib/desolate-proxy/public/trust-proxy-in-builds.sh
install -m 0755 ssh-allow.sh /opt/desolate-proxy/ssh-allow.sh

echo "==> detect bridge interface for network '$COMPOSE_NET'"
BRIDGE=""
GW=$(docker network inspect "$COMPOSE_NET" -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)
if [ -n "$GW" ]; then
    BRIDGE=$(ip -br addr | awk -v gw="$GW" '$3 ~ "^"gw"/" {print $1}' | head -1)
fi
if [ -z "$BRIDGE" ]; then
    # Network not created yet (first install before `cli.sh up`). docker-compose.yml
    # pins the bridge name, so we can name it in advance instead of guessing
    # docker0 and silently protecting the wrong interface.
    BRIDGE=br-desolate
    echo "    NOTE: '$COMPOSE_NET' does not exist yet; using the name pinned in"
    echo "          docker-compose.yml ($BRIDGE). It will match once the stack is up."
elif [ "$BRIDGE" != "br-desolate" ]; then
    echo "    WARNING: detected '$BRIDGE', but docker-compose.yml pins 'br-desolate'."
    echo "             Using the detected name. If you edited the compose network,"
    echo "             keep nftables-desolate.conf's DESOLATE_IF in step with it."
    echo "    detected: $BRIDGE (gateway $GW)"
else
    echo "    detected: $BRIDGE (gateway $GW)"
fi
sed "s|define DESOLATE_IF = \".*\"|define DESOLATE_IF = \"$BRIDGE\"|" nftables-desolate.conf \
    > /etc/desolate-proxy/nftables-desolate.conf

echo "==> container resolver (dedicated dnsmasq on :5353)"
# REPAIR: earlier versions installed this as a drop-in, which moved the VM's own
# resolver off :53 and killed name resolution VM-wide (see the header of
# dnsmasq-desolate.conf). Undo that before doing anything else -- a VM upgraded
# from one of those installs is still broken until this file is gone.
if [ -f /etc/dnsmasq.d/desolate.conf ]; then
    echo "    removing the legacy /etc/dnsmasq.d/desolate.conf drop-in"
    echo "    (it moved the VM's OWN resolver to :5353 -- restoring it to :53)"
    rm -f /etc/dnsmasq.d/desolate.conf
    systemctl restart dnsmasq || true
fi

install -m 0644 dnsmasq-desolate.conf /etc/desolate-proxy/dnsmasq.conf
install -m 0644 desolate-dnsmasq.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q --now desolate-dnsmasq || {
    echo "    desolate-dnsmasq failed to start -- if the error mentions 'nftset'," >&2
    echo "    your dnsmasq predates 2.87. Comment out the nftset lines in" >&2
    echo "    /etc/desolate-proxy/dnsmasq.conf and see README 'git over SSH'." >&2
    journalctl -u desolate-dnsmasq -n 10 --no-pager >&2 || true
    exit 1
}
# The system resolver must still be the one on :53. Restarting it is harmless if
# it was never disturbed, and repairs the case where it was.
systemctl is-enabled --quiet dnsmasq 2>/dev/null && systemctl restart dnsmasq || true

echo "==> VM name resolution"
# The VM's OWN resolution, distinct from the containers'. Assert it rather than
# assume it: everything above can succeed while leaving :53 unserved, and the
# blast radius is every image pull, apt call and git fetch the VM makes.
RESOLVES=0
for host in registry-1.docker.io deb.debian.org one.one.one.one; do
    getent hosts "$host" >/dev/null 2>&1 && { RESOLVES=1; break; }
done
if [ "$RESOLVES" = 1 ]; then
    echo "    OK"
else
    cat >&2 <<EOF

    ERROR: the VM can no longer resolve hostnames.

    /etc/resolv.conf says:
$(sed 's/^/      /' /etc/resolv.conf 2>/dev/null)
    listening on 53/5353:
$(ss -lunp 2>/dev/null | grep -E ':53|:5353' | sed 's/^/      /' || echo "      (nothing)")

    Two resolvers are meant to be running here, and they are not alternatives:
      :5353  desolate-dnsmasq  -- CONTAINERS, via the nftables redirect
      :53    dnsmasq           -- the VM ITSELF; Colima's resolv.conf points here
                                  (this VM has no systemd-resolved)
    If :53 is unserved, the usual cause is something having set a global
    'port=' on the system dnsmasq -- check /etc/dnsmasq.conf and
    /etc/dnsmasq.d/ for a stray drop-in, remove it, then:
      sudo systemctl restart dnsmasq
    Stopping now rather than letting the next image pull fail with an error
    that points at Docker instead of at DNS.
EOF
    exit 1
fi

echo "==> nftables"
nft -f /etc/desolate-proxy/nftables-desolate.conf

echo "==> git-over-ssh allowlist"
# Same reason as the ExecStartPost in the unit: the load above just emptied the
# sets. Fails loudly rather than leaving an allowlist that refuses every clone.
/opt/desolate-proxy/ssh-allow.sh
cat > /etc/systemd/system/desolate-nft.service <<'EOF'
[Unit]
Description=desolate-proxy nftables interception rules
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/desolate-proxy/nftables-desolate.conf
# Loading the ruleset does `delete table inet desolate`, which EMPTIES
# ssh_allow_v4/v6. Refill them, or git over SSH is refused until the next
# install -- with nothing but a connection timeout to say why.
ExecStartPost=/opt/desolate-proxy/ssh-allow.sh
[Install]
WantedBy=multi-user.target
EOF

echo "==> systemd units"
install -m 0644 desolate-proxy.service /etc/systemd/system/
install -m 0644 desolate-proxy-ca.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q --now desolate-nft desolate-proxy desolate-proxy-ca

echo "==> done"
systemctl --no-pager --plain status desolate-proxy | head -5
echo
echo "Interface: $BRIDGE   Proxy: :18080   CA: :18081   DNS: :5353"
echo "Add secrets from your Mac:  ./cli.sh secret add NAME --hosts api.example.com"
