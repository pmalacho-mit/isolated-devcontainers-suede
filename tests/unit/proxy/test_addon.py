"""
Unit tests for the desolate-proxy mitmproxy addon.

The cases under "demonstrated exfiltration" were executed for real against the
previous version of this addon -- transparent mitmproxy, nftables REDIRECT,
containers on a bridge -- and each one delivered the real secret to an
attacker-controlled server. They are regression tests.

Run: ./tests/run.sh unit   (or: pytest tests/unit/proxy)
Needs: mitmproxy (same version install.sh pins) and pytest.
"""

import importlib.util
import logging
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


def leak_suspected(caplog, name):
    """Did an AUDIT line record `name` passing UNSUBSTITUTED toward a host its
    allowlist does not cover? Since #12 this, not a 403, is leak detection's
    verdict -- so it is what a test of leak detection has to look for."""
    for line in _audit_lines(caplog):
        fields = dict(f.split("=", 1) for f in line.split()[1:] if "=" in f)
        if fields.get("verdict") == "LEAK-SUSPECT" and name in fields.get("suspect", "").split(","):
            return True
    return False


def carries_value(flow, value=SECRET_VALUE):
    """Is the real value anywhere in what would leave: URL, headers or body?"""
    return (value in flow.request.url
            or value in str(flow.request.headers)
            or value.encode() in (flow.request.content or b""))


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

def test_placeholder_toward_a_non_allowlisted_host_passes_unsubstituted(tmp_path, caplog):
    """#12. A `git push` of code that mentions a placeholder, or an issue body
    quoting one, carries nothing secret -- it used to be a 403 anyway. Now it
    goes out exactly as written, and the audit says so."""
    caplog.set_level(logging.INFO)
    _, addon, _ = load_addon(tmp_path)
    f = make_flow(sni="example.com", host_header="example.com",
                  headers={"X-Exfil": SECRET_NAME})
    addon.request(f)
    assert not blocked(f)
    assert f.request.headers["X-Exfil"] == SECRET_NAME
    assert not carries_value(f), "the real value left toward a non-allowlisted host"
    assert leak_suspected(caplog, SECRET_NAME)


def test_one_request_two_secrets_only_the_allowlisted_one_is_substituted(tmp_path, caplog):
    """The bound is per secret, not per request: a request that is legitimate
    for one secret does not carry another one's value to the same host."""
    caplog.set_level(logging.INFO)
    _, addon, _ = load_addon(tmp_path, settings={
        "default_action": "allow",
        "secrets": {
            SECRET_NAME: {"value": SECRET_VALUE, "hosts": ["api.openai.com"]},
            "OTHER-GITHUB-TOKEN": {"value": "ghp-real-other", "hosts": ["api.github.com"]},
        },
        "network": [{"action": "allow", "host": "*"}],
    })
    f = make_flow(sni="api.openai.com", host_header="api.openai.com", method="POST",
                  headers={"Authorization": f"Bearer {SECRET_NAME}"},
                  content=b'{"note": "OTHER-GITHUB-TOKEN"}')
    addon.request(f)
    assert not blocked(f)
    assert f.request.headers["Authorization"] == f"Bearer {SECRET_VALUE}"
    assert not carries_value(f, "ghp-real-other")
    assert b"OTHER-GITHUB-TOKEN" in f.request.content
    assert leak_suspected(caplog, "OTHER-GITHUB-TOKEN")
    line = next(l for l in _audit_lines(caplog) if "LEAK-SUSPECT" in l)
    assert f"secrets={SECRET_NAME}" in line, f"the substitution is missing from: {line}"


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


def test_the_network_allowlist_is_spoofable_over_plaintext(tmp_path):
    """KNOWN GAP, pinned so it cannot change by accident.

    Leak detection is decided strictly on the PROVEN destination (the TLS SNI),
    and refuses a placeholder over plaintext outright -- that is E6 above. The
    NETWORK policy is not: `policy_host = proven or claimed or request.host`
    falls back to the Host header, which over plain HTTP the client chooses
    independently of the IP it connects to. So with `default_action: "deny"`,
    any container reaches any PUBLIC address on :80 by naming an allowlisted
    host in a header nothing verifies.

    What this is NOT: a way to move a secret. Substitution needs an SNI, so the
    placeholder travels as itself. Internal addresses are still refused by the
    destination-address check ahead of this, and by the kernel behind it.

    What it IS: the destination allowlist bounds HTTPS and does not bound
    plaintext. Anyone turning `default_action: "deny"` on should know that.
    Making it hold would mean judging plaintext on `request.host` -- the real
    destination in transparent mode -- rather than on the claimed name.
    """
    _, addon, _ = load_addon(tmp_path, settings={
        "default_action": "deny",
        "secrets": {SECRET_NAME: {"value": SECRET_VALUE, "hosts": ["api.openai.com"]}},
        "network": [{"action": "allow", "host": "*.debian.org"}],
        "scrub_responses": True,
    })

    spoofed = make_flow(sni=None, host_header="deb.debian.org", dest=PUBLIC_ATTACKER)
    addon.request(spoofed)
    assert spoofed.response is None, (
        "plaintext Host spoofing is now refused -- good. Delete this test and "
        "the matching paragraph in release/README.md."
    )

    # The two things that DO still hold, asserted here so the gap above is
    # never mistaken for a wider one.
    honest = make_flow(sni=None, host_header=None, dest=PUBLIC_ATTACKER)
    addon.request(honest)
    assert honest.response is not None and honest.response.status_code == 403, (
        "with no name claimed, the destination IP is judged and denied"
    )

    carrying = make_flow(sni=None, host_header="deb.debian.org", dest=PUBLIC_ATTACKER,
                         headers={"Authorization": f"Bearer {SECRET_NAME}"})
    addon.request(carrying)
    assert blocked(carrying), "a secret must never ride the plaintext path"
    assert SECRET_VALUE not in str(carrying.request.headers)


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


