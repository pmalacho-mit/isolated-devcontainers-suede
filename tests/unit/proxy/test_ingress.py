"""
Unit tests for desolate-ingress, the VM-side forwarder (release/proxy/vm/ingress.py).

The bounds are the point. The orchestrator writes the ports/ directory and is
the component most exposed to projects, so every refusal below is one a
compromised writer would try: a port that reaches the Mac's LAN, an address that
is the VM itself, an address that is not a project's at all.

Run: ./tests/run.sh unit   (or: pytest tests/unit/proxy)
Needs: pytest. Python 3 stdlib otherwise -- the forwarder has no dependencies.
"""

import asyncio
import importlib.util
import json
import os
import socket
import sys
from pathlib import Path

import pytest

INGRESS_PATH = Path(__file__).resolve().parents[3] / "release" / "proxy" / "vm" / "ingress.py"
spec = importlib.util.spec_from_file_location("desolate_ingress", INGRESS_PATH)
ingress = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ingress
spec.loader.exec_module(ingress)


def ip_addr(*links):
    """`ip -j addr` output for (ifname, address, prefixlen) triples."""
    return json.dumps([
        {"ifname": name, "addr_info": [{"family": "inet", "local": local, "prefixlen": prefix}]}
        for name, local, prefix in links
    ])


SUBNETS = ingress.bridge_subnets(ip_addr(
    ("br-d-3f2a9c1e5b", "172.21.0.1", 16),   # a project dind's bridge
    ("br-desolate-in", "172.19.0.1", 16),    # the shared dind's
    ("br-desolate", "172.18.0.1", 16),       # the EDITOR's -- never a target
    ("docker0", "172.17.0.1", 16),
    ("br-dx", "172.30.0.1", 16),             # one character from a match
))


# ------------------------------------------------------------------ the bounds --

class TestSubnets:
    def test_only_desolate_dind_bridges_hold_targets(self):
        networks = {str(network) for network, _ in SUBNETS}
        assert networks == {"172.21.0.0/16", "172.19.0.0/16"}

    def test_the_editor_bridge_is_not_one_of_them(self):
        # The ingress dials dinds. The editor has its own fixed publish, and a
        # forwarder that could reach its bridge could reach the deploy keys'
        # container from the Mac's side of the boundary.
        with pytest.raises(ingress.Refused, match="not inside a desolate bridge"):
            ingress.check_address("172.18.0.5", SUBNETS)


class TestHostPort:
    @pytest.mark.parametrize("name", ["1024", "8080", "65535"])
    def test_accepted(self, name):
        assert ingress.parse_host_port(name) == int(name)

    @pytest.mark.parametrize("name", ["22", "80", "443", "981", "1023"])
    def test_below_1024_is_refused(self, name):
        # Measured (vm-loopback-forward.sh L3): Lima forwards a root listener
        # below 1024 to EVERY interface on the Mac, even when it is bound to
        # 127.0.0.1 in the VM.
        with pytest.raises(ingress.Refused, match="outside 1024-65535"):
            ingress.parse_host_port(name)

    @pytest.mark.parametrize("name", ["65536", "99999", "08080", "0", "-1", "8080.tmp", "", "80 80", "１０２４"])
    def test_not_a_port(self, name):
        with pytest.raises(ingress.Refused):
            ingress.parse_host_port(name)


