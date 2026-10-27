#!/usr/bin/env bash
# Queries cli.sh hands to other programs, EXECUTED rather than eyeballed.
#
# `secret list` shipped with a jq program that was invalid jq -- it escaped its
# quotes to survive `colima ssh` re-parsing, and `\"` is not legal inside a
# `\(...)` interpolation. It could never have worked, on any machine, and
# nothing caught it: bash -n only checks bash, and the failure was masked by a
# `|| echo "(no secrets configured yet)"` that reported an empty store.
#
# So: pull the real program out of cli.sh and run it against a fixture.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

if ! command -v jq >/dev/null 2>&1; then
  skip "cli.sh queries" "jq not installed"
  summary; exit $?
fi

group "the 'secret list' jq program"

# Extracted, not retyped -- a copy here could drift from what actually ships.
PROG=$(sed -n "s/^SECRET_LIST_JQ='\(.*\)'$/\1/p" "$RELEASE/cli.sh")
if [ -z "$PROG" ]; then
  fail "found SECRET_LIST_JQ in cli.sh" "sed matched nothing -- was it renamed or reformatted?"
  summary; exit $?
fi
pass "found SECRET_LIST_JQ in cli.sh"

FIXTURE='{"secrets":{"MYAPP-OPENAI-KEY":{"value":"x","hosts":["api.openai.com","*.example.com"]},"OTHER-KEY":{"value":"y","hosts":["b.com"]}}}'

if OUT=$(printf '%s' "$FIXTURE" | jq -r "$PROG" 2>&1); then
  pass "it is valid jq and runs"
else
  fail "it is valid jq and runs" "$OUT"
fi

assert_contains "it lists a secret with its allowlist" "$OUT" "MYAPP-OPENAI-KEY"
assert_contains "it includes every host, not just the first" "$OUT" "*.example.com"
assert_contains "it lists every secret" "$OUT" "OTHER-KEY"

# A scope and a header confinement travel as counts, then the projects, the
# headers, the hosts -- so each is told apart, and nothing reads as a host.
SCOPED_FIXTURE='{"secrets":{"DEPLOY-KEY":{"value":"x","hosts":["api.github.com"],"projects":["acme/widgets","solo"]},"OPEN-KEY":{"value":"y","hosts":["b.com"]},"OAUTH":{"value":"z","hosts":["api.anthropic.com"],"headers":["authorization"]}}}'
SCOPED_OUT=$(printf '%s' "$SCOPED_FIXTURE" | jq -r "$PROG" 2>&1)
assert_eq "a scoped secret's row: name, counts, projects, hosts" \
  "$(printf '%s\n' "$SCOPED_OUT" | grep '^DEPLOY-KEY')" "$(printf 'DEPLOY-KEY\t2\t0\tacme/widgets\tsolo\tapi.github.com')"
assert_eq "an unscoped one's: two zeros, then its hosts" \
  "$(printf '%s\n' "$SCOPED_OUT" | grep '^OPEN-KEY')" "$(printf 'OPEN-KEY\t0\t0\tb.com')"
assert_eq "a confined one's: its headers before its hosts" \
  "$(printf '%s\n' "$SCOPED_OUT" | grep '^OAUTH')" "$(printf 'OAUTH\t0\t1\tauthorization\tapi.anthropic.com')"

# The whole point of the TSV shape: nothing for a remote shell to re-parse.
case "$PROG" in
  *'"'*) fail "the program survives 'colima ssh' re-parsing" \
              "it contains a double quote, which the remote shell may strip" ;;
  *' '*) fail "the program survives 'colima ssh' re-parsing" \
              "it contains a space, which the remote shell may split on" ;;
  *)     pass "the program survives 'colima ssh' re-parsing" ;;
esac

# An empty store must be distinguishable from a broken query -- conflating them
# is what hid the bug.
EMPTY=$(printf '%s' '{"secrets":{}}' | jq -r "$PROG" 2>&1)
assert_eq "an empty store yields no rows" "$EMPTY" ""