@pytest.mark.parametrize("hosts", [
    ["*"],                              # the whole point: no allowlist at all
    ["**"],
    ["*.*"],
    ["*.com"],                          # a whole TLD
    ["*openai.com"],                    # fnmatch: also matches evilopenai.com
    ["api.*"],
    ["?"],
    [""],
    ["api.openai.com", "*"],            # one good entry does not redeem the list
])
def test_a_wildcard_allowlist_is_refused(tmp_path, hosts):
    """An allowlist that does not pin a destination is not an allowlist.

    With `hosts: ["*"]` the placeholder is a bearer token again: any container
    can post it anywhere and the proxy will helpfully swap the real key in.
    """
    _, addon, _ = load_addon(tmp_path, settings={
        "default_action": "allow",
        "secrets": {SECRET_NAME: {"value": SECRET_VALUE, "hosts": hosts}},
        "network": [{"action": "allow", "host": "*"}],
        "scrub_responses": True,
    })
    addon._maybe_reload()
    assert SECRET_NAME not in addon.secrets, f"hosts={hosts} was accepted"

    f = make_flow(sni="api.openai.com", host_header="api.openai.com",
                  headers={"Authorization": f"Bearer {SECRET_NAME}"})
    addon.request(f)
    # nothing loaded, so nothing to substitute: the placeholder travels as itself
    assert f.request.headers["Authorization"] == f"Bearer {SECRET_NAME}"


@pytest.mark.parametrize("hosts", [
    ["api.openai.com"],
    ["*.openai.com"],
    ["api.openai.com", "*.openai.com"],
    ["localhost"],                      # a literal name pins itself, however short
])
def test_a_pinned_allowlist_still_loads(tmp_path, hosts):
    _, addon, _ = load_addon(tmp_path, settings={
        "default_action": "allow",
        "secrets": {SECRET_NAME: {"value": SECRET_VALUE, "hosts": hosts}},
        "network": [{"action": "allow", "host": "*"}],
        "scrub_responses": True,
    })
    addon._maybe_reload()
    assert SECRET_NAME in addon.secrets, f"hosts={hosts} was refused"


def test_the_network_allowlist_may_still_be_a_wildcard(tmp_path):
    """The host check applies to SECRETS, not to the network rules.

    `{"host": "*"}` is the shipped `network` default and means something
    defensible -- the path is default-deny, the destination set is not. Reusing
    the secrets rule there would refuse the stock settings file.
    """
    _, addon, _ = load_addon(tmp_path)
    addon._maybe_reload()
    assert addon.network == [{"action": "allow", "host": "*"}]
    f = make_flow(sni="deb.debian.org", host_header="deb.debian.org")
    addon.request(f)
    assert not blocked(f)


# ---------------------------------------------------------------------------
# overlapping placeholder names
# ---------------------------------------------------------------------------
# Substitution is a plain string replace and detection a plain substring
# search, so a name that contains another cannot be handled correctly by
# either. The check this replaced was a minimum name LENGTH, which does not
# prevent it at all -- the pair below is 29 and 31 characters.

OVERLAPPING = SECRET_NAME + "-2"


def test_overlapping_placeholders_are_both_dropped(tmp_path):
    _, addon, _ = load_addon(tmp_path, settings={
        "default_action": "allow",
        "secrets": {
            SECRET_NAME: {"value": SECRET_VALUE, "hosts": ["api.openai.com"]},
            OVERLAPPING: {"value": "sk-the-other-one", "hosts": ["api.openai.com"]},
        },
        "network": [{"action": "allow", "host": "*"}],
        "scrub_responses": True,
    })
    addon._maybe_reload()
    assert addon.secrets == {}, "keeping either one leaves the ambiguity in place"


def test_the_overlap_this_prevents(tmp_path):
    """What the drop is protecting against, spelled out as the request it breaks.

    Without the check, a request carrying only the LONGER placeholder also
    'contains' the shorter one, so it is judged against the shorter one's
    allowlist and gets its value spliced in -- leaving '-2' glued to a real
    API key, addressed to a host the user never allowlisted for it.
    """
    _, addon, _ = load_addon(tmp_path)
    addon._maybe_reload()
    # the pair, forced past the config check to demonstrate the mechanism
    addon.secrets = {
        SECRET_NAME: {"value": SECRET_VALUE, "hosts": ["api.openai.com"]},
        OVERLAPPING: {"value": "sk-the-other-one", "hosts": ["api.anthropic.com"]},
    }
    f = make_flow(sni="api.openai.com", host_header="api.openai.com",
                  headers={"Authorization": f"Bearer {OVERLAPPING}"})
    assert addon._placeholders_in_request(f) == {SECRET_NAME, OVERLAPPING}, \
        "the shorter name is found inside the longer one -- this is the whole problem"


def test_short_names_are_fine_when_nothing_overlaps(tmp_path):
    """The length bar is gone; a short name that collides with nothing works.

    Length was never the property that mattered. Overlap is.
    """
    _, addon, _ = load_addon(tmp_path, settings={
        "default_action": "allow",
        "secrets": {
            "K1": {"value": "sk-one", "hosts": ["api.openai.com"]},
            "K2": {"value": "sk-two", "hosts": ["api.openai.com"]},
        },
        "network": [{"action": "allow", "host": "*"}],
        "scrub_responses": True,
    })
    addon._maybe_reload()
    assert set(addon.secrets) == {"K1", "K2"}
    f = make_flow(sni="api.openai.com", host_header="api.openai.com",
                  headers={"Authorization": "Bearer K1"})
    addon.request(f)
    assert f.request.headers["Authorization"] == "Bearer sk-one"


def test_a_secret_dropped_for_overlap_takes_its_neighbours_with_it_only(tmp_path):
    """One bad pair must not disarm the rest of the store."""
    _, addon, _ = load_addon(tmp_path, settings={
        "default_action": "allow",
        "secrets": {
            SECRET_NAME: {"value": SECRET_VALUE, "hosts": ["api.openai.com"]},
            OVERLAPPING: {"value": "sk-other", "hosts": ["api.openai.com"]},
            "UNRELATED-PLACEHOLDER": {"value": "sk-fine", "hosts": ["api.openai.com"]},
        },
        "network": [{"action": "allow", "host": "*"}],
        "scrub_responses": True,
    })
    addon._maybe_reload()
    assert set(addon.secrets) == {"UNRELATED-PLACEHOLDER"}


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


