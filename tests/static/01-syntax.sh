#!/usr/bin/env bash
# Syntax + reachability checks. Cheap, and they catch the class of bug where a
# whole section of a script never runs.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"

group "shell syntax"
while IFS= read -r f; do
  assert_ok "bash -n ${f#"$ROOT/"}" bash -n "$f"
done < <(find "$ROOT" -name '*.sh' -not -path '*/node_modules/*' -not -path '*/.git/*' | sort)

group "python syntax"
if command -v python3 >/dev/null; then
  assert_ok "py_compile proxy/vm/addon.py" python3 -m py_compile "$RELEASE/proxy/vm/addon.py"
else
  skip "python syntax" "python3 not installed"
fi

group "typescript parses"
if node -e 'process.exit(process.versions.node.split(".").map(Number)[0] >= 22 ? 0 : 1)' 2>/dev/null; then
  for f in policy.ts broker.ts snapshot.ts desolate.ts desolate-client.ts newrepo.ts; do
    # --check parses and strips types without executing.
    assert_ok "node --check vscode-image/$f" node --check "$RELEASE/vscode-image/$f"
  done
else
  skip "typescript parses" "node >= 22 required for native type stripping"
fi

group "every static suite can actually fail"
# 03-nftables.sh shipped without a `summary` call, and `summary` is what returns
# the failure: harness `fail` only counts, so a script that ends on an assertion
# exits with that assertion's status and the runner's `bash "$t" || rc=1` sees
# success. Every rule in that file -- the forward default-deny, the lateral
# drops, the ssh scoping -- was unable to turn the suite red for as long as that
# was true. A suite that cannot fail is worse than a missing one, because it
# reports as covered.
for t in "$ROOT"/tests/static/*.sh; do
  name="$(basename "$t") ends by calling summary"
  if [ "$(grep -c '^summary$' "$t")" -ge 1 ]; then
    LAST_CODE=$(grep -vE '^\s*(#.*)?$' "$t" | tail -1)
    assert_eq "$name" "$LAST_CODE" "summary"
  else
    fail "$name" "no top-level 'summary' -- failures in this file cannot fail the suite"
  fi
done

group "no unreachable code after a top-level exit"
# preflight.sh once had its entire egress-proxy section sitting after `exit`,
# so the single check that tells you whether interception is on never ran and
# nothing complained. Generic guard: a top-level `exit` must be the last
# statement in the file.
for f in "$RELEASE/preflight.sh" "$RELEASE/observe.sh" "$RELEASE/cli.sh"; do
  name="no code after top-level exit in ${f#"$ROOT/"}"
  last_exit=$(grep -n '^exit ' "$f" | tail -1 | cut -d: -f1)
  if [ -z "$last_exit" ]; then
    pass "$name"
  else
    trailing=$(tail -n "+$((last_exit + 1))" "$f" | grep -vE '^\s*(#.*)?$' | head -3)
    if [ -z "$trailing" ]; then pass "$name"
    else fail "$name" "unreachable after line $last_exit: $(printf '%s' "$trailing" | head -1)"; fi
  fi
done


group "CLI argument formats we hand to other tools"
# The devcontainer CLI validates --mount against exactly
#   type=<bind|volume>,source=<source>,target=<target>[,external=<true|false>]
# and rejects the ENTIRE invocation with "Unmatched argument format" on anything
# else -- a `readonly` key here once broke every `desolate <project>`, and only
# after the egress proxy was installed, because that mount is conditional on
# ca.pem existing. Nothing at build or unit level catches it: it is a string
# assembled at runtime and validated by a different process.
# Matched on the SPEC itself, not on proximity to the "--mount" token: the call
# was once reformatted onto two lines and this grep then matched nothing, which
# the empty-guard below caught. Anchor on the thing being asserted.
MOUNT_SPECS=$(grep -oE '`type=[a-z]+,[^`]+`' "$RELEASE/vscode-image/desolate.ts" | tr -d '`')
if [ -z "$MOUNT_SPECS" ]; then
  fail "found the --mount specs in desolate.ts" "grep matched nothing -- did the call shape change?"
else
  while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    # Drop ${...} interpolations; only the KEYS matter for this grammar.
    keys=$(printf '%s' "$spec" | sed 's/\${[^}]*}/X/g' | tr ',' '\n' | sed 's/=.*//' | paste -sd, -)
    case "$keys" in
      type,source,target|type,source,target,external)
        pass "devcontainer --mount spec is well-formed ($keys)" ;;
      *)
        fail "devcontainer --mount spec is well-formed" \
             "keys '$keys' -- the CLI accepts only type,source,target[,external]" ;;
    esac
  done <<< "$MOUNT_SPECS"