group "the 'secret add' collision jq program"
# Same extraction discipline: this one decides whether a new placeholder may be
# stored at all, and it runs inside the VM where a mistake is invisible from
# here. Two secrets whose names overlap cannot both be substituted -- the proxy
# replaces by plain string search -- so registering the second must be refused.
COLLIDE=$(sed -n "s/^SECRET_COLLISION_JQ='\(.*\)'$/\1/p" "$RELEASE/cli.sh")
if [ -z "$COLLIDE" ]; then
  fail "found SECRET_COLLISION_JQ in cli.sh" "sed matched nothing -- was it renamed?"
else
  pass "found SECRET_COLLISION_JQ in cli.sh"

  STORE='{"secrets":{"MYAPP-OPENAI-KEY":{"value":"x","hosts":["a.com"]},"OTHER-KEY":{"value":"y","hosts":["b.com"]}}}'
  collides() { printf '%s' "$STORE" | jq -r --arg n "$1" "$COLLIDE" 2>&1 | paste -sd, -; }

  assert_eq "a longer name containing an existing one is caught" \
            "$(collides MYAPP-OPENAI-KEY-2)" "MYAPP-OPENAI-KEY"
  assert_eq "a shorter name contained BY an existing one is caught too" \
            "$(collides MYAPP-OPENAI)" "MYAPP-OPENAI-KEY"
  assert_eq "an unrelated name is free" "$(collides MYAPP-STRIPE-KEY)" ""
  # Re-adding the same name is how you rotate a value; it must not self-collide.
  assert_eq "re-adding the same name is not a collision" "$(collides MYAPP-OPENAI-KEY)" ""
  assert_eq "an empty store collides with nothing" \
            "$(printf '%s' '{}' | jq -r --arg n K "$COLLIDE" 2>&1 | paste -sd, -)" ""

  case "$COLLIDE" in
    *'"'*) fail "the program survives 'colima ssh' re-parsing" "it contains a double quote" ;;
    *' '*) fail "the program survives 'colima ssh' re-parsing" "it contains a space" ;;
    *)     pass "the program survives 'colima ssh' re-parsing" ;;
  esac
fi

group "the --hosts allowlist has to name a destination"
# '*' as a secret's allowlist is the absence of an allowlist: the placeholder
# becomes a bearer token any container can post anywhere and still have the
# real key swapped in. addon.py refuses the same shapes on load (see
# tests/unit/proxy); this is the half that tells you at registration time.
# Extracted and EXECUTED, so the two cannot drift into disagreeing.
FN=$(sed -n '/^host_pattern_pins_a_destination()/,/^}/p' "$RELEASE/cli.sh")
if [ -z "$FN" ]; then
  fail "found host_pattern_pins_a_destination in cli.sh" "sed matched nothing -- was it renamed?"
else
  pass "found host_pattern_pins_a_destination in cli.sh"
  eval "$FN"

  for h in api.openai.com openai.com '*.openai.com' '*.eu.openai.com' localhost; do
    if host_pattern_pins_a_destination "$h"; then pass "accepts $h"
    else fail "accepts $h" "a legitimate allowlist entry was refused"; fi
  done

  # '*foo.com' is the subtle one: fnmatch's '*' does not stop at a dot, so it
  # matches 'evilfoo.com' as well -- an attacker-registrable name.
  for h in '*' '**' '*.*' '*.com' '*openai.com' 'api.*' '*.openai.' '*..com' ''; do
    if host_pattern_pins_a_destination "$h"; then fail "refuses '$h'" "it pins nothing"
    else pass "refuses '$h'"; fi
  done
fi

group "the jq expressions in ssh-allow.sh"
# Third jq bug in this codebase, and none were caught by anything: a jq program
# is a string in one language embedded in another, so `bash -n` sees a valid
# script and the error only appears when that line runs. `secret list` shipped
# invalid jq for months; ssh-allow.sh's final assertion used `?//`, which parses
# as jq's destructuring-alternative operator, so the check could never run.
# Extract every jq program from the script and EXECUTE it.
SSH_ALLOW="$RELEASE/proxy/vm/ssh-allow.sh"
GH_FIXTURE='{"git":["192.30.252.0/22","140.82.112.0/20","2a0a:a440::/29"]}'

