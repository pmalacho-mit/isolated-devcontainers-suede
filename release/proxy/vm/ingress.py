"""
desolate-ingress: the VM-side forwarder that carries a project's dev-server
ports to the Mac, with no published port range anywhere.

    Mac 127.0.0.1:P --(Lima)--> VM 127.0.0.1:P   this process
                    --> <dind-ip>:Q              a project dind, on its br-d-* bridge
                    --> (inner publish Q:Q)      the relay, inside that dind
                    --> devcontainer:port

Lima forwards any VM listener on 127.0.0.1 to the Mac's 127.0.0.1, dynamically
(tests/probes/vm-loopback-forward.sh), and the VM reaches a sysbox dind's inner
publish at the dind's own bridge address (tests/probes/dind-reach-from-vm.sh).
So a host port is a listener this process opens on demand. Nothing is published
by docker, and nothing in the container world gains a route it lacks today.

WHAT IT READS. Two directories, written by others, polled:

    <root>/dinds/<dind-name>   one line: that dind's address on its bridge
                               (written by the supervisor, which creates them)
    <root>/ports/<host-port>   one line: <dind-name>:<port> [<owner>]
                               (claimed by desolate.ts when it allocates the
                               port, the owner being the target that did)

A file appearing opens a listener; a file vanishing closes it and drops its
connections; a file REWRITTEN closes and reopens it. The reopen is load-bearing:
when the Mac already holds a port, Lima forwards nothing and never retries
(L6), so a fresh listener is the only way back -- `desolate --ports --move`
rewrites the file for exactly that.

WHAT IT REFUSES, here and not in its writers. The orchestrator writes `ports/`
and is the component most exposed to projects, so every bound is enforced in
this process, and anything outside them is logged and ignored:

  - a host port that is not an integer in 1024..65535. Below 1024, Lima
    forwards a VM loopback listener to EVERY interface on the Mac, i.e. onto
    the LAN (L3) -- refusing those is a security bound, not hygiene;
  - a dind that is not listed under dinds/;
  - an address outside a desolate bridge's subnet (br-d-*, br-desolate-in),
    read from `ip -j addr` -- so no file can aim this at the internet, at the
    VM, or at another network's containers;
  - a bridge's own (gateway) address. That address is the VM: forwarding to it
    would expose VM services such as the proxy's :18080 to the Mac.

WHOSE NAME A REQUEST MAY USE. Each forward answers its own target's host
alone (hosts.ts): a cookie is scoped by host, never by port, so a port that
served a page under ANY name a browser could be pointed at -- the outer
editor's `desolate.localhost`, another target's -- would hand that page the
cookies of that name, the editors' connection tokens among them. So, on each
connection, before a byte goes either way:

  - an HTTP/1.x request must carry one Host, `<its host>:<host port>`;
  - a TLS ClientHello must name its host as SNI;
  - anything else -- Postgres, Redis, h2c, a protocol of its own -- is not
    something a browser can send, and passes as it always did.

A client that sends nothing is taken for a server-first protocol (MySQL,
SMTP, SSH) after FIRST_BYTES_SECONDS, and the server's greeting is passed only
if it does not look like an HTTP response: Chrome sends a request on a
PRECONNECTED socket with bytes already waiting on it, so a dev server that
answered before it was asked could otherwise land its page under a name that
is not its own. A client that then speaks HTTP or TLS on it is cut off.

It binds 127.0.0.1 only (L2: a 0.0.0.0 listener reaches the Mac's LAN too).
DESOLATE_INGRESS_BIND may add addresses for remote sessions later; unset, the
default, is loopback alone.

Python 3 stdlib only, run as its own uid `desolate-ingress`, whose nftables
output rule lets it dial the desolate bridges and nothing else.

Directories are POLLED rather than watched with inotify, which the stdlib does
not provide: a scan of two directories holding a few dozen one-line files every
POLL_SECONDS costs nothing, and a missed event cannot exist.
"""

import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import re
import subprocess
import sys
import time

