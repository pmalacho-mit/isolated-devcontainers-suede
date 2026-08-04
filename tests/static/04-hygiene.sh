#!/usr/bin/env bash
# Repository hygiene: things that are only a problem once, at the moment they
# get committed.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"
cd "$ROOT"

group "nothing sensitive is tracked"
TRACKED=$(git ls-files 2>/dev/null)
# Match real dotenv files by path segment, not substring: `.env` and `.env.local`
# are secrets, `.env.example` is documentation and is meant to be tracked. A
# plain substring check on ".env" fails on the example file.
DOTENVS=$(printf '%s\n' "$TRACKED" | grep -E '(^|/)\.env($|\.)' \
          | grep -vE '(^|/)\.env\.example$' || true)
assert_eq ".env is not committed (it holds VSCODE_TOKEN)" "${DOTENVS:-none}" "none"
# The exemption above is only safe while the example stays a template, and the
# rule is stronger than "no real token": the example must carry NO value at all.
#
# It shipped `VSCODE_TOKEN="$(openssl rand -hex 24)"`, which reads as a
# template and is not one -- compose does no command substitution when it
# parses .env, so `cp .env.example .env` produced a stack whose editor token
# was the literal string `$(openssl rand -hex 24)`, committed in a public repo.
# That token is the only thing standing between anything that can reach
# 127.0.0.1:$VSCODE_PORT and read/write access to every project. A check for a
# hex-shaped token passed it, because the dangerous value was not hex-shaped.
#
# So: any assignment at all fails. `cli.sh up` refuses to start without a
# token, which makes the absence self-correcting; a placeholder does not.
SET_TOKEN=$(git grep -nE '^[[:space:]]*VSCODE_TOKEN=.' -- '*.env.example' 2>/dev/null || true)
assert_eq ".env.example assigns no VSCODE_TOKEN at all" "${SET_TOKEN:-none}" "none"
# And the same trap for anything else: a `$(...)` in an env file is inert.
SUBST=$(git grep -nE '^[^#]*=[^#]*\$\(' -- '*.env.example' 2>/dev/null || true)
assert_eq ".env.example promises no command substitution" "${SUBST:-none}" "none"
assert_not_contains "no .DS_Store" "$TRACKED" ".DS_Store"
assert_not_contains "no ssh private keys" "$TRACKED" "id_rsa"
assert_not_contains "no deploy keys" "$TRACKED" "deploy_"

if [ -f .gitignore ]; then
  IGN=$(cat .gitignore)
  assert_contains ".gitignore covers .env" "$IGN" ".env"
  assert_contains ".gitignore covers .DS_Store" "$IGN" ".DS_Store"
else
  fail ".gitignore exists" "no .gitignore -- .env will be committed sooner or later"
fi

group "no key material in tracked files"
# The whole design rests on secret values living only in the VM. A PEM private
# key or an obvious API token in the repo means that stopped being true.
HITS=$(git grep -lE 'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY' -- . 2>/dev/null || true)
assert_eq "no PEM private keys" "${HITS:-none}" "none"
# sk-... / ghp_... shaped literals, ignoring the deliberate placeholders.
TOKENS=$(git grep -nE '(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})' -- . 2>/dev/null \
         | grep -v 'sk-real\.\.\.' | grep -v 'sk-\.\.\.' || true)
assert_eq "no API-token-shaped literals" "${TOKENS:-none}" "none"

group "example projects declare no host ports"
# Host ports are machine-specific; desolate allocates them. appPort in
# particular collides with the relay bind and fails at run time. Checked on the
# PARSED config -- the files legitimately mention appPort in comments warning
# people off it.
jsonc_key() {
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import json, re, sys
raw = open(sys.argv[1]).read()
raw = re.sub(r'/\*[\s\S]*?\*/', '', raw)
raw = re.sub(r'^\s*//.*$', '', raw, flags=re.M)
raw = re.sub(r',(\s*[}\]])', r'\1', raw)
try: cfg = json.loads(raw)
except Exception as e: print(f"PARSE-ERROR {e}"); sys.exit(0)
print("present" if sys.argv[2] in cfg else "absent")
PY
}
EXAMPLES=(example-project sample-fastapi)
for p in "${EXAMPLES[@]}"; do
  f="$SAMPLES/$p/.devcontainer/devcontainer.json"
  if [ ! -f "$f" ]; then
    # Skip rather than fail: a missing example is a packaging gap, not a
    # security regression, and a permanently-red suite teaches people to
    # ignore it. Still visible in the output as a skip.
    skip "$p host-port checks" "no samples/$p/"
    continue
  fi
  assert_eq "$p has no appPort" "$(jsonc_key "$f" appPort)" "absent"
  assert_eq "$p forwards no host ports" "$(jsonc_key "$f" forwardPorts)" "absent"
done

group "example projects blank the agent-forwarding env"
for p in "${EXAMPLES[@]}"; do
  f="$SAMPLES/$p/.devcontainer/devcontainer.json"
  if [ ! -f "$f" ]; then
    skip "$p blanks SSH_AUTH_SOCK" "no samples/$p/"
    continue
  fi
  assert_contains "$p blanks SSH_AUTH_SOCK" "$(cat "$f")" '"SSH_AUTH_SOCK": ""'
done

group "the secrets story stays a placeholder story"
# A real value in a tracked devcontainer.json would defeat the entire model,
# and it is exactly the mistake the design invites (the file LOOKS like a place
# for keys). Placeholders are >= 12 chars and match the documented shape.
for f in $(git ls-files '*devcontainer.json'); do
  vals=$(python3 - "$f" <<'PY' 2>/dev/null || true
import json, re, sys
raw = open(sys.argv[1]).read()
raw = re.sub(r'/\*[\s\S]*?\*/', '', raw)
raw = re.sub(r'^\s*//.*$', '', raw, flags=re.M)
try: cfg = json.loads(raw)
except Exception: sys.exit(0)
for k, v in (cfg.get("containerEnv") or {}).items():
    if isinstance(v, str) and v and not re.fullmatch(r'[A-Z0-9][A-Z0-9._-]{11,}', v):
        print(f"{k}={v}")
PY
)
  assert_eq "$f containerEnv holds only placeholders" "${vals:-none}" "none"
done

group "docs do not promise more than the code enforces"
# The SHIPPED readme, not the repo's own -- these claims are promises made to
# whoever installs release/.
README=$(cat "$RELEASE/README.md")
# Each of these sentences was, at one point, describing an unenforced property.
assert_contains "README documents the compose-mode refusal" "$README" "dockerComposeFile"
assert_contains "README documents the initializeCommand refusal" "$README" "initializeCommand"
assert_contains "README documents the runArgs allowlist" "$README" "allowlist"

summary