def test_the_deliberate_verbatim_echo_is_closed(tmp_path):
    """Scrubbing is not only about accidents, and this is the case that earns it.

    Substitution rewrites request BODIES, so a compromised container does not
    have to wait for an endpoint to leak by mistake -- it can store the
    placeholder through an allowlisted API and have the REAL value written down
    server-side, then read it back:

        POST /v1/files  {"content": "<placeholder>"}   -> the real key is stored
        GET  /v1/files/{id}/content                    -> it comes back

    Any allowlisted API with a writable-then-readable field is that oracle.
    What the container gets back is the placeholder again.
    """
    _, addon, _ = load_addon(tmp_path)
    addon._maybe_reload()

    stored = make_flow(sni="api.openai.com", host_header="api.openai.com",
                       method="POST", content=f'{{"content":"{SECRET_NAME}"}}'.encode())
    addon.request(stored)
    assert not blocked(stored)
    assert SECRET_VALUE.encode() in stored.request.content, "the upstream really does store it"

    stored.response = tutils.tresp(content=stored.request.content)
    addon.response(stored)
    assert SECRET_VALUE.encode() not in stored.response.content
    assert SECRET_NAME.encode() in stored.response.content


def test_scrubbing_does_not_survive_a_transforming_endpoint(tmp_path):
    """KNOWN LIMIT, pinned so it is never mistaken for a boundary.

    The scrub is an exact match on the value, so an allowlisted host that can
    TRANSFORM its input defeats it in a single request. Reversing and spacing
    are the two cheapest spellings; base64, chunking across JSON fields and
    "spell it out" all work identically.

    This is a property of substitution itself rather than a defect here: the
    real value is handed to the host, and what the host chooses to say back is
    not something this process can bound. The guarantee that survives is the
    BOUND -- the value only ever travels to that secret's allowlisted hosts --
    and release/README.md says so under "What this does not give you".

    If this test ever fails, do not simply delete it. Scrubbing having become
    transform-proof would be a much larger claim than it looks, and it should be
    read very sceptically before the README is strengthened to match.
    """
    _, addon, _ = load_addon(tmp_path)
    addon._maybe_reload()

    def what_the_container_reads(transform):
        f = make_flow(sni="api.openai.com", host_header="api.openai.com",
                      method="POST", content=f'{{"prompt":"{SECRET_NAME}"}}'.encode())
        addon.request(f)
        assert not blocked(f)
        handed_to_the_host = f.request.content.decode()
        assert SECRET_VALUE in handed_to_the_host
        f.response = tutils.tresp(content=transform(SECRET_VALUE).encode())
        addon.response(f)
        return f.response.content.decode()

    reversed_reply = what_the_container_reads(lambda v: v[::-1])
    assert SECRET_VALUE not in reversed_reply, "an exact match would have caught this"
    assert reversed_reply[::-1] == SECRET_VALUE, "and the container just reverses it back"

    spaced_reply = what_the_container_reads(lambda v: " ".join(v))
    assert SECRET_VALUE not in spaced_reply
    assert spaced_reply.replace(" ", "") == SECRET_VALUE


# ===========================================================================
# E16 -- Content-Encoding, and the size cap that hid behind it
# ===========================================================================
# Both directions read `raw_content`, which is the body still in its
# Content-Encoding, and searched it for a PLAINTEXT secret. Against a gzipped
# message -- what nearly every JSON API returns -- the search matched nothing,
# so no scrub fired and no leak was detected. Both now read `.content`.
#
# The 5 MiB cap that used to sit alongside it is gone for the same reason: it
# was never a memory guard (mitmproxy has buffered the whole body before these
# hooks run) and it made the largest bodies the unscrubbed ones.


def _gzip(data: bytes) -> bytes:
    import gzip
    return gzip.compress(data)


def test_E16_a_gzipped_response_echoing_a_secret_is_scrubbed(tmp_path):
    """VERIFIED BYPASS: an allowlisted endpoint echoes the real key inside a
    gzipped body. `bvalue in raw_content` is False against compressed bytes, so
    the scrub never ran and the real value entered the container -- the exact
    thing response scrubbing exists to prevent."""
    _, addon, _ = load_addon(tmp_path)
    addon._maybe_reload()
    f = make_flow(sni="api.openai.com", host_header="api.openai.com")
    f.response = tutils.tresp(content=_gzip(f'{{"echo":"{SECRET_VALUE}"}}'.encode()))
    f.response.headers["Content-Encoding"] = "gzip"

    addon.response(f)

    assert SECRET_VALUE.encode() not in f.response.content
    assert SECRET_NAME.encode() in f.response.content
    # And it leaves still gzipped, so the container can actually read it.
    assert f.response.raw_content != f.response.content
    assert SECRET_VALUE.encode() not in f.response.raw_content


def test_E16b_a_placeholder_in_a_gzipped_request_body_is_seen(tmp_path, caplog):
    """The mirror of it outbound. A placeholder inside a compressed body was
    invisible, so leak detection never ran: a request aimed at a host the
    secret is not allowlisted for went unblocked because the client had set
    Content-Encoding."""
    _, addon, _ = load_addon(tmp_path)
    addon._maybe_reload()
    f = make_flow(sni="evil.example.com", host_header="evil.example.com",
                  method="POST", content=_gzip(f'{{"key":"{SECRET_NAME}"}}'.encode()))
    f.request.headers["Content-Encoding"] = "gzip"
    caplog.set_level(logging.INFO)

    addon.request(f)

    assert leak_suspected(caplog, SECRET_NAME), "the placeholder in a gzipped body was not seen"
    assert not carries_value(f)


