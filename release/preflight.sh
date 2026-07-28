#!/usr/bin/env bash
# preflight.sh -- run on your Mac after `docker compose up -d --build`.
# Empirically checks every layer of the stack and the security invariants.
set -uo pipefail

pass=0; fail=0
ok()   { echo "  ok    $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
note() { echo "        $*"; }

echo
echo "== 1. containers =="
for c in desolate-dind desolate-orchestrator desolate-vscode; do
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null) || { bad "$c not found"; continue; }
  rc=$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null)
  if [ "$st" = running ] && [ "${rc:-0}" -lt 3 ]; then ok "$c running (restarts: $rc)"
  else bad "$c status=$st restarts=$rc"; note "docker compose logs --tail=40 ${c#desolate-}"; fi
done
h=$(docker inspect -f '{{.State.Health.Status}}' desolate-dind 2>/dev/null)
[ "$h" = healthy ] && ok "dind healthcheck: healthy" || bad "dind health=$h (wait, or check logs)"

echo
echo "== 1b. sysbox runtime (the core guarantee) =="
PRIV=$(docker inspect -f '{{.HostConfig.Privileged}}' desolate-dind 2>/dev/null)
RT=$(docker inspect -f '{{.HostConfig.Runtime}}' desolate-dind 2>/dev/null)
if [ "$RT" = "sysbox-runc" ] && [ "$PRIV" = "false" ]; then
  ok "dind runs UNPRIVILEGED under sysbox-runc"
else
  bad "dind runtime=$RT privileged=$PRIV -- expected sysbox-runc + unprivileged"
  note "the daemon must expose sysbox-runc; run: ./cli.sh vm install"
fi
# Confirm the containment maps as claimed: container-root -> unprivileged VM uid.
UIDMAP=$(docker exec desolate-dind cat /proc/self/uid_map 2>/dev/null | awk '{print $2}')
if [ -n "$UIDMAP" ] && [ "$UIDMAP" != "0" ]; then
  ok "dind user-namespace active (container uid0 -> VM uid $UIDMAP, not root)"
else
  bad "dind uid_map shows container-root == VM-root ($UIDMAP) -- NOT contained"
fi

echo
echo "== 2. privilege separation (editor must NOT hold the daemon) =="
if docker exec desolate-vscode docker info >/dev/null 2>&1; then
  bad "EDITOR CAN DRIVE THE INNER DAEMON -- privilege separation is broken"
  note "a malicious extension could mount any project's volumes; check that"
  note "docker-compose.yml gives vscode no inner-run mount and no DOCKER_HOST"
else
  ok "editor has no daemon access (broker-only)"
fi
if docker inspect desolate-vscode --format '{{range .Mounts}}{{.Name}} {{end}}' 2>/dev/null | grep -q inner-run; then
  bad "editor mounts inner-run -- the daemon socket is exposed to the editor"
else
  ok "editor does not mount the daemon socket volume"
fi
if docker exec desolate-orchestrator docker info >/dev/null 2>&1; then
  ok "orchestrator can drive the inner dockerd"
else
  bad "orchestrator cannot reach inner dockerd"; note "check DOCKER_HOST + dockerd --group=1000 vs uid"
fi
if docker exec desolate-vscode test -S /run/broker/desolate.sock 2>/dev/null; then
  ok "broker socket reachable from the editor"
else
  bad "broker socket missing -- 'desolate' in the editor will not work"
  note "docker logs desolate-orchestrator"
fi
nv=$(docker exec desolate-orchestrator node --version 2>/dev/null)
case "$nv" in v1[89]*|v2[0-9]*) ok "node $nv (devcontainer CLI needs >=18)";;
  *) bad "node '$nv' too old -- rebuild: docker compose build --no-cache vscode";; esac
dv=$(docker exec desolate-orchestrator devcontainer --version 2>/dev/null)
[ -n "$dv" ] && ok "devcontainer CLI $dv" || bad "devcontainer CLI broken"
docker exec desolate-vscode test -x /usr/local/bin/desolate \
  && ok "desolate (broker client) installed in editor" || bad "desolate client missing"
# The editor is where git happens: deploy keys are minted here and clones/pushes
# run here. ssh-keygen was missing from the image for a long time, so `repo add`
# died with a raw Node ENOENT trace -- a missing binary is invisible until the
# moment something shells out to it.
for t in git ssh-keygen ssh git-lfs git-subrepo; do
  docker exec desolate-vscode sh -c "command -v $t >/dev/null" \
    && ok "editor has $t" \
    || { bad "editor is missing $t"
         note "the vscode image installs git, openssh-client, git-lfs and git-subrepo"; }
