"""desolate v3: the part of a domain's egress that holds its secrets (section 4.3, Phase 4).

One mitmproxy per domain that has secrets, in the root VM, on the root's loopback. It is
reached only by that domain's workspaces' own proxies (proxy.ts), and only for connections
to a host one of the domain's secrets names. Everything else a workspace sends stays
end-to-end TLS and never comes here.

A workspace never holds a secret's value. It holds the secret's NAME, a placeholder
(MYAPP-OPENAI-KEY), and sends that. This swaps the name for the value on the way out, when
and only when the request is provably going where the secret is allowed to go. The rules
are v2's (carryover/proxy/addon.py, which this is cut down from; its tests' cases are
tests/v3/t2/07-secrets.test.ts here):

  PROVEN DESTINATION  the TLS SNI, and only the SNI: it is the name mitmproxy validates the
                      upstream certificate against. proxy.ts hands over each connection
                      with the name it checked (x-desolate-host) and the address it
                      resolved and checked; the SNI must be that name, and the upstream is
                      that address. Nothing is resolved a second time here.
  NO PROOF, NO VALUE  plaintext, a Host header that is not the SNI, or two Host headers,
                      while carrying a placeholder: refused.
  ALLOWLIST           a placeholder sent toward a host its secret does not name is passed
                      through UNSUBSTITUTED (the destination learns a name, not a value),
                      and audited.
  HEADERS             a secret with `headers` is substituted in those request headers and
                      nowhere else; without, in the path, the headers and the body.
  SWITCHED OFF        a secret can be switched off, or on for a while (`off`, `until`). A
                      request that carries the name of a secret that is off is refused: the
                      name is not sent in the value's place. A switch that cannot be read
                      is off.
  SCRUB               a value echoed back in a response (headers, body, websocket frames
                      from the server) is replaced by its name before the workspace sees it.
  FAIL CLOSED         any error in here refuses the request or withholds the response.

Attribution: which workspace a request came from is what proxy.ts says (x-desolate-workspace
on the CONNECT it makes), never anything the workspace says: a workspace's own bytes start
inside the tunnel.
"""
import fnmatch
import ipaddress
import json
import logging
import os
import re
import time

from mitmproxy import http

log = logging.getLogger("desolate-secrets")

SETTINGS_PATH = os.environ.get("DESOLATE_SECRETS", "/var/lib/desolate/secrets/unset.json")
POLICY_PATH = os.environ.get("DESOLATE_POLICY", "/var/lib/desolate/proxy/policy/unset.json")
AUDIT_PATH = os.environ.get("DESOLATE_AUDIT", "/var/lib/desolate/proxy/audit.log")

SECRET_NAME = re.compile(r"[A-Z][A-Z0-9_-]{7,63}")
HEADER_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*")
GLOB_META = re.compile(r"[*?\[\]]")
# The one wildcard shape that pins a destination: a leading "*." over at least two labels.
PINNED_WILDCARD = re.compile(r"\*\.(?:[^*?\[\]./]+\.)+[^*?\[\]./]+\Z")


def host_pattern_problem(pattern):
    """Why this `hosts` entry cannot pin a destination, or None if it can. (v2, unchanged.)"""
    if not isinstance(pattern, str) or not pattern.strip():
        return "is empty"
    if not GLOB_META.search(pattern):
        return None                      # a literal name pins itself
    if PINNED_WILDCARD.fullmatch(pattern):
        return None
    if not GLOB_META.sub("", pattern).strip("."):
        return "matches every host, so this secret would have no allowlist at all"
    return "puts a wildcard somewhere it cannot be trusted: only '*.<name>.<tld>' is accepted"