def test_E16c_a_gzipped_request_toward_an_allowed_host_is_substituted(tmp_path):
    """The good path, which the fix must not break: the value goes in, and the
    body the upstream receives is still validly gzipped."""
    _, addon, _ = load_addon(tmp_path)
    addon._maybe_reload()
    f = make_flow(sni="api.openai.com", host_header="api.openai.com",
                  method="POST", content=_gzip(f'{{"key":"{SECRET_NAME}"}}'.encode()))
    f.request.headers["Content-Encoding"] = "gzip"

    addon.request(f)

    assert not blocked(f)
    assert SECRET_VALUE.encode() in f.request.content
    # Re-encoded, not smuggled out as plaintext, and Content-Length agrees.
    assert SECRET_VALUE.encode() not in f.request.raw_content
    assert f.request.headers["content-length"] == str(len(f.request.raw_content))


def test_E16d_a_body_that_cannot_be_decoded_fails_closed(tmp_path):
    """A body claiming gzip that is not gzip cannot be proven clean, so it must
    block. 'Unreadable' is not 'holds no secret' -- and the alternative, falling
    back to the raw bytes, is the bypass this whole section is about."""
    _, addon, _ = load_addon(tmp_path)
    addon._maybe_reload()

    inbound = make_flow(sni="api.openai.com", host_header="api.openai.com")
    inbound.response = tutils.tresp(content=b"this is definitely not gzip")
    inbound.response.headers["Content-Encoding"] = "gzip"
    addon.response(inbound)
    assert blocked(inbound), "an undecodable response must not pass unscrubbed"

    outbound = make_flow(sni="api.openai.com", host_header="api.openai.com",
                         method="POST", content=b"this is definitely not gzip")
    outbound.request.headers["Content-Encoding"] = "gzip"
    addon.request(outbound)
    assert blocked(outbound), "an undecodable request body must not pass unscanned"


def test_E16e_a_body_with_no_secrets_configured_is_never_decoded(tmp_path):
    """The blast radius of failing closed, bounded deliberately.

    Decoding every body on every request would make a malformed
    Content-Encoding a 502 for people who have configured no secrets at all and
    are getting nothing from this addon but a network policy. With no secrets
    there is nothing to find, so the body is never read and such traffic passes
    exactly as it did before."""
    _, addon, _ = load_addon(tmp_path, settings={
        "default_action": "allow",
        "secrets": {},
        "network": [{"action": "allow", "host": "*"}],
        "scrub_responses": True,
    })
    addon._maybe_reload()

    f = make_flow(sni="api.openai.com", host_header="api.openai.com",
                  method="POST", content=b"this is definitely not gzip")
    f.request.headers["Content-Encoding"] = "gzip"
    addon.request(f)
    assert not blocked(f)

    f.response = tutils.tresp(content=b"this is definitely not gzip either")
    f.response.headers["Content-Encoding"] = "gzip"
    addon.response(f)
    assert not blocked(f)


def test_E16f_size_is_no_longer_a_way_past_the_scrub(tmp_path, caplog):
    """The 5 MiB cap skipped inspection of anything larger, so a secret echoed
    past it went straight through. It protected nothing: mitmproxy has already
    buffered the whole body by the time this hook runs."""
    _, addon, _ = load_addon(tmp_path)
    addon._maybe_reload()
    padding = b"x" * (6 * 1024 * 1024)

    inbound = make_flow(sni="api.openai.com", host_header="api.openai.com")
    inbound.response = tutils.tresp(content=padding + SECRET_VALUE.encode())
    addon.response(inbound)
    assert SECRET_VALUE.encode() not in inbound.response.content

    outbound = make_flow(sni="evil.example.com", host_header="evil.example.com",
                         method="POST", content=padding + SECRET_NAME.encode())
    caplog.set_level(logging.INFO)
    addon.request(outbound)
    assert leak_suspected(caplog, SECRET_NAME), "a placeholder past the old cap must still be seen"
    assert not carries_value(outbound)


def test_E16g_one_body_rewrite_however_many_secrets_match(tmp_path):
    """Every assignment to `.content` re-encodes the whole body and rewrites
    Content-Length, so doing it per secret pays that per name. Asserted through
    behaviour rather than a call count: all of them land, and the result is
    still a validly encoded body."""
    secrets = {f"MYAPP-KEY-{i}-PLACEHOLDER": {"value": f"sk-real-{i}", "hosts": ["api.openai.com"]}
               for i in range(4)}
    _, addon, _ = load_addon(tmp_path, settings={
        "default_action": "allow",
        "secrets": secrets,
        "network": [{"action": "allow", "host": "*"}],
        "scrub_responses": True,
    })
    addon._maybe_reload()
    assert len(addon.secrets) == 4, "the fixture's names must not overlap each other"

    payload = " ".join(secrets).encode()
    f = make_flow(sni="api.openai.com", host_header="api.openai.com",
                  method="POST", content=_gzip(payload))
    f.request.headers["Content-Encoding"] = "gzip"
    addon.request(f)
    for entry in secrets.values():
        assert entry["value"].encode() in f.request.content
    assert f.request.headers["content-length"] == str(len(f.request.raw_content))

    f.response = tutils.tresp(content=_gzip(b" ".join(e["value"].encode() for e in secrets.values())))
    f.response.headers["Content-Encoding"] = "gzip"
    addon.response(f)
    for name, entry in secrets.items():
        assert entry["value"].encode() not in f.response.content
        assert name.encode() in f.response.content


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


def _audit_lines(caplog):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith("AUDIT ")]


def test_E12a_audit_line_never_carries_a_secret_value(tmp_path, caplog):
    """The audit line is parsed by `cli.sh proxy audit` and persisted in
    journald. A secret VALUE reaching it would put a real credential somewhere
    other than the one 0600 file meant to hold them -- most easily via a query
    string, which is exactly where an API token tends to live."""
    caplog.set_level(logging.INFO)
    mod, inst, _ = load_addon(tmp_path)
    f = make_flow(sni="api.openai.com", host_header="api.openai.com", dest="104.18.7.1")
    f.request.path = f"/v1/models?key={SECRET_NAME}&page=2"
    inst.request(f)
    lines = _audit_lines(caplog)
    assert lines, "no AUDIT line emitted"
    line = lines[0]
    assert SECRET_VALUE not in line, "the audit line leaked the real secret value"
    path_field = line.split("path=")[1].split(" ")[0]
    assert "?" not in path_field, "kept a query string, which is where a token would be"
    assert f"secrets={SECRET_NAME}" in line, "the substituted name should be reported"