ROOT = os.environ.get("DESOLATE_INGRESS_ROOT", "/run/desolate-ingress")
POLL_SECONDS = float(os.environ.get("DESOLATE_INGRESS_POLL", "0.25"))
LOOPBACK = "127.0.0.1"
MIN_HOST_PORT, MAX_PORT = 1024, 65535

# Interfaces whose subnets hold forwardable addresses. The hyphen in `br-d-` is
# the whole margin between "every project bridge" and "any interface whose name
# starts br-d" (tests/probes/nft-bridge-wildcard.sh).
DESOLATE_BRIDGE = re.compile(r"^(br-d-[0-9a-f]+|br-desolate-in)$")

# Names the supervisor writes under dinds/ (dind.ts `name`): desolate-dind, or
# desolate-dind-<namespace>. Anything else is not a file this reads.
DIND_NAME = re.compile(r"^desolate-dind(-[A-Za-z0-9._-]+)?$")

log = logging.getLogger("desolate-ingress")


class Refused(ValueError):
    """A file this process will not act on, and why."""


# ---------------------------------------------------------------- pure parts --

def bridge_subnets(ip_addr_json):
    """[(network, gateway)] for every desolate bridge in `ip -j addr` output.

    The gateway is the address the VM holds on that bridge -- the one address
    in the subnet that is NOT a container."""
    subnets = []
    for link in json.loads(ip_addr_json or "[]"):
        if not DESOLATE_BRIDGE.match(link.get("ifname", "")):
            continue
        for info in link.get("addr_info", []):
            if info.get("family") != "inet":
                continue
            interface = ipaddress.ip_interface(f"{info['local']}/{info['prefixlen']}")
            subnets.append((interface.network, interface.ip))
    return subnets


def parse_host_port(filename):
    # No leading zeros: `08080` would listen on 8080 while its file stays
    # `08080`, and the two spellings of one port must not both exist.
    if not re.fullmatch(r"[1-9][0-9]{0,4}", filename):
        raise Refused(f"ports/{filename!r} is not a port number")
    port = int(filename)
    if not MIN_HOST_PORT <= port <= MAX_PORT:
        raise Refused(f"host port {port} is outside {MIN_HOST_PORT}-{MAX_PORT} "
                      f"(below 1024, Lima forwards onto the Mac's LAN)")
    return port


# The target that wrote a ports/ file, so its writers can tell their own files
# from another's (desolate.ts); the forward does not depend on it.
OWNER = r"[A-Za-z0-9][A-Za-z0-9_.-]*"


def parse_target(content):
    """`<dind-name>:<port> [<owner>]` -> (dind, port, owner or None)."""
    match = re.fullmatch(rf"([^:\s]+):([0-9]{{1,5}})(?:[ \t]+({OWNER}))?\s*", content)
    if not match:
        raise Refused(f"content {content.strip()[:60]!r} is not <dind-name>:<port> [<owner>]")
    dind, port, owner = match.group(1), int(match.group(2)), match.group(3)
    if not DIND_NAME.match(dind):
        raise Refused(f"{dind!r} is not a dind name")
    if not 1 <= port <= MAX_PORT:
        raise Refused(f"target port {port} is out of range")
    return dind, port, owner


def expected_host(owner):
    """The host a forward's requests must name: hosts.ts `hostOf`, of the
    target that owns it (its namespace). The same function -- the tests hold
    the two to the same names. None for a file that names no owner, whose
    HTTP and TLS are then refused: no name is provably its own."""
    if owner is None:
        return None
    readable = re.sub(r"[^a-z0-9]+", "-", owner.lower()).lstrip("-")[:40].rstrip("-")
    digest = hashlib.sha256(owner.encode("utf-8")).hexdigest()[:16]
    return f"{readable}-{digest}.localhost" if readable else f"{digest}.localhost"


