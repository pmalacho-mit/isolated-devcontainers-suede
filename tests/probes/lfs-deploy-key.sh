#!/usr/bin/env bash
# PROBE -- not a test. Answers a capability question so a design decision can
# be made; it asserts no invariant and gates nothing.
#
# QUESTION (Git LFS through desolate's push and pull): does GitHub let a
# repository's DEPLOY KEY, over SSH, authenticate Git LFS downloads and
# uploads for that repository -- and refuse it for any other?
#
#   ./tests/probes/lfs-deploy-key.sh <owner/repo>
#
# The design it decides: the editor's cache moves a project's LFS objects with
# the deploy key it already pushes with -- `git-lfs-authenticate` over the
# repository's ssh alias, then GitHub's LFS batch API over HTTPS -- verifying
# each object against its sha256 id. If GitHub refuses deploy keys for LFS,
# the design needs another credential, and that is a different conversation.
#
# Use a SCRATCH, PRIVATE repository, added with `./cli.sh repo add` (so the
# keyring holds its write deploy key). Private, because a public repository
# serves LFS downloads to anyone, which would answer Q4 without the key. It
# uploads ONE small object (about 60 bytes) to that repository's LFS storage,
# which GitHub deletes only with the repository -- so delete it afterwards. It
# pushes no commit and no branch.
#
#   gh repo create <you>/desolate-lfs-probe --private --add-readme
#   ./cli.sh repo add <you>/desolate-lfs-probe
#   ./tests/probes/lfs-deploy-key.sh <you>/desolate-lfs-probe
#   gh repo delete <you>/desolate-lfs-probe --yes
#
#   C0  CONTROL   the key reaches the repository at all (git ls-remote over
#                 the alias) -- without it, every no below means nothing
#   Q1  DOWNLOAD  git-lfs-authenticate <repo> download answers with an href
#   Q2  UPLOAD    git-lfs-authenticate <repo> upload answers with an href
#   C1  CONTROL   the same key, asking to upload to octocat/Hello-World, is
#                 refused -- or the yeses above say nothing about the key
#   Q3  PUT       an object goes up: batch upload, the upload, its verify
#   Q4  GET       the same object comes back, by the download auth, and its
#                 sha256 is its id
#   Q5  (info)    whether GitHub speaks pure-SSH LFS (git-lfs-transfer)
#
# Runs in the outer editor, where the keyring's agent socket is, with the ssh
# config transfer.ts writes per use. No token is printed: what is shown is
# status codes, hosts and GitHub's own messages.
set -uo pipefail
REPO=${1:?usage: lfs-deploy-key.sh <owner/repo>  -- a scratch PRIVATE repository, added with ./cli.sh repo add}
printf '%s' "$REPO" | grep -Eqx '[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*' \
  || { echo "probe: '$REPO' is not owner/repo" >&2; exit 2; }
[ "$(docker inspect -f '{{.State.Running}}' desolate-vscode 2>/dev/null)" = true ] \
  || { echo "probe: desolate-vscode is not running -- ./cli.sh up first" >&2; exit 2; }

docker exec -i desolate-vscode with-ca bash -s -- "$REPO" <<'INNER'
set -uo pipefail
REPO=$1 TAG=${1/\//__}
PUB=/run/keyring/pub/$TAG.pub
[ -f "$PUB" ] || { echo "probe: the keyring has no deploy key for $REPO -- ./cli.sh repo add $REPO first"; exit 2; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
# As transfer.ts sshFor writes it.
cat > "$W/ssh_config" <<EOF
Host github.com-$TAG
  HostName github.com
  User git
  IdentityFile $PUB
  IdentitiesOnly yes
  UserKnownHostsFile /etc/desolate/github_known_hosts
  GlobalKnownHostsFile /dev/null
  StrictHostKeyChecking yes
EOF
SSH=(ssh -F "$W/ssh_config" -o BatchMode=yes -o ConnectTimeout=15 "git@github.com-$TAG")
declare -A A

# A field of a JSON document on stdin ("a.b.0.c"), or nothing.
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],JSON.parse(s));process.stdout.write(v==null?"":typeof v=="string"?v:JSON.stringify(v))}catch{}})' "$1"; }
# An object of headers ({"Authorization": ...}) as curl arguments, one per line.
header_args() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const [k,v] of Object.entries(JSON.parse(s)||{}))process.stdout.write("-H\n"+k+": "+v+"\n")}catch{}})'; }
host_of() { printf '%s' "$1" | sed -E 's|^https?://([^/]+).*|\1|'; }
said() { tr -d '\r' < "$1" | grep -v '^\s*$' | head -2 | sed 's/^/      /'; }

echo "== C0 the deploy key reaches $REPO"
if GIT_SSH_COMMAND="ssh -F $W/ssh_config -o BatchMode=yes" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
     git -c core.hooksPath=/dev/null ls-remote "git@github.com-$TAG:$REPO.git" HEAD >"$W/c0" 2>&1; then
  A[C0]=yes; echo "   yes"
else
  A[C0]=no; echo "   NO -- nothing below can be read as an answer"; said "$W/c0"
fi

