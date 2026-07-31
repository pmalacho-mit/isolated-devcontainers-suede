#!/usr/bin/env bash
# PROBE -- not a test. Answers a capability question about the environment so a
# design decision can be made; it asserts no invariant and gates nothing.
#
# QUESTION: can dind run devcontainers under sysbox-runc -- i.e. does sysbox nest
# inside sysbox on this kernel?
#
# Why it matters: today dind's dockerd launches devcontainers with plain runc, so
# a devcontainer that turns on the docker-in-docker feature must be PRIVILEGED
# (all caps, all devices, no seccomp/apparmor) to run nested docker. That
# privilege is real relative to dind, and dind <-> containers is the weakest of
# the stack's three boundaries (README "Isolation model"). "Do not run untrusted
# code in an allowPrivileged project" is the only thing standing in that gap, and
# in the agent era that instruction is a fig leaf.
#
# The structural fix is to run devcontainers under sysbox-runc, exactly as the VM
# runs dind. Then EVERY devcontainer is user-namespaced relative to dind:
# container-root maps to an unprivileged dind uid, capabilities apply only to what
# that nested namespace owns, and -- the real prize -- nested docker works WITHOUT
# privilege, so allowPrivileged can be deleted rather than merely contained
# (policy.ts would refuse privileged outright instead of auditing an opt-in).
#
# But that requires sysbox to run INSIDE the (already sysbox-contained) dind.
# Whether that composes is a KERNEL question, not an engineering one, and it is
# the single unknown that decides whether the rest of the work is worth doing:
#
#   Q2  do sysbox's own daemons (sysbox-mgr, sysbox-fs) start inside a sysbox
#       container? sysbox-fs is FUSE-backed, and /dev/fuse two userns levels down
#       is the most likely place for this to fail.
#   Q3  does that nested dockerd accept and register the sysbox-runc runtime?
#   Q4  THE VERDICT -- does a container started with --runtime=sysbox-runc one
#       level down actually get a user namespace? uid_map must map root to a
#       NON-zero id. If it does, sibling isolation becomes structural, the same
#       way sysbox already protects the VM from dind.
#   Q5  THE PAYOFF -- does nested docker run under that inner sysbox WITHOUT
#       --privileged? If yes, the docker-in-docker feature no longer needs
#       privilege at all, and allowPrivileged goes away.
#
# What this proves and what it does NOT: a YES here says the kernel supports the
# nesting. It does NOT settle the image plumbing (the shipped dind is Alpine/musl;
# sysbox is glibc/Debian, so the real change also rebases dind on Ubuntu). This
# probe stands that plumbing up in a THROWAWAY Ubuntu dind so the kernel question
# can be answered without touching the shipped image. Failures are labelled
# [KERNEL] (the real verdict) or [PLUMBING] (solvable, does not condemn the idea).
#
# ---------------------------------------------------------------------------
# HOW TO RUN -- on your Mac. The stack does NOT need to be up; this only needs
# the VM with sysbox-runc registered (./cli.sh vm install):
#
#   ./tests/probes/nested-sysbox.sh
#
# It re-execs itself INSIDE the Colima VM (where `docker` is the daemon that has
# sysbox-runc), creates ONE throwaway container named desolate-nsprobe-* on the
# VM daemon, and removes it on exit including on failure. It does not touch the
# desolate stack, any project, /workspaces, or anything on your Mac. Expect it to
# take a few minutes on first run (it pulls ubuntu/alpine/dind and apt-installs
# sysbox inside the throwaway). Paste the SUMMARY block back when it finishes.
#
# NOTE ON EGRESS: the throwaway runs on the VM's default docker bridge, not
# br-desolate, so the proxy's nftables interception (which matches iifname
# br-desolate) does NOT apply and apt/github work normally. If your VM blocks
# egress more broadly, the apt/download steps fail as [PLUMBING], not [KERNEL].
set -uo pipefail

PROFILE="${COLIMA_PROFILE:-desolate}"

# ---------------------------------------------------------------------------
# Stage 0: get inside the VM. On the Mac, `docker` is not the daemon that has
# sysbox-runc -- the VM's is. Rather than tunnel every command through nested
# `colima ssh -- docker exec ...` quoting, ship this whole file into the VM and
# run it there, where every docker call below is local.
# ---------------------------------------------------------------------------
if [ "${DESOLATE_NSPROBE_INVM:-}" != 1 ]; then
  if ! command -v colima >/dev/null 2>&1; then
    echo "This probe must run from the Mac (colima not found on PATH)." >&2
    echo "If you are already inside the VM, re-run with DESOLATE_NSPROBE_INVM=1." >&2
    exit 1
  fi
  echo "== entering the Colima VM (profile '$PROFILE') =="
  exec colima ssh -p "$PROFILE" -- env DESOLATE_NSPROBE_INVM=1 bash -s < "$0"
  echo "could not enter the VM via 'colima ssh -p $PROFILE'." >&2
  exit 1
