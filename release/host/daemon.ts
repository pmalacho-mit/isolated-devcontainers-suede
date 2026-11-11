// The host daemon: one per stack, outside every VM (P5). Two jobs.
//
// THE FORWARDER (section 4.4). One listener per port on the host's 127.0.0.1, never another
// address. A port is published under the number it has inside the VM, with nothing declared:
// the daemon asks each workspace's own daemon what is listening. Several workspaces share a
// number BY NAME: each connection is routed by its HTTP Host or TLS SNI to the workspace
// that name belongs to, and a request that names no workspace gets 421 and reaches nothing.
// What has no name in its protocol (Postgres, Redis) reaches the first workspace that had
// the port; the others are asked to keep the number taken, so their servers move on.
// A port the host itself holds cannot be listened on: every workspace is asked to keep it
// taken. Ports below 1024 are never forwarded.
//
// THE LINK. Each workspace's only way out is one stream to its own proxy in the root. The
// daemon owns the host end of it and carries each connection to that workspace's proxy and
// nowhere else: which link a connection arrived on is what attributes it.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { devHostname, editorHostname } from "../shared/names.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { sleep, waitFor } from "../shared/run.ts";
import { sniffSocket } from "../shared/sniff.ts";
import { guest, INSTANCE, paths } from "./paths.ts";
import { backend, ROOT_VM, rootctl } from "./stack.ts";

const SOCKET = path.join(paths.state, "daemon.sock");
const PIDFILE = path.join(paths.state, "daemon.pid");
const LOG = path.join(paths.logs, "daemon.log");
const NODE = ["node", "--disable-warning=ExperimentalWarning"];
/** Protocols with no name in them, known by their port before any connection is seen. */
const RAW_PORTS = new Set([3306, 5432, 6379, 27017, 11211, 5672, 9092, 1433, 26257]);

type Registered = { vm: string; domain: string; workspace: string; proxyPort: number | null };
type Entry = Registered & { listeners: Set<number>; reserved: Set<number>; link: Server | null; lastError: string };
export type PortView = {
  workspace: string;
  forwarded: { port: number; url: string }[];
  reserved: { port: number; why: string }[];
};