# Flags are OPTIONAL in this pattern. Requiring one (`jq -[a-z]+`) is how the
# first version of this test missed the very bug it was written for: that call
# was a bare `jq '<prog>'`, so the grep skipped it and the group passed on the
# OTHER programs. A guard that matches some of its subjects is worse than one
# that matches none, because the empty-guard below cannot see it.
PROGS=$(grep -oE "jq( -[a-zA-Z]+)* '[^']+'" "$SSH_ALLOW" \
        | sed -E "s/^jq( -[a-zA-Z]+)* '//; s/'$//" | sort -u)
# ...plus the two passed via the add_all helper.
PROGS="$PROGS
$(grep -oE "add_all ssh_allow_v[46] '[^']+'" "$SSH_ALLOW" | sed -E "s/.*'([^']+)'.*/\1/")"

if [ -z "$(printf '%s' "$PROGS" | tr -d '[:space:]')" ]; then
  fail "found jq programs in ssh-allow.sh" "grep matched nothing -- did the calls change shape?"
else
  while IFS= read -r prog; do
    [ -n "$prog" ] || continue
    if OUT=$(printf '%s' "$GH_FIXTURE" | jq -r "$prog" 2>&1); then
      pass "jq program runs: $prog"
    else
      fail "jq program runs: $prog" "$OUT"
    fi
  done <<< "$PROGS"
fi

# And the split must actually separate families, or one set gets both.
V4=$(printf '%s' "$GH_FIXTURE" | jq -r '.git[] | select(contains(":") | not)' | tr '\n' ' ')
V6=$(printf '%s' "$GH_FIXTURE" | jq -r '.git[] | select(contains(":"))' | tr '\n' ' ')
assert_not_contains "the v4 filter excludes IPv6 ranges" "$V4" ":"
assert_contains "the v6 filter keeps IPv6 ranges" "$V6" "2a0a"

group "the 'export' archive"

# Extracted, not retyped, and run against a real directory tree: the claim is
# about what realpath and tar do with planted symlinks, which only running it
# shows. Judged on the archive's own listing, not on a printed path.
EXPORT=$(awk "/^EXPORT_TAR_SH='/{p=1; sub(/^EXPORT_TAR_SH='/, \"\")} p{ if (sub(/'\$/, \"\")) { print; exit } print }" "$RELEASE/cli.sh")
if [ -z "$EXPORT" ]; then
  fail "found EXPORT_TAR_SH in cli.sh" "awk matched nothing -- was it renamed or reformatted?"