fi

# ---- from here on we are INSIDE the VM; `docker` == the VM daemon ----------

# Keep this in step with vm/install-sysbox.sh; the throwaway installs the SAME
# sysbox the VM runs, so a YES here is a YES for the version you actually ship.
SYSBOX_VERSION="${SYSBOX_VERSION:-0.7.0}"
DIND="desolate-nsprobe-dind"          # the throwaway "future dind" (Ubuntu+sysbox)
BASE_IMG="ubuntu:24.04"               # glibc base, the real dind rebase target
DIND_IMG="docker:29-dind"             # for the unprivileged-nested-docker payoff test
# The inner dockerd's data root REFUSES to sit on overlayfs, and a container's
# rootfs IS overlayfs -- the shipped dind dodges this for /var/lib/docker with
# the dind-sysbox-data volume (compose), so the throwaway gets the same ext4
# footing here. NOTE: sysbox-mgr's OWN data root (/var/lib/sysbox) is handled
# differently -- as a container-mounted tmpfs inside (see the inner script) --
# because a bind-mounted volume is a mount set up in an ancestor userns and
# LOCKED, which is what made the idmapped-mount check EPERM last run.
DKR_VOL="desolate-nsprobe-docker-data"   # -> /var/lib/docker (inner dockerd)

# Q-slots, filled as we go; rendered in the SUMMARY at the end.
Q1="UNKNOWN"; Q2="UNKNOWN"; Q3="UNKNOWN"; Q4="UNKNOWN"; Q5="UNKNOWN"
UIDMAP=""