done
docker exec desolate-orchestrator test -x /usr/local/bin/desolate-run \
  && ok "desolate-run installed in orchestrator" || bad "desolate-run missing"

echo
echo "== 3. shared server volume (powers desolate) =="
ec=$(docker inspect -f '{{.State.ExitCode}}' desolate-volume-init 2>/dev/null)
[ "$ec" = 0 ] && ok "volume-init completed (exit 0)" \
  || bad "volume-init exit=$ec -- docker logs desolate-volume-init"
if docker exec desolate-dind test -x /server-dist/bin/openvscode-server; then
  ok "server seeded and visible inside dind (devcontainers can mount it)"
else
  bad "server-dist not populated in dind"
  note "docker volume rm desolate_server-dist && docker compose up -d"
fi
docker exec desolate-vscode test -w /workspaces \
  && ok "/workspaces writable by editor user" \
  || bad "/workspaces not writable by uid 1000 -- volume-init chown failed?"
# Every devcontainer executes this binary from a SHARED mount, so anything that
# can write it can run code in every other project. Assert the live mount, not
# just the compose intent: `:ro` in config and a read-only mount at runtime are
# different claims, and only this one matters.
for c in desolate-dind desolate-orchestrator; do
  if docker exec "$c" sh -c 'touch /server-dist/.desolate-writetest 2>/dev/null' 2>/dev/null; then
    docker exec "$c" rm -f /server-dist/.desolate-writetest >/dev/null 2>&1
    bad "$c can WRITE /server-dist -- the shared editor server is poisonable"
    note "every devcontainer executes /vscode-server/bin/openvscode-server from here"
    note "docker-compose.yml must mount server-dist :ro for this service"
  else
    ok "$c holds /server-dist read-only"
  fi
done

echo
echo "== 4. the inner daemon is not on the network at all =="
# This section used to assert that a socket proxy on 127.0.0.1:2375 allowed GET
# and refused POST. That proxy is gone: its read-only guarantee constrained only
# this machine -- already the trust root, and able to drive the inner daemon via
# the orchestrator regardless -- while an unauthenticated HTTP port on loopback
# is reachable from a browser aimed at a hostile page. So the check inverted.
# The property now is that NOTHING answers there.
if curl -s --max-time 3 -o /dev/null http://127.0.0.1:2375/_ping 2>/dev/null; then
  bad "something is serving the docker API on 127.0.0.1:2375"
  note "the socket proxy was removed deliberately -- see docker-compose.yml"
  note "find it: docker ps --format '{{.Names}} {{.Ports}}' | grep 2375"
else
  ok "nothing answers the docker API on 127.0.0.1:2375"
fi
if docker ps --format '{{.Ports}}' | grep -q ':2375'; then
  bad "a container publishes 2375 to the host"
else
  ok "no container publishes the daemon API to the host"
fi
# The replacement path must actually work, or 'observe' is dead and people will
# reach for a published port again.
if docker exec desolate-orchestrator docker ps --format '{{.Names}}' >/dev/null 2>&1; then
  ok "inner-daemon visibility works through the orchestrator (./cli.sh observe)"
else
  bad "cannot list inner containers via the orchestrator -- ./cli.sh observe is broken"
fi

echo
echo "== 5. security invariants =="
if docker inspect desolate-vscode desolate-orchestrator 2>/dev/null \
     | grep -q '"Source": "/var/run/docker.sock"'; then
  bad "HOST docker socket is mounted somewhere -- this breaks the design"
else
  ok "host docker socket not mounted into the stack"
fi
if docker ps --format '{{.Ports}}' | grep -q "0.0.0.0:3000"; then
  bad "port 3000 published on 0.0.0.0 -- should be 127.0.0.1 only"
else ok "port 3000 not exposed beyond loopback"; fi
# The dind publish is what makes a relay reachable from the Mac; DESOLATE_PORT_*
# is what desolate.ts allocates relays from. compose feeds both from the same
# variables, so these agree unless a running container predates an .env edit --
# and the failure mode is silent: the relay starts, the URL just never answers.
PMIN=$(docker exec desolate-orchestrator printenv DESOLATE_PORT_MIN 2>/dev/null || echo 8080)
PMAX=$(docker exec desolate-orchestrator printenv DESOLATE_PORT_MAX 2>/dev/null || echo 8090)
PUB=" $(docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}' \
        desolate-dind 2>/dev/null) "
missing=""
for p in $(seq "${PMIN:-8080}" "${PMAX:-8090}"); do
  case "$PUB" in *" $p "*) ;; *) missing="$missing $p" ;; esac
done
if [ -z "$missing" ]; then
  ok "dind publishes every port desolate allocates from ($PMIN-$PMAX)"