lfs_auth() {   # <repo> <operation> -> JSON on stdout
  "${SSH[@]}" git-lfs-authenticate "$1" "$2" </dev/null 2>"$W/auth-err"
}
for op in download upload; do
  q=$([ $op = download ] && echo Q1 || echo Q2)
  echo "== $q git-lfs-authenticate $REPO $op"
  lfs_auth "$REPO" "$op" > "$W/auth-$op"
  href=$(field href < "$W/auth-$op")
  if [ -n "$href" ]; then
    A[$q]=yes; echo "   yes: an href at $(host_of "$href"), expires in $(field expires_in < "$W/auth-$op")s"
  else
    A[$q]=no; echo "   NO"; said "$W/auth-err"
  fi
done

echo "== C1 the same key, asking to upload to octocat/Hello-World"
lfs_auth octocat/Hello-World upload > "$W/auth-other"
if [ -n "$(field href < "$W/auth-other")" ]; then
  A[C1]=NOT-REFUSED; echo "   NOT refused -- so Q1/Q2 say nothing about this key"
else
  A[C1]=refused; echo "   refused, as it should be:"; said "$W/auth-err"
fi

# One object: content, its sha256 id, its size.
printf 'desolate-lfs-probe %s %s\n' "$(date -u +%FT%TZ)" "$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$W/object"
OID=$(sha256sum "$W/object" | cut -d' ' -f1) SIZE=$(wc -c < "$W/object" | tr -d ' ')
batch() {   # <auth json file> <operation> -> the batch response on stdout, its status in $W/status
  local href; href=$(field href < "$1")
  mapfile -t H < <(field header < "$1" | header_args)
  curl -sS --max-time 30 -o "$W/batch" -w '%{http_code}' -X POST "$href/objects/batch" \
    -H "Accept: application/vnd.git-lfs+json" -H "Content-Type: application/vnd.git-lfs+json" "${H[@]}" \
    -d "{\"operation\":\"$2\",\"transfers\":[\"basic\"],\"objects\":[{\"oid\":\"$OID\",\"size\":$SIZE}]}" > "$W/status" 2>"$W/curl-err"
  cat "$W/batch"
}

echo "== Q3 an object goes up ($SIZE bytes, oid ${OID:0:12}...)"
A[Q3]=no
if [ "${A[Q2]}" = yes ]; then
  batch "$W/auth-upload" upload > "$W/up"
  echo "   batch: HTTP $(cat "$W/status")"
  err=$(field objects.0.error.message < "$W/up")
  [ -n "$err" ] && echo "   the object's error: $err"
  [ -z "$err" ] && [ -n "$(field message < "$W/up")" ] && echo "   GitHub said: $(field message < "$W/up")"
  put=$(field objects.0.actions.upload.href < "$W/up")
  if [ -n "$put" ]; then
    mapfile -t H < <(field objects.0.actions.upload.header < "$W/up" | header_args)
    code=$(curl -sS --max-time 60 -o "$W/put-body" -w '%{http_code}' -X PUT "$put" "${H[@]}" \
             -H "Content-Type: application/octet-stream" --data-binary @"$W/object" 2>"$W/curl-err")
    echo "   upload to $(host_of "$put"): HTTP $code"
    ok=$([ "${code:0:1}" = 2 ] && echo yes || echo no)
    verify=$(field objects.0.actions.verify.href < "$W/up")
    if [ "$ok" = yes ] && [ -n "$verify" ]; then
      mapfile -t H < <(field objects.0.actions.verify.header < "$W/up" | header_args)
      code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -X POST "$verify" "${H[@]}" \
               -H "Content-Type: application/vnd.git-lfs+json" -d "{\"oid\":\"$OID\",\"size\":$SIZE}" 2>"$W/curl-err")
      echo "   verify at $(host_of "$verify"): HTTP $code"
      ok=$([ "${code:0:1}" = 2 ] && echo yes || echo no)
    fi
    A[Q3]=$ok
  elif [ "$(cat "$W/status")" = 200 ] && [ -z "$err" ]; then
    echo "   (no upload action: GitHub has this object already)"; A[Q3]=yes
  fi
else
  echo "   skipped: no upload auth (Q2)"
fi

echo "== Q4 the same object comes back"
A[Q4]=no
if [ "${A[Q1]}" = yes ] && [ "${A[Q3]}" = yes ]; then
  batch "$W/auth-download" download > "$W/down"
  echo "   batch: HTTP $(cat "$W/status")"
  get=$(field objects.0.actions.download.href < "$W/down")
  err=$(field objects.0.error.message < "$W/down")
  [ -n "$err" ] && echo "   the object's error: $err"
  if [ -n "$get" ]; then
    mapfile -t H < <(field objects.0.actions.download.header < "$W/down" | header_args)
    code=$(curl -sS --max-time 60 -o "$W/fetched" -w '%{http_code}' "$get" "${H[@]}" 2>"$W/curl-err")
    got=$(sha256sum "$W/fetched" | cut -d' ' -f1)
    echo "   download from $(host_of "$get"): HTTP $code, sha256 ${got:0:12}..."
    [ "$got" = "$OID" ] && A[Q4]=yes || echo "   the bytes are not the object"
  fi
else
  echo "   skipped: needs Q1 and Q3"
fi

echo "== Q5 (info) pure-SSH LFS"
timeout 20 "${SSH[@]}" git-lfs-transfer "$REPO" download </dev/null >"$W/q5" 2>&1; rc=$?
echo "   exit $rc:"; said "$W/q5"

echo
echo "ANSWERS (paste these back)"
for k in C0 Q1 Q2 C1 Q3 Q4; do echo "  $k ${A[$k]:-?}"; done
echo "  Q5 exit $rc"
INNER