note() { printf '      %s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }

cleanup() {
  # Removing the throwaway takes its inner dockerd, sysbox daemons and every
  # nested container with it -- nothing of this probe survives.
  docker rm -f "$DIND" >/dev/null 2>&1
  docker volume rm -f "$DKR_VOL" >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

echo
echo "== 0. VM daemon has sysbox-runc (the OUTER layer we nest inside) =="
if ! docker info >/dev/null 2>&1; then
  bad "cannot reach the VM docker daemon"
  note "start Colima:  colima start -p $PROFILE"
  exit 1
fi
if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q sysbox-runc; then
  ok "sysbox-runc is registered on the VM daemon"
else
  bad "sysbox-runc is NOT registered on the VM daemon"
  note "install it first:  ./cli.sh vm install"
  exit 1
fi
echo "      VM kernel: $(uname -r 2>/dev/null)"

echo
echo "== 0.5. mount-shifting facts (this is what decides nesting) =="
# sysbox shifts uids across the userns with ONE of two mechanisms: shiftfs (a
# Nestybox/Canonical out-of-tree module) or idmapped mounts (in-kernel). Level 1
# works, so the VM supports whichever it picked -- but idmapped mounts do NOT
# compose into a second userns (last run's EPERM), while shiftfs is designed to.
# So the whole feasibility question reduces to: is shiftfs available here?
SHIFTFS_VM="absent"; grep -q shiftfs /proc/filesystems 2>/dev/null && SHIFTFS_VM="present"
if [ "$SHIFTFS_VM" = absent ] && sudo modprobe shiftfs >/dev/null 2>&1; then
  grep -q shiftfs /proc/filesystems 2>/dev/null && SHIFTFS_VM="loadable (modprobe)"
fi
# What level-1 sysbox actually chose, straight from its own log.
SBXMODE=$(sudo journalctl -u sysbox-mgr --no-pager 2>/dev/null \
            | grep -ioE 'using (shiftfs|ID-mapped mounts|idmapped)[^"]*' | tail -1)
[ -n "$SBXMODE" ] || SBXMODE=$(sudo journalctl -u sysbox-mgr --no-pager 2>/dev/null \
            | grep -iE 'shiftfs|id-mapp|idmapp' | tail -1 | sed 's/.*msg=//')
echo "      shiftfs on VM kernel   : $SHIFTFS_VM"
echo "      level-1 sysbox mode    : ${SBXMODE:-<sysbox-mgr journal not readable>}"

echo
echo "== 1. stand up a throwaway Ubuntu dind UNDER sysbox-runc (Q1) =="
# This models the future dind: an Ubuntu (glibc) base that will host sysbox. It
# runs under the VM's sysbox-runc, so it is itself a sysbox container -- which is
# the prerequisite for running sysbox INSIDE it. No --privileged anywhere.
docker rm -f "$DIND" >/dev/null 2>&1
docker volume rm -f "$DKR_VOL" >/dev/null 2>&1
if docker run -d --name "$DIND" --runtime=sysbox-runc \
     -v "$DKR_VOL:/var/lib/docker" \
     "$BASE_IMG" sleep infinity >/dev/null 2>&1; then
  ok "throwaway Ubuntu dind is running under sysbox-runc (no --privileged)"
  Q1="YES"
else
  bad "could not start an Ubuntu container under sysbox-runc"
  note "[KERNEL/PLUMBING] docker said:"
  docker run --rm --runtime=sysbox-runc "$BASE_IMG" true 2>&1 | sed 's/^/        /' | tail -4
  Q1="NO"
  # Nothing below can run without the outer container.
  echo; echo "VERDICT: could not even start the outer test container -- see above."
  exit 1
fi

# ---------------------------------------------------------------------------
# The provisioning + test script that runs INSIDE the throwaway dind. Fed on
# stdin (no quoting games): install docker + sysbox, start the daemons by hand
# (no systemd in here), then run the two decisive containers one level deeper.
# It writes machine-readable RESULT lines to /tmp/nsprobe.result, which the VM
# side reads back after it finishes; it also streams human-readable progress.
# ---------------------------------------------------------------------------
INNER=$(cat <<INNER_EOF
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
RESULT=/tmp/nsprobe.result
: > "\$RESULT"
say() { printf '        %s\n' "\$*"; }
put() { printf '%s=%s\n' "\$1" "\$2" >> "\$RESULT"; }

SYSBOX_VERSION="$SYSBOX_VERSION"
DIND_IMG="$DIND_IMG"

# -- deps + sysbox (the [PLUMBING]; failures here do not condemn the idea) ----
say "apt: installing docker.io + sysbox runtime deps ..."
# rsync and fuse3 are sysbox's own runtime deps (sysbox-mgr shells out to rsync;
# sysbox-fs is FUSE). apt pulls them from the deb's Depends anyway, but naming
# them here means a miss shows up as an apt error, not as a mysterious daemon
# that won't start later.
if ! { apt-get update -qq && \
       apt-get install -y -qq ca-certificates curl iptables iproute2 kmod rsync fuse3 \
                              e2fsprogs util-linux docker.io >/dev/null 2>&1; }; then
  say "apt install failed -- likely restricted VM egress"
  put Q2 "NO -- [PLUMBING] apt install failed"; exit 0
fi

ARCH=\$(dpkg --print-architecture)
DEB="sysbox-ce_\${SYSBOX_VERSION}.linux_\${ARCH}.deb"
URL="https://github.com/nestybox/sysbox/releases/download/v\${SYSBOX_VERSION}/\${DEB}"
say "downloading \$DEB ..."
if ! curl -fSL --retry 3 -o "/tmp/\$DEB" "\$URL" >/dev/null 2>&1; then
  say "could not download the sysbox deb"
  put Q2 "NO -- [PLUMBING] sysbox deb download failed"; exit 0
fi
# Install via apt with the deb PATH (as vm/install-sysbox.sh does), NOT 'dpkg
# -i'. A bare dpkg -i leaves the deb's Depends unmet, and the 'apt-get install
# -f' that would follow "fixes" that by REMOVING the half-installed package --
# which is exactly why an earlier run found no sysbox-runc binary. apt resolves
# the deps first, so the files are unpacked. The postinst then tries to restart
# docker via systemd and fails (there is none in here), but that runs AFTER the
# unpack, so the binaries are in place and we start the daemons by hand below.
say "installing the sysbox deb (its postinst will warn -- no systemd in here) ..."
apt-get install -y -qq "/tmp/\$DEB" >/tmp/sysbox-install.log 2>&1 || true
dpkg --configure -a >>/tmp/sysbox-install.log 2>&1 || true
if ! command -v sysbox-runc >/dev/null 2>&1; then
  say "sysbox-runc still not present -- install log tail:"
  tail -n 12 /tmp/sysbox-install.log 2>/dev/null | sed 's/^/          /'
  put Q2 "NO -- [PLUMBING] sysbox package did not install"; exit 0
fi
say "sysbox-runc installed: \$(sysbox-runc --version 2>/dev/null | awk '/^sysbox-runc/{print \$3}')"

# sysbox-fs is FUSE-backed. /dev/fuse two userns levels down is the classic
# nesting blocker, so surface its presence explicitly -- and capture WHY a mknod
# fails, since "Operation not permitted" (devices cgroup) vs "exists" tells us
# whether the future dind image must be given /dev/fuse or can create it itself.
if [ ! -e /dev/fuse ]; then
  mknod -m 0666 /dev/fuse c 10 229 2>/tmp/fuse.err || true
fi
FUSE="absent"; [ -e /dev/fuse ] && FUSE="present"
say "/dev/fuse: \$FUSE"
[ "\$FUSE" = absent ] && say "mknod said: \$(tail -n1 /tmp/fuse.err 2>/dev/null)"
put FUSE "\$FUSE"

# -- start sysbox's daemons INSIDE this sysbox container (Q2) -----------------
put SHIFTFS_IN "\$(grep -q shiftfs /proc/filesystems 2>/dev/null && echo present || echo absent)"

# The data root must clear BOTH of sysbox-mgr's gates:
#   (a) fs-type: NOT overlayfs, NOT tmpfs -- a real filesystem;
#   (b) idmap:   the container must be able to create an idmapped mount over it,
#                which requires CAP_SYS_ADMIN in the SUPERBLOCK's userns.
# A bind of the runc-provided volume clears (a) but its superblock is the VM's
# initial userns, so (b) EPERMs. A tmpfs clears (b) -- container owns it -- but
# fails (a). The one thing that can clear both is a real fs the CONTAINER mounts:
# a loopback ext4 it formats itself, whose superblock userns is this container's.
# If sysbox-mgr still EPERMs on THAT, idmapped mounts genuinely do not nest here
# and (shiftfs being absent) there is no in-kernel route left.
mkdir -p /var/lib/sysbox /run/sysbox
DATAROOT="none"
dd if=/dev/zero of=/sbxdata.img bs=1M count=512 >/dev/null 2>&1
if mkfs.ext4 -q -F /sbxdata.img >/dev/null 2>&1 \
   && LOOP=\$(losetup -f --show /sbxdata.img 2>/tmp/loop.err) \
   && mount "\$LOOP" /var/lib/sysbox 2>>/tmp/loop.err; then
  DATAROOT="loopback-ext4 (container-owned real fs -- clears BOTH gates if it nests)"
elif mount -t tmpfs tmpfs /var/lib/sysbox 2>/tmp/tmpfs.err; then
  DATAROOT="tmpfs (could not get a loopback device; sysbox will reject the fs-type)"
else
  DATAROOT="rootfs overlayfs (no writable data root; sysbox will reject the fs-type)"
fi
put DATAROOT "\$DATAROOT"
say "data root: \$DATAROOT"
[ "\$DATAROOT" != "loopback-ext4"* ] && say "loop note: \$(tail -n1 /tmp/loop.err 2>/dev/null)"
say "starting sysbox-mgr and sysbox-fs ..."
sysbox-mgr --log /var/log/sysbox-mgr.log >/dev/null 2>&1 &
sleep 2
sysbox-fs  --log /var/log/sysbox-fs.log  >/dev/null 2>&1 &
sleep 3
MGR="down"; FS="down"
pgrep -x sysbox-mgr >/dev/null 2>&1 && MGR="up"
pgrep -x sysbox-fs  >/dev/null 2>&1 && FS="up"
say "sysbox-mgr: \$MGR   sysbox-fs: \$FS"
if [ "\$MGR" != "up" ] || [ "\$FS" != "up" ]; then
  # Distinguish "the kernel won't nest this" from "a data root landed on
  # overlayfs" -- the latter is the same volume-not-overlayfs constraint the
  # shipped dind already handles, i.e. [PLUMBING], not a wall.
  if grep -qi 'ID-mapping\|mapped mount' /var/log/sysbox-mgr.log 2>/dev/null; then
    case "\$DATAROOT" in
      loopback-ext4*) LABEL="[KERNEL] CONCLUSIVE -- idmap EPERM even on a container-owned real fs; idmapped mounts do not nest here and shiftfs is absent" ;;
      *)              LABEL="[KERNEL] idmapped-mount check EPERM nested (data root: \$DATAROOT)" ;;
    esac
  elif grep -qi "can't be on" /var/log/sysbox-mgr.log 2>/dev/null; then
    LABEL="[PLUMBING/ENV] sysbox rejected the data-root fs-type (\$DATAROOT) -- never reached the idmap check"
  else
    LABEL="[KERNEL]"
  fi
  put Q2 "NO -- \$LABEL (mgr=\$MGR fs=\$FS)"
  say "--- sysbox-mgr.log (tail) ---"; tail -n 6 /var/log/sysbox-mgr.log 2>/dev/null | sed 's/^/          /'
  say "--- sysbox-fs.log (tail) ---";  tail -n 6 /var/log/sysbox-fs.log  2>/dev/null | sed 's/^/          /'
  exit 0
fi
put Q2 "YES -- sysbox daemons run nested"

# -- inner dockerd with sysbox-runc registered (Q3) --------------------------
mkdir -p /etc/docker
echo '{"runtimes":{"sysbox-runc":{"path":"/usr/bin/sysbox-runc"}}}' > /etc/docker/daemon.json
say "starting the inner dockerd ..."
dockerd >/var/log/dockerd.log 2>&1 &
UP=""
for i in \$(seq 1 30); do docker info >/dev/null 2>&1 && { UP=1; break; }; sleep 1; done
if [ -z "\$UP" ]; then
  put Q3 "NO -- [KERNEL] inner dockerd never came up"
  say "--- dockerd.log (tail) ---"; tail -n 8 /var/log/dockerd.log 2>/dev/null | sed 's/^/          /'
  exit 0
fi
if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q sysbox-runc; then
  put Q3 "YES -- inner dockerd registered sysbox-runc"
else
  put Q3 "NO -- [PLUMBING] inner dockerd did not register sysbox-runc"; exit 0
fi

# -- THE VERDICT: a container one level down gets a user namespace (Q4) -------
# uid_map "0 <hostuid> <size>" with a NON-zero middle field means container-root
# is mapped to an unprivileged inner uid -- the property that makes a privileged
# devcontainer unable to reach siblings, exactly as it protects the VM from dind.
say "running a container under the INNER sysbox-runc ..."
docker pull -q alpine >/dev/null 2>&1
UIDMAP=\$(docker run --rm --runtime=sysbox-runc alpine cat /proc/self/uid_map 2>/tmp/inner.err | tr -s ' ' | sed 's/^ *//')
if [ -z "\$UIDMAP" ]; then
  put Q4 "NO -- [KERNEL] container under inner sysbox-runc failed to run"
  say "--- error ---"; tail -n 6 /tmp/inner.err 2>/dev/null | sed 's/^/          /'
  exit 0
fi
put UIDMAP "\$UIDMAP"
HOSTUID=\$(echo "\$UIDMAP" | awk '{print \$2}')
if [ -n "\$HOSTUID" ] && [ "\$HOSTUID" != "0" ]; then
  say "uid_map: \$UIDMAP   (root -> inner uid \$HOSTUID: userns ACTIVE)"
  put Q4 "YES -- root maps to non-zero (\$HOSTUID)"
else
  say "uid_map: \$UIDMAP   (root -> 0: NO user namespace)"
  put Q4 "NO -- [KERNEL] identity uid_map, no userns"
  exit 0
fi

# -- THE PAYOFF: nested docker with NO --privileged (Q5) ---------------------
# If the docker-in-docker feature works under inner sysbox without privilege,
# allowPrivileged is unnecessary and can be removed rather than contained.
say "starting an unprivileged docker:dind under the inner sysbox-runc ..."
docker pull -q "\$DIND_IMG" >/dev/null 2>&1
if docker run -d --name inner-dind --runtime=sysbox-runc \
     -e DOCKER_TLS_CERTDIR="" "\$DIND_IMG" >/dev/null 2>&1; then
  INFO=""
  for i in \$(seq 1 30); do
    docker exec inner-dind docker -H unix:///var/run/docker.sock info >/dev/null 2>&1 && { INFO=1; break; }
    sleep 1
  done
  if [ -n "\$INFO" ]; then
    say "nested dockerd is up WITHOUT --privileged"
    put Q5 "YES -- unprivileged nested docker works"
  else
    say "nested dockerd did not come up"
    put Q5 "NO -- [KERNEL] nested dockerd failed unprivileged"
    docker logs inner-dind 2>&1 | tail -n 6 | sed 's/^/          /'
  fi
  docker rm -f inner-dind >/dev/null 2>&1
else
  put Q5 "NO -- [KERNEL] could not start docker:dind under inner sysbox-runc"
fi
INNER_EOF
)