class DesolateSecrets:
    def __init__(self):
        self.secrets = {}
        self.internal = set()
        self.domain = ""
        self._mtime = None
        self._policy_mtime = None
        # client connection id -> what proxy.ts said when it opened the tunnel
        self.tunnels = {}

    # ---------------------------------------------------------------- settings
    def _maybe_reload(self):
        try:
            mtime = os.stat(SETTINGS_PATH).st_mtime_ns
        except OSError:
            if self.secrets:
                log.error("the secrets file is gone; holding no secrets")
            self.secrets, self._mtime = {}, None
            return
        if mtime != self._mtime:
            try:
                with open(SETTINGS_PATH) as handle:
                    cfg = json.load(handle)
            except (OSError, ValueError) as error:
                # A file that cannot be read is not the last good file: no secrets.
                log.error(f"cannot read {SETTINGS_PATH}: {error}; holding no secrets")
                self.secrets, self._mtime = {}, mtime
                return
            self.domain = str(cfg.get("domain", ""))
            secrets = {}
            for name, entry in (cfg.get("secrets") or {}).items():
                value, hosts, headers = entry.get("value"), entry.get("hosts"), entry.get("headers")
                if not SECRET_NAME.fullmatch(name) or not isinstance(value, str) or not value:
                    log.error(f"secret {name!r}: no usable name or value; skipping")
                    continue
                if not isinstance(hosts, list) or not hosts or any(host_pattern_problem(h) for h in hosts):
                    log.error(f"secret {name!r}: its hosts do not pin a destination; skipping")
                    continue
                if headers is not None and (not isinstance(headers, list) or not headers
                                            or not all(isinstance(h, str) and HEADER_NAME.fullmatch(h) for h in headers)):
                    log.error(f"secret {name!r}: its headers cannot be read; skipping (a confinement that cannot be read is not widened)")
                    continue
                off, until = entry.get("off", False), entry.get("until")
                if not isinstance(off, bool) or (until is not None and (isinstance(until, bool) or not isinstance(until, (int, float)))):
                    log.error(f"secret {name!r}: off {off!r} / until {until!r} cannot be read; holding it OFF")
                    off, until = True, None
                secrets[name] = {"value": value, "hosts": [h.lower() for h in hosts],
                                 "headers": None if headers is None else frozenset(h.lower() for h in headers),
                                 "off": off, "until": until}
            for name in self._overlapping(secrets):
                del secrets[name]
            self.secrets, self._mtime = secrets, mtime
        try:
            policy_mtime = os.stat(POLICY_PATH).st_mtime_ns
        except OSError:
            self.internal, self._policy_mtime = set(), None
            return
        if policy_mtime != self._policy_mtime:
            try:
                with open(POLICY_PATH) as handle:
                    self.internal = {str(a) for a in (json.load(handle).get("internal") or [])}
            except (OSError, ValueError):
                self.internal = set()
            self._policy_mtime = policy_mtime

    def is_on(self, name):
        entry = self.secrets[name]
        return not entry["off"] and (entry["until"] is None or time.time() < entry["until"])

    @staticmethod
    def _overlapping(secrets):
        """Names that contain, or are contained by, another. Both go: neither can be
        substituted unambiguously. (v2, unchanged.)"""
        names = sorted(secrets)
        overlapping = set()
        for index, name in enumerate(names):
            for other in names[index + 1:]:
                if name in other or other in name:
                    log.error(f"placeholders {name!r} and {other!r} overlap; dropping both")
                    overlapping.update((name, other))
        return overlapping

    # ---------------------------------------------------------------- what a request proves
    @staticmethod
    def _host_matches(host, patterns):
        host = (host or "").lower()
        return any(fnmatch.fnmatch(host, p) for p in patterns)

    @staticmethod
    def proven_host(flow):
        sni = getattr(flow.client_conn, "sni", None)
        return sni.lower() if sni else None

    @staticmethod
    def destination_address(flow):
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
        if address is None:
            return True                  # an upstream that is not an address is not a checked one
        mapped = getattr(address, "ipv4_mapped", None)
        if mapped is not None:
            address = mapped
        return (not address.is_global or address.is_private or address.is_loopback
                or address.is_link_local or address.is_multicast
                or address.is_reserved or address.is_unspecified)

    @staticmethod
    def _without_port(raw):
        raw = raw.strip()
        if raw.startswith("["):
            return raw.split("]", 1)[0][1:].lower()
        if raw.count(":") == 1:
            raw = raw.rsplit(":", 1)[0]
        return raw.lower()

    @classmethod
    def claimed_names(cls, flow):
        """Every name the request itself gives as its destination: each Host header, and
        HTTP/2's :authority."""
        names = []
        authority = getattr(flow.request, "authority", "") or ""
        if authority.strip():
            names.append(cls._without_port(authority))
        for value in flow.request.headers.get_all("host"):
            if value and value.strip():
                names.append(cls._without_port(value))
        return names

    @staticmethod
    def _block(flow, code, msg):
        flow.response = http.Response.make(code, f"desolate: {msg}\n".encode(), {"content-type": "text/plain"})

    def audit(self, flow, verdict, host, secrets=(), reason=None):
        tunnel = self.tunnels.get(flow.client_conn.id, {})
        entry = {"time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z", "domain": self.domain,
                 "workspace": tunnel.get("workspace", "?"), "host": host, "port": 443, "verdict": verdict,
                 "method": flow.request.method, "route": flow.request.path.split("?", 1)[0][:200]}
        if secrets:
            entry["secrets"] = sorted(secrets)   # names, never values
        if reason:
            entry["reason"] = reason
        try:
            with open(AUDIT_PATH, "a") as handle:
                handle.write(json.dumps(entry) + "\n")
        except OSError as error:
            log.error(f"cannot write the audit log: {error}")

    def _in_its_headers(self, flow, name):
        allowed = self.secrets[name]["headers"]
        return any(name in v for k, v in flow.request.headers.items(multi=True) if k.lower() in allowed)

    def _placeholders(self, flow):
        if not self.secrets:
            return set()
        confined = {n for n, e in self.secrets.items() if e["headers"] is not None}
        found = {n for n in confined if self._in_its_headers(flow, n)}
        rest = [n for n in self.secrets if n not in confined]
        if rest:
            url = flow.request.url
            headers = "\n".join(f"{k}: {v}" for k, v in flow.request.headers.items(multi=True))
            body = flow.request.content or b""
            found |= {n for n in rest if n in url or n in headers or n.encode() in body}
        return found

    # ---------------------------------------------------------------- hooks
    def http_connect(self, flow: http.HTTPFlow):
        """proxy.ts opening a tunnel for one workspace's connection."""
        try:
            workspace = flow.request.headers.get("x-desolate-workspace", "")
            host = flow.request.headers.get("x-desolate-host", "").lower()
            if not re.fullmatch(r"[a-z0-9-]{1,80}", workspace) or not host or flow.request.port != 443:
                return self._block(flow, 403, "this proxy is reached only through a workspace's own proxy")
            self.tunnels[flow.client_conn.id] = {"workspace": workspace, "host": host}
        except Exception:
            log.exception("http_connect failed; refusing the tunnel (fail-closed)")
            self._block(flow, 502, "internal error; tunnel refused")

    def client_disconnected(self, client):
        self.tunnels.pop(client.id, None)

    def request(self, flow: http.HTTPFlow):
        try:
            self._request(flow)
        except Exception:
            log.exception("request handling failed; refusing the request (fail-closed)")
            self._block(flow, 502, "internal error; request refused")

    def _request(self, flow: http.HTTPFlow):
        self._maybe_reload()
        tunnel = self.tunnels.get(flow.client_conn.id)
        proven = self.proven_host(flow)
        if tunnel is None:
            return self._block(flow, 403, "this proxy is reached only through a workspace's own proxy")
        shown = proven or tunnel["host"]
        refuse = lambda reason, secrets=(): (self.audit(flow, "refused", shown, secrets, reason), self._block(flow, 403, reason))
        # The tunnel was opened, checked and resolved for one name. It speaks TLS for that
        # name, or it carries nothing.
        if proven is None:
            return refuse("this connection is not TLS, so its destination cannot be proven")
        if proven != tunnel["host"]:
            return refuse(f"this connection was opened for {tunnel['host']}, not for {proven}")
        destination = self.destination_address(flow)
        if self.is_internal(destination) and str(destination) not in self.internal:
            return refuse(f"{destination} is an internal address, which a workspace is not carried to")
        found = self._placeholders(flow)
        if found:
            claims = self.claimed_names(flow)
            if len(flow.request.headers.get_all("host")) > 1 or any(name != proven for name in claims):
                return refuse(f"the request names {sorted(set(claims))} as its destination, not only the TLS destination "
                              f"'{proven}'; refusing to substitute a secret", found)
        suspect = {name for name in found if not self._host_matches(proven, self.secrets[name]["hosts"])}
        found -= suspect
        switched_off = sorted(name for name in found if not self.is_on(name))
        if switched_off:
            return refuse(f"secret {switched_off} is switched off; on the host: "
                          f"desolate domain {self.domain} secret on {switched_off[0]} [--ttl 30m]", switched_off)
        body = flow.request.content or b""
        substituted = body
        for name in found:
            value, allowed = self.secrets[name]["value"], self.secrets[name]["headers"]
            if allowed is not None:
                for k, v in list(flow.request.headers.items(multi=True)):
                    if k.lower() in allowed and name in v:
                        flow.request.headers[k] = v.replace(name, value)
                continue
            if name in flow.request.path:
                flow.request.path = flow.request.path.replace(name, value)
            for k, v in list(flow.request.headers.items(multi=True)):
                if name in v:
                    flow.request.headers[k] = v.replace(name, value)
            if name.encode() in substituted:
                substituted = substituted.replace(name.encode(), value.encode())
        if substituted is not body:
            flow.request.content = substituted
        if suspect:
            self.audit(flow, "leak-suspect", proven, suspect, "a placeholder was sent toward a host its secret does not name; passed unsubstituted")
        if found:
            self.audit(flow, "substituted", proven, found)
        elif not suspect:
            self.audit(flow, "allowed", proven)

    def response(self, flow: http.HTTPFlow):
        try:
            if not flow.response or not self.secrets:
                return
            body = flow.response.content or b""
            scrubbed = body
            trailers = getattr(flow.response, "trailers", None)
            for name, entry in self.secrets.items():
                value, bvalue = entry["value"], entry["value"].encode()
                for k, v in list(flow.response.headers.items(multi=True)):
                    if value in v:
                        flow.response.headers[k] = v.replace(value, name)
                if trailers:
                    for k, v in list(trailers.items(multi=True)):
                        if value in v:
                            trailers[k] = v.replace(value, name)
                if bvalue in scrubbed:
                    scrubbed = scrubbed.replace(bvalue, name.encode())
            if scrubbed is not body:
                flow.response.content = scrubbed
        except Exception:
            log.exception("response scrub failed; withholding the response (fail-closed)")
            self._block(flow, 502, "internal error; response withheld")

    def websocket_message(self, flow: http.HTTPFlow):
        messages = getattr(getattr(flow, "websocket", None), "messages", None)
        try:
            self._maybe_reload()
            if not messages or not self.secrets:
                return
            message = messages[-1]
            if message.from_client:
                return  # outbound frames are never substituted into: a placeholder stays a placeholder
            content = message.content
            scrubbed = content
            for name, entry in self.secrets.items():
                bvalue = entry["value"].encode()
                if bvalue in scrubbed:
                    scrubbed = scrubbed.replace(bvalue, name.encode())
            if scrubbed is not content:
                message.content = scrubbed
        except Exception:
            log.exception("websocket scrub failed; dropping the message (fail-closed)")
            if messages:
                messages[-1].drop()


addons = [DesolateSecrets()]