// ------------------------------------------------------------------ the daemon itself
const serve = async () => {
  const b = backend();
  const entries = new Map<string, Entry>();
  /** A host listener per forwarded port. */
  const forwards = new Map<number, Server>();
  /** Ports a workspace listens on that a program on the host already holds: they cannot be
   *  published. Tried again now and then, in case the program has gone. */
  const hostHeld = new Map<number, number>();
  /** For a port spoken without a name: the one workspace it reaches. */
  const rawOwner = new Map<number, string>();
  const knownRaw = new Set(RAW_PORTS);
  const log = (line: string) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);

  const byName = (name: string): { entry: Entry; surface: "dev" | "editor" } | null => {
    for (const entry of entries.values()) {
      if (name === devHostname(INSTANCE, entry.domain, entry.workspace)) return { entry, surface: "dev" };
      if (name === editorHostname(INSTANCE, entry.domain, entry.workspace)) return { entry, surface: "editor" };
    }
    return null;
  };

  const pipe = (client: Socket, upstream: Duplex, head: Buffer) => {
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  };

  const refuseHttp = (client: Socket, status: string, text: string) => {
    client.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  };

  const onInbound = async (port: number, client: Socket) => {
    client.on("error", () => client.destroy());
    const { sniffed, head } = await sniffSocket(client, 400);
    if (sniffed.kind === "http" || sniffed.kind === "tls") {
      const target = sniffed.name ? byName(sniffed.name) : null;
      if (!target) {
        // A request that names no workspace reaches nothing (v2's ingress "WHOSE NAME").
        if (sniffed.kind === "http") refuseHttp(client, "421 Misdirected Request", "desolate: this address names no workspace. Open a workspace's own URL: see `desolate ports`.\n");
        else client.destroy();
        return;
      }
      // A workspace's editor name answers for its editor only, and its dev name never for it.
      if (target.surface === "editor" || !target.entry.listeners.has(port)) {
        if (sniffed.kind === "http") refuseHttp(client, "502 Bad Gateway", `desolate: nothing is listening on port ${port} in ${target.entry.domain}/${target.entry.workspace}.\n`);
        else client.destroy();
        return;
      }
      return pipe(client, b.dial(target.entry.vm, port), head);
    }
    // No name in the protocol: this port reaches one workspace, the first that had it.
    knownRaw.add(port);
    const owner = rawOwner.get(port);
    const entry = owner ? entries.get(owner) : undefined;
    if (!entry || !entry.listeners.has(port)) return client.destroy();
    pipe(client, b.dial(entry.vm, port), head);
  };

  const reconcile = () => {
    const wanted = new Set<number>();
    for (const entry of entries.values()) for (const port of entry.listeners) wanted.add(port);
    for (const [port, server] of forwards)
      if (!wanted.has(port)) {
        server.close();
        forwards.delete(port);
        rawOwner.delete(port);
      }
    for (const port of hostHeld.keys()) if (!wanted.has(port)) hostHeld.delete(port);
    for (const port of wanted) {
      const holders = [...entries.values()].filter((entry) => entry.listeners.has(port));
      const owner = rawOwner.get(port);
      if (!owner || !holders.some((entry) => entry.vm === owner)) rawOwner.set(port, holders[0]!.vm);
      if (forwards.has(port)) continue;
      if (Date.now() - (hostHeld.get(port) ?? 0) < 10_000) continue;
      const server = createServer((client) => void onInbound(port, client));
      server.on("error", (error: NodeJS.ErrnoException) => {
        // Something on the host has this port. It cannot be published; every workspace is
        // asked to keep the number taken instead.
        if (forwards.get(port) === server) forwards.delete(port);
        hostHeld.set(port, Date.now());
        if (error.code !== "EADDRINUSE") log(`port ${port}: ${error.message}`);
      });
      server.on("listening", () => hostHeld.delete(port));
      forwards.set(port, server);
      // 127.0.0.1 only, never a wildcard: nothing on the LAN reaches a workspace.
      server.listen({ port, host: "127.0.0.1", exclusive: true });
    }
    for (const entry of entries.values()) {
      const reserve = new Set<number>();
      for (const port of hostHeld.keys()) if (!entry.listeners.has(port)) reserve.add(port);
      for (const port of forwards.keys())
        if (!entry.listeners.has(port) && knownRaw.has(port) && rawOwner.get(port) !== entry.vm) reserve.add(port);
      entry.reserved = reserve;
    }
  };

  const sync = async (entry: Entry) => {
    try {
      const result = await b.exec(entry.vm, [...NODE, `${guest.release}/workspace/wsctl.ts`], { input: JSON.stringify({ op: "ports", reserve: [...entry.reserved] }), timeoutMs: 15_000 });
      const reply = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as { ok?: boolean; listeners?: number[]; error?: string };
      if (!reply.ok || !Array.isArray(reply.listeners)) throw new Error(reply.error ?? `exit ${result.code}`);
      // Fail closed on what the VM says: integers, 1024 and up, and a sane number of them.
      entry.listeners = new Set(reply.listeners.filter((port) => Number.isInteger(port) && port >= 1024 && port <= 65535).slice(0, 256));
      entry.lastError = "";
    } catch (error) {
      // A workspace that cannot be asked forwards nothing new, and what it had is dropped.
      entry.listeners = new Set();
      entry.lastError = String(error);
    }
  };

  const openLink = (entry: Entry) => {
    const dir = paths.link(entry.vm);
    fs.mkdirSync(dir, { recursive: true });
    const socket = path.join(dir, "proxy.sock");
    fs.rmSync(socket, { force: true });
    const server = createServer((client) => {
      client.on("error", () => client.destroy());
      if (entry.proxyPort === null) return client.destroy();
      // To this workspace's proxy in the root, and nowhere else.
      pipe(client, b.dial(ROOT_VM, entry.proxyPort), Buffer.alloc(0));
    });
    server.on("error", (error) => log(`link ${entry.vm}: ${error.message}`));
    server.listen(socket, () => fs.chmodSync(socket, 0o666));
    entry.link = server;
  };

  const register = (r: Registered) => {
    const existing = entries.get(r.vm);
    if (existing) {
      existing.proxyPort = r.proxyPort;
      return;
    }
    const entry: Entry = { ...r, listeners: new Set(), reserved: new Set(), link: null, lastError: "" };
    entries.set(r.vm, entry);
    openLink(entry);
  };
  const unregister = (vm: string) => {
    const entry = entries.get(vm);
    if (!entry) return;
    entry.link?.close();
    entries.delete(vm);
    reconcile();
  };

  const view = (): PortView[] =>
    [...entries.values()].map((entry) => ({
      workspace: `${entry.domain}/${entry.workspace}`,
      forwarded: [...entry.listeners].sort((a, b) => a - b).filter((port) => !hostHeld.has(port)).map((port) => ({ port, url: `http://${devHostname(INSTANCE, entry.domain, entry.workspace)}:${port}` })),
      reserved: [
        ...[...entry.reserved].sort((a, b) => a - b).map((port) => ({ port, why: hostHeld.has(port) ? "a program on this machine holds it" : `no name in its protocol, and ${entries.get(rawOwner.get(port) ?? "")?.workspace ?? "another workspace"} had it first` })),
        ...[...entry.listeners].filter((port) => hostHeld.has(port)).map((port) => ({ port, why: "listening in the workspace, but a program on this machine holds that port: not forwarded" })),
      ],
    })).sort((a, b) => a.workspace.localeCompare(b.workspace));

  fs.mkdirSync(paths.state, { recursive: true });
  fs.rmSync(SOCKET, { force: true });
  createServer((connection) => {
    let buffer = "";
    connection.on("error", () => connection.destroy());
    connection.on("data", async (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let reply: unknown = { ok: false, error: "unknown request" };
      try {
        const request = JSON.parse(buffer.slice(0, end)) as { op: string } & Partial<Registered>;
        if (request.op === "register") {
          register(request as Registered);
          const entry = entries.get(request.vm!)!;
          await sync(entry);
          reconcile();
          reply = { ok: true };
        } else if (request.op === "unregister") {
          unregister(request.vm!);
          reply = { ok: true };
        } else if (request.op === "ports") {
          await Promise.all([...entries.values()].map(sync));
          reconcile();
          // A listen that fails says so a moment later; then one more round, so that the
          // reservations decided just now are in place inside the VMs before the answer.
          await sleep(50);
          reconcile();
          await Promise.all([...entries.values()].map(sync));
          reply = { ok: true, ports: view() };
        } else if (request.op === "stop") {
          connection.end(JSON.stringify({ ok: true }) + "\n");
          for (const server of forwards.values()) server.close();
          for (const entry of entries.values()) entry.link?.close();
          fs.rmSync(SOCKET, { force: true });
          fs.rmSync(PIDFILE, { force: true });
          process.exit(0);
        }
      } catch (error) {
        reply = { ok: false, error: String(error) };
      }
      connection.end(JSON.stringify(reply) + "\n");
    });
  }).listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600));
  fs.writeFileSync(PIDFILE, String(process.pid));
  log(`daemon up, pid ${process.pid}`);

  // After a restart of the host: take up every workspace whose VM is running.
  try {
    const domains = await rootctl<{ slug: string; workspaces: (WorkspacePlan & { proxyPort?: number })[] }[]>("domain.list", {}, { quiet: true, timeoutMs: 30_000 });
    const running = new Set((await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name));
    for (const d of domains) for (const w of d.workspaces) if (running.has(w.vm)) register({ vm: w.vm, domain: w.domain, workspace: w.workspace, proxyPort: w.proxyPort ?? null });
  } catch (error) {
    log(`could not list workspaces at start: ${String(error)}`);
  }
  for (;;) {
    await Promise.all([...entries.values()].map(sync));
    reconcile();
    await sleep(1000);
  }
};

