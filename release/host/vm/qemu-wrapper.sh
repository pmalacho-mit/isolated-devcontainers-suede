#!/bin/bash
# Stands between Lima and QEMU for the `qemu` backend (Lima runs whatever
# $QEMU_SYSTEM_<ARCH> names). It changes one thing: the VM's user-mode network.
#
# Lima always gives a VM QEMU's user network, which lets the guest reach the host, the LAN and
# the internet, and offers no setting to stop that. QEMU itself does: `restrict=on` isolates
# the guest (nothing it sends is routed to the host or beyond; Lima's own ssh forward INTO the
# guest still works), and `guestfwd` carries connections the guest makes to one address to a
# program on the host. So, for a VM started with DESOLATE_QEMU_EGRESS=none:
#
#   - the guest has no route to anything (enforced by QEMU, outside the guest: P5);
#   - connecting to 192.168.5.100:15000 inside the guest reaches the unix socket named in
#     DESOLATE_QEMU_LINK on the host, which is that workspace's link to its proxy.
#
# Every other invocation (version checks, `-netdev help`, a root VM) passes through unchanged.
set -euo pipefail
REAL=${DESOLATE_QEMU_REAL:?the real qemu binary is not set}
if [ "${DESOLATE_QEMU_EGRESS:-open}" != none ]; then exec "$REAL" "$@"; fi
args=()
previous=""
for arg in "$@"; do
  if [ "$previous" = "-netdev" ] && [ "${arg#user,}" != "$arg" ]; then
    arg="$arg,restrict=on"
    if [ -n "${DESOLATE_QEMU_LINK:-}" ]; then
      case "$DESOLATE_QEMU_LINK" in *,*|*\ *) echo "qemu-wrapper: the link's path must not contain a comma or a space" >&2; exit 1 ;; esac
      arg="$arg,guestfwd=tcp:192.168.5.100:15000-cmd:socat STDIO UNIX-CONNECT:$DESOLATE_QEMU_LINK"
    fi
  fi
  args+=("$arg")
  previous=$arg
done
# Fail closed: a VM that must have no egress is never started with a network this did not
# restrict, or with a second one beside it.
after_netdev=0
for arg in "${args[@]}"; do
  if [ "$after_netdev" = 1 ]; then
    case "$arg" in
      help) ;;
      user,*restrict=on*) ;;
      user,*) echo "qemu-wrapper: an unrestricted user network would be started; refusing" >&2; exit 1 ;;
      *) echo "qemu-wrapper: a network other than the restricted one ($arg) would bypass the proxy; refusing" >&2; exit 1 ;;
    esac
  fi
  if [ "$arg" = "-netdev" ]; then after_netdev=1; else after_netdev=0; fi
done
# A real VM start has a -netdev; anything else (probes) is passed through.
exec "$REAL" "${args[@]}"
