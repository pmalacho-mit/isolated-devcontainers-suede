#!/usr/bin/env bash
# PROBE -- run this on your Mac, against a LIVE stack. It asserts nothing and
# gates nothing; it answers a question so a fix can be chosen.
#
#   ./tests/probes/loopback-cookie-scope.sh
#
# THE QUESTION
#
# Everything this stack shows you is on 127.0.0.1: the main editor on
# $VSCODE_PORT, and every project's own editor and dev server on
# DESOLATE_PORT_MIN..MAX. They are different PORTS on the same HOST.
#
# Browsers do not scope cookies by port. RFC 6265 s8.5 is explicit: "cookies do
# not provide isolation by port". A page served from 127.0.0.1:8085 -- which is
# to say, a dev server inside any devcontainer -- shares one cookie jar with the
# main editor on 127.0.0.1:3000, and `document.cookie` reads the whole jar
# unless a cookie is flagged HttpOnly.
#
# The main editor is the crown jewel: read/write on every project in
# /workspaces, plus the broker. If it authenticates with a readable cookie, then
# a compromised project that gets you to open its dev-server URL -- the URL
# `desolate` itself prints and tells you to open -- can read the main editor's
# token out of the jar.
#
# So the question is narrow and answerable: DOES the editor set a cookie, is it
# HttpOnly, and is the cookie alone sufficient to authenticate?
#
# WHAT THIS DOES NOT DO
#
# It does not attack anything. It reads response headers, and it uses curl's own
# cookie engine (which matches browsers in ignoring ports) to show where a
# cookie would travel. Nothing is sent to any devcontainer.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
RELEASE="$ROOT/release"
JAR=$(mktemp -t desolate-probe-jar)
trap 'rm -f "$JAR"' EXIT INT TERM

say()  { printf '%s\n' "$*"; }
head2() { printf '\n\033[1m-- %s --\033[0m\n' "$*"; }
finding() { printf '  \033[1;33mFINDING\033[0m  %s\n' "$*"; }
clear_() { printf '  \033[32mclear\033[0m    %s\n' "$*"; }
info()  { printf '  info     %s\n' "$*"; }

# Same .env reading rules as cli.sh (last wins, quotes stripped, CR dropped).
env_value() {
  local v
  v=$(grep "^$1=" "$RELEASE/.env" 2>/dev/null | tail -n 1)
  v=${v#*=}; v=${v%$'\r'}
  case $v in \"*\") v=${v#\"}; v=${v%\"} ;; \'*\') v=${v#\'}; v=${v%\'} ;; esac
  printf '%s' "$v"
}

PORT=$(env_value VSCODE_PORT); PORT=${PORT:-3000}
TOKEN=$(env_value VSCODE_TOKEN)
PMIN=$(env_value DESOLATE_PORT_MIN); PMIN=${PMIN:-8080}
PMAX=$(env_value DESOLATE_PORT_MAX); PMAX=${PMAX:-8090}

[ -n "$TOKEN" ] || {
  say "probe: no VSCODE_TOKEN in $RELEASE/.env -- is the stack set up? (./cli.sh up)"
  exit 1
}
curl -sS -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null || {
  say "probe: nothing answering on 127.0.0.1:$PORT -- start the stack first (./cli.sh up)"
  exit 1
}

say "editor: 127.0.0.1:$PORT     project range: $PMIN-$PMAX"

# ---------------------------------------------------------------------------
head2 "1. does authenticating with ?tkn= set a cookie, and is it HttpOnly?"
# ---------------------------------------------------------------------------
HEADERS=$(curl -sSI --max-time 5 -c "$JAR" "http://127.0.0.1:$PORT/?tkn=$TOKEN" 2>/dev/null)
SETCOOKIE=$(printf '%s' "$HEADERS" | grep -i '^set-cookie:' || true)

if [ -z "$SETCOOKIE" ]; then
  # A HEAD may not be enough; the workbench GET is what usually sets it.
  SETCOOKIE=$(curl -sS -D - -o /dev/null --max-time 5 -c "$JAR" \
                "http://127.0.0.1:$PORT/?tkn=$TOKEN" 2>/dev/null \
              | grep -i '^set-cookie:' || true)
fi

if [ -z "$SETCOOKIE" ]; then
  clear_ "the editor set no cookie at all on this request."
  info   "If it authenticates purely from the ?tkn= query parameter, there is"
  info   "nothing in the shared jar to steal and finding 1 does not apply."
  info   "Re-run after loading the editor in a browser once, to be sure."
  COOKIE_NAME=""
else
  say ""
  printf '%s\n' "$SETCOOKIE" | sed 's/^/    /'
  say ""
  COOKIE_NAME=$(printf '%s' "$SETCOOKIE" | head -1 | sed -E 's/^[Ss]et-[Cc]ookie: *([^=]+)=.*/\1/')
  if printf '%s' "$SETCOOKIE" | grep -qi 'httponly'; then
    clear_ "the cookie is HttpOnly -- document.cookie cannot read it."
    info   "A hostile page on another 127.0.0.1 port still has it ATTACHED to"
    info   "requests it makes to :$PORT (that is CSRF, not theft) -- see step 4."
  else
    finding "'$COOKIE_NAME' is NOT HttpOnly."
    info   "Any page on any 127.0.0.1 port reads it with document.cookie."
  fi
fi

# ---------------------------------------------------------------------------
head2 "2. is the cookie alone enough to authenticate, without ?tkn= ?"
# ---------------------------------------------------------------------------
NOAUTH=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null)
WITHJAR=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -b "$JAR" "http://127.0.0.1:$PORT/" 2>/dev/null)
info "no credentials      -> HTTP $NOAUTH"
info "cookie jar only     -> HTTP $WITHJAR"
if [ "$NOAUTH" != "$WITHJAR" ] && [ "$WITHJAR" = "200" ]; then
  finding "the cookie by itself authenticates. Whoever reads it has the editor."
