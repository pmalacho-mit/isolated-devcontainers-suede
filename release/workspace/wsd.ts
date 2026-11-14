// desolate's daemon in a workspace VM (sections 4.4, 6.5). It runs as the workspace's user,
// with the domain's trust: if an agent that is root here tampers with it, it can only lie
// about its own VM, and the host (the authority) still forwards nothing it should not.
//
//   branches  when a branch of the domain's moves, an incremental bundle and the list of refs
//             go to the outbox, so the root always sees every domain's branches (6.5); and
//             what the root delivered to the inbox is imported as root/<branch>.
//   ports     which TCP ports are listening here (for the host's forwarder to publish), and
//             which the host asks this VM to keep taken, so a dev server moves to the next
//             number instead of colliding with one that cannot be shared by name.
//   compose   a compose devcontainer's listeners, and its `service:port` forwards, mirrored
//             onto this VM's loopback (bridge.ts), so they are listeners here like any other.
//
// The host speaks to it through `wsctl.ts`, over the VM layer's exec: port numbers in, taken
// ports out, nothing else.
import * as fs from "node:fs";
import * as os from "node:os";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { run, sleep } from "../shared/run.ts";
import { tick as bridgeTick } from "./bridge.ts";
import { branches, domainRepos, importDeliveries, syncRepo } from "./sync.ts";

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

/** What the host shows about this workspace without asking again: the editor's token (the
 *  host builds the address) and one line about the devcontainer. */
const surfaces = (): { editorToken?: string; devcontainer?: string; folder?: string } => {
  const out: { editorToken?: string; devcontainer?: string; folder?: string } = {};
  try {
    const token = fs.readFileSync(`${os.homedir()}/.desolate-editor/token`, "utf8").trim();
    if (/^[0-9a-f]{48}$/.test(token)) out.editorToken = token;
  } catch {
    /* no editor yet */
  }
  try {
    const d = JSON.parse(fs.readFileSync("/run/desolate/devcontainer.json", "utf8")) as { state?: string; why?: string; image?: string; remoteUser?: string; checkout?: string };
    out.devcontainer = d.state === "up" ? `up (${String(d.image).slice(0, 80)}, user ${String(d.remoteUser).slice(0, 40)})` : d.state === "failed" ? `FAILED: ${String(d.why).slice(0, 300)}` : "none";
    if (typeof d.checkout === "string") out.folder = d.checkout.slice(0, 300);
  } catch {
    /* not decided yet */
  }
  return out;
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
        reply = { ok: true, listeners: await listeners(), reserved: [...reserved.keys()].sort((a, b) => a - b), ...surfaces() };
      } else reply = { ok: false, error: "unknown op" };
    } catch (error) {
      reply = { ok: false, error: String(error) };
    }
    connection.end(JSON.stringify(reply) + "\n");
  });
}).listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600));

// The domain's refs, watched by comparing them every few seconds (a shared .git on virtiofs
// delivers no file events across VMs). Every workspace of a domain does this; the bundles
// are idempotent, so two writing the same refs is harmless.
const seen = new Map<string, string>();
const watch = async () => {
  for (;;) {
    for (const repo of domainRepos()) {
      try {
        const now = JSON.stringify(await branches(repo));
        if (seen.get(repo) !== now) {
          // Debounce: a rebase moves a branch many times in a second.
          await sleep(500);
          await syncRepo(repo);
          seen.set(repo, JSON.stringify(await branches(repo)));
        }
        await importDeliveries(repo);
      } catch (error) {
        console.error(`wsd: ${repo}: ${String(error)}`);
      }
    }
    await sleep(3000);
  }
};
void watch();

const bridge = async () => {
  for (;;) {
    await bridgeTick().catch((error: unknown) => console.error(`wsd: compose ports: ${String(error)}`));
    await sleep(1000);
  }
};
void bridge();