class TestTarget:
    def test_accepted(self):
        assert ingress.parse_target("desolate-dind-acme__widgets:5173\n") == ("desolate-dind-acme__widgets", 5173, None)
        assert ingress.parse_target("desolate-dind:8080") == ("desolate-dind", 8080, None)

    def test_an_owner_may_follow(self):
        # desolate.ts names the target that claimed the port, so a withdraw can
        # tell its own files from another's -- and the forward answers that
        # target's host alone (WHOSE NAME).
        assert ingress.parse_target("desolate-dind:8080 acme__widgets--wt--wip\n") == ("desolate-dind", 8080, "acme__widgets--wt--wip")

    @pytest.mark.parametrize("content", [
        "desolate-dind:8080 ../x", "desolate-dind:8080 a b", "desolate-dind:8080 -x", "desolate-dind:8080 a;b",
    ])
    def test_a_malformed_owner_is_refused(self, content):
        with pytest.raises(ingress.Refused):
            ingress.parse_target(content)

    @pytest.mark.parametrize("content", [
        "", "desolate-dind", "desolate-dind:", ":8080", "desolate-dind:0", "desolate-dind:70000",
        "desolate-dind:8080:1", "evil:8080", "desolate-dind-x 8080", "../dinds/x:80",
    ])
    def test_malformed(self, content):
        with pytest.raises(ingress.Refused):
            ingress.parse_target(content)


class TestAddress:
    def test_a_container_address_is_accepted(self):
        assert str(ingress.check_address("172.21.0.2\n", SUBNETS)) == "172.21.0.2"

    @pytest.mark.parametrize("gateway", ["172.21.0.1", "172.19.0.1"])
    def test_a_gateway_is_refused(self, gateway):
        # The gateway IS the VM: forwarding to it would hand the Mac the VM's
        # own services, such as the proxy on :18080.
        with pytest.raises(ingress.Refused, match="gateway"):
            ingress.check_address(gateway, SUBNETS)

    @pytest.mark.parametrize("address", ["172.21.0.0", "172.21.255.255"])
    def test_network_and_broadcast_are_refused(self, address):
        with pytest.raises(ingress.Refused, match="not a host address"):
            ingress.check_address(address, SUBNETS)

    @pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "1.1.1.1", "172.17.0.2", "172.30.0.2", "::1"])
    def test_anything_outside_the_bridges_is_refused(self, address):
        with pytest.raises(ingress.Refused):
            ingress.check_address(address, SUBNETS)

    def test_garbage_is_refused(self):
        with pytest.raises(ingress.Refused, match="not an address"):
            ingress.check_address("172.21.0.2; rm -rf /", SUBNETS)


class TestDesired:
    DINDS = {"desolate-dind-acme": "172.21.0.2\n", "desolate-dind": "172.19.0.1\n"}

    def test_a_good_file_becomes_a_listener(self):
        wanted, refused = ingress.desired({"8081": "desolate-dind-acme:5173"}, self.DINDS, SUBNETS)
        assert wanted == {8081: ("172.21.0.2", 5173, None)} and refused == []
        wanted, _ = ingress.desired({"8081": "desolate-dind-acme:5173 acme"}, self.DINDS, SUBNETS)
        assert wanted == {8081: ("172.21.0.2", 5173, ingress.expected_host("acme"))}

    def test_an_unknown_dind_is_refused(self):
        wanted, refused = ingress.desired({"8081": "desolate-dind-nobody:5173"}, self.DINDS, SUBNETS)
        assert wanted == {} and "no dind named" in refused[0]

    def test_a_dind_file_naming_a_gateway_is_refused(self):
        # dinds/ is the supervisor's; the bound holds against it too.
        wanted, refused = ingress.desired({"8082": "desolate-dind:8082"}, self.DINDS, SUBNETS)
        assert wanted == {} and "gateway" in refused[0]

    def test_one_bad_file_does_not_cost_the_good_ones(self):
        wanted, refused = ingress.desired(
            {"8081": "desolate-dind-acme:5173", "80": "desolate-dind-acme:80"}, self.DINDS, SUBNETS)
        assert list(wanted) == [8081] and len(refused) == 1


