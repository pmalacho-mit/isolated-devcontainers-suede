#!/usr/bin/env bash
# Everything ./tests/run.sh needs that the base image and features do not give
# us. Idempotent -- safe to re-run by hand after a rebuild.
#
# What the suite actually requires, and why each line below exists:
#
#   node >= 22.18   native TS type stripping; the unit tests import .ts
#                   directly with no build step   -> provided by the node feature
#   docker compose  static/02 renders the compose file (config only, NO daemon
#                   needed)                       -> docker-outside-of-docker
#   jq              static/02 queries that rendered config; without it the whole
#                   suite SKIPS rather than fails, which is easy to miss
#   python+mitmproxy  unit/proxy imports release/proxy/vm/addon.py, which imports
#                   mitmproxy at module scope
#   devcontainer    integration/broker resolves specs through the real CLI --
#                   the policy's "ground truth". Without it 8 cases fail.
set -euo pipefail

# postCreateCommand's cwd is not contractual, and neither is yours when you
# re-run this by hand. Everything below is anchored here instead.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> apt tools"
sudo apt-get update -qq
# The linter is not needed by the suite, but every shipped script is shell and
# it catches the quoting bugs that `bash -n` cannot.
sudo apt-get install -y -qq jq shellcheck

echo "==> devcontainer CLI"
# Installed from package.json rather than `npm i -g` so the version stays
# pinned in one place -- integration/broker treats this CLI as ground truth for
# spec resolution, so which version it is matters.
npm --prefix "$REPO_ROOT" install --no-audit --no-fund --silent

# Then LINK it onto the default PATH. Exporting PATH here would have been
# pointless: this script is a child process of postCreateCommand, so the
# assignment dies with it and never reaches an interactive shell. /usr/local/bin
# is already on PATH for login, non-login, and `bash -c` shells alike, which is
# what tests/integration/run.sh's `command -v devcontainer` probe needs.
sudo ln -sfn "$REPO_ROOT/node_modules/.bin/devcontainer" /usr/local/bin/devcontainer

echo "==> mitmproxy venv for the addon tests"
# /opt/mitmtest is one of the paths tests/run.sh find_python() probes, so
# putting it here means ./tests/run.sh unit just works with no env vars.
#
# PINNED to match proxy/vm/install.sh. The addon is the entire secrets
# boundary and mitmproxy answers an addon exception by forwarding the request
# unmodified -- so testing against a different version than production runs is
# how a silently-disabled substitution path gets shipped.
MITMPROXY_VERSION=11.0.2
if [ ! -x /opt/mitmtest/bin/python ]; then
    # Create the DIRECTORY with sudo, then build the venv as the normal user.
    # `sudo python3` would resolve through root's secure_path to the system
    # interpreter rather than the one the python feature put on our PATH.
    sudo install -d -o "$(id -u)" -g "$(id -g)" /opt/mitmtest
    python3 -m venv /opt/mitmtest
fi
/opt/mitmtest/bin/pip install --quiet --upgrade pip
/opt/mitmtest/bin/pip install --quiet "mitmproxy==${MITMPROXY_VERSION}" pytest
/opt/mitmtest/bin/python -c 'import mitmproxy, pytest; print("    mitmproxy + pytest ok")'

echo "==> verify the suite can find everything"
# Report rather than fail: a fresh container should come up even if one of
# these is temporarily unreachable.
for c in node npm jq docker devcontainer shellcheck; do
    printf '    %-14s %s\n' "$c" "$(command -v "$c" 2>/dev/null || echo 'MISSING')"
done
printf '    %-14s %s\n' "mitm python" /opt/mitmtest/bin/python

cat <<'EOF'

Test tooling ready. Try:
    ./tests/run.sh            # static + unit, no daemon needed
    ./tests/run.sh static     # config invariants only
EOF