fi

group "shared directories are never bind-mounted into a devcontainer"
# It is EXECUTED by every project. A bind of the shared /server-dist -- even a
# read-only one -- is poisonable: MS_RDONLY is per-mount, and a privileged
# devcontainer holds CAP_SYS_ADMIN in dind's userns and can remount it rw. Each
# project must get an overlay volume whose lower cannot be written through.
if grep -qE '"--mount",[^)]*type=bind,source=\$\{(SERVER_SRC|CA_DIR)\}' "$RELEASE/vscode-image/desolate.ts"; then
  fail "injected mounts are volumes, not binds" \
       "found a type=bind of a SHARED dir -- that is the poisonable shape"
else
  pass "injected mounts are volumes, not binds"
fi
# WHICH directories get an overlay, what the volumes are named, and whether the
# policy accepts them are assertions about values, so they live in
# tests/unit/desolate/overlay.test.ts and run against the real module.
#
# They were greps for identifier names here until one of them ("ensureOverlayVolume")
# went on passing for a whole refactor against nothing but a stale comment. A grep
# cannot tell a definition from a mention, so it reports "still covered" long after
# the thing it named is gone. Only the bind-vs-volume shape stays here, because that
# one is about a string this file assembles and hands to another process.
assert_ok "the overlay invariants are asserted against the module, not this grep" \
  test -f "$ROOT/tests/unit/desolate/overlay.test.ts"

group "every entry point carries proxy-CA trust"
# with-ca grants trust by EXPORTING env vars and exec'ing, and `docker exec`
# inherits nothing the entrypoint exported. A wrapper that skips it therefore
# works from the broker (which inherits the entrypoint's env) and fails from the
# Mac (`cli.sh desolate` -> docker exec), with an "unable to verify the first
# certificate" from whatever it spawns. Same root cause has now hit preflight,
# `cli.sh proxy test`, and `desolate` itself.
WRAPPERS=$(grep -oE "printf '#!/bin/sh[^']*' > /usr/local/bin/[a-z-]+" "$RELEASE/vscode-image/Dockerfile")
if [ -z "$WRAPPERS" ]; then
  fail "found the wrapper definitions in the Dockerfile" "grep matched nothing -- did they move?"
else
  while IFS= read -r w; do
    [ -n "$w" ] || continue
    name=${w##*/}
    case "$w" in
      *with-ca*) pass "$name routes through with-ca" ;;
      *) fail "$name routes through with-ca" \
              "bare exec -- works under the entrypoint, breaks under 'docker exec'" ;;
    esac
  done <<< "$WRAPPERS"
fi

# cli.sh is the other family of entry points: every `docker exec` into the
# editor is a fresh process with none of the entrypoint's exports. Commands run
# there speak TLS (git-lfs, git-subrepo, curl, pip), so they need with-ca too --
# otherwise the same command works in the browser terminal, which IS a child of
# the entrypoint, and fails from the Mac.
while IFS= read -r line; do
  [ -n "$line" ] || continue
  case "$line" in
    *with-ca*)     pass "cli.sh exec into the editor uses with-ca" ;;
    *newrepo*|*desolate-run*) pass "cli.sh exec runs a self-wrapping command" ;;
    *)             fail "cli.sh exec into the editor uses with-ca" \
                        "bare exec: ${line#*exec }" ;;
  esac
