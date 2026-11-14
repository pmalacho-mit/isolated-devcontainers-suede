// The compose devcontainer's network, as the workspace VM sees it. Runs INSIDE the project's
// primary compose service, as the VM's user, started by devcontainer.ts:
//
//   <the editor's node> svcnet.ts /run/desolate/svcnet.sock
//
// WHY. A single-container spec runs on the VM's network, so a dev server in it is a listener
// in the VM and the host's forwarder publishes it with nothing declared. A compose service
// keeps its own network (it must: its neighbours are reached by service name), so what
// listens in it, even on its loopback, is invisible to the VM. This answers on a unix socket
// in /run/desolate (a directory the container shares with the VM) and is the VM's way into
// that network; wsd.ts (bridge.ts) mirrors each listener here onto the VM's loopback, where
// the forwarder finds it as it finds any other. The same way in carries `forwardPorts`
// written `service:port`: connected from here, the name resolves as the app resolves it.
//
// Nothing here is a boundary (P5): the service, the VM and this program are all the domain's.
// The socket is the VM user's alone (0600), and it is asked for two things:
//   L\n                       the TCP ports listening in this network namespace, as JSON
//   C <host|-> <port>\n       a connection to that host and port (-: the listener on that
//                             port here), then the bytes both ways
import * as fs from "node:fs";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";

type Listener = { port: number; address: string };
/** /proc/net/tcp{,6}: state 0A is LISTEN; addresses are hex, in the kernel's byte order. */
export const listening = (): Listener[] => {
  const out = new Map<number, Listener>();
  for (const [file, v6] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]] as const) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== "0A" || !fields[1]) continue;
      const [hex, portHex] = fields[1].split(":");
      const port = parseInt(portHex ?? "", 16);
      if (!Number.isInteger(port) || !hex) continue;
      const address = v6 ? addressV6(hex) : addressV4(hex);
      // A port held on IPv4 and IPv6 both: either reaches it; keep the first.
      if (!out.has(port)) out.set(port, { port, address });
    }
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
};
const addressV4 = (hex: string) => (hex.match(/../g) ?? []).reverse().map((byte) => parseInt(byte, 16)).join(".");
const addressV6 = (hex: string) => {
  // Four 32-bit words, each in host (little-endian) order.
  const words = (hex.match(/.{8}/g) ?? []).map((word) => (word.match(/../g) ?? []).reverse().join(""));
  const groups = words.join("").match(/.{4}/g) ?? [];
  const text = groups.map((g) => g.replace(/^0+(?=.)/, "")).join(":");
  if (/^0:0:0:0:0:0:0:0$/.test(text)) return "::";
  if (/^0:0:0:0:0:0:0:1$/.test(text)) return "::1";
  const mapped = /^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(text);
  if (mapped) {
    const a = parseInt(mapped[1]!, 16);
    const b = parseInt(mapped[2]!, 16);
    return [a >> 8, a & 255, b >> 8, b & 255].join(".");
  }
  return text;
};
/** Where to reach the listener on a port: a wildcard is reached at loopback. */
const targetOf = (port: number): string => {
  const found = listening().find((l) => l.port === port);
  if (!found || found.address === "0.0.0.0") return "127.0.0.1";
  if (found.address === "::") return "::1";
  return found.address;
};

const DOCKER_DNS = "127.0.0.11";
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$|^[0-9a-fA-F:.]{2,45}$/;
const serve = (client: Socket) => {
  client.on("error", () => client.destroy());
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf(10);
    if (end < 0) {
      if (head.length > 512) client.destroy();
      return;
    }
    client.off("data", onData);
    const line = head.subarray(0, end).toString().trim();
    const rest = head.subarray(end + 1);
    // Not docker's own resolver, which every container on a compose network has at 127.0.0.11.
    if (line === "L") return void client.end(JSON.stringify(listening().filter((l) => l.address !== DOCKER_DNS).map((l) => l.port)) + "\n");
    const ask = /^C (\S+) (\d{1,5})$/.exec(line);
    const port = Number(ask?.[2]);
    if (!ask || port < 1 || port > 65535 || (ask[1] !== "-" && !HOST.test(ask[1]!))) return void client.destroy();
    client.pause();
    const upstream = connect({ host: ask[1] === "-" ? targetOf(port) : ask[1], port });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    upstream.on("connect", () => {
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  };
  client.on("data", onData);
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const socket = process.argv[2] ?? "";
  if (!/^\/run\/desolate\/[a-z0-9-]+\.sock$/.test(socket)) {
    console.error("usage: svcnet.ts /run/desolate/<name>.sock");
    process.exit(64);
  }
  fs.rmSync(socket, { force: true });
  const server = createServer(serve);
  server.on("error", (error) => {
    console.error(`svcnet: ${error.message}`);
    process.exit(1);
  });
  server.listen(socket, () => fs.chmodSync(socket, 0o600));
}