def test_E12b_substitution_log_does_not_echo_the_value_either(tmp_path, caplog):
    """Same hazard, older line. SUBST logged flow.request.path AFTER the
    substitution loop had run, and .path covers the query string."""
    caplog.set_level(logging.INFO)
    mod, inst, _ = load_addon(tmp_path)
    f = make_flow(sni="api.openai.com", host_header="api.openai.com", dest="104.18.7.1")
    f.request.path = f"/v1/models?key={SECRET_NAME}"
    inst.request(f)
    everything = " ".join(r.getMessage() for r in caplog.records)
    assert SECRET_VALUE not in everything, "a log line echoed the substituted secret"
    assert f.request.path.endswith(SECRET_VALUE), \
        "the request itself must still carry the real value"


def test_E12c_every_verdict_reaches_the_audit(tmp_path, caplog):
    """An audit that only records substitutions cannot answer 'what did this
    container contact', which is the question it exists for."""
    caplog.set_level(logging.INFO)
    mod, inst, _ = load_addon(tmp_path)
    inst.request(make_flow(sni="example.com", host_header="example.com", dest="104.18.7.1"))
    inst.request(make_flow(sni=None, host_header="api.openai.com", dest="192.168.5.2"))
    verdicts = " ".join(_audit_lines(caplog))
    assert "verdict=ALLOW" in verdicts, f"no ALLOW verdict in: {verdicts}"
    assert "verdict=DENY-INTERNAL" in verdicts, f"no DENY verdict in: {verdicts}"


# ===========================================================================
# the self-test fixture
#
# It has failed in both directions: deleted, so preflight's probes stopped
# failing closed and reported `secrets can be exfiltrated` against a healthy
# addon; and present, where its published NAME made every request merely
# mentioning it a 403. `"selftest": true` separates the probe from prose.
# ===========================================================================

FIXTURE_NAME = "DESOLATE-SELFTEST-PLACEHOLDER"
FIXTURE_VALUE = "injected-selftest-value-93f2"


def _fixture_settings(extra_secrets=None):
    secrets = {FIXTURE_NAME: {"value": FIXTURE_VALUE, "hosts": ["httpbin.org"],
                              "selftest": True}}
    secrets.update(extra_secrets or {})
    return {"default_action": "allow", "secrets": secrets,
            "network": [{"action": "allow", "host": "*"}], "scrub_responses": True}


def test_the_selftest_probe_still_trips_leak_detection(tmp_path, caplog):
    """preflight's HTTPS probe: the fixture toward a host it is not
    allowlisted for must produce the LEAK-SUSPECT line preflight greps for,
    or the check proves nothing."""
    caplog.set_level(logging.INFO)
    _, addon, _ = load_addon(tmp_path, _fixture_settings())
    f = make_flow(sni="example.com", host_header="example.com",
                  headers={"X-Exfil": FIXTURE_NAME})
    addon.request(f)
    assert leak_suspected(caplog, FIXTURE_NAME)
    assert f.request.headers["X-Exfil"] == FIXTURE_NAME
    assert not carries_value(f, FIXTURE_VALUE)


def test_the_selftest_plaintext_spoof_probe_still_trips(tmp_path):
    """preflight's :80 probe: no SNI means no provable destination, so a
    placeholder over plaintext is refused whatever the Host header claims."""
    _, addon, _ = load_addon(tmp_path, _fixture_settings())
    f = make_flow(sni=None, host_header="httpbin.org", dest="93.184.216.34",
                  headers={"X-Exfil": FIXTURE_NAME})
    addon.request(f)
    assert blocked(f)


def test_the_fixture_name_in_a_body_is_not_a_leak(tmp_path, caplog):
    """THE regression this flag exists for.

    An agent editing this repo sends a diff naming the fixture to its model
    API; `git push` sends blobs containing it. Under the substring rule both
    were 403 "secret ... is not permitted for host ...", which is true, useless
    and indistinguishable from real exfiltration.
    """
    _, addon, _ = load_addon(tmp_path, _fixture_settings())
    body = f'{{"diff": "+  X-Exfil: {FIXTURE_NAME}\\n"}}'.encode()
    f = make_flow(sni="api.anthropic.com", host_header="api.anthropic.com",
                  content=body, method="POST", dest="104.18.7.1")
    caplog.set_level(logging.INFO)
    addon.request(f)
    assert f.response is None, "a body that merely names the fixture was refused"
    assert f.request.content == body, "and it must travel unmodified"
    assert not leak_suspected(caplog, FIXTURE_NAME), \
        "and it must not fill the audit with suspects every time this repo is pushed"


def test_the_fixture_name_in_a_url_is_not_a_leak(tmp_path):
    _, addon, _ = load_addon(tmp_path, _fixture_settings())
    f = make_flow(sni="github.com", host_header="github.com", dest="104.18.7.1")
    f.request.path = f"/search?q={FIXTURE_NAME}"
    addon.request(f)
    assert f.response is None
    assert FIXTURE_NAME in f.request.path, "nothing was substituted, so nothing changed"


def test_the_fixture_is_not_matched_as_part_of_a_longer_header(tmp_path):
    """A whole header VALUE is the discriminator, not a substring of one --
    otherwise a User-Agent or a JSON header quoting the name is a 403 again."""
    _, addon, _ = load_addon(tmp_path, _fixture_settings())
    f = make_flow(sni="example.com", host_header="example.com",
                  headers={"X-Note": f"about {FIXTURE_NAME} and why it exists"})
    addon.request(f)
    assert f.response is None