elif [ "$NOAUTH" = "$WITHJAR" ]; then
  info "no difference -- either both are refused, or the editor is not gating"
  info "this path at all. Check '$NOAUTH' against 'cli.sh preflight'."
fi

# ---------------------------------------------------------------------------
head2 "3. does the jar travel ACROSS ports on 127.0.0.1?"
# ---------------------------------------------------------------------------
# curl's cookie engine implements RFC 6265 host matching, i.e. it ignores the
# port, exactly as a browser does. So the jar written while talking to :$PORT is
# character-for-character the jar a browser would send to a project port, and
# printing it answers the question without needing a project running -- or
# sending anything to one.
if grep -qv '^#' "$JAR" 2>/dev/null; then
  say ""
  grep -v '^#' "$JAR" | awk '{printf "    %s  (domain %s)\n", $6, $1}'
  say ""
  finding "the jar above is shared with every 127.0.0.1 port, including the"
  info   "  $PMIN-$PMAX range that devcontainer dev servers are published on."
  info   "  Cookie scope is (domain, path) -- never port. RFC 6265 s8.5."
else
  clear_ "the jar is empty; nothing to share across ports."
fi

# ---------------------------------------------------------------------------
head2 "4. what is actually listening in the project range right now?"
# ---------------------------------------------------------------------------
FOUND=0
for p in $(seq "$PMIN" "$PMAX"); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 1 "http://127.0.0.1:$p/" 2>/dev/null || true)
  case "$code" in
    ''|000) continue ;;   # nothing listening
    *)      info "127.0.0.1:$p answers (HTTP $code) -- same cookie jar as :$PORT"
            FOUND=$((FOUND+1)) ;;
  esac
done
[ "$FOUND" -eq 0 ] && info "nothing published in $PMIN-$PMAX (no project running)"

# ---------------------------------------------------------------------------
head2 "verdict"
# ---------------------------------------------------------------------------
cat <<EOF
  The exposure is real only if BOTH are true:
    - the editor authenticates from a cookie (step 2), and
    - that cookie is not HttpOnly (step 1).

  If both hold, the attack needs no bug in desolate: a compromised project
  serves a page on its own dev-server port, you open the URL 'desolate' printed
  for it, and its JavaScript reads the main editor's cookie out of the shared
  127.0.0.1 jar.

  Fixes, cheapest first -- see tests/probes/README-cookie-fixes.md
EOF