// ------------------------------------------------------------------ talking to it
const ask = (request: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const connection = connect(SOCKET);
    let buffer = "";
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error("the host daemon did not answer"));
    }, timeoutMs);
    connection.on("connect", () => connection.write(JSON.stringify(request) + "\n"));
    connection.on("data", (chunk) => (buffer += chunk));
    connection.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer));
      } catch {
        reject(new Error("the host daemon sent no answer"));
      }
    });
    connection.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const alive = () => ask({ op: "ping" }, 3000).then(() => true, () => false);

export const ensureDaemon = async () => {
  if (await alive()) return;
  fs.mkdirSync(paths.logs, { recursive: true });
  const log = fs.openSync(LOG, "a");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), "serve"], { detached: true, stdio: ["ignore", log, log], env: process.env });
  child.unref();
  if (!(await waitFor(alive, 20_000, 100))) throw new Error(`the host daemon did not start; see ${LOG}`);
};

export const connectWorkspace = async (plan: WorkspacePlan & { proxyPort?: number | null }) => {
  await ensureDaemon();
  const reply = await ask({ op: "register", vm: plan.vm, domain: plan.domain, workspace: plan.workspace, proxyPort: plan.proxyPort ?? null });
  if (reply.ok !== true) throw new Error(`the host daemon refused the workspace: ${String(reply.error)}`);
};

export const disconnectWorkspace = async (vm: string) => {
  if (await alive()) await ask({ op: "unregister", vm });
};

export const ports = async (): Promise<PortView[]> => {
  await ensureDaemon();
  const reply = await ask({ op: "ports" });
  if (reply.ok !== true) throw new Error(String(reply.error));
  return reply.ports as PortView[];
};

export const stopForwarder = async () => {
  if (await alive()) await ask({ op: "stop" }).catch(() => {});
};

if (process.argv[2] === "serve" && process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) void serve();