def test_the_fixture_value_is_never_scrubbed_from_a_response(tmp_path):
    """Scrubbing it would plant the fixture's NAME in a body the container
    then echoes back, which is a 403 on the next request. The value is fake and
    published; there is nothing to protect."""
    _, addon, _ = load_addon(tmp_path, _fixture_settings())
    f = make_flow(sni="httpbin.org", host_header="httpbin.org")
    f.response = tutils.tresp(content=f"the value is {FIXTURE_VALUE}".encode())
    addon.response(f)
    assert FIXTURE_VALUE.encode() in f.response.content
    assert FIXTURE_NAME.encode() not in f.response.content


def test_the_flag_is_opt_in_and_changes_nothing_else(tmp_path, caplog):
    """A real secret sharing the store with the fixture keeps the ordinary
    substring rule in every position. The narrowing is per-entry, so it cannot
    loosen the bound on anything real."""
    _, addon, _ = load_addon(tmp_path, _fixture_settings({
        SECRET_NAME: {"value": SECRET_VALUE, "hosts": ["api.openai.com"]},
    }))
    body = f'{{"key": "{SECRET_NAME}"}}'.encode()
    f = make_flow(sni="example.com", host_header="example.com",
                  content=body, method="POST", dest="104.18.7.1")
    caplog.set_level(logging.INFO)
    addon.request(f)
    assert leak_suspected(caplog, SECRET_NAME), "a REAL secret in a body must still be seen"
    assert SECRET_VALUE.encode() not in f.request.content


def test_a_secret_without_the_flag_keeps_the_substring_rule(tmp_path, caplog):
    """The default is unchanged: absent `selftest`, a placeholder is matched
    anywhere it appears. Pins that the flag defaults to False rather than to
    whatever the last entry set."""
    _, addon, _ = load_addon(tmp_path, {
        "default_action": "allow",
        "secrets": {FIXTURE_NAME: {"value": FIXTURE_VALUE, "hosts": ["httpbin.org"]}},
        "network": [{"action": "allow", "host": "*"}],
    })
    f = make_flow(sni="example.com", host_header="example.com",
                  content=f"mentions {FIXTURE_NAME}".encode(), method="POST",
                  dest="104.18.7.1")
    caplog.set_level(logging.INFO)
    addon.request(f)
    assert leak_suspected(caplog, FIXTURE_NAME)


# ===========================================================================
# T4.6: which project a request came from, and what that may unlock
# ===========================================================================

A_ADDRESS, B_ADDRESS, SHARED_ADDRESS = "172.30.0.2", "172.31.0.2", "172.19.0.2"
SCOPED = "ACME-WIDGETS-DEPLOY-KEY"


def dinds_fixture(tmp_path):
    """The supervisor's dinds/ directory: two project dinds and the shared one."""
    dinds = tmp_path / "dinds"
    dinds.mkdir()
    (dinds / "desolate-dind-acme__widgets").write_text(f"{A_ADDRESS}\n")
    (dinds / "desolate-dind-solo").write_text(f"{B_ADDRESS}\n")
    (dinds / "desolate-dind").write_text(f"{SHARED_ADDRESS}\n")
    (dinds / ".desolate-dind-solo.tmp").write_text("10.0.0.9\n")      # a writer mid-rename
    return dinds


def scoped_addon(tmp_path, network=None):
    mod, addon, path = load_addon(tmp_path, {
        "default_action": "allow",
        "secrets": {
            SECRET_NAME: {"value": SECRET_VALUE, "hosts": ["api.openai.com"]},
            SCOPED: {"value": "deploy-real-value", "hosts": ["api.github.com"], "projects": ["acme/widgets"]},
        },
        "network": network or [{"action": "allow", "host": "*"}],
    })
    mod.DINDS_DIR = str(dinds_fixture(tmp_path))
    return mod, addon


def from_(address, **kwargs):
    flow = make_flow(**kwargs)
    flow.client_conn.peername = (address, 40000)
    return flow


def audit_fields(caplog):
    return [dict(f.split("=", 1) for f in line.split()[1:] if "=" in f) for line in _audit_lines(caplog)]


def test_attribution_comes_from_the_published_dind_addresses(tmp_path):
    _, addon = scoped_addon(tmp_path)
    assert addon.project_of(from_(A_ADDRESS)) == "acme/widgets"
    assert addon.project_of(from_(B_ADDRESS)) == "solo"
    assert addon.project_of(from_(SHARED_ADDRESS)) is None, "the shared dind is no project's"
    assert addon.project_of(from_("10.0.0.9")) is None, "a writer's temporary file attributes nothing"
    assert addon.project_of(from_(f"::ffff:{A_ADDRESS}")) == "acme/widgets", "the same address, IPv4-mapped"


def test_a_dind_file_name_decodes_to_the_project_that_owns_it(tmp_path):
    mod, _ = scoped_addon(tmp_path)
    assert mod.project_of_dind("desolate-dind-solo") == "solo"
    assert mod.project_of_dind("desolate-dind-acme__widgets") == "acme/widgets"
    # `/` is the LAST `__`: owner `a_`, repo `b`. Left to right it was `a/_b`,
    # which is no project, so that project was never attributed at all.
    assert mod.project_of_dind("desolate-dind-a___b") == "a_/b"
    # The supervisor's scratch file, as it was once named: attributed to a
    # project `solo.tmp`, so `solo`'s own scoped secrets met DENY-SCOPE.
    assert mod.project_of_dind("desolate-dind-solo.tmp") is None
    assert mod.project_of_dind(".desolate-dind-solo.tmp") is None
    assert mod.project_of_dind("desolate-dind") is None


def test_a_scratch_file_mid_publish_attributes_nothing(tmp_path):
    # A project's first publish, between write and rename: its address must
    # not belong, for that moment, to a project called `fresh.tmp`.
    mod, addon = scoped_addon(tmp_path)
    (Path(mod.DINDS_DIR) / "desolate-dind-fresh.tmp").write_text("172.29.0.2\n")
    assert addon.project_of(from_("172.29.0.2")) is None