# ------------------------------------------------------- listeners, for real --

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def echo_server():
    async def echo(reader, writer):
        while data := await reader.read(1024):
            writer.write(b"echo:" + data)
            await writer.drain()
        writer.close()
    server = await asyncio.start_server(echo, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


def loopback_as_bridge():
    """A fake `ip -j addr` that makes 127.0.0.0/8 a project bridge, so the
    forwarder's real bound admits the test's echo server on 127.0.0.1."""
    return ip_addr(("br-d-0123456789", "127.0.0.254", 8))


def write(path, content):
    tmp = f"{path}.tmp"
    with open(tmp, "w") as handle:
        handle.write(content)
    os.replace(tmp, path)   # the writers' own shape: an atomic rename


async def roundtrip(port, payload=b"hi"):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(payload)
    await writer.drain()
    data = await asyncio.wait_for(reader.read(1024), 2)
    writer.close()
    return data


@pytest.fixture
def root(tmp_path):
    (tmp_path / "dinds").mkdir()
    (tmp_path / "ports").mkdir()
    return tmp_path


def test_files_open_and_close_listeners(root):
    async def scenario():
        target, target_port = await echo_server()
        host_port = free_port()
        forwarder = ingress.Ingress(str(root), subnets_source=loopback_as_bridge)
        write(root / "dinds" / "desolate-dind-acme", "127.0.0.1\n")
        write(root / "ports" / str(host_port), f"desolate-dind-acme:{target_port}\n")

        await forwarder.reconcile()
        assert await roundtrip(host_port) == b"echo:hi"
        bound = {s.getsockname()[0] for s in forwarder.listeners[host_port].servers[0].sockets}
        assert bound == {"127.0.0.1"}, "the listener must bind loopback only"

        os.remove(root / "ports" / str(host_port))
        await forwarder.reconcile()
        with pytest.raises(OSError):
            await roundtrip(host_port)
        target.close()
    asyncio.run(scenario())


def test_removal_drops_connections_in_flight(root):
    async def scenario():
        target, target_port = await echo_server()
        host_port = free_port()
        forwarder = ingress.Ingress(str(root), subnets_source=loopback_as_bridge)
        write(root / "dinds" / "desolate-dind-acme", "127.0.0.1\n")
        write(root / "ports" / str(host_port), f"desolate-dind-acme:{target_port}\n")
        await forwarder.reconcile()

        reader, writer = await asyncio.open_connection("127.0.0.1", host_port)
        writer.write(b"one")
        assert await asyncio.wait_for(reader.read(1024), 2) == b"echo:one"
        os.remove(root / "ports" / str(host_port))
        await forwarder.reconcile()
        assert await asyncio.wait_for(reader.read(1024), 2) == b"", "the old connection survived"
        target.close()
    asyncio.run(scenario())


def test_a_rewrite_with_the_same_content_reopens(root):
    # Measured (L6): a port the Mac already held is never retried by Lima, so
    # a fresh listener is the only recovery -- and `--move` asks for one by
    # rewriting the file, whatever it says.
    async def scenario():
        target, target_port = await echo_server()
        host_port = free_port()
        forwarder = ingress.Ingress(str(root), subnets_source=loopback_as_bridge)
        write(root / "dinds" / "desolate-dind-acme", "127.0.0.1\n")
        write(root / "ports" / str(host_port), f"desolate-dind-acme:{target_port}\n")
        await forwarder.reconcile()
        first = forwarder.listeners[host_port]

        await forwarder.reconcile()
        assert forwarder.listeners[host_port] is first, "an unchanged file must not churn"

        write(root / "ports" / str(host_port), f"desolate-dind-acme:{target_port}\n")
        await forwarder.reconcile()
        assert forwarder.listeners[host_port] is not first
        assert await roundtrip(host_port) == b"echo:hi"
        target.close()
    asyncio.run(scenario())


def test_a_refused_file_opens_nothing(root):
    async def scenario():
        host_port = free_port()
        forwarder = ingress.Ingress(str(root), subnets_source=loopback_as_bridge)
        write(root / "dinds" / "desolate-dind-acme", "127.0.0.254\n")   # the gateway
        write(root / "ports" / str(host_port), "desolate-dind-acme:22\n")
        await forwarder.reconcile()
        assert forwarder.listeners == {}
        with pytest.raises(OSError):
            await roundtrip(host_port)
    asyncio.run(scenario())


def test_a_symlinked_file_is_not_read(root, tmp_path):
    # A link would let the writer of one directory point the forwarder at a
    # file it does not own.
    async def scenario():
        elsewhere = tmp_path / "elsewhere"
        elsewhere.write_text("127.0.0.1\n")
        os.symlink(elsewhere, root / "dinds" / "desolate-dind-acme")
        host_port = free_port()
        write(root / "ports" / str(host_port), "desolate-dind-acme:8080\n")
        forwarder = ingress.Ingress(str(root), subnets_source=loopback_as_bridge)
        await forwarder.reconcile()
        assert forwarder.listeners == {}
    asyncio.run(scenario())


def test_a_peer_that_stopped_reading_cannot_hold_a_close(root):
    # A close flushes before it lets go; with a client that reads nothing and an
    # upstream that keeps sending, the buffer never drains, and on 3.12.1+
    # wait_closed() waits for that connection -- so reconcile() would never
    # return, and no port would open or close again.
    async def scenario():
        async def flood(reader, writer):
            try:
                while True:
                    writer.write(b"x" * 65536)
                    await writer.drain()
            except (ConnectionError, asyncio.CancelledError):
                pass
        target = await asyncio.start_server(flood, "127.0.0.1", 0)
        target_port = target.sockets[0].getsockname()[1]
        host_port = free_port()
        forwarder = ingress.Ingress(str(root), subnets_source=loopback_as_bridge)
        write(root / "dinds" / "desolate-dind-acme", "127.0.0.1\n")
        write(root / "ports" / str(host_port), f"desolate-dind-acme:{target_port}\n")
        await forwarder.reconcile()

        import socket
        stalled = socket.create_connection(("127.0.0.1", host_port))
        stalled.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        await asyncio.sleep(0.5)   # long enough for every buffer on the way to fill

        os.remove(root / "ports" / str(host_port))
        await asyncio.wait_for(forwarder.reconcile(), 5)
        assert forwarder.listeners == {}
        stalled.close()
        target.close()
    asyncio.run(scenario())


def test_a_port_it_cannot_listen_on_is_said_once(root, caplog):
    async def scenario():
        import socket
        held = socket.socket()
        held.bind(("127.0.0.1", 0))
        held.listen()
        host_port = held.getsockname()[1]
        forwarder = ingress.Ingress(str(root), subnets_source=loopback_as_bridge)
        write(root / "dinds" / "desolate-dind-acme", "127.0.0.1\n")
        write(root / "ports" / str(host_port), "desolate-dind-acme:8080\n")
        with caplog.at_level("WARNING"):
            for _ in range(4):
                await forwarder.reconcile()
            assert sum("cannot listen" in r.message for r in caplog.records) == 1
            write(root / "ports" / str(host_port), "desolate-dind-acme:8080\n")
            await forwarder.reconcile()
            assert sum("cannot listen" in r.message for r in caplog.records) == 2, "a rewrite is said again"
        held.close()
    asyncio.run(scenario())


# ----------------------------------------------------- whose name, for real --
#
# A cookie is scoped by host, never by port: a forward that served a page under
# the outer editor's name, or another target's, handed it their cookies --
# their connection tokens. Each port answers its own target's host alone.

HOSTS = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "hosts.json").read_text())