else
  pass "found EXPORT_TAR_SH in cli.sh"
  WS=$(mktemp -d)
  mkdir -p "$WS/acme/widgets/dist" "$WS/acme/gadgets" "$WS/solo"
  echo built > "$WS/acme/widgets/dist/app.js"
  echo private > "$WS/acme/gadgets/secret.txt"
  ln -s ../gadgets "$WS/acme/widgets/escape"
  ln -s dist "$WS/acme/widgets/inside"
  ln -s /etc "$WS/acme/widgets/dist/etc-link"
  # The case the first version missed: a single-segment project whose child
  # links to ANOTHER project, named as if it were an owner/repo.
  ln -s ../acme/gadgets "$WS/solo/b"
  archive() { sh -c "$EXPORT" sh "$WS" "$@"; }
  listing() { archive "$@" 2>/dev/null | tar -tf - 2>/dev/null | sort | tr '\n' ' '; }

  OUT=$(listing acme/widgets dist)
  if [ "$OUT" = "dist/ dist/app.js dist/etc-link " ]; then pass "a directory in the project is archived under its own name"
  else fail "a directory in the project is archived under its own name" "got: $OUT"; fi
  case "$(listing acme/widgets)" in
    "widgets/ "*) pass "no path means the whole project" ;;
    *) fail "no path means the whole project" "got: $(listing acme/widgets)" ;;
  esac
  if archive acme/widgets dist | tar -tvf - 2>/dev/null | grep -q 'etc-link -> /etc'; then
    pass "a link inside is archived AS a link, never followed"
  else fail "a link inside is archived AS a link, never followed" "tar followed it or dropped it"; fi
  OUT=$(listing acme/widgets inside)
  if [ "$OUT" = "dist/ dist/app.js dist/etc-link " ]; then pass "a symlink that stays inside is followed to its target"
  else fail "a symlink that stays inside is followed to its target" "got: $OUT"; fi
  for case in "escape:4" "../gadgets/secret.txt:4" "nope:3"; do
    rel=${case%:*} want=${case#*:}
    archive acme/widgets "$rel" >/dev/null 2>&1; RC=$?
    if [ "$RC" = "$want" ]; then pass "acme/widgets '$rel' exits $want"
    else fail "acme/widgets '$rel' exits $want" "rc=$RC"; fi
  done
  for project in solo/b .. . "" /etc acme/widgets/../gadgets/.. acme/ acme/widgets/dist .hidden nosuch; do
    archive "$project" . >/dev/null 2>&1; RC=$?
    if [ "$RC" = 2 ]; then pass "'$project' is not a project"
    else fail "'$project' is not a project" "rc=$RC"; fi
  done
  rm -rf "$WS"
fi

group "the proxy's AUDIT lines are read as journald holds them"
# Measured on the VM, 2026-10-26: mitmdump under systemd prefixes every line
# with its time, and every reader here anchored on `^AUDIT` -- so `proxy audit`
# printed nothing and preflight's leak oracle failed against a working addon.
# These are that VM's lines, verbatim, and the same lines unprefixed.
VM_LEAK='[12:05:13.007] AUDIT verdict=LEAK-SUSPECT method=GET host=example.com path=/desolate-manual-probe secrets=- suspect=DESOLATE-SELFTEST-PLACEHOLDER project=-'
VM_ALLOW='[12:04:04.855] AUDIT verdict=ALLOW method=GET host=raw.githubusercontent.com path=/x secrets=- suspect=- project=pmalacho-mit/isolated-devcontainers-suede'
VM_PROSE="[12:05:13.007] LEAK-SUSPECT placeholder 'DESOLATE-SELFTEST-PLACEHOLDER' sent toward 'example.com' -- passed UNSUBSTITUTED"
JOURNAL=$(printf '%s\n' "$VM_PROSE" "$VM_LEAK" "$VM_ALLOW" "${VM_ALLOW#\[*\] }")
FIELDS_SED=$(sed -n "s/^AUDIT_FIELDS_SED='\(.*\)'$/\1/p" "$RELEASE/cli.sh")
assert_eq "proxy audit reads every AUDIT line, prefixed or not, and no prose" \
  "$(printf '%s\n' "$JOURNAL" | sed -nE "$FIELDS_SED" | cut -d' ' -f1 | tr '\n' ' ')" \
  "verdict=LEAK-SUSPECT verdict=ALLOW verdict=ALLOW "
eval "$(sed -n '/^leak_suspect_line()/p' "$RELEASE/cli.sh")"
assert_eq "proxy test finds its probe's line by path" \
  "$(printf '%s\n' "$JOURNAL" | leak_suspect_line desolate-manual-probe)" "$VM_LEAK"
# The oracle's own pattern, as preflight.sh writes it; anchored, or it proves
# nothing -- a bare path would match on its own.
PREFLIGHT_RE=$(sed -nE 's/.*grep -aE? "(\^.*AUDIT verdict=LEAK-SUSPECT \.\* path=\/)\$marker ".*/\1/p' "$RELEASE/preflight.sh")
case "$PREFLIGHT_RE" in
  "^"*) assert_eq "preflight's leak oracle matches it too" \
          "$(printf '%s\n' "$JOURNAL" | grep -aE "${PREFLIGHT_RE}desolate-manual-probe " | tail -n 1)" "$VM_LEAK" ;;
  *) fail "found preflight's leak oracle pattern" "sed matched nothing anchored -- was it reformatted?" ;;
esac

