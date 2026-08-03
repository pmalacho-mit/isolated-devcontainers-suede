"""
Unit tests for the desolate-proxy mitmproxy addon.

The cases under "demonstrated exfiltration" were executed for real against the
previous version of this addon -- transparent mitmproxy, nftables REDIRECT,
containers on a bridge -- and each one delivered the real secret to an
attacker-controlled server. They are regression tests.

Run: tests/unit/proxy/run.sh   (or: pytest tests/unit/proxy)
Needs: mitmproxy (same version install.sh pins) and pytest.
"""

import importlib.util
import ipaddress
import json
import os
import sys
from pathlib import Path

import pytest

from mitmproxy.test import tflow, tutils

# parents[3] is the repo root; shipped code lives under release/.
ADDON_PATH = Path(__file__).resolve().parents[3] / "release" / "proxy" / "vm" / "addon.py"

SECRET_NAME = "MYAPP-OPENAI-KEY-PLACEHOLDER"
SECRET_VALUE = "sk-real-value-do-not-leak"

# A PUBLIC address, deliberately. The demonstrated-exfiltration tests below
# must be blocked by the proven-host check, not by the internal-destination
# check -- 203.0.113.0/24 (which they used to use) is classified internal, so
# they would have kept passing with proven_host() removed entirely.
PUBLIC_ATTACKER = "104.18.7.1"