def test_every_audit_line_names_the_project(tmp_path, caplog):
    _, addon = scoped_addon(tmp_path)
    with caplog.at_level(logging.INFO):
        addon.request(from_(A_ADDRESS, sni="example.com", dest="93.184.216.34"))
        addon.request(from_(SHARED_ADDRESS, sni="example.com", dest="93.184.216.34"))
    assert [f["project"] for f in audit_fields(caplog)] == ["acme/widgets", "-"]


def test_a_scoped_secret_reaches_its_project(tmp_path):
    _, addon = scoped_addon(tmp_path)
    f = from_(A_ADDRESS, sni="api.github.com", dest="140.82.112.6", headers={"Authorization": f"token {SCOPED}"})
    addon.request(f)
    assert not blocked(f)
    assert carries_value(f, "deploy-real-value")


@pytest.mark.parametrize("source", [B_ADDRESS, SHARED_ADDRESS, "172.29.9.9"],
                         ids=["another project", "the shared dind", "an unmapped address"])
def test_a_scoped_secret_is_refused_to_anyone_else(tmp_path, caplog, source):
    _, addon = scoped_addon(tmp_path)
    f = from_(source, sni="api.github.com", dest="140.82.112.6", headers={"Authorization": f"token {SCOPED}"})
    with caplog.at_level(logging.INFO):
        addon.request(f)
    assert blocked(f) and f.response.status_code == 403
    assert not carries_value(f, "deploy-real-value")
    verdicts = [(x["verdict"], x["suspect"]) for x in audit_fields(caplog)]
    assert verdicts == [("DENY-SCOPE", SCOPED)]


def test_an_unscoped_secret_is_everyones_as_before(tmp_path):
    _, addon = scoped_addon(tmp_path)
    for source in (A_ADDRESS, B_ADDRESS, SHARED_ADDRESS):
        f = from_(source, sni="api.openai.com", dest="104.18.6.1", headers={"Authorization": f"Bearer {SECRET_NAME}"})
        addon.request(f)
        assert carries_value(f), source


@pytest.mark.parametrize("projects", ["acme/widgets", [], ["a/b/c"], [7]],
                         ids=["a string", "empty", "not a project name", "not a string"])
def test_a_scope_that_cannot_be_read_drops_the_secret(tmp_path, projects):
    mod, addon, _ = load_addon(tmp_path, {"secrets": {
        SCOPED: {"value": "deploy-real-value", "hosts": ["api.github.com"], "projects": projects}}})
    addon._maybe_reload()
    assert SCOPED not in addon.secrets, "an unreadable scope must not be widened to everyone"


def test_a_network_rule_naming_projects_is_theirs_alone(tmp_path):
    _, addon = scoped_addon(tmp_path, network=[
        {"action": "deny", "host": "example.com", "projects": ["solo"]},
        {"action": "allow", "host": "*"},
    ])
    denied = from_(B_ADDRESS, sni="example.com", dest="93.184.216.34")
    allowed = from_(A_ADDRESS, sni="example.com", dest="93.184.216.34")
    addon.request(denied)
    addon.request(allowed)
    assert blocked(denied) and not blocked(allowed)


def test_a_scoped_deny_also_stops_traffic_no_project_is_named_for(tmp_path):
    # A project moved onto the shared daemon -- its own spec decides that --
    # is unattributed there. A deny that skipped it was a deny it could walk
    # around (found in review).
    _, addon = scoped_addon(tmp_path, network=[
        {"action": "deny", "host": "example.com", "projects": ["solo"]},
        {"action": "allow", "host": "*"},
    ])
    unattributed = from_(SHARED_ADDRESS, sni="example.com", dest="93.184.216.34")
    addon.request(unattributed)
    assert blocked(unattributed)


def test_a_deny_whose_scope_cannot_be_read_applies_to_everyone(tmp_path):
    _, addon = scoped_addon(tmp_path, network=[
        {"action": "deny", "host": "example.com", "projects": "solo"},
        {"action": "allow", "host": "*"},
    ])
    f = from_(A_ADDRESS, sni="example.com", dest="93.184.216.34")
    addon.request(f)
    assert blocked(f)


def test_a_scoped_allow_admits_no_unattributed_traffic(tmp_path):
    _, addon = scoped_addon(tmp_path, network=[
        {"action": "allow", "host": "example.com", "projects": ["solo"]},
    ])
    f = from_(SHARED_ADDRESS, sni="example.com", dest="93.184.216.34")
    addon._maybe_reload()
    addon.default_action = "deny"
    addon.request(f)
    assert blocked(f)


def test_a_network_rule_whose_scope_cannot_be_read_applies_to_no_one(tmp_path):
    _, addon = scoped_addon(tmp_path, network=[
        {"action": "allow", "host": "example.com", "projects": "solo"},
    ])
    addon.default_action = "deny"
    f = from_(B_ADDRESS, sni="example.com", dest="93.184.216.34")
    addon._maybe_reload()
    addon.default_action = "deny"
    addon.request(f)
    assert blocked(f)


def test_attribution_follows_a_dind_that_moved(tmp_path):
    mod, addon = scoped_addon(tmp_path)
    assert addon.project_of(from_(A_ADDRESS)) == "acme/widgets"
    dinds = Path(mod.DINDS_DIR)
    (dinds / "desolate-dind-acme__widgets").unlink()
    (dinds / "desolate-dind-acme__widgets.new").write_text("172.30.0.7\n")
    os.replace(dinds / "desolate-dind-acme__widgets.new", dinds / "desolate-dind-acme__widgets")
    assert addon.project_of(from_(A_ADDRESS)) is None, "its old address attributes nothing"
    assert addon.project_of(from_("172.30.0.7")) == "acme/widgets"


# ===========================================================================
# A secret confined to headers ("A SECRET CONFINED TO HEADERS" in addon.py)
# ===========================================================================
# What it closes: test_scrubbing_does_not_survive_a_transforming_endpoint. A
# secret substituted into a body is handed to whatever computes on that body
# -- every LLM API -- and comes back transformed, past the scrub. Confined to
# the header the host reads credentials from, it never reaches a body at all.