def test_the_expected_host_is_hosts_ts_own():
    # tests/unit/desolate/hosts.test.ts holds hosts.ts to the same file.
    assert {name: ingress.expected_host(name) for name in HOSTS} == HOSTS
    assert ingress.expected_host(None) is None


def client_hello(name):
    """A real ClientHello naming `name`, from the ssl module itself."""
    import ssl
    context = ssl.create_default_context()
    incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
    tls = context.wrap_bio(incoming, outgoing, server_hostname=name)
    try:
        tls.do_handshake()
    except ssl.SSLWantReadError:
        pass
    return outgoing.read()


def test_the_sni_is_read_from_a_real_client_hello():
    assert ingress.server_name(client_hello("acme-widgets-babf3e111073ee33.localhost")) == \
        "acme-widgets-babf3e111073ee33.localhost"
    assert ingress.server_name(b"\x16\x03\x01\x00\x05garbage") is None


async def recording_server(greeting=b""):
    """An upstream that says `greeting` on connect, then echoes; `seen` is
    every byte it was sent."""
    seen = bytearray()

    async def serve(reader, writer):
        if greeting:
            writer.write(greeting)
            await writer.drain()
        while data := await reader.read(65536):
            seen.extend(data)
            writer.write(b"echo:" + data)
            await writer.drain()
        writer.close()
    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1], seen


