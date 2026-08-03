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
if docker exec desolate-dind test -x /server-dist/bin/codium-server; then
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
    note "every devcontainer executes /vscode-server/bin/codium-server from here"
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
# Ask the RUNNING container where the editor is published, rather than assuming
# 3000: VSCODE_PORT moves it, and a container that predates an .env edit is still
# on the old port -- which is exactly the case a check reading .env would miss.
VSPORT=$(docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}}{{end}}{{end}}' \
         desolate-vscode 2>/dev/null)
VSIPS=$(docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostIp}} {{end}}{{end}}' \
        desolate-vscode 2>/dev/null)
if [ -z "$VSPORT" ]; then
  note "editor container not running -- skipping its port checks"
else
  # Check the bind ADDRESS, not the number. The old test grepped every container's
  # ports for the literal "0.0.0.0:3000", so it silently stopped covering anything
  # the moment the port moved -- and missed other non-loopback binds entirely.
  BADIP=""
  for ip in $VSIPS; do
    [ "$ip" = "127.0.0.1" ] || BADIP="$BADIP $ip"
  done
  if [ -n "$BADIP" ]; then
    bad "editor published on non-loopback address(es):$BADIP -- should be 127.0.0.1 only"
  else
    ok "editor (port $VSPORT) not exposed beyond loopback"
  fi
fi
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
if [ -z "$VSPORT" ]; then
  note "editor container not running -- skipping the token-gate check"
elif curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$VSPORT/" 2>/dev/null | grep -qE '401|403'; then
  ok "editor rejects tokenless requests"
else
  note "editor returned a page without a token -- confirm VSCODE_TOKEN is set in .env"
fi

echo
echo "== 5b. lateral containment (devcontainers must not reach the editor) =="
# The editor container holds the git deploy keys, so the property that matters
# most to a project is that it cannot address the editor at all. Devcontainers
# live inside dind and egress through dind's bridge address, so dind is the
# right place to stand for this probe -- it is strictly more capable than
# anything running inside it, and a refusal here is a refusal for all of them.
VSNET=$(docker inspect -f '{{range $n, $c := .NetworkSettings.Networks}}{{$n}} {{end}}' \
        desolate-vscode 2>/dev/null)
DINDNET=$(docker inspect -f '{{range $n, $c := .NetworkSettings.Networks}}{{$n}} {{end}}' \
          desolate-dind 2>/dev/null)
SHARED=""
for n in $DINDNET; do
  case " $VSNET " in *" $n "*) SHARED="$SHARED $n" ;; esac
done
if [ -n "$SHARED" ]; then
  bad "dind shares network(s)$SHARED with the editor"
  note "they must be on separate bridges (devnet / dindnet in docker-compose.yml)"
  note "a shared bridge makes the traffic BRIDGED, and the nftables forward chain"
  note "then only sees it while br_netfilter happens to be on -- an invisible wall"
  note "fix: ./cli.sh down && ./cli.sh up, then re-run 'sudo ./install.sh' in the VM"
else
  ok "dind and the editor are on separate networks"
fi

VSIP=$(docker inspect -f '{{range $n, $c := .NetworkSettings.Networks}}{{$c.IPAddress}} {{end}}' \
       desolate-vscode 2>/dev/null)
if [ -z "$VSIP" ]; then
  note "editor container not running -- skipping the reachability probe"
elif ! docker exec desolate-dind sh -c 'command -v wget >/dev/null' 2>/dev/null; then
  note "no wget inside dind -- skipping the reachability probe"