def check_address(text, subnets):
    """The dind's address, if it is one this may dial."""
    try:
        address = ipaddress.ip_address(text.strip())
    except ValueError:
        raise Refused(f"{text.strip()[:60]!r} is not an address")
    for network, gateway in subnets:
        if address in network:
            if address == gateway:
                raise Refused(f"{address} is the gateway of {network} -- the VM itself")
            if address in (network.network_address, network.broadcast_address):
                raise Refused(f"{address} is not a host address of {network}")
            return address
    raise Refused(f"{address} is not inside a desolate bridge subnet")


def desired(ports, dinds, subnets):
    """What should be listening, from the two directories' contents.

    ports:  {filename: content} under ports/
    dinds:  {filename: content} under dinds/
    Returns ({host_port: (address, port, host)}, [refusal messages])."""
    wanted, refusals = {}, []
    for filename, content in sorted(ports.items()):
        try:
            host_port = parse_host_port(filename)
            dind, port, owner = parse_target(content)
            if dind not in dinds:
                raise Refused(f"no dind named {dind!r} under dinds/")
            address = check_address(dinds[dind], subnets)
            wanted[host_port] = (str(address), port, expected_host(owner))
        except Refused as why:
            refusals.append(f"ports/{filename}: {why}")
    return wanted, refusals


def read_directory(path):
    """({filename: content}, {filename: fingerprint}) for the regular files
    directly in `path`.

    The fingerprint is (inode, mtime): the writers replace a file by atomic
    rename, so a rewrite -- even with identical content -- is a new inode, and
    a rewrite is what asks for a listener to be reopened.

    Symlinks and anything else are skipped: a link would let a writer of one
    directory point this at a file it does not own."""
    entries, fingerprints = {}, {}
    try:
        names = os.listdir(path)
    except FileNotFoundError:
        return entries, fingerprints
    for name in names:
        full = os.path.join(path, name)
        try:
            status = os.lstat(full)
            if not os.path.isfile(full) or os.path.islink(full):
                continue
            with open(full, encoding="utf-8", errors="replace") as handle:
                entries[name] = handle.read(256)
            fingerprints[name] = (status.st_ino, status.st_mtime_ns)
        except OSError:
            continue
    return entries, fingerprints


def bind_addresses():
    extra = [a.strip() for a in os.environ.get("DESOLATE_INGRESS_BIND", "").split(",") if a.strip()]
    return [LOOPBACK, *[a for a in extra if a != LOOPBACK]]


# ------------------------------------------------------- whose name, asked --

# How long a client may say nothing before it is taken for a server-first
# protocol's; and how long, and how much, a request head or ClientHello may
# take once it has begun.
FIRST_BYTES_SECONDS = float(os.environ.get("DESOLATE_INGRESS_FIRST_BYTES", "1.0"))
HEAD_SECONDS = 10.0
HEAD_LIMIT = 64 * 1024