echo
echo "== 2-5. install sysbox in the throwaway and run the nested tests =="
note "this is the slow part (apt + image pulls inside the throwaway) ..."
# Feed the provisioning script in on stdin; run it as root inside the throwaway.
printf '%s' "$INNER" | docker exec -i -u 0 "$DIND" bash -c 'cat > /tmp/prov.sh && bash /tmp/prov.sh'

# Pull the machine-readable results back out.
RES=$(docker exec "$DIND" cat /tmp/nsprobe.result 2>/dev/null)
val() { printf '%s\n' "$RES" | awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,""); print; exit}'; }
Q2=$(val Q2); Q3=$(val Q3); Q4=$(val Q4); Q5=$(val Q5)
UIDMAP=$(val UIDMAP)
[ -n "$Q2" ] || Q2="UNKNOWN -- inner script produced no Q2 (see output above)"
[ -n "$Q3" ] || Q3="UNKNOWN"
[ -n "$Q4" ] || Q4="UNKNOWN"
[ -n "$Q5" ] || Q5="UNKNOWN"

echo
echo "=============== SUMMARY (paste this back) ==============="
echo "  VM kernel               : $(uname -r 2>/dev/null)"
echo "  sysbox version tested   : $SYSBOX_VERSION"
echo "  shiftfs on VM kernel    : ${SHIFTFS_VM:-unknown}"
echo "  level-1 sysbox mode     : ${SBXMODE:-unknown}"
echo "  shiftfs in throwaway    : $(val SHIFTFS_IN)"
echo "  sysbox-mgr data root    : $(val DATAROOT)"
echo "  Q1 outer sysbox dind    : $Q1"
echo "  Q2 sysbox daemons nest  : $Q2"
echo "  /dev/fuse nested        : $(val FUSE)"
echo "  Q3 inner dockerd+runtime: $Q3"
echo "  Q4 devcontainer userns  : $Q4"
echo "     uid_map             : ${UIDMAP:-<none>}"
echo "  Q5 unprivileged d-in-d  : $Q5"
echo "========================================================="
echo