else
  bad "desolate allocates from $PMIN-$PMAX but dind does not publish:$missing"
  note "relays on those ports bind inside dind and are unreachable from the Mac"
  note "recreate dind so it picks up the range: ./cli.sh up"
fi
if curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ 2>/dev/null | grep -qE '401|403'; then
  ok "editor rejects tokenless requests"
else
  note "editor returned a page without a token -- confirm VSCODE_TOKEN is set in .env"
fi

echo
echo "== 6. end-to-end: run a container on the inner daemon =="
# Split "cannot trust" from "cannot reach" BEFORE the pull. Every inner pull
# traverses mitmproxy, so an untrusted CA surfaces as an x509 error that never
# mentions CAs -- and dind installs the cert at entrypoint, with its output sent
# to /dev/null, so nothing else reports the failure either.
if docker exec desolate-dind test -f /usr/local/share/ca-certificates/desolate-proxy.crt 2>/dev/null; then
  ok "dind has the proxy CA in its trust store"
else
  bad "dind has NOT installed the proxy CA -- every image pull will fail with x509"
  note "docker exec -u 0 desolate-dind /desolate-ca/install-ca.sh   # now reports the real reason"
  note "then: docker restart desolate-dind"
fi

# This check used to discard the error entirely and print "network? disk?",
# which is a guess, not a diagnosis. Keep the output and classify it.
RUNOUT=$(docker exec desolate-orchestrator docker run --rm hello-world 2>&1); RC=$?
if [ "$RC" = 0 ]; then
  ok "inner dockerd can pull and run images"
else
  case "$RUNOUT" in
    *x509*|*"unknown authority"*|*"certificate is not trusted"*)
      bad "inner run failed: dind does not trust the proxy CA (x509)"
      note "docker exec -u 0 desolate-dind /desolate-ca/install-ca.sh; docker restart desolate-dind" ;;
    *"no such host"*|*"server misbehaving"*|*"Temporary failure in name resolution"*)
      bad "inner run failed: name resolution inside dind"
      note "desolate-dnsmasq on :5353 and the nftables dport-53 redirect are the path" ;;
    *"connection refused"*|*"i/o timeout"*|*"Client.Timeout"*|*"TLS handshake timeout"*)
      bad "inner run failed: no egress path from dind"
      note "./cli.sh proxy status ; ./cli.sh proxy logs" ;;
    *"rlimit"*)
      # RLIMIT_NOFILE is type 7. dind is user-namespaced by sysbox, so it cannot
      # raise a hard limit above what it inherited or above fs.nr_open -- asking
      # for more makes every container fail at creation, naming neither ulimits
      # nor sysbox.
      bad "inner run failed: the requested ulimit exceeds what sysbox allows dind to set"
      note "dind's ceiling: hard=$(docker exec desolate-dind sh -c 'ulimit -Hn' 2>/dev/null || echo '?') nr_open=$(docker exec desolate-dind cat /proc/sys/fs/nr_open 2>/dev/null || echo '?')"
      note "set DESOLATE_NOFILE in .env below that (default 65536), then ./cli.sh up" ;;
    *"no space left"*)
      bad "inner run failed: the VM is out of disk"
      note "colima ssh -p \${COLIMA_PROFILE:-desolate} -- df -h /var/lib/docker" ;;
    *)
      bad "inner run failed" ;;
  esac
  note "docker says: $(printf '%s\n' "$RUNOUT" | grep -v '^[[:space:]]*$' | tail -2 | tr '\n' ' ')"
fi

