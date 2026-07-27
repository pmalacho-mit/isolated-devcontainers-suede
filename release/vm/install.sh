#!/usr/bin/env bash
# One-shot VM provisioner. Runs INSIDE the Colima VM, as root.
#
# Normally you do NOT run this by hand -- from the Mac:
#   ./cli.sh vm install
# which sshes in and calls this. Run it directly only if you are already in the
# VM (`colima ssh -p desolate`) and the repo is on a Colima mount.
#
# Installs the two VM-side layers, in order:
#   1. sysbox      -- the containment boundary (install-sysbox.sh)
#   2. egress proxy -- mitmproxy + dnsmasq + nftables (../proxy/vm/install.sh)
#
# Both layers are idempotent, so re-running is safe and is how you upgrade.
#
# Flags:
#   --proxy-only   skip the sysbox layer. `cli.sh up` uses this to re-arm the
#                  nftables rules when the bridge has drifted, since the sysbox
#                  step restarts docker and would kill the running stack.
set -euo pipefail
cd "$(dirname "$0")"

PROXY_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --proxy-only) PROXY_ONLY=1 ;;
        *) echo "usage: install.sh [--proxy-only]" >&2; exit 1 ;;
    esac
done

if [ "$(id -u)" != 0 ]; then
    echo "install.sh: must run as root (use: sudo ./install.sh)" >&2
    exit 1
fi

if [ "$PROXY_ONLY" = 0 ]; then
    # Docker 28+ (the `docker:29-dind` image the stack runs) needs the kernel's
    # ipset support for its iptables rules. dind runs under sysbox in a user
    # namespace and CANNOT load kernel modules itself, so the module has to be
    # available here, in the VM. Loading it now also gets it out of the way of
    # a much less obvious failure later: dockerd exits during startup inside
    # dind, and all you see from the Mac is a container that never turns
    # healthy. Not fatal -- a kernel with ipset built in has nothing to load.
    echo "### 0/2  kernel prerequisites"
    if modprobe ip_set 2>/dev/null || [ -d /sys/module/ip_set ] \
       || grep -qw ip_set /proc/modules 2>/dev/null; then
        echo "    ipset available (needed by the inner dockerd)"
    else
        echo "    WARNING: could not load the ip_set kernel module."
        echo "             Docker 28+ needs it and dind cannot load it itself."
        echo "             If dind never becomes healthy, this is why:"
        echo "               docker logs desolate-dind"
    fi
    echo

    echo "### 1/2  sysbox"
    ./install-sysbox.sh
    echo
else
    echo "### sysbox: skipped (--proxy-only)"
fi

if [ "$PROXY_ONLY" = 0 ]; then echo "### 2/2  egress proxy"; else echo "### egress proxy"; fi
../proxy/vm/install.sh

echo
echo "VM provisioning complete."
