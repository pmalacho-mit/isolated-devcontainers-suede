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
    <root>/ports/<host-port>   one line: <dind-name>:<port>
                               (written by desolate.ts once a relay is up)

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


def parse_target(content):
    """`<dind-name>:<port>` -> (dind, port)."""
    match = re.fullmatch(r"([^:\s]+):([0-9]{1,5})\s*", content)
    if not match:
        raise Refused(f"content {content.strip()[:60]!r} is not <dind-name>:<port>")
    dind, port = match.group(1), int(match.group(2))
    if not DIND_NAME.match(dind):
        raise Refused(f"{dind!r} is not a dind name")
    if not 1 <= port <= MAX_PORT:
        raise Refused(f"target port {port} is out of range")
    return dind, port


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
    Returns ({host_port: (address, port)}, [refusal messages])."""
    wanted, refusals = {}, []
    for filename, content in sorted(ports.items()):
        try:
            host_port = parse_host_port(filename)
            dind, port = parse_target(content)
            if dind not in dinds:
                raise Refused(f"no dind named {dind!r} under dinds/")
            address = check_address(dinds[dind], subnets)
            wanted[host_port] = (str(address), port)
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

    def __init__(self, host_port, target):
        self.host_port, self.target = host_port, target
        self.servers, self.connections = [], set()

    async def open(self, addresses):
        for address in addresses:
            self.servers.append(await asyncio.start_server(self._accept, address, self.host_port))

    async def _accept(self, client_reader, client_writer):
        task = asyncio.current_task()
        self.connections.add(task)
        address, port = self.target
        try:
            upstream_reader, upstream_writer = await asyncio.wait_for(
                asyncio.open_connection(address, port), 5)
        except (OSError, asyncio.TimeoutError) as err:
            log.info("ports/%s: %s:%s did not answer (%s)", self.host_port, address, port, err)
            client_writer.close()
            self.connections.discard(task)
            return
        try:
            await asyncio.gather(_pump(client_reader, upstream_writer),
                                 _pump(upstream_reader, client_writer))
        finally:
            self.connections.discard(task)

    async def close(self):
        for server in self.servers:
            server.close()
        for task in list(self.connections):
            task.cancel()
        for server in self.servers:
            await server.wait_closed()
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
                log.warning("REFUSED ports/%s: cannot listen (%s)", host_port, err)
                continue
            self.listeners[host_port] = listener
            log.info("OPEN  127.0.0.1:%s -> %s:%s", host_port, *target)

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