done <<< "$(grep -E 'docker exec .*(\$CONTAINER|\$ORCHESTRATOR)' "$RELEASE/cli.sh" | grep -v '^\s*#')"

group "every command the TypeScript shells out to is in the image"
# `newrepo` called ssh-keygen, which the image never installed -- so per-repo
# deploy keys, cloning and pushing had never worked, and the failure was a raw
# Node ENOENT stack trace. Nothing caught it: the call is a runtime spawn, and
# the missing package is in a different file entirely.
#
# The table maps each command to the thing that must provide it. An unknown
# command fails rather than being assumed fine -- that is the forcing function.
declare -A PROVIDER=(
  [devcontainer]="@devcontainers/cli"   # npm global
  [docker]="docker-\${DOCKER_VERSION}"  # static tarball
  [git]="git"                           # apt
  [ssh-keygen]="openssh-client"         # apt -- also provides ssh, for git's transport
  [ssh-agent]="openssh-client"          # apt -- the keyring IS an ssh-agent
  [ssh-add]="openssh-client"            # apt -- loads keys into that agent
  [sleep]="SKIP"                        # coreutils, in every base image
  [tsx]="tsx"                           # npm global
)
# COMMENTS STRIPPED. Matching the whole file passed even with openssh-client
# removed from the install line, because the comment explaining why it is needed
# still mentioned it -- a guard that its own documentation satisfies.
DOCKERFILE=$(grep -v '^[[:space:]]*#' "$RELEASE/vscode-image/Dockerfile")
# FLATTENED FIRST. A formatter puts the command on its own line --
#   execFileSync(
#     "ssh-keygen",
# -- and a line-oriented grep then sees no call at all. That is not a
# hypothetical: ssh-keygen is the exact command this check was written for, and
# it, `tsx` and `devcontainer` had all drifted out of the match while the table
# below still listed them, so the guard reported full coverage of three
# commands it was no longer looking at.
CMDS=$(cat "$RELEASE"/vscode-image/*.ts | tr '\n' ' ' \
       | grep -oE '\b(execFileSync|spawn|run|run\.status)\(\s*"[a-z0-9-]+"' \
       | sed -E 's/.*"([a-z0-9-]+)"/\1/' | sort -u)
# An empty match means the call shape moved again, which must be loud: this
# whole group silently asserts nothing when the extraction finds no commands.
[ -n "$CMDS" ] || fail "found the shell-outs in vscode-image/*.ts" \
  "the extraction matched nothing -- did the call shape change?"
while IFS= read -r cmd; do
  [ -n "$cmd" ] || continue
  want=${PROVIDER[$cmd]:-}
  if [ -z "$want" ]; then
    fail "'$cmd' has a known provider" \
         "not in the table -- add it, and make sure the Dockerfile installs it"
  elif [ "$want" = "SKIP" ]; then
    pass "'$cmd' needs no package (base image)"
  else
    case "$DOCKERFILE" in
      *"$want"*) pass "'$cmd' is provided by '$want'" ;;
      *) fail "'$cmd' is provided by '$want'" "the Dockerfile does not mention '$want'" ;;
    esac
  fi
done <<< "$CMDS"

# And the inverse. A table entry nothing matched means either the command left
# the code -- fine, delete the row -- or the extraction above stopped seeing it,
# which is how this guard came to be checking five commands while claiming
# eight. Either way it is a row that no longer asserts anything.
for cmd in "${!PROVIDER[@]}"; do
  case $'\n'"$CMDS"$'\n' in
    *$'\n'"$cmd"$'\n'*) ;;
    *) fail "'$cmd' is still shelled out to" \
            "in the table but found in no call -- remove the row, or fix the extraction" ;;
  esac
done

summary