group "proxy audit <n> shows n requests, not n journal lines"
# A request writes about eight journal lines and one AUDIT line, so reading
# `journalctl -n <n>` showed fewer than n requests -- with n=5, usually none
# (measured on the VM, 2026-10-26). A stand-in colima serves the VM's own lines
# and honours -n the way journalctl does.
STUB=$(mktemp -d)
{ for i in 1 2 3; do
    printf '%s\n' "[12:0$i:00.000][172.19.0.2:3448$i] client connect" \
      "[12:0$i:00.100] AUDIT verdict=ALLOW method=GET host=h$i.example path=/ secrets=- suspect=- project=acme/widgets" \
      "      << HTTP/2.0 200 OK 1b" "[12:0$i:00.200][172.19.0.2:3448$i] client disconnect" \
      "[12:0$i:00.200][172.19.0.2:3448$i] server disconnect 1.2.3.4:443"
  done; } > "$STUB/journal"
cat > "$STUB/colima" <<EOF
#!/bin/sh
n=10; while [ \$# -gt 0 ]; do [ "\$1" = -n ] && n=\$2; shift; done
tail -n "\$n" "$STUB/journal"
EOF
chmod +x "$STUB/colima"
assert_eq "proxy audit 2: the last two requests" \
  "$(PATH="$STUB:$PATH" "$RELEASE/cli.sh" proxy audit 2 2>&1 | awk '{print $4}' | tr '\n' ' ')" "h2.example/ h3.example/ "
assert_eq "proxy logs --project acme/widgets 1: its last request" \
  "$(PATH="$STUB:$PATH" "$RELEASE/cli.sh" proxy logs --project acme/widgets 1 2>&1 | grep -o 'host=[^ ]*')" "host=h3.example"
rm -rf "$STUB"

group "proxy logs --project matches its project exactly"
AWK=$(sed -n "s/^PROJECT_AUDIT_AWK='\(.*\)'$/\1/p" "$RELEASE/cli.sh")
if [ -z "$AWK" ]; then
  fail "found PROJECT_AUDIT_AWK in cli.sh" "sed matched nothing -- was it renamed or reformatted?"
else
  LINES='AUDIT verdict=ALLOW host=a.com project=a.b
[12:04:04.855] AUDIT verdict=ALLOW host=d.com project=a.b
AUDIT verdict=ALLOW host=b.com project=aXb
AUDIT verdict=ALLOW host=c.com project=a.b/c
[12:04:04.855] NOTE project=a.b'
  assert_eq "only the AUDIT lines naming exactly that project, as journald holds them" \
    "$(printf '%s\n' "$LINES" | awk -v want=" project=a.b" "$AWK" | tr '\n' '|')" \
    "AUDIT verdict=ALLOW host=a.com project=a.b|[12:04:04.855] AUDIT verdict=ALLOW host=d.com project=a.b|"
fi

group "exec, bundle and --status: what reaches docker (docs/agents.md)"
# A stand-in docker that logs each call's argv, one word per field, and answers
# as the stack would: the editor running, a bundle made in the orchestrator.
STUB=$(mktemp -d)
cat > "$STUB/docker" <<EOF
#!/bin/sh
printf '%s|' "\$@" >> "$STUB/calls"; echo >> "$STUB/calls"
case "\$1" in
  inspect) echo running ;;
  exec) case "\$*" in *--bundle*) echo "a log line"; echo "BUNDLED issue/42 abc123 /workspaces/.desolate/bundles/ns/branch.bundle" ;; esac ;;
  cp) : > "\$3" ;;
esac
EOF
chmod +x "$STUB/docker"
cli() { : > "$STUB/calls"; PATH="$STUB:$PATH" DESOLATE_NO_COMPLETION_INSTALL=1 "$RELEASE/cli.sh" "$@" </dev/null 2>&1; }
execs() { grep '^exec|' "$STUB/calls" | tr '\n' ' '; }

cli exec acme/widgets --worktree issue-42 -- claude -p 'fix it, --stop' >/dev/null
assert_eq "exec: the command after --, word for word, to the orchestrator's runner" "$(execs)" \
  "exec|-i|-e|DESOLATE_PLANE=mac|desolate-orchestrator|desolate-run|--exec|--worktree|issue-42|acme/widgets|--|claude|-p|fix it, --stop| "