else
  REACHED=""
  for ip in $VSIP; do
    # -S so the status line lands in the output: the editor answers a tokenless
    # request with 401/403, and either is still REACHED. Only the absence of any
    # HTTP reply means the packet did not arrive.
    OUT=$(docker exec desolate-dind sh -c \
          "wget -T 4 -q -S -O /dev/null http://$ip:3000/ 2>&1 || true" 2>/dev/null)
    case "$OUT" in *HTTP/*) REACHED="$REACHED $ip" ;; esac
  done
  if [ -n "$REACHED" ]; then
    bad "the container world CAN reach the editor at$REACHED:3000"
    note "the ssh deploy keys live in that container; this is the escape that matters"
    note "check: colima ssh -p ${COLIMA_PROFILE:-desolate} -- sudo nft list table inet desolate"
    note "the forward chain must drop between the two bridges BEFORE its ct-state accept"
  else
    ok "the container world cannot reach the editor on :3000"
  fi
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
      # nor sysbox. This host's ceiling is below the value compose asks for.
      bad "inner run failed: the requested ulimit exceeds what sysbox allows dind to set"
      note "dind's ceiling: hard=$(docker exec desolate-dind sh -c 'ulimit -Hn' 2>/dev/null || echo '?') nr_open=$(docker exec desolate-dind cat /proc/sys/fs/nr_open 2>/dev/null || echo '?')"
      note "lower --default-ulimit=nofile and the dind ulimits in docker-compose.yml (65536:524288) below that, then ./cli.sh up" ;;
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
  # The proxy is the one process standing on both sides of the wall: nftables
  # redirects every :80/:443 here whatever the destination, and this then dials
  # it from the VM, where the container-bridge drops no longer apply. Without an
  # address check that makes it a confused deputy for the Mac and the LAN.
  #
  # What this probe can and cannot conclude, because one ambiguous result is how
  # a check ends up asserting nothing:
  #
  #   - a 403 is addon.py refusing the address, which is the intended path;
  #   - but it is NOT guaranteed, and demanding it was a false alarm on every
  #     Mac with nothing listening on :80. `connection_strategy=eager` is pinned
  #     in desolate-proxy.service, deliberately (tests/static/06-proxy-service.sh
  #     says why), and eager dials the ORIGINAL DESTINATION before the request
  #     hook runs. An internal address that does not accept the connection
  #     therefore dies at that dial and addon.py never sees the request: 502 if
  #     the connect was refused, no reply at all if the packet was dropped.
  #     Contained -- by a different layer than the one being named.
  #
  # So what is asserted is REACHING it, not which layer stopped it. addon.py's
  # own refusal is covered by tests/unit/proxy (the E10 family), and
  # tests/integration/stack reads the same result the same way.
  #
  # The plaintext-spoof probe above is the precondition: it got a 403 out of the
  # addon over :80, so a no-reply here is about the destination rather than a
  # dead redirect. Without that, "no reply" would pass for the wrong reason
  # forever.
  INTERNAL=$(docker exec desolate-orchestrator sh -c \
             'curl -s -o /dev/null -w "%{http_code}" --max-time 8 http://192.168.5.2/' \
             2>/dev/null || true)
  case "$INTERNAL" in
    403)   ok "the proxy refuses internal destinations (403 from addon.py)" ;;
    502)   ok "internal destination unreachable (502: the proxy dialled it and could not connect)" ;;
    000|"")
           if [ "$SPOOF" = "403" ]; then
             ok "internal destination unreachable (no reply: the dial went nowhere)"
           else
             bad "no answer for the internal-destination probe, and :80 did not reach"
             note "the addon either (the spoof probe above returned '$SPOOF'), so this"
             note "says nothing about containment -- fix the redirect first."
             note "./cli.sh proxy status ; ./cli.sh proxy logs"
           fi ;;
    # Anything else is an ANSWER, and an answer means the stack reached
    # 192.168.5.2. Not just 2xx: a 401 from a router's admin page or a 404 from
    # a service on the Mac is the same reach wearing a different number, so the
    # two proxy-generated codes above are named and everything else fails.
    *)     bad "an internal destination ANSWERED ('$INTERNAL') -- the stack reached"
           note "192.168.5.2 through the proxy. addon.py must refuse private,"
           note "loopback and link-local destination ADDRESSES before consulting"
           note "the network policy, which matches on names only." ;;
  esac
  # The OUTER layer, and the one the probe above cannot distinguish from a
  # closed port. addon.py's refusal is inner and has three ways of being absent
  # (eager dials first, tls_passthrough skips the hook, a broken addon enforces
  # nothing); the kernel has none of them. So assert the chain is actually
  # loaded rather than inferring it from a timeout.
  NFT_OUT=$(colima ssh -p "${COLIMA_PROFILE:-desolate}" -- \
            sudo nft list chain inet desolate output 2>/dev/null || true)
  case "$NFT_OUT" in
    *DESOLATE_INTERNAL4*|*"daddr { 0.0.0.0/8"*|*"10.0.0.0/8"*)
      ok "the proxy's own egress is bounded in the kernel (output chain loaded)"
      # Which layer stopped the probe above. Zero is not a fault -- it means
      # addon.py or a refused connection got there first -- but a nonzero
      # count is the only place an attempt to reach the Mac or LAN is visible.
      if printf '%s' "$NFT_OUT" | grep -qE 'packets [1-9]'; then
        note "the kernel drop is what stopped it (counters moved)"
      else
        note "kernel drop counters read zero: addon.py or a closed port answered first"
      fi ;;
    "") note "could not read the output chain (colima ssh unavailable?) -- skipped" ;;
    *)  bad "the proxy's egress chain is loaded but carries no internal-address drop"
        note "nftables-desolate.conf must drop DESOLATE_INTERNAL4/6 for skuid"
        note "desolate-proxy, or the proxy is a route to the Mac and the LAN"
        note "for anything that can reach :80/:443 -- which is every container." ;;
  esac
else
  note "desolate-proxy not installed -- secrets substitution and egress control are OFF"
  note "install it: ./cli.sh vm install"
fi

echo
echo "-- $pass passed, $fail failed --"
[ "$fail" -eq 0 ] && echo "Stack looks good. Next: ./cli.sh desolate example-project" || \
  echo "Fix the FAIL lines above; see Troubleshooting in README.md"
exit $((fail > 0))
