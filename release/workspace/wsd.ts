// desolate's daemon in a workspace VM (sections 4.4, 6.5). It runs as the workspace's user,
// with the domain's trust: if an agent that is root here tampers with it, it can only lie
// about its own VM, and the host (the authority) still forwards nothing it should not.
//
//   ports     which TCP ports are listening here (for the host's forwarder to publish), and
//             which the host asks this VM to keep taken, so a dev server moves to the next
//             number instead of colliding with one that cannot be shared by name.
//
// The host speaks to it through `wsctl.ts`, over the VM layer's exec: port numbers in, taken
// ports out, nothing else.
import * as fs from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { run } from "../shared/run.ts";

const SOCKET = "/run/desolate/wsd.sock";
/** desolate's own listeners in the VM: never offered for forwarding. */
const INTERNAL = new Set([15080, 15443]);

const reserved = new Map<number, Server>();
const reserve = (wanted: number[]) => {
  const want = new Set(wanted.filter((port) => Number.isInteger(port) && port >= 1024 && port <= 65535));
  for (const [port, server] of reserved)
    if (!want.has(port)) {
      server.close();
      reserved.delete(port);
    }
  for (const port of want) {
    if (reserved.has(port)) continue;
    // Hold the port and refuse whoever connects: a program that tries the next number when
    // one is taken (Vite without --strictPort) then moves on.
    const server = createServer((socket) => socket.destroy());
    server.on("error", () => reserved.delete(port));
    server.listen({ port, host: "0.0.0.0", exclusive: true });
    reserved.set(port, server);
  }
};

const listeners = async () => {
  const result = await run("ss", ["-H", "-ltn"], { timeoutMs: 5000 });
  const ports = new Set<number>();
  for (const line of result.stdout.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const at = local.lastIndexOf(":");
    const port = Number(local.slice(at + 1));
    const address = local.slice(0, at).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    if (!Number.isInteger(port) || port < 1024 || INTERNAL.has(port) || reserved.has(port)) continue;
    // Loopback and wildcard listeners: what a dev server binds. Not the docker bridge's.
    if (!["0.0.0.0", "127.0.0.1", "*", "::", "::1"].includes(address)) continue;
    ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
};

fs.mkdirSync("/run/desolate", { recursive: true });
fs.rmSync(SOCKET, { force: true });
createServer((connection) => {
  let buffer = "";
  connection.on("error", () => connection.destroy());
  connection.on("data", async (chunk) => {
    buffer += chunk.toString();
    const end = buffer.indexOf("\n");
    if (end < 0) return buffer.length > 65536 ? connection.destroy() : undefined;
    let reply: unknown;
    try {
      const request = JSON.parse(buffer.slice(0, end)) as { op?: string; reserve?: unknown };
      if (request.op === "ports") {
        if (Array.isArray(request.reserve)) reserve(request.reserve.map(Number));
        reply = { ok: true, listeners: await listeners(), reserved: [...reserved.keys()].sort((a, b) => a - b) };
      } else reply = { ok: false, error: "unknown op" };
    } catch (error) {
      reply = { ok: false, error: String(error) };
    }
    connection.end(JSON.stringify(reply) + "\n");
  });
}).listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600));