cli exec solo ls >/dev/null
assert_eq "exec: no worktree, and no -- needed" "$(execs)" \
  "exec|-i|-e|DESOLATE_PLANE=mac|desolate-orchestrator|desolate-run|--exec|solo|--|ls| "
OUT=$(cli exec solo --)
assert_eq "exec with no command is refused, before docker" "$(execs)" ""
assert_contains "and says how" "$OUT" "usage: cli.sh exec"

DEST="$STUB/out.bundle"
OUT=$(cli bundle acme/widgets --worktree issue-42 "$DEST")
assert_eq "bundle: made in the sandbox, then copied out of the orchestrator" \
  "$(grep -E '^(exec|cp)\|' "$STUB/calls" | tr '\n' ' ')" \
  "exec|-e|DESOLATE_PLANE=mac|desolate-orchestrator|desolate-run|--bundle|--worktree|issue-42|acme/widgets| cp|desolate-orchestrator:/workspaces/.desolate/bundles/ns/branch.bundle|$DEST| "
assert_contains "and says what it holds" "$OUT" "issue/42 at abc123 -> $DEST"
OUT=$(cli bundle acme/widgets "$DEST")
assert_contains "a file that is there is not overwritten" "$OUT" "already exists; refusing"
assert_eq "  before docker is asked" "$(grep -cE '^(exec|cp)\|' "$STUB/calls")" "0"

cli desolate --status --json acme/widgets >/dev/null
assert_eq "desolate --status is the editor's to read, not the orchestrator's" "$(execs)" \
  "exec|-e|DESOLATE_PLANE=mac|desolate-vscode|desolate|--status|--json|acme/widgets| "
rm -rf "$STUB"

group "secret add --headers, through a stand-in VM"
# `secret add` runs its store in the VM over `colima ssh`. A stand-in colima
# runs that same script here, against a scratch store: the one change it makes
# is where the store lives (and who owns it).
VMSTUB=$(mktemp -d)
cat > "$VMSTUB/colima" <<EOF
#!/usr/bin/env bash
while [ "\$1" != -- ]; do shift; done; shift
[ "\$1" = sudo ] && shift
args=("\$@")
for i in "\${!args[@]}"; do
  a=\${args[\$i]}; a=\${a//\/etc\/desolate-proxy\/settings.json/$VMSTUB/settings.json}; a=\${a//-o desolate-proxy -g desolate-proxy/}
  args[\$i]=\$a
done
exec "\${args[@]}"
EOF
chmod +x "$VMSTUB/colima"
vmcli() { PATH="$VMSTUB:$PATH" DESOLATE_NO_COMPLETION_INSTALL=1 "$RELEASE/cli.sh" secret "$@" 2>&1; }
OUT=$(printf 'sk-ant-oat01-x\n' | vmcli add DESOLATE-CLAUDE-OAUTH --hosts api.anthropic.com --headers Authorization)
assert_contains "it is stored" "$OUT" "stored"
assert_eq "confined to the header it names, lower-cased" \
  "$(jq -c '.secrets["DESOLATE-CLAUDE-OAUTH"].headers' "$VMSTUB/settings.json")" '["authorization"]'
printf 'v\n' | vmcli add OPEN-KEY --hosts b.com >/dev/null
assert_eq "without --headers, no confinement is written" "$(jq -c '.secrets["OPEN-KEY"] | has("headers")' "$VMSTUB/settings.json")" "false"
LIST=$(vmcli list)
assert_contains "list shows the confinement" "$LIST" "DESOLATE-CLAUDE-OAUTH  ->  api.anthropic.com   [headers: authorization]"
assert_contains "and nothing for one without" "$LIST" "OPEN-KEY  ->  b.com"
OUT=$(printf 'v\n' | vmcli add BAD-KEY --hosts b.com --headers 'x y')
assert_contains "a header that is no header name is refused" "$OUT" "is not a header name"
assert_eq "  and nothing is stored" "$(jq -c '.secrets | has("BAD-KEY")' "$VMSTUB/settings.json")" "false"
rm -rf "$VMSTUB"

summary