async def forward(root, owner="acme__widgets", greeting=b""):
    upstream, upstream_port, seen = await recording_server(greeting)
    host_port = free_port()
    forwarder = ingress.Ingress(str(root), subnets_source=loopback_as_bridge)
    write(root / "dinds" / "desolate-dind-acme", "127.0.0.1\n")
    write(root / "ports" / str(host_port), f"desolate-dind-acme:{upstream_port}{' ' + owner if owner else ''}\n")
    await forwarder.reconcile()
    return upstream, host_port, seen, forwarder


async def exchange(port, payload, wait=2.0):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    if payload:
        writer.write(payload)
        await writer.drain()
    try:
        data = await asyncio.wait_for(reader.read(65536), wait)
    except asyncio.TimeoutError:
        data = None
    writer.close()
    return data


def request(host, extra=b""):
    return b"GET / HTTP/1.1\r\nHost: " + host.encode() + b"\r\nUser-Agent: t\r\n" + extra + b"\r\n"


OWN = HOSTS["acme__widgets"]


def test_a_request_for_its_own_host_is_forwarded(root):
    async def scenario():
        upstream, port, seen, forwarder = await forward(root)
        data = await exchange(port, request(f"{OWN}:{port}"))
        assert data.startswith(b"echo:GET / HTTP/1.1"), data
        assert bytes(seen).startswith(b"GET / HTTP/1.1"), "the bytes read to check it were not passed on"
        upstream.close()
        await forwarder.listeners[port].close()
    asyncio.run(scenario())


@pytest.mark.parametrize("named", [
    "desolate.localhost:{port}",            # the outer editor's
    HOSTS["solo"] + ":{port}",              # another target's
    "127.0.0.1:{port}",                     # the shared jar every editor used to be in
    OWN,                                    # its own name at another port
    OWN.upper() + ":{port}0",
])
def test_a_request_for_another_name_is_refused_and_reaches_nothing(root, named):
    async def scenario():
        upstream, port, seen, forwarder = await forward(root)
        data = await exchange(port, request(named.format(port=port)))
        assert data.startswith(b"HTTP/1.1 421 "), data
        assert bytes(seen) == b"", "the upstream saw a request it should not have"
        upstream.close()
        await forwarder.listeners[port].close()
    asyncio.run(scenario())


def test_the_host_is_matched_without_case(root):
    async def scenario():
        upstream, port, seen, forwarder = await forward(root)
        assert (await exchange(port, request(f"{OWN.upper()}:{port}"))).startswith(b"echo:")
        upstream.close()
        await forwarder.listeners[port].close()
    asyncio.run(scenario())


def test_two_host_headers_are_refused(root):
    async def scenario():
        upstream, port, seen, forwarder = await forward(root)
        data = await exchange(port, request(f"{OWN}:{port}", b"Host: desolate.localhost:3000\r\n"))
        assert data.startswith(b"HTTP/1.1 421 ") and bytes(seen) == b""
        upstream.close()
        await forwarder.listeners[port].close()
    asyncio.run(scenario())


def test_a_forward_that_names_no_owner_takes_no_http_at_all(root):
    async def scenario():
        upstream, port, seen, forwarder = await forward(root, owner=None)
        data = await exchange(port, request(f"{OWN}:{port}"))
        assert data.startswith(b"HTTP/1.1 421 ") and bytes(seen) == b""
        upstream.close()
        await forwarder.listeners[port].close()
    asyncio.run(scenario())


