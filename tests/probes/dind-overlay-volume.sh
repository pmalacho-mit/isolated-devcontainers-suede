#!/usr/bin/env bash
# PROBE -- not a test. Answers a capability question about the environment so a
# design decision can be made; it asserts no invariant and gates nothing.
#
# QUESTION: can the shared editor server (/server-dist, currently bind-mounted
# read-only into every devcontainer as /vscode-server) be replaced by a
# PER-PROJECT overlay volume, giving each project a private copy-on-write view?
#
# Why it matters: `:ro` on a bind is a per-mount flag, and a --privileged
# devcontainer holds CAP_SYS_ADMIN in dind's user namespace, so it can
# `mount -o remount,rw` its own copy. An overlay's lowerdir cannot be written
# through the overlay at all -- writes are copied up, always -- so the
# protection becomes structural rather than a flag. Verified on an ordinary
# daemon already; the open questions are specific to dind under sysbox:
#
#   Q1  can dockerd-inside-dind mount overlayfs for a `local` driver volume,
#       given it runs inside sysbox's user namespace?
#   Q2  is the upperdir on a filesystem that can host one? overlayfs CANNOT be
#       an upperdir, and dind's volumes live under /var/lib/docker.
#
# ANSWERED 2026-07-28 -- all three YES, and the design now depends on it:
#   storage driver overlayfs, /var/lib/docker ext4 (so upperdir is viable),
#   a --privileged write did not reach the lower, upper cost 8K.
# Kept as a diagnostic: ensureServerVolume() in desolate.ts refuses to start a
# project when the overlay cannot be built, and this is what tells you why.
#
# HOW TO RUN -- on your Mac, with the stack up:
#
#   ./cli.sh up                          # if it is not already running
#   ./tests/probes/dind-overlay-volume.sh
#
# It creates volumes named desolate-probe-* on the INNER daemon and removes them
# again, including on failure. It does not touch /server-dist, any project, or
# anything on your Mac. Paste the SUMMARY block back when it finishes.
set -uo pipefail

ORCH=desolate-orchestrator
DIND=desolate-dind
PREFIX=desolate-probe
IMG=alpine:3

Q1="UNKNOWN"; Q2="UNKNOWN"; Q3="UNKNOWN"; Q4="UNKNOWN"
note() { printf '      %s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; }

# Drives the INNER daemon (the one holding devcontainers).
inner() { docker exec "$ORCH" docker "$@"; }
# Runs a command inside dind itself, to look at its filesystem.
indind() { docker exec "$DIND" "$@"; }

cleanup() {
  inner rm -f "$PREFIX-c" >/dev/null 2>&1
  for v in merged lower upper work; do inner volume rm -f "$PREFIX-$v" >/dev/null 2>&1; done
}
trap cleanup EXIT INT TERM

echo
echo "== 0. reach the inner daemon =="
if ! inner info >/dev/null 2>&1; then
  bad "cannot reach the inner daemon through $ORCH"
  note "is the stack up?  ./cli.sh up"
  exit 1
fi
ok "inner daemon reachable"
echo "      storage driver: $(inner info --format '{{.Driver}}' 2>/dev/null)"

echo
echo "== 1. what filesystem backs dind's volumes (Q2) =="
# overlayfs cannot be an upperdir. dind's /var/lib/docker is the
# dind-sysbox-data volume, bound from the VM -- so this SHOULD be a real fs.
VOLFS=$(indind stat -f -c %T /var/lib/docker 2>/dev/null | tr -d '\r')
SRVFS=$(indind stat -f -c %T /server-dist 2>/dev/null | tr -d '\r')
echo "      /var/lib/docker : ${VOLFS:-unknown}   (upperdir will live here)"
echo "      /server-dist    : ${SRVFS:-unknown}   (lowerdir)"
case "$VOLFS" in
  overlayfs|overlay) bad "upperdir would sit on overlayfs -- not permitted"; Q2="NO -- $VOLFS" ;;
  "" )               bad "could not determine the filesystem"; Q2="UNKNOWN" ;;
  *)                 ok "upperdir filesystem is '$VOLFS' (not overlayfs)"; Q2="YES -- $VOLFS" ;;
esac

echo
echo "== 2. can the local driver mount an overlay volume in dind (Q1) =="
inner pull -q "$IMG" >/dev/null 2>&1 || { bad "could not pull $IMG on the inner daemon"; exit 1; }
for v in lower upper work; do
  inner volume create "$PREFIX-$v" >/dev/null 2>&1 || { bad "could not create $PREFIX-$v"; exit 1; }
done
inner run --rm -v "$PREFIX-lower:/l" "$IMG" sh -c 'echo PRISTINE-SERVER > /l/openvscode-server' >/dev/null 2>&1