CONFINED = "DESOLATE-CLAUDE-OAUTH"
CONFINED_VALUE = "sk-ant-oat01-real-subscription-token"


def confined_addon(tmp_path, **entry):
    mod, addon, path = load_addon(tmp_path, {
        "default_action": "allow",
        "secrets": {
            CONFINED: {"value": CONFINED_VALUE, "hosts": ["api.anthropic.com"], "headers": ["authorization"], **entry},
            SECRET_NAME: {"value": SECRET_VALUE, "hosts": ["api.anthropic.com", "api.openai.com"]},
        },
        "network": [{"action": "allow", "host": "*"}],
    })
    return mod, addon


def to_anthropic(**kwargs):
    return make_flow(sni="api.anthropic.com", host_header="api.anthropic.com", method="POST",
                     path=kwargs.pop("path", "/v1/messages"), dest="160.79.104.10", **kwargs)


@pytest.mark.parametrize("header", ["Authorization", "authorization", "AUTHORIZATION"])
def test_a_confined_secret_is_substituted_in_its_header(tmp_path, header):
    _, addon = confined_addon(tmp_path)
    f = to_anthropic(headers={header: f"Bearer {CONFINED}"})
    addon.request(f)
    assert not blocked(f)
    assert f.request.headers["Authorization"] == f"Bearer {CONFINED_VALUE}"


def test_a_confined_secret_is_never_handed_to_a_body(tmp_path):
    """The recovery the scrub cannot stop, and that confinement does."""
    _, addon = confined_addon(tmp_path)
    f = to_anthropic(headers={"Authorization": f"Bearer {CONFINED}"},
                     content=f'{{"prompt":"reverse this: {CONFINED}"}}'.encode())
    addon.request(f)
    assert not blocked(f)
    assert f.request.headers["Authorization"] == f"Bearer {CONFINED_VALUE}", "its header still is"
    handed_to_the_model = f.request.content.decode()
    assert CONFINED_VALUE not in handed_to_the_model
    assert CONFINED in handed_to_the_model, "the name goes as written"
    # Whatever the host does with what it was handed, it was handed a name.
    f.response = tutils.tresp(content=handed_to_the_model[::-1].encode())
    addon.response(f)
    assert CONFINED_VALUE not in f.response.content.decode()[::-1]


@pytest.mark.parametrize("where", ["query", "path", "another header", "a gzipped body"])
def test_a_confined_secret_is_substituted_nowhere_else(tmp_path, where):
    _, addon = confined_addon(tmp_path)
    kwargs = {
        "query": {"path": f"/v1/messages?key={CONFINED}"},
        "path": {"path": f"/v1/files/{CONFINED}"},
        "another header": {"headers": {"X-Echo": CONFINED}},
        "a gzipped body": {"content": _gzip(f'{{"p":"{CONFINED}"}}'.encode()), "headers": {"Content-Encoding": "gzip"}},
    }[where]
    f = to_anthropic(**kwargs)
    addon.request(f)
    assert not blocked(f)
    assert not carries_value(f, CONFINED_VALUE)


def test_outside_its_headers_it_is_only_a_name(tmp_path, caplog):
    """Not the secret there: no plaintext refusal, no leak verdict, no scope."""
    _, addon = confined_addon(tmp_path, projects=["acme/widgets"])
    with caplog.at_level(logging.INFO):
        plain = make_flow(host_header="example.com", method="POST", dest="93.184.216.34", content=CONFINED.encode())
        addon.request(plain)
        elsewhere = make_flow(sni="example.com", host_header="example.com", dest="93.184.216.34",
                              headers={"Authorization": f"Bearer {CONFINED}"}, path="/x")
        addon.request(elsewhere)
    assert not blocked(plain), "a name in a body over plaintext is not a secret over plaintext"
    assert not blocked(elsewhere)
    assert [x["verdict"] for x in audit_fields(caplog)] == ["ALLOW", "LEAK-SUSPECT"], \
        "in its own header toward another host, it is still the secret, and still suspect"


def test_a_confined_secret_keeps_its_project_scope(tmp_path):
    mod, addon = confined_addon(tmp_path, projects=["acme/widgets"])
    mod.DINDS_DIR = str(dinds_fixture(tmp_path))
    mine = to_anthropic(headers={"Authorization": f"Bearer {CONFINED}"})
    mine.client_conn.peername = (A_ADDRESS, 40000)
    addon.request(mine)
    assert carries_value(mine, CONFINED_VALUE)
    theirs = to_anthropic(headers={"Authorization": f"Bearer {CONFINED}"})
    theirs.client_conn.peername = (B_ADDRESS, 40000)
    addon.request(theirs)
    assert blocked(theirs) and not carries_value(theirs, CONFINED_VALUE)


def test_an_unconfined_secret_beside_it_is_substituted_as_before(tmp_path):
    _, addon = confined_addon(tmp_path)
    f = to_anthropic(headers={"Authorization": f"Bearer {CONFINED}"},
                     content=f'{{"a":"{SECRET_NAME}","b":"{CONFINED}"}}'.encode())
    addon.request(f)
    assert f.request.headers["Authorization"] == f"Bearer {CONFINED_VALUE}"
    body = f.request.content.decode()
    assert SECRET_VALUE in body and CONFINED in body and CONFINED_VALUE not in body


@pytest.mark.parametrize("headers", ["authorization", [], ["bad header"], [""], [7]],
                         ids=["a string", "empty", "a space", "an empty name", "not a string"])
def test_a_confinement_that_cannot_be_read_drops_the_secret(tmp_path, caplog, headers):
    _, addon = confined_addon(tmp_path, headers=headers)
    with caplog.at_level(logging.ERROR):
        addon._maybe_reload()
    assert CONFINED not in addon.secrets, "never widened to everywhere"
    assert SECRET_NAME in addon.secrets
    assert "not a list of header names" in caplog.text