def load_addon(tmp_path, settings=None):
    """Import addon.py fresh, pointed at a throwaway settings file."""
    settings = settings if settings is not None else {
        "default_action": "allow",
        "secrets": {SECRET_NAME: {"value": SECRET_VALUE, "hosts": ["api.openai.com", "*.openai.com"]}},
        "network": [{"action": "allow", "host": "*"}],
        "scrub_responses": True,
    }
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(settings))

    spec = importlib.util.spec_from_file_location(f"desolate_addon_{id(tmp_path)}", ADDON_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    mod.SETTINGS_PATH = str(path)
    inst = mod.DesolateProxy()
    return mod, inst, path


def make_flow(sni=None, host_header=None, headers=None, content=b"", path="/v1/models",
              method="GET", dest="1.2.3.4"):
    """A transparent-mode flow: `dest` is where the packet actually goes, `sni`
    is what TLS proved, `host_header` is what the client merely claimed."""
    req = tutils.treq(method=method.encode(), path=path.encode(), content=content)
    f = tflow.tflow(req=req)
    f.request.host = dest
    f.request.port = 443 if sni else 80
    f.request.scheme = "https" if sni else "http"
    f.client_conn.sni = sni
    if host_header is not None:
        f.request.headers["Host"] = host_header
    elif "Host" in f.request.headers:
        del f.request.headers["Host"]
    for k, v in (headers or {}).items():
        f.request.headers[k] = v
    return f


def blocked(flow):
    return flow.response is not None and flow.response.status_code in (403, 502)


# ===========================================================================
# demonstrated exfiltration (regression)
# ===========================================================================

def test_E6_plaintext_host_spoof_is_refused(tmp_path):
    """VERIFIED ATTACK: connect to an attacker IP on :80, claim
    `Host: api.openai.com`. The old addon read the Host header, found it
    allowlisted, substituted the real key, and mitmproxy delivered it to the
    original destination. Observed at the attacker: the real secret."""
    _, addon, _ = load_addon(tmp_path)
    f = make_flow(sni=None, host_header="api.openai.com", dest=PUBLIC_ATTACKER,
                  headers={"Authorization": f"Bearer {SECRET_NAME}"})
    addon.request(f)
    assert blocked(f), "plaintext exfiltration was NOT blocked"
    assert SECRET_VALUE not in f.request.headers["Authorization"]
    assert SECRET_NAME in f.request.headers["Authorization"], "placeholder must be left untouched"


def test_E7_tls_sni_host_mismatch_is_refused(tmp_path):
    """VERIFIED ATTACK: terminate TLS on a host you legitimately own
    (SNI=evil.example.com, valid certificate, so upstream verification passes),
    then set `Host: api.openai.com` inside the encrypted request. Same result:
    the real secret arrived at the attacker."""
    _, addon, _ = load_addon(tmp_path)
    f = make_flow(sni="evil.example.com", host_header="api.openai.com", dest=PUBLIC_ATTACKER,
                  headers={"Authorization": f"Bearer {SECRET_NAME}"})
    addon.request(f)
    assert blocked(f), "SNI/Host mismatch was NOT blocked"
    assert SECRET_VALUE not in str(f.request.headers)


def test_E8_addon_failure_must_not_fail_open(tmp_path):
    """VERIFIED BEHAVIOUR: mitmproxy answers an uncaught addon exception by
    forwarding the request unmodified. With `pip install mitmproxy` unpinned,
    one API change would therefore disable secret policy silently while every
    request kept succeeding. The hook now catches and blocks."""
    _, addon, _ = load_addon(tmp_path)

    def boom(_flow):
        raise AttributeError("module mitmproxy.ctx has no attribute log")

    addon._request = boom
    f = make_flow(sni="api.openai.com", host_header="api.openai.com")
    addon.request(f)
    assert f.response is not None and f.response.status_code == 502, \
        "a broken addon let the request through (fail-open)"


def test_E8b_response_scrub_failure_does_not_leak(tmp_path):
    _, addon, _ = load_addon(tmp_path)

    def boom(_flow):
        raise RuntimeError("kaboom")

    addon._response = boom
    f = make_flow(sni="api.openai.com", host_header="api.openai.com")
    f.response = tutils.tresp(content=SECRET_VALUE.encode())
    addon.response(f)
    assert f.response.status_code == 502


# ===========================================================================
# the legitimate path must keep working
# ===========================================================================

def test_substitution_when_sni_and_host_agree(tmp_path):
    _, addon, _ = load_addon(tmp_path)
    f = make_flow(sni="api.openai.com", host_header="api.openai.com",
                  headers={"Authorization": f"Bearer {SECRET_NAME}"})
    addon.request(f)
    assert not blocked(f)
    assert f.request.headers["Authorization"] == f"Bearer {SECRET_VALUE}"


def test_substitution_in_url_and_body(tmp_path):
    _, addon, _ = load_addon(tmp_path)
    f = make_flow(sni="api.openai.com", host_header="api.openai.com",
                  path=f"/v1/x?key={SECRET_NAME}",
                  content=json.dumps({"token": SECRET_NAME}).encode(),
                  method="POST")
    addon.request(f)
    assert not blocked(f)
    assert SECRET_VALUE in f.request.url
    assert SECRET_VALUE.encode() in f.request.content
    assert SECRET_NAME.encode() not in f.request.content


def test_missing_host_header_is_fine_when_sni_proves_the_destination(tmp_path):
    _, addon, _ = load_addon(tmp_path)
    f = make_flow(sni="api.openai.com", host_header=None,
                  headers={"Authorization": f"Bearer {SECRET_NAME}"})
    addon.request(f)
    assert not blocked(f)
    assert f.request.headers["Authorization"] == f"Bearer {SECRET_VALUE}"


def test_host_header_port_is_ignored_when_comparing(tmp_path):
    _, addon, _ = load_addon(tmp_path)
    f = make_flow(sni="api.openai.com", host_header="api.openai.com:443",
                  headers={"Authorization": f"Bearer {SECRET_NAME}"})
    addon.request(f)
    assert not blocked(f), "host:port must compare equal to the bare SNI"


def test_glob_allowlist_matches(tmp_path):
    _, addon, _ = load_addon(tmp_path)
    f = make_flow(sni="eu.openai.com", host_header="eu.openai.com",
                  headers={"Authorization": f"Bearer {SECRET_NAME}"})
    addon.request(f)
    assert not blocked(f)
    assert SECRET_VALUE in f.request.headers["Authorization"]


def test_requests_without_placeholders_pass_over_plaintext(tmp_path):
    """apt/pip over http must keep working; only SECRET-bearing plaintext dies."""
    _, addon, _ = load_addon(tmp_path)
    f = make_flow(sni=None, host_header="deb.debian.org", dest="1.2.3.4")
    addon.request(f)
    assert f.response is None


# ===========================================================================
# allowlist and network policy
# ===========================================================================

def test_placeholder_toward_a_non_allowlisted_host_is_blocked(tmp_path):
    _, addon, _ = load_addon(tmp_path)
    f = make_flow(sni="example.com", host_header="example.com",
                  headers={"X-Exfil": SECRET_NAME})
    addon.request(f)
    assert blocked(f)
    assert f.request.headers["X-Exfil"] == SECRET_NAME


def test_network_policy_deny(tmp_path):
    _, addon, _ = load_addon(tmp_path, settings={
        "default_action": "deny",
        "secrets": {},
        "network": [{"action": "allow", "host": "*.debian.org"}],
        "scrub_responses": True,
    })
    allowed = make_flow(sni="deb.debian.org", host_header="deb.debian.org")
    addon.request(allowed)
    assert allowed.response is None

    denied = make_flow(sni="evil.example.com", host_header="evil.example.com")
    addon.request(denied)
    assert denied.response is not None and denied.response.status_code == 403


def test_method_scoped_network_rule(tmp_path):
    _, addon, _ = load_addon(tmp_path, settings={
        "default_action": "deny",
        "secrets": {},
        "network": [{"action": "allow", "host": "api.example.com", "method": "GET"}],
        "scrub_responses": True,
    })
    get = make_flow(sni="api.example.com", host_header="api.example.com", method="GET")
    addon.request(get)
    assert get.response is None
    post = make_flow(sni="api.example.com", host_header="api.example.com", method="POST")
    addon.request(post)
    assert post.response is not None and post.response.status_code == 403


# ===========================================================================
# config hygiene
# ===========================================================================

def test_secret_without_allowlist_is_ignored(tmp_path):
    """A secret with no hosts must not become a wildcard by omission."""
    _, addon, _ = load_addon(tmp_path, settings={
        "default_action": "allow",
        "secrets": {SECRET_NAME: {"value": SECRET_VALUE, "hosts": []}},
        "network": [{"action": "allow", "host": "*"}],
        "scrub_responses": True,
    })
    addon._maybe_reload()
    assert SECRET_NAME not in addon.secrets
    f = make_flow(sni="api.openai.com", host_header="api.openai.com",
                  headers={"Authorization": f"Bearer {SECRET_NAME}"})
    addon.request(f)
    # nothing to substitute -- the placeholder travels as itself, never a value
    assert f.request.headers["Authorization"] == f"Bearer {SECRET_NAME}"


def test_secret_with_empty_value_is_ignored(tmp_path):
    _, addon, _ = load_addon(tmp_path, settings={
        "default_action": "allow",
        "secrets": {SECRET_NAME: {"value": "", "hosts": ["api.openai.com"]}},
        "network": [{"action": "allow", "host": "*"}],
        "scrub_responses": True,
    })
    addon._maybe_reload()
    assert SECRET_NAME not in addon.secrets


def test_settings_reload_picks_up_changes(tmp_path):
    _, addon, path = load_addon(tmp_path)
    addon._maybe_reload()
    assert SECRET_NAME in addon.secrets
    path.write_text(json.dumps({"default_action": "allow", "secrets": {}, "network": [],
                                "scrub_responses": True}))
    os.utime(path, (0, 0))          # force a different mtime
    addon._maybe_reload()
    assert addon.secrets == {}


def test_malformed_settings_keeps_the_last_good_config(tmp_path):
    """A truncated write must not silently drop the allowlist."""
    _, addon, path = load_addon(tmp_path)
    addon._maybe_reload()
    assert SECRET_NAME in addon.secrets
    path.write_text("{ this is not json")
    os.utime(path, (0, 0))
    addon._maybe_reload()
    assert SECRET_NAME in addon.secrets


# ===========================================================================
# response scrubbing
# ===========================================================================

def test_response_body_and_headers_are_scrubbed(tmp_path):
    _, addon, _ = load_addon(tmp_path)
    f = make_flow(sni="api.openai.com", host_header="api.openai.com")
    addon._maybe_reload()
    f.response = tutils.tresp(content=f'{{"echo":"{SECRET_VALUE}"}}'.encode())
    f.response.headers["X-Echo"] = SECRET_VALUE
    addon.response(f)
    assert SECRET_VALUE.encode() not in f.response.content
    assert SECRET_NAME.encode() in f.response.content
    assert f.response.headers["X-Echo"] == SECRET_NAME


def test_scrubbing_can_be_disabled(tmp_path):
    _, addon, _ = load_addon(tmp_path, settings={
        "default_action": "allow",
        "secrets": {SECRET_NAME: {"value": SECRET_VALUE, "hosts": ["api.openai.com"]}},
        "network": [{"action": "allow", "host": "*"}],
        "scrub_responses": False,
    })
    addon._maybe_reload()
    f = make_flow(sni="api.openai.com", host_header="api.openai.com")
    f.response = tutils.tresp(content=SECRET_VALUE.encode())
    addon.response(f)
    assert SECRET_VALUE.encode() in f.response.content


# ===========================================================================
# helpers
# ===========================================================================

@pytest.mark.parametrize("raw,expected", [
    ("api.openai.com", "api.openai.com"),
    ("api.openai.com:443", "api.openai.com"),
    ("API.OpenAI.com", "api.openai.com"),
    ("[::1]:8080", "::1"),
])
def test_host_header_normalisation(tmp_path, raw, expected):
    _, addon, _ = load_addon(tmp_path)
    f = make_flow(sni="x", host_header=raw)
    assert addon.host_header(f) == expected


def test_proven_host_is_sni_only(tmp_path):
    _, addon, _ = load_addon(tmp_path)
    f = make_flow(sni="api.openai.com", host_header="lies.example.com")
    assert addon.proven_host(f) == "api.openai.com"
    g = make_flow(sni=None, host_header="lies.example.com")
    assert addon.proven_host(g) is None


# ===========================================================================
# substitution must not disturb the request's destination
# ===========================================================================
# ---------------------------------------------------------------------------
# E10: the proxy as a confused deputy
# ---------------------------------------------------------------------------
# nftables REDIRECTs :80/:443 from the container bridges here whatever the
# destination was, and this process then dials that destination FROM THE VM,
# where the container-bridge drops no longer apply. So it is the one component
# standing on both sides of the containment boundary. The network policy cannot
# close this: it matches names with fnmatch, and the shipped default is
# {"host": "*"}, which an IP literal matches -- and a name check could not close
# it either, since a public hostname resolving to 10.x satisfies any allowlist.


@pytest.mark.parametrize("dest", [
    "192.168.5.2",     # the Mac, over Colima's vmnet
    "172.17.0.2",      # a container on another docker bridge
    "10.4.1.9",        # the LAN
    "127.0.0.1",       # the VM itself
    "169.254.169.254", # cloud metadata
    "0.0.0.0",
    "100.64.1.9",      # RFC 6598 shared space -- a tailnet peer. NOT is_private.
    "::ffff:192.168.5.2",  # the Mac again, spelled as IPv4-mapped IPv6
    "fd00::1",         # IPv6 ULA
])
def test_E10_internal_destinations_are_refused(tmp_path, dest):
    mod, inst, _ = load_addon(tmp_path)
    f = make_flow(host_header="example.com", dest=dest)
    inst.request(f)
    assert blocked(f), f"{dest} was forwarded"


def test_E10b_internal_destination_is_refused_even_with_a_valid_sni(tmp_path):
    """The name is the part an attacker chooses, so the address is checked first."""
    mod, inst, _ = load_addon(tmp_path)
    f = make_flow(sni="api.openai.com", host_header="api.openai.com", dest="192.168.5.2")
    inst.request(f)
    assert blocked(f)


def test_E10c_public_destinations_still_pass(tmp_path):
    mod, inst, _ = load_addon(tmp_path)
    f = make_flow(sni="api.openai.com", host_header="api.openai.com", dest="104.18.7.1")
    inst.request(f)
    assert not blocked(f)


def test_E10d_the_escape_hatch_is_opt_in_and_named(tmp_path):
    mod, inst, _ = load_addon(tmp_path, settings={
        "default_action": "allow",
        "allow_private_destinations": True,
        "secrets": {},
        "network": [{"action": "allow", "host": "*"}],
    })
    f = make_flow(host_header="example.com", dest="192.168.5.2")
    inst.request(f)
    assert not blocked(f)


def test_E10e_a_hostname_destination_is_not_mistaken_for_an_address(tmp_path):
    """Non-IP candidates are skipped, not guessed at."""
    mod, inst, _ = load_addon(tmp_path)
    f = make_flow(dest="example.com")
    f.server_conn.peername = None
    f.server_conn.address = ("example.com", 80)
    assert mod.DesolateProxy.destination_address(f) is None
    assert mod.DesolateProxy.is_internal(None) is False


def test_E10f_the_connection_address_is_used_when_the_request_carries_a_name(tmp_path):
    """The DNS-rebinding case, and the reason this is an address check.

    Over TLS mitmproxy fills `request.host` from the SNI, so the request looks
    like it is going to a perfectly ordinary public name. What the connection
    actually dials is the resolved address -- and a name whose A record points
    inside is exactly how an allowlist gets satisfied by an internal target.
    """
    mod, inst, _ = load_addon(tmp_path)
    f = make_flow(sni="api.openai.com", host_header="api.openai.com",
                  dest="api.openai.com")
    f.server_conn.peername = ("10.1.2.3", 443)
    inst.request(f)
    assert blocked(f)


def test_E10g_the_regression_tests_above_still_fail_on_the_NAME(tmp_path):
    """Guards E6/E7 against being silently satisfied by the address check.

    Those two are the demonstrated-exfiltration regressions, and they exist to
    prove `proven_host()` refuses a spoofed Host. If their destination were in a
    range `is_internal` rejects, they would keep passing with `proven_host()`
    deleted -- green, and testing nothing. So: their address must be public, and
    the block must come from the name.
    """
    mod, inst, _ = load_addon(tmp_path)
    assert mod.DesolateProxy.is_internal(ipaddress.ip_address("104.18.7.1")) is False
    f = make_flow(sni=None, host_header="api.openai.com", dest="104.18.7.1",
                  headers={"Authorization": f"Bearer {SECRET_NAME}"})
    inst.request(f)
    assert blocked(f)
    assert b"internal" not in f.response.content, \
        "E6 blocked on the destination address, so it is no longer testing the Host spoof"


def test_E10h_tls_passthrough_never_reaches_this_check(tmp_path):
    """A known, deliberate hole -- recorded so it is a decision, not a surprise.

    `tls_clienthello` sets ignore_connection for a matching SNI, and the flow is
    then tunnelled without ever producing a request hook. The SNI is chosen by
    the client, so any configured glob is a way to reach an internal address on
    :443. Empty by default; this asserts the default, and documents the cost of
    changing it.
    """
    mod, inst, _ = load_addon(tmp_path)
    assert inst.tls_passthrough == [], \
        "a non-empty default tls_passthrough would bypass the destination check"


def test_E9_substitution_preserves_the_host_header(tmp_path):
    """Substituting a secret must not rewrite where the request is going.

    The addon once did `flow.request.url = flow.request.url.replace(...)`. In
    transparent mode request.host is the destination IP, and assigning .url --
    even a byte-identical string, which is what it was whenever the placeholder
    lived in a header rather than the URL -- re-parses it and REWRITES the Host
    header to that IP. The upstream CDN then cannot tell which site is being
    addressed and answers with an opaque HTML 403.

    It only appeared once a secret was registered, because the substitution loop
    does not run otherwise: unregistered, the request went out intact and came
    back with a truthful 401 from the API. That asymmetry is what made it look
    like a credentials problem.
    """
    _, addon, _ = load_addon(tmp_path, {
        "default_action": "allow",
        "secrets": {"MYAPP-KEY-PLACEHOLDER": {"value": "sk-real", "hosts": ["api.openai.com"]}},
        "network": [{"action": "allow", "host": "*"}],
        "scrub_responses": True,
    })
    f = make_flow(sni="api.openai.com", host_header="api.openai.com",
                  dest="162.159.140.245",
                  headers={"Authorization": "Bearer MYAPP-KEY-PLACEHOLDER"})
    addon.request(f)

    assert not blocked(f), "an allowlisted host must not be blocked"
    # the point of the test
    assert f.request.headers["Host"] == "api.openai.com", \
        "substitution rewrote the Host header to the destination IP"
    assert f.request.headers["Authorization"] == "Bearer sk-real"


def test_E9b_substitution_still_reaches_the_query_string(tmp_path):
    """...while still substituting placeholders that DO live in the URL."""
    _, addon, _ = load_addon(tmp_path, {
        "default_action": "allow",
        "secrets": {"MYAPP-KEY-PLACEHOLDER": {"value": "sk-real", "hosts": ["api.openai.com"]}},
        "network": [{"action": "allow", "host": "*"}],
        "scrub_responses": True,
    })
    f = make_flow(sni="api.openai.com", host_header="api.openai.com",
                  dest="162.159.140.245", path="/v1/models?token=MYAPP-KEY-PLACEHOLDER")
    addon.request(f)

    assert not blocked(f)
    assert "sk-real" in f.request.path
    assert "MYAPP-KEY-PLACEHOLDER" not in f.request.path
    assert f.request.headers["Host"] == "api.openai.com"
