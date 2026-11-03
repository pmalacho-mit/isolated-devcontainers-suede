#!/usr/bin/env bash
# `cli.sh watch`: what needs you, said once each, through the notifier you
# chose (DESOLATE_NOTIFY) -- with docker and the VM stood in for, and a
# recorder as the notifier.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin"
: > "$W/notified"
# A target that asks, with an escape sequence in what it says; one that is
# done; and the proxy's journal: one request allowed, one flagged.
cat > "$W/bin/docker" <<'STUB'
#!/bin/bash
case "$*" in
  *"--status --json"*) printf '%s' '[{"target":"acme/w","project":"acme/w","worktree":null,"status":{"color":"orange","updated":"t1","message":"which API version?\u001b]0;x\u0007"}},{"target":"solo","project":"solo","worktree":null,"status":{"color":"green","updated":"t","message":"done"}}]' ;;
  inspect*) echo running ;;
esac
STUB
cat > "$W/bin/colima" <<'STUB'
#!/bin/bash
case "$*" in
  *"-n 0 --show-cursor"*) echo "-- cursor: c0" ;;
  *"after-cursor=c0"*) printf '%s\n' "[1] AUDIT verdict=ALLOW method=GET host=a.com path=/ secrets=- suspect=- project=-" \
    "[2] AUDIT verdict=LEAK-SUSPECT method=POST host=evil.example path=/x secrets=- suspect=MY-KEY project=acme/w" "-- cursor: c1" ;;
  *) echo "-- cursor: c1" ;;
esac
STUB
printf '#!/bin/sh\nprintf "%%s | %%s\\n" "$1" "$2" >> "%s"\n' "$W/notified" > "$W/bin/recorder"
chmod +x "$W/bin/"*
OUT=$(DESOLATE_NOTIFY="$W/bin/recorder" PATH="$W/bin:$PATH" timeout 4 bash "$RELEASE/cli.sh" watch 1 2>&1)

group "cli.sh watch"
assert_contains "  (it ran, and polled more than once)" "$OUT" "watching every 1s"
assert_eq "a target that asks, once, and what it said with no control character in it" \
  "$(grep -c 'acme/w asks' "$W/notified")" "1"
assert_contains "  what it said" "$(cat "$W/notified")" "desolate: acme/w asks | which API version??]0;x?"
assert_not_contains "a target that is done is not news" "$(cat "$W/notified")" "solo"
assert_contains "a placeholder that strayed, once" "$(cat "$W/notified")" "desolate proxy: LEAK-SUSPECT | MY-KEY toward evil.example, from acme/w"
assert_eq "  and only that from the journal" "$(wc -l < "$W/notified" | tr -d ' ')" "2"
assert_eq "no escape character reached the terminal" "$(printf '%s' "$OUT" | LC_ALL=C grep -c $'\x1b')" "0"
# The default notifier, stood in for by an osascript that records.
printf '#!/bin/sh\necho called >> "%s"\n' "$W/osascript.log" > "$W/bin/osascript"
chmod +x "$W/bin/osascript"
env -u DESOLATE_NOTIFY PATH="$W/bin:$PATH" timeout 2 bash "$RELEASE/cli.sh" watch 1 >/dev/null 2>&1
assert_contains "control: unset, it notifies through osascript" "$(cat "$W/osascript.log" 2>/dev/null)" "called"
rm -f "$W/osascript.log"
DESOLATE_NOTIFY=none PATH="$W/bin:$PATH" timeout 2 bash "$RELEASE/cli.sh" watch 1 >/dev/null 2>&1
assert_eq "DESOLATE_NOTIFY=none: not at all" "$(cat "$W/osascript.log" 2>/dev/null)" ""
summary