# RFC 9110's token: what a method is spelled with. A request line is
# `<token> SP <target> SP HTTP/1.x`; a browser sends nothing else in the clear,
# and writes its request head at once -- so a first read that is not a token
# and a space is not the start of one.
TOKEN_START = re.compile(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32} ")
REQUEST_LINE = re.compile(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+ [^ \r\n]+ HTTP/1\.[01]\r?\n")


class Misdirected(Exception):
    """A request for a name that is not this port's own."""


async def _read_more(reader, buffer, until, deadline):
    """`buffer`, read into until `until(buffer)` or HEAD_LIMIT bytes; it is not
    an HTTP head or a ClientHello that takes longer than its deadline."""
    loop = asyncio.get_running_loop()
    while not until(buffer) and len(buffer) < HEAD_LIMIT:
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise Misdirected("too slow")
        chunk = await asyncio.wait_for(reader.read(HEAD_LIMIT - len(buffer)), remaining)
        if not chunk:
            break
        buffer += chunk
    return buffer


def server_name(hello):
    """The SNI of a TLS record holding a ClientHello, or None."""
    try:
        if hello[0] != 0x16 or hello[5] != 0x01:
            return None
        at = 5 + 4 + 2 + 32                       # record, handshake header, version, random
        at += 1 + hello[at]                        # session id
        at += 2 + int.from_bytes(hello[at:at + 2], "big")   # cipher suites
        at += 1 + hello[at]                        # compression methods
        end = at + 2 + int.from_bytes(hello[at:at + 2], "big")
        at += 2
        while at + 4 <= end:
            kind, length = int.from_bytes(hello[at:at + 2], "big"), int.from_bytes(hello[at + 2:at + 4], "big")
            if kind == 0:                          # server_name: list, type 0 (host_name), name
                body = hello[at + 4:at + 4 + length]
                if body[2] != 0:
                    return None
                size = int.from_bytes(body[3:5], "big")
                return body[5:5 + size].decode("ascii").lower()
            at += 4 + length
    except (IndexError, UnicodeDecodeError):
        return None
    return None


def request_host(head):
    """The one Host of an HTTP/1.x request head, lowercased; None for none, or
    for more than one."""
    lines = head.split(b"\r\n\r\n", 1)[0].split(b"\n")[1:]
    hosts = [line.split(b":", 1)[1].strip() for line in lines if line.lower().startswith(b"host:")]
    if len(hosts) != 1:
        return None
    try:
        return hosts[0].decode("ascii").lower()
    except UnicodeDecodeError:
        return None


async def classify(reader, first, deadline):
    """What a client's first bytes are: ("tls", bytes, sni), ("http", bytes,
    host), or ("other", bytes, None) -- with every byte read so far, to pass
    on."""
    if first[:1] == b"\x16":
        def whole_record(buffer):
            return len(buffer) >= 5 and len(buffer) >= 5 + int.from_bytes(buffer[3:5], "big")
        first = await _read_more(reader, first, whole_record, deadline)
        return "tls", first, server_name(first)
    if not TOKEN_START.match(first):
        return "other", first, None
    first = await _read_more(reader, first, lambda buffer: b"\n" in buffer, deadline)
    if not REQUEST_LINE.match(first):
        return "other", first, None
    first = await _read_more(reader, first, lambda buffer: b"\r\n\r\n" in buffer or b"\n\n" in buffer, deadline)
    return "http", first, request_host(first)


def admits(kind, named, host, host_port):
    """Whether a request of this kind, naming `named`, is this port's own."""
    if kind == "other":
        return True
    if host is None:
        return False
    return named == (host if kind == "tls" else f"{host}:{host_port}")


def looks_like_http_response(greeting):
    # Chrome finds a status line a few bytes in (LocateStartOfStatusLine), and
    # case does not matter to it.
    return b"http" in greeting[:16].lower()


async def _cancelled(task):
    """Cancelled AND finished -- a stream allows one reader at a time, and a
    cancelled read still holds it until the loop has run it out. What it read,
    if it finished first."""
    task.cancel()
    try:
        return await task
    except asyncio.CancelledError:
        return b""


MISDIRECTED = (b"HTTP/1.1 421 Misdirected Request\r\nContent-Type: text/plain\r\n"
               b"Connection: close\r\n\r\n")


# ---------------------------------------------------------------- forwarding --

async def _pump(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


class Listener:
    """One host port: its servers, its target, and its live connections."""

    # How long a close waits for its servers: on 3.12.1+ wait_closed() waits
    # for every connection too, and the aborts below should make that instant.
    CLOSE_SECONDS = 2

    def __init__(self, host_port, target):
        self.host_port, self.target = host_port, target
        self.servers, self.connections, self.transports = [], set(), set()

    async def open(self, addresses):
        for address in addresses:
            self.servers.append(await asyncio.start_server(self._accept, address, self.host_port))

    async def _connect(self):
        """The upstream connection, tracked from the start: a close() while it
        is still being admitted aborts it too."""
        address, port, _ = self.target
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_connection(address, port), 5)
        except (OSError, asyncio.TimeoutError) as err:
            log.info("ports/%s: %s:%s did not answer (%s)", self.host_port, address, port, err)
            return None
        self.transports.add(writer.transport)
        return reader, writer

    def _drop(self, writer):
        self.transports.discard(writer.transport)
        writer.close()

    def _refuse(self, kind, named, writer):
        _, _, host = self.target
        log.warning("REFUSED 127.0.0.1:%s: a %s request for %r; it answers %s only",
                    self.host_port, kind, named, f"{host}:{self.host_port}" if host else "no name")
        if kind == "http":
            writer.write(MISDIRECTED + f"desolate-ingress: this port answers "
                         f"http://{host}:{self.host_port}/ only\n".encode() if host else MISDIRECTED)

    async def _admit(self, client_reader, client_writer):
        """(upstream reader, upstream writer, the server-to-client pump if it
        has begun), with whatever the client sent already written upstream --
        or None, having refused. See WHOSE NAME."""
        _, _, host = self.target
        loop = asyncio.get_running_loop()
        try:
            first = await asyncio.wait_for(client_reader.read(HEAD_LIMIT), FIRST_BYTES_SECONDS)
        except asyncio.TimeoutError:
            first = None
        if first == b"":
            return None
        if first is not None:
            kind, sent, named = await classify(client_reader, first, loop.time() + HEAD_SECONDS)
            if not admits(kind, named, host, self.host_port):
                return self._refuse(kind, named, client_writer)
            upstream = await self._connect()
            if upstream is None:
                return None
            upstream[1].write(sent)
            return (*upstream, None)

        # Server-first, by the look of it: whichever side speaks first decides.
        upstream = await self._connect()
        if upstream is None:
            return None
        upstream_reader, upstream_writer = upstream
        from_client = asyncio.ensure_future(client_reader.read(HEAD_LIMIT))
        from_server = asyncio.ensure_future(upstream_reader.read(HEAD_LIMIT))
        done, _ = await asyncio.wait({from_client, from_server}, return_when=asyncio.FIRST_COMPLETED)
        if from_client in done:
            # Both at once, rarely: what the server said is passed on once the
            # client's request has been admitted, and not before.
            early = await _cancelled(from_server)
            first = from_client.result()
            if not first:
                self._drop(upstream_writer)
                return None
            kind, sent, named = await classify(client_reader, first, loop.time() + HEAD_SECONDS)
            if not admits(kind, named, host, self.host_port):
                self._drop(upstream_writer)
                return self._refuse(kind, named, client_writer)
            upstream_writer.write(sent)
            if early:
                client_writer.write(early)
            return (*upstream, None)
        await _cancelled(from_client)
        greeting = from_server.result()
        if not greeting or looks_like_http_response(greeting):
            if greeting:
                log.warning("REFUSED 127.0.0.1:%s: the server spoke HTTP before it was asked", self.host_port)
            self._drop(upstream_writer)
            return None
        # Past a first chunk that is not a status line, nothing the server
        # sends can be read as a response to anything (HTTP/0.9 is refused off
        # ports 80 and 443), so the rest flows as it comes.
        client_writer.write(greeting)
        to_client = asyncio.ensure_future(_pump(upstream_reader, client_writer))
        # The client's first bytes still decide: a browser on this socket is
        # one that did not wait for an answer to a request it never sent.
        first = await client_reader.read(HEAD_LIMIT)
        kind, sent, _ = await classify(client_reader, first, loop.time() + HEAD_SECONDS) if first else ("other", b"", None)
        if not first or kind != "other":
            if first:
                log.warning("REFUSED 127.0.0.1:%s: %s on a server-first connection", self.host_port, kind)
            to_client.cancel()
            self._drop(upstream_writer)
            return None
        upstream_writer.write(sent)
        return upstream_reader, upstream_writer, to_client

    async def _accept(self, client_reader, client_writer):
        task = asyncio.current_task()
        self.connections.add(task)
        self.transports.add(client_writer.transport)
        upstream = None
        try:
            try:
                upstream = await self._admit(client_reader, client_writer)
            except (OSError, Misdirected, asyncio.TimeoutError):
                upstream = None
            if upstream is None:
                try:
                    await client_writer.drain()
                except ConnectionError:
                    pass
                client_writer.close()
                return
            upstream_reader, upstream_writer, to_client = upstream
            await asyncio.gather(_pump(client_reader, upstream_writer),
                                 to_client or _pump(upstream_reader, client_writer))
        finally:
            if upstream is not None:
                self.transports.discard(upstream[1].transport)
            self.connections.discard(task)
            self.transports.discard(client_writer.transport)

    async def close(self):
        """Closed, and every connection with it -- ABORTED, not closed: a close
        flushes first, so a peer that stopped reading would hold it, and with
        it wait_closed() and every port behind it in reconcile(), for ever."""
        for server in self.servers:
            server.close()
        for transport in list(self.transports):
            transport.abort()
        for task in list(self.connections):
            task.cancel()
        for server in self.servers:
            try:
                await asyncio.wait_for(server.wait_closed(), self.CLOSE_SECONDS)
            except asyncio.TimeoutError:
                log.warning("ports/%s: closed without waiting for its connections", self.host_port)
        self.servers.clear()


SUBNETS_SECONDS = 5.0


class Ingress:
    def __init__(self, root=ROOT, subnets_source=None, addresses=None, clock=None):
        self.root = root
        self.subnets_source = subnets_source or _ip_addr_json
        self.addresses = addresses or bind_addresses()
        self.clock = clock or time.monotonic
        self.listeners = {}
        self._last_refusals = set()
        self._cannot_listen = {}
        self._fingerprints = {}
        self._dinds_seen = None
        self._subnets, self._subnets_at = [], None

    def _current_subnets(self, dinds_changed):
        """`ip -j addr`, re-read when dinds/ changed (a new bridge came with a
        new dind) and otherwise every SUBNETS_SECONDS, not every poll."""
        now = self.clock()
        if dinds_changed or self._subnets_at is None or now - self._subnets_at >= SUBNETS_SECONDS:
            self._subnets = bridge_subnets(self.subnets_source())
            self._subnets_at = now
        return self._subnets

    async def reconcile(self):
        ports, fingerprints = read_directory(os.path.join(self.root, "ports"))
        dinds, dind_prints = read_directory(os.path.join(self.root, "dinds"))
        dinds_changed = dind_prints != self._dinds_seen
        self._dinds_seen = dind_prints
        wanted, refusals = desired(ports, dinds, self._current_subnets(dinds_changed))

        # Say each refusal once, not every poll.
        for message in sorted(set(refusals) - self._last_refusals):
            log.warning("REFUSED %s", message)
        self._last_refusals = set(refusals)

        for host_port in list(self.listeners):
            rewritten = self._fingerprints.get(str(host_port)) != fingerprints.get(str(host_port))
            if host_port not in wanted or wanted[host_port] != self.listeners[host_port].target or rewritten:
                await self.listeners.pop(host_port).close()
                log.info("CLOSE 127.0.0.1:%s", host_port)

        for host_port, target in wanted.items():
            if host_port in self.listeners:
                continue
            listener = Listener(host_port, target)
            try:
                await listener.open(self.addresses)
            except OSError as err:
                await listener.close()
                # Retried every poll, said once per rewrite of the file.
                if self._cannot_listen.get(host_port) != fingerprints.get(str(host_port)):
                    log.warning("REFUSED ports/%s: cannot listen (%s)", host_port, err)
                self._cannot_listen[host_port] = fingerprints.get(str(host_port))
                continue
            self._cannot_listen.pop(host_port, None)
            self.listeners[host_port] = listener
            log.info("OPEN  127.0.0.1:%s -> %s:%s as %s", host_port, *target)

        self._fingerprints = fingerprints

    async def run(self):
        while True:
            try:
                await self.reconcile()
            except Exception:
                log.exception("reconcile failed; keeping the listeners as they were")
            await asyncio.sleep(POLL_SECONDS)


def _ip_addr_json():
    return subprocess.run(["ip", "-j", "addr"], capture_output=True, text=True, check=True).stdout


def main():
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s")
    log.info("desolate-ingress watching %s, binding %s", ROOT, ",".join(bind_addresses()))
    asyncio.run(Ingress().run())


if __name__ == "__main__":
    main()