def test_tls_is_forwarded_for_its_own_name_only(root):
    async def scenario():
        upstream, port, seen, forwarder = await forward(root)
        own = client_hello(OWN)
        assert (await exchange(port, own)) == b"echo:" + own
        before = len(seen)
        assert await exchange(port, client_hello("desolate.localhost")) in (b"", None)
        assert len(seen) == before, "a ClientHello for another name reached the upstream"
        upstream.close()
        await forwarder.listeners[port].close()
    asyncio.run(scenario())


@pytest.mark.parametrize("payload", [
    b"\x00\x00\x00\x08\x04\xd2\x16\x2f",   # Postgres SSLRequest
    b"*1\r\n$4\r\nPING\r\n",                 # Redis
    b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",     # h2c prior knowledge: no browser sends it
    b"hi",
])
def test_what_no_browser_sends_passes_as_before(root, payload):
    async def scenario():
        upstream, port, seen, forwarder = await forward(root)
        assert (await exchange(port, payload)) == b"echo:" + payload
        upstream.close()
        await forwarder.listeners[port].close()
    asyncio.run(scenario())


def test_a_server_first_protocol_still_works(root, monkeypatch):
    monkeypatch.setattr(ingress, "FIRST_BYTES_SECONDS", 0.2)
    async def scenario():
        upstream, port, seen, forwarder = await forward(root, greeting=b"220 smtp.example ESMTP\r\n")
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        assert await asyncio.wait_for(reader.read(1024), 2) == b"220 smtp.example ESMTP\r\n"
        writer.write(b"EHLO mac\r\n")
        await writer.drain()
        assert await asyncio.wait_for(reader.read(1024), 2) == b"echo:EHLO mac\r\n"
        writer.close()
        upstream.close()
        await forwarder.listeners[port].close()
    asyncio.run(scenario())


def test_a_server_that_answers_before_it_is_asked_is_not_passed_on(root, monkeypatch):
    # Chrome sends a request on a PRECONNECTED socket with bytes already waiting
    # on it: a status line sent first would be read as the answer, under
    # whatever name the socket was opened for.
    monkeypatch.setattr(ingress, "FIRST_BYTES_SECONDS", 0.2)
    async def scenario():
        forged = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi"
        for greeting in (forged, b"\r\n" + forged, forged.lower()):
            upstream, port, seen, forwarder = await forward(root, greeting=greeting)
            assert await exchange(port, b"", wait=1.0) in (b"", None)
            upstream.close()
            await forwarder.listeners[port].close()
    asyncio.run(scenario())


def test_control_without_the_wait_the_forged_answer_does_arrive(root, monkeypatch):
    # The control for the test above: with the client's bytes sent at once the
    # forged status line is what comes back -- echoed after the request, here,
    # because the check passed; the point is the fixture does send it.
    async def scenario():
        upstream, port, seen, forwarder = await forward(root, greeting=b"HTTP/1.1 200 OK\r\n\r\n")
        data = await exchange(port, request(f"{OWN}:{port}"))
        assert data.startswith(b"HTTP/1.1 200 OK"), data
        upstream.close()
        await forwarder.listeners[port].close()
    asyncio.run(scenario())


def test_http_on_a_server_first_connection_is_cut_off(root, monkeypatch):
    monkeypatch.setattr(ingress, "FIRST_BYTES_SECONDS", 0.2)
    async def scenario():
        upstream, port, seen, forwarder = await forward(root, greeting=b"220 hello\r\n")
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        assert await asyncio.wait_for(reader.read(1024), 2) == b"220 hello\r\n"
        writer.write(request(f"{OWN}:{port}"))
        await writer.drain()
        assert await asyncio.wait_for(reader.read(1024), 2) == b""
        assert bytes(seen) == b""
        writer.close()
        upstream.close()
        await forwarder.listeners[port].close()
    asyncio.run(scenario())
