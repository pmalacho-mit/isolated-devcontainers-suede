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
COMPOSE_DIND_NET="${DESOLATE_DIND_NET:-desolate_dindnet}"

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
else
    # Re-assert the SELF-TEST FIXTURE, and nothing else.
    #
    # preflight's leak-detection and plaintext-spoof probes both send
    # X-Exfil: DESOLATE-SELFTEST-PLACEHOLDER, and addon.py only recognises
    # CONFIGURED placeholder names -- so with the fixture absent the probes
    # cannot fail closed. They report "the addon may have failed to load" and
    # "secrets can be exfiltrated" while the addon is healthy, which is a
    # false alarm loud enough to teach you to ignore the check.
    #
    # The fixture is safe to re-assert unconditionally: the value is fake and
    # its allowlist pins httpbin.org, so substituting it toward anywhere else
    # is exactly the 403 the probes are asserting. This installer is
    # documented idempotent; the seed above was the one part of it that was
    # not.
    #
    # "selftest": true is not decoration -- it is what stops the fixture from
    # 403ing ordinary traffic that merely MENTIONS its name (this repo's own
    # source does, so `git push` did). Without it, re-asserting on every run
    # would make the poison permanent instead of fixing it. addon.py's header
    # section has the whole argument.
    #
    # jq's output is installed with the same mode/owner as every other write
    # to this file (cli.sh secret add|rm do the same), under umask 077 so the
    # temp file never exists 0644 while it holds the whole store.
    (
      umask 077
      F=/etc/desolate-proxy/settings.json
      T=$(mktemp)
      trap 'rm -f "$T"' EXIT INT TERM
      # -e alone is not enough: it is also satisfied by a fixture left behind
      # by an older install, which has no "selftest" flag and therefore still
      # blocks any request naming it. Assert the shape, not the presence.
      if jq -e '.secrets["DESOLATE-SELFTEST-PLACEHOLDER"].selftest == true' "$F" >/dev/null 2>&1; then
        echo "    self-test fixture present"
      elif jq '.secrets["DESOLATE-SELFTEST-PLACEHOLDER"] =
                 {value: "injected-selftest-value-93f2", hosts: ["httpbin.org"], selftest: true}' \
             "$F" > "$T" \
           && install -m 0600 -o desolate-proxy -g desolate-proxy "$T" "$F"; then
        echo "    restored the self-test fixture (preflight's probes need it)"
      else
        echo "    WARNING: could not restore the self-test fixture into $F" >&2
        echo "             preflight's leak/spoof probes will report a false alarm." >&2
      fi
    )
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

# Both bridges, because the stack is split across two networks and BOTH must be
# armed. Arming only the editor's would leave the container world -- dind, and
# every devcontainer inside it -- with unfiltered egress and no lateral wall,
# which is the exact inverse of what this layer is for.
detect_bridge() {   # detect_bridge <compose network> <pinned name>
    local network="$1" pinned="$2" gateway found
    gateway=$(docker network inspect "$network" \
                -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)
    if [ -n "$gateway" ]; then
        found=$(ip -br addr | awk -v gw="$gateway" '$3 ~ "^"gw"/" {print $1}' | head -1)
    fi
    if [ -z "${found:-}" ]; then
        # Network not created yet (first install before `cli.sh up`).
        # docker-compose.yml pins the bridge name, so we can name it in advance
        # instead of guessing docker0 and silently protecting the wrong iface.
        echo "    NOTE: '$network' does not exist yet; using the name pinned in" >&2
        echo "          docker-compose.yml ($pinned). It will match once up." >&2
        printf '%s' "$pinned"
        return
    fi
    if [ "$found" != "$pinned" ]; then
        echo "    WARNING: detected '$found' for '$network', but docker-compose.yml" >&2
        echo "             pins '$pinned'. Using the detected name. If you edited the" >&2
        echo "             compose network, keep nftables-desolate.conf in step." >&2
    fi
    echo "    detected: $found (network $network, gateway $gateway)" >&2
    printf '%s' "$found"
}

echo "==> detect bridge interfaces"
BRIDGE=$(detect_bridge "$COMPOSE_NET" br-desolate)
DIND_BRIDGE=$(detect_bridge "$COMPOSE_DIND_NET" br-desolate-in)
if [ "$BRIDGE" = "$DIND_BRIDGE" ]; then
    cat >&2 <<EOF

    ERROR: both networks resolve to the same bridge ('$BRIDGE').

    The editor and the container world would share one L2 segment, and the
    lateral drop between them could not be expressed -- a devcontainer would be
    one routable hop from the editor container and the git deploy keys in it.
    This is what the two pinned bridge names in docker-compose.yml prevent, so
    the usual cause is a stack whose networks predate the split:
      ./cli.sh down && ./cli.sh up
    then re-run this.
EOF
    exit 1
fi
sed -e "s|define DESOLATE_IF = \".*\"|define DESOLATE_IF = \"$BRIDGE\"|" \
    -e "s|define DESOLATE_DIND_IF = \".*\"|define DESOLATE_DIND_IF = \"$DIND_BRIDGE\"|" \
    -e "s|define DESOLATE_IFS = .*|define DESOLATE_IFS = { \"$BRIDGE\", \"$DIND_BRIDGE\" }|" \
    nftables-desolate.conf > /etc/desolate-proxy/nftables-desolate.conf

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
# The output chain scopes its drops with `meta skuid desolate-proxy`, and nft
# resolves that NAME to a uid while parsing. If the account is missing the file
# does not parse, and `nft -f` is atomic: nothing is applied, so interception
# and the forward default-deny would be absent together, quietly, on a VM that
# otherwise looks installed. The account is created at the top of this script;
# say so plainly if that has somehow not happened rather than letting nft
# report a syntax error about a line that is not wrong.
id desolate-proxy >/dev/null 2>&1 || {
    echo "ERROR: the desolate-proxy account does not exist, so the nftables" >&2
    echo "       ruleset cannot resolve 'meta skuid desolate-proxy' and NOTHING" >&2
    echo "       would be applied. Re-run this installer from the top." >&2
    exit 1
}
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
echo "Interfaces: $BRIDGE (editor), $DIND_BRIDGE (containers)"
echo "Proxy: :18080   CA: :18081   DNS: :5353"
echo "Add secrets from your Mac:  ./cli.sh secret add NAME --hosts api.example.com"
