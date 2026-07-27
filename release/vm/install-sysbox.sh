#!/usr/bin/env bash
# sysbox installer. Runs INSIDE the Colima VM, as root.
#
# sysbox is the containment boundary: it maps container-root to an unprivileged
# VM user, which is what lets the inner dockerd run nested WITHOUT --privileged.
# Nothing else in this stack substitutes for it, so cli.sh refuses to start
# until `docker info` lists the runtime.
#
# Idempotent: re-running with the pinned version already installed and
# registered is a no-op that exits 0.
set -euo pipefail

# Bump deliberately, then re-run. Check the releases page for newer builds:
#   https://github.com/nestybox/sysbox/releases
SYSBOX_VERSION="${SYSBOX_VERSION:-0.7.0}"

echo "==> preconditions"
# sysbox needs cgroup v2 and id-mapped mounts. Colima's 6.x kernel has both;
# this catches someone pointing the script at an older or non-Colima VM, where
# the deb installs cleanly and then fails at container start with a much less
# obvious error.
if [ ! -r /sys/fs/cgroup/cgroup.controllers ]; then
    echo "    ERROR: cgroup v2 is not mounted (no /sys/fs/cgroup/cgroup.controllers)." >&2
    echo "           sysbox requires it. Recreate the VM with a current Colima." >&2
    exit 1
fi
echo "    cgroup v2 OK"

if ! command -v docker >/dev/null 2>&1; then
    echo "    ERROR: no docker inside the VM -- start Colima with '--runtime docker'." >&2
    exit 1
fi

echo "==> sysbox $SYSBOX_VERSION"
HAVE=""
if command -v sysbox-runc >/dev/null 2>&1; then
    HAVE=$(sysbox-runc --version 2>/dev/null | awk '/^sysbox-runc/{print $3}')
fi
if [ "$HAVE" = "$SYSBOX_VERSION" ]; then
    echo "    already at $SYSBOX_VERSION"
else
    [ -n "$HAVE" ] && echo "    have '$HAVE', want '$SYSBOX_VERSION' -- reinstalling"

    # The deb's postinst restarts docker to rewrite network parameters, and it
    # REFUSES to run while any container exists -- stopped ones count, because
    # it checks `docker ps -a -q`. Check that here, before apt touches anything.
    #
    # This used to be a warning. It cannot be: when the postinst bails, dpkg is
    # left with sysbox-ce unpacked-but-unconfigured, which then blocks every
    # later apt operation on the VM until someone runs `dpkg --configure -a`.
    # Refusing before the download is recoverable; discovering it afterwards is
    # a broken package database plus a confusing error.
    #
    # Deliberately NOT in the preconditions block above: when sysbox is already
    # at the right version this whole branch is skipped, and a running stack is
    # then no reason to refuse a re-run (which is how the proxy layer upgrades).
    # Our OWN containers are removed automatically. They are the expected reason
    # for this, tearing them down is exactly what we would otherwise print
    # instructions for, and `docker rm` does not touch named volumes -- so
    # /workspaces, the inner images and the editor's settings all survive and
    # `cli.sh up` puts everything back. Making the operator do it by hand only
    # bought them a failed install and a second invocation.
    #
    # Containers we do NOT own are a different question. They might be someone
    # else's work, and destroying them is not this script's decision to make.
    for proj in desolate desolate-test; do
        OURS=$(docker ps -aq --filter "label=com.docker.compose.project=$proj" 2>/dev/null)
        if [ -n "$OURS" ]; then
            echo "    removing the '$proj' stack's containers (the deb needs a"
            echo "    container-free daemon; named volumes are not affected)"
            # shellcheck disable=SC2086
            docker rm -f $OURS >/dev/null 2>&1 || true
        fi
    done

    EXISTING=$(docker ps -aq 2>/dev/null | wc -l | tr -d ' ')
    if [ "${EXISTING:-0}" != 0 ]; then
        cat >&2 <<EOF
    ERROR: $EXISTING container(s) remain on the VM's docker daemon after
           removing the desolate stack, and the sysbox installer refuses to
           configure itself while any exist (stopped ones count -- it checks
           'docker ps -a -q').

    These are not ours, so this script will not remove them. What they are:
$(docker ps -a --format '      {{.Names}}  ({{.Image}}, {{.Status}})' 2>/dev/null)

    Remove them yourself and re-run \`./cli.sh vm install\`, or run:
      colima ssh -p \${COLIMA_PROFILE:-desolate} -- 'docker ps -aq | xargs -r docker rm -f'
EOF
        exit 1
    fi

    export DEBIAN_FRONTEND=noninteractive

    # Clear a half-finished install from a previous attempt. dpkg refuses to
    # proceed while sysbox-ce sits in unpacked/half-configured state, and the
    # check above has just guaranteed the postinst can now succeed.
    ST=$(dpkg-query -W -f='${Status}' sysbox-ce 2>/dev/null || true)
    case "$ST" in
        ""|*"ok installed") ;;
        *)  echo "    a previous attempt left sysbox-ce in state '$ST' -- clearing it"
            dpkg --configure -a >/dev/null 2>&1 \
              || apt-get remove -y -qq sysbox-ce >/dev/null 2>&1 \
              || dpkg --purge --force-all sysbox-ce >/dev/null 2>&1 \
              || echo "    WARNING: could not clear it; the install below may fail" ;;
    esac

    apt-get update -qq
    apt-get install -y -qq jq curl

    ARCH=$(dpkg --print-architecture)
    # Filename format changed at 0.6.7 to sysbox-ce_<VER>.linux_<arch>.deb --
    # note the DOT before "linux", not the "-0." older docs use.
    DEB="sysbox-ce_${SYSBOX_VERSION}.linux_${ARCH}.deb"
    URL="https://github.com/nestybox/sysbox/releases/download/v${SYSBOX_VERSION}/${DEB}"

    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT INT TERM
    echo "    downloading $DEB"
    curl -fSL --retry 3 -o "$TMP/$DEB" "$URL"
    apt-get install -y -qq "$TMP/$DEB"
fi

echo "==> runtime registration"
# Some Docker builds do not pick the runtime up from the deb's daemon.json
# edit, so verify against the daemon rather than trusting the install.
if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q sysbox-runc; then
    echo "    sysbox-runc already registered"
else
    echo "    not registered -- adding it to /etc/docker/daemon.json"
    install -d /etc/docker
    TMPJ=$(mktemp)
    if [ -s /etc/docker/daemon.json ]; then
        jq '.runtimes."sysbox-runc" = {"path":"/usr/bin/sysbox-runc"}' \
            /etc/docker/daemon.json > "$TMPJ"
    else
        echo '{"runtimes":{"sysbox-runc":{"path":"/usr/bin/sysbox-runc"}}}' > "$TMPJ"
    fi
    install -m 0644 "$TMPJ" /etc/docker/daemon.json
    rm -f "$TMPJ"
    systemctl restart docker
    # The daemon takes a moment to accept connections again.
    for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi

if ! docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q sysbox-runc; then
    echo "    ERROR: sysbox-runc still not listed by 'docker info'." >&2
    echo "           Inspect: systemctl status docker; cat /etc/docker/daemon.json" >&2
    exit 1
fi

echo "==> done"
echo "sysbox-runc registered. Verify from the Mac: docker info | grep -A2 Runtimes"