L=$(inner volume inspect "$PREFIX-lower" -f '{{.Mountpoint}}' 2>/dev/null | tr -d '\r')
U=$(inner volume inspect "$PREFIX-upper" -f '{{.Mountpoint}}' 2>/dev/null | tr -d '\r')
W=$(inner volume inspect "$PREFIX-work"  -f '{{.Mountpoint}}' 2>/dev/null | tr -d '\r')
echo "      lowerdir: $L"

# NOTE: `volume create` is lazy -- the mount happens when a container uses it,
# so success here proves nothing. Starting a container is the real answer.
if inner volume create --driver local \
      --opt type=overlay --opt device=overlay \
      --opt o="lowerdir=$L,upperdir=$U,workdir=$W" "$PREFIX-merged" >/dev/null 2>&1; then
  ok "overlay volume created (lazy -- proves nothing yet)"
else
  bad "docker volume create refused the overlay options"
  Q1="NO -- volume create refused"
fi

MOUNTOUT=$(inner run --name "$PREFIX-c" -v "$PREFIX-merged:/m" "$IMG" \
             sh -c 'cat /m/openvscode-server' 2>&1)
if printf '%s' "$MOUNTOUT" | grep -q PRISTINE-SERVER; then
  ok "a container MOUNTED the overlay and read through to the lower"
  Q1="YES"
else
  bad "mounting the overlay volume failed"
  note "docker said: $(printf '%s' "$MOUNTOUT" | tail -2 | tr '\n' ' ')"
  Q1="NO -- mount failed"
fi
inner rm -f "$PREFIX-c" >/dev/null 2>&1

echo
echo "== 3. does a write through the overlay leave the lower intact (Q3) =="
if [ "$Q1" = "YES" ]; then
  inner run --rm --privileged -v "$PREFIX-merged:/m" "$IMG" \
      sh -c 'echo MALICIOUS > /m/openvscode-server' >/dev/null 2>&1
  AFTER=$(inner run --rm -v "$PREFIX-lower:/l" "$IMG" cat /l/openvscode-server 2>/dev/null | tr -d '\r')
  if [ "$AFTER" = "PRISTINE-SERVER" ]; then
    ok "a --privileged write did NOT reach the lower (still 'PRISTINE-SERVER')"
    Q3="YES"
  else
    bad "the lower was modified -- now '$AFTER'"
    Q3="NO"
  fi
  echo "      upper cost after one modified file:"
  inner run --rm -v "$PREFIX-upper:/u" "$IMG" du -sh /u 2>/dev/null | sed 's/^/        /'
else
  note "skipped -- the overlay never mounted"
  Q3="SKIPPED"
fi

echo
echo "== 4. was the read-only bind residual ever reachable? (Q4) =="
# The reason we stopped relying on `:ro`: MS_RDONLY is per-mount, so a container
# with CAP_SYS_ADMIN can remount its own copy rw and write through to the shared
# file. Whether that succeeds inside dind's sysbox user namespace is a separate
# question -- mounts crossing a userns boundary are LOCKED and cannot be
# remounted. Informational either way: the overlay does not depend on the answer.
Q4=$(inner run --rm --privileged -v "$PREFIX-lower:/ro:ro" "$IMG" sh -c '
  mount -o remount,bind,rw /ro 2>/dev/null || { echo LOCKED; exit 0; }
  touch /ro/probe 2>/dev/null && echo REMOUNTABLE || echo LOCKED' 2>/dev/null | tr -d '\r')
case "$Q4" in
  REMOUNTABLE) bad "a privileged container CAN remount a :ro bind rw here"
               note "so read-only alone would not have been enough -- the overlay is load-bearing" ;;
  LOCKED)      ok  "a privileged container could NOT remount a :ro bind rw here"
               note "the residual was not reachable; the overlay closes it regardless" ;;
  *)           note "inconclusive ('$Q4')"; Q4="UNKNOWN" ;;
esac

echo
echo "=============== SUMMARY (paste this back) ==============="
echo "  inner storage driver : $(inner info --format '{{.Driver}}' 2>/dev/null)"
echo "  /var/lib/docker fs   : ${VOLFS:-unknown}"
echo "  /server-dist fs      : ${SRVFS:-unknown}"
echo "  Q1 overlay mounts    : $Q1"
echo "  Q2 upperdir viable   : $Q2"
echo "  Q3 lower protected   : $Q3"
echo "  Q4 :ro remountable   : ${Q4:-UNKNOWN}"
echo "========================================================="
echo
[ "$Q1" = "YES" ] && [ "$Q3" = "YES" ] \
  && echo "VERDICT: per-project overlay volumes are viable here." \
  || echo "VERDICT: not viable as-is -- the numbers above say which part failed."