echo
echo "== 7. egress proxy (secrets never enter containers) =="
# This section used to sit AFTER an `exit`, so it never ran: the one check that
# tells you whether interception is actually on was dead code. Keep it last,
# keep it reachable.
if colima ssh -p "${COLIMA_PROFILE:-desolate}" -- systemctl is-active --quiet desolate-proxy 2>/dev/null; then
  ok "desolate-proxy is running in the VM"
  # Two resolvers, two ports, both required: :5353 serves containers via the
  # nftables redirect, :53 serves the VM itself (Colima has no systemd-resolved).
  # Conflating them is what once moved the system resolver off :53 and broke
  # every image pull the VM made.
  colima ssh -p "${COLIMA_PROFILE:-desolate}" -- systemctl is-active --quiet desolate-dnsmasq 2>/dev/null \
    && ok "desolate-dnsmasq is serving container DNS on :5353" \
    || bad "desolate-dnsmasq is not running -- containers cannot resolve anything"
  colima ssh -p "${COLIMA_PROFILE:-desolate}" -- getent hosts registry-1.docker.io >/dev/null 2>&1 \
    && ok "the VM itself still resolves (:53 intact)" \
    || bad "the VM cannot resolve hostnames -- check for a stray dnsmasq drop-in setting 'port='"
  PERM=$(colima ssh -p "${COLIMA_PROFILE:-desolate}" -- sudo stat -c '%a' /etc/desolate-proxy/settings.json 2>/dev/null)
  [ "$PERM" = "600" ] && ok "settings.json is 0600" \
    || bad "settings.json mode is '$PERM' (want 600) -- secret values may be readable"
  if docker exec desolate-orchestrator test -f /desolate-ca/ca.pem 2>/dev/null; then
    ok "proxy CA is mounted into the stack"
  else
    bad "CA missing at /desolate-ca/ca.pem -- TLS through the proxy will fail"
    note "did install.sh run? it creates /var/lib/desolate-proxy/public in the VM"
  fi
  # Interception check: a request from inside the stack should be MITM'd.
  #
  # `with-ca` is REQUIRED here, and its absence was a real false alarm. The
  # orchestrator trusts the proxy CA through that wrapper -- which exports
  # SSL_CERT_FILE/CURL_CA_BUNDLE and execs -- not through the system trust
  # store. `docker exec` starts a fresh process from the image config and
  # inherits none of the entrypoint's exports, so a bare curl here verifies
  # against a bundle that has never seen the mitmproxy CA. It then fails on
  # certificate verification, prints no "issuer:" line, and this check reports
  # "egress may be dead" while egress is perfectly healthy.
  CURLOUT=$(docker exec desolate-orchestrator with-ca sh -c \
        'curl -sv --max-time 8 https://example.com 2>&1' 2>/dev/null || true)
  ISS=$(printf '%s\n' "$CURLOUT" | grep -m1 -i "issuer:" || true)
  case "$ISS" in
    *mitmproxy*) ok "egress is intercepted (issuer: mitmproxy)" ;;
    "")          bad "no HTTPS response from inside the stack -- egress may be dead"
                 note "curl said: $(printf '%s\n' "$CURLOUT" \
                        | grep -m1 -iE 'curl: |SSL certificate|refused|timed out|Could not resolve' \
                        || echo '(no diagnostic line)')"
                 note "./cli.sh proxy status ; ./cli.sh proxy logs" ;;
    *)           bad "egress NOT intercepted -- traffic is bypassing the proxy"
                 note "issuer was: $ISS"
                 note "check DESOLATE_IF in the VM matches the compose bridge (re-run install.sh)" ;;
  esac
  # Interception being ON is not the same as the POLICY being on: an addon that
  # fails to load leaves a working transparent proxy that substitutes nothing.
  # Prove the policy runs by tripping it -- a placeholder toward a host it is
  # not allowlisted for must come back 403.
  # with-ca for the same reason as above; without it this returns 000 (curl could
  # not verify the cert) and reads as "the addon failed to load".
  LEAK=$(docker exec desolate-orchestrator with-ca sh -c \
         'curl -s -o /dev/null -w "%{http_code}" --max-time 8 https://example.com \
            -H "X-Exfil: DESOLATE-SELFTEST-PLACEHOLDER"' 2>/dev/null || true)
  case "$LEAK" in
    403) ok "leak detection is live (placeholder toward a non-allowlisted host -> 403)" ;;
    000) bad "leak detection got no response at all (000) -- TLS to the proxy failed"
         note "not necessarily the addon: check the interception line above first" ;;
    *)   bad "leak detection returned '$LEAK', expected 403 -- the addon may have failed to load" ;;
  esac
  # And that a secret cannot be coaxed out over plaintext, where the destination
  # cannot be proven (the Host-header spoofing path).
  SPOOF=$(docker exec desolate-orchestrator sh -c \
          'curl -s -o /dev/null -w "%{http_code}" --max-time 8 http://example.com \
             -H "Host: httpbin.org" -H "X-Exfil: DESOLATE-SELFTEST-PLACEHOLDER"' 2>/dev/null || true)
  [ "$SPOOF" = "403" ] && ok "plaintext secret egress refused (Host header cannot vouch for a destination)" \
    || bad "plaintext spoof returned '$SPOOF', expected 403 -- secrets can be exfiltrated"
else
  note "desolate-proxy not installed -- secrets substitution and egress control are OFF"
  note "install it: ./cli.sh vm install"
fi

echo
echo "-- $pass passed, $fail failed --"
[ "$fail" -eq 0 ] && echo "Stack looks good. Next: ./cli.sh desolate example-project" || \
  echo "Fix the FAIL lines above; see Troubleshooting in README.md"
exit $((fail > 0))