case "$Q4" in
  YES*)
    echo "VERDICT: sysbox-in-sysbox WORKS on this kernel. Devcontainers can run under"
    echo "         sysbox-runc, which makes sibling isolation structural and lets"
    case "$Q5" in
      YES*) echo "         allowPrivileged be REMOVED (nested docker needs no privilege)." ;;
      *)    echo "         allowPrivileged be contained; nested-docker payoff (Q5) needs a look." ;;
    esac
    echo "         Next: rebase dind on Ubuntu+sysbox, register sysbox-runc in dind's"
    echo "         dockerd, pin runtime=sysbox-runc in desolate.ts, invert policy.ts." ;;
  *)
    echo "VERDICT: not viable as-is. The Q above marked [KERNEL] is the blocker;"
    echo "         [PLUMBING] failures are solvable and do not condemn the approach."
    case "$Q2" in
      *idmapped-mount*)
        echo
        echo "         The blocker is the idmapped-mount check: sysbox's uid-shifting does"
        echo "         not compose into a second userns on this kernel. The known escape is"
        echo "         shiftfs (see the mount-shifting facts above):"
        case "${SHIFTFS_VM:-absent}" in
          present*|loadable*)
            echo "           shiftfs IS available -- if level-1 sysbox is on idmapped mounts,"
            echo "           forcing it onto shiftfs (or a sysbox build that prefers it when"
            echo "           nested) is the path to try next." ;;
          *)
            echo "           shiftfs is NOT on this kernel, so there is no in-kernel route to"
            echo "           nest the shift. Options narrow to: a Colima kernel that carries"
            echo "           shiftfs, or a different per-devcontainer boundary (gVisor/Kata)." ;;
        esac ;;
      *fs-type*|*ENV*)
        echo
        echo "         The nested sysbox could not even build the data root it needs. This"
        echo "         environment exposes no loop device (and no /dev/fuse), so a"
        echo "         CONTAINER-OWNED real filesystem -- the only kind that could pass the"
        echo "         idmap check -- cannot be created. With shiftfs also absent, there is"
        echo "         no in-kernel route to nest sysbox here."
        echo
        echo "         Reframe worth considering: you do NOT need sysbox to NEST. Give each"
        echo "         privileged/untrusted project its OWN dind (a sysbox container on the"
        echo "         VM daemon). Siblings then sit in separate dinds, isolated by the"
        echo "         level-1 sysbox boundary that every run above confirmed WORKS -- no"
        echo "         nesting required." ;;
    esac ;;
esac
echo
