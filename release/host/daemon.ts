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
import { refuse } from "../shared/exit.ts";
import { accept as acceptLink } from "../shared/link.ts";
import { hostArgv } from "../shared/actions.ts";
import { devHostname, EDITOR, editorHostname, editorHostPort, ROOT_HOSTNAME, ROOT_UI } from "../shared/names.ts";
import { statusDir } from "../shared/status.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { sleep, waitFor } from "../shared/run.ts";
import { sniffSocket } from "../shared/sniff.ts";
import { guest, INSTANCE, paths, RELEASE_DIR } from "./paths.ts";
import { backend, ROOT_VM, rootctl } from "./stack.ts";

const SOCKET = path.join(paths.state, "daemon.sock");
const PIDFILE = path.join(paths.state, "daemon.pid");
const LOG = path.join(paths.logs, "daemon.log");
const NODE = ["node", "--disable-warning=ExperimentalWarning"];
/** Protocols with no name in them, known by their port before any connection is seen. */
const RAW_PORTS = new Set([3306, 5432, 6379, 27017, 11211, 5672, 9092, 1433, 26257]);

type Registered = { vm: string; domain: string; workspace: string; proxyPort: number | null };
type Checkouts = { repo: string; kind: string; name: string; path?: string }[];
type Entry = Registered & { listeners: Set<number>; reserved: Set<number>; link: Server | null; lastError: string; editorToken: string; devcontainer: string; folder: string; watchers: fs.FSWatcher[] };
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

  // Every workspace's editor, on one host port, by the editor's own hostname and no other.
  // What it reaches is the gate in that workspace's VM (workspace/editor-gate.ts), never
  // the editor's server itself.
  let editorError = "";
  const editors = createServer((client) => {
    client.on("error", () => client.destroy());
    void sniffSocket(client, 400).then(({ sniffed, head }) => {
      // The root's one surface: the dashboard. The state service checks the name and the
      // origin of every request itself.
      if (sniffed.kind === "http" && sniffed.name === ROOT_HOSTNAME) {
        dashboardUsed = Date.now();
        return pipe(client, toStateService(), head);
      }
      const target = sniffed.kind === "http" && sniffed.name ? byName(sniffed.name) : null;
      if (!target || target.surface !== "editor") {
        if (sniffed.kind === "http") refuseHttp(client, "421 Misdirected Request", "desolate: this port answers to a workspace's editor hostname only. `desolate editor <domain>/<workspace>` prints it.\n");
        else client.destroy();
        return;
      }
      pipe(client, b.dial(target.entry.vm, EDITOR.gate), head);
    });
  });
  editors.on("error", (error: NodeJS.ErrnoException) => {
    editorError = error.code === "EADDRINUSE" ? `a program on this machine holds port ${editorHostPort()}` : error.message;
    log(`editors on port ${editorHostPort()}: ${error.message}`);
  });
  editors.listen({ port: editorHostPort(), host: "127.0.0.1", exclusive: true });

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
      const reply = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as { ok?: boolean; listeners?: number[]; error?: string; editorToken?: unknown; devcontainer?: unknown; folder?: unknown };
      // For the dashboard. Shown as text and built into an address: a token is 48 hex, the
      // rest is cut to a line.
      entry.editorToken = typeof reply.editorToken === "string" && /^[0-9a-f]{48}$/.test(reply.editorToken) ? reply.editorToken : "";
      entry.devcontainer = typeof reply.devcontainer === "string" ? reply.devcontainer.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 400) : "";
      if (typeof reply.folder === "string" && /^\/workspaces\/[A-Za-z0-9._\/-]+$/.test(reply.folder)) entry.folder = reply.folder;
      if (!reply.ok || !Array.isArray(reply.listeners)) throw new Error(reply.error ?? `exit ${result.code}`);
      // Fail closed on what the VM says: integers, 1024 and up, and a sane number of them.
      // The editor's two in-VM ports are never dev-server ports: a dev hostname must not
      // reach the editor, and nothing may reach its server around its gate.
      entry.listeners = new Set(reply.listeners.filter((port) => Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== EDITOR.server && port !== EDITOR.gate && port !== editorHostPort()).slice(0, 256));
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
    const carry = (client: Socket) => {
      client.on("error", () => client.destroy());
      if (entry.proxyPort === null) return client.destroy();
      // To this workspace's proxy in the root, and nowhere else.
      pipe(client, b.dial(ROOT_VM, entry.proxyPort), Buffer.alloc(0));
    };
    const server = createServer(carry);
    server.on("error", (error) => log(`link ${entry.vm}: ${error.message}`));
    server.listen(socket, () => fs.chmodSync(socket, 0o666));
    entry.link = server;
    // vz: the guest reaches its link through one loopback port on the host, the only one
    // its confinement allows it.
    const { hostPort, token } = b.link(entry.vm);
    if (hostPort) {
      // Every process on this machine can connect to a loopback port. Only a connection
      // that opens with this workspace's token is carried; without a token, none is.
      const tcp = createServer((client) => {
        client.on("error", () => client.destroy());
        if (!token || entry.proxyPort === null) return client.destroy();
        void acceptLink(client, token).then((rest) => {
          if (rest === null || entry.proxyPort === null) return client.destroy();
          pipe(client, b.dial(ROOT_VM, entry.proxyPort), rest);
        });
      });
      tcp.on("error", (error) => log(`link ${entry.vm} on port ${hostPort}: ${error.message}`));
      tcp.listen({ port: hostPort, host: "127.0.0.1", exclusive: true });
      server.on("close", () => tcp.close());
    }
  };

  const register = (r: Registered) => {
    const existing = entries.get(r.vm);
    if (existing) {
      existing.proxyPort = r.proxyPort;
      return;
    }
    const entry: Entry = { vm: r.vm, domain: r.domain, workspace: r.workspace, proxyPort: r.proxyPort, listeners: new Set(), reserved: new Set(), link: null, lastError: "", editorToken: "", devcontainer: "", folder: "", watchers: [] };
    entries.set(r.vm, entry);
    // A status set in the workspace is a file changing in a share. A VM gets no events for
    // a share, so the host watches (the directory, for a change: it reads nothing) and
    // tells the root's state service to look.
    const checkouts = (r as Registered & { checkouts?: Checkouts }).checkouts ?? [];
    // The folder the editor opens: the first checkout (as `desolate editor` prints it).
    if (typeof checkouts[0]?.path === "string" && /^\/workspaces\/[A-Za-z0-9._\/-]+$/.test(checkouts[0].path)) entry.folder = checkouts[0].path;
    for (const c of checkouts)
      try {
        const watcher = fs.watch(statusDir(paths.domainRepos(r.domain), c), (_event, file) => {
          if (file === null || String(file).startsWith("desolate-")) nudge();
        });
        // The directory is the workspace's: it can vanish or be replaced at any moment. A
        // watcher that fails is closed; it must never be an error nobody listens to,
        // which would end this daemon and with it every workspace's link.
        watcher.on("error", () => watcher.close());
        entry.watchers.push(watcher);
      } catch {
        /* no such checkout yet: the state service's own slow look covers it */
      }
    openLink(entry);
  };
  const unregister = (vm: string) => {
    const entry = entries.get(vm);
    if (!entry) return;
    entry.link?.close();
    for (const watcher of entry.watchers) watcher.close();
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


  // ---------------------------------------------------------------- the root UI's host side
  // The root's state service cannot see the host, and cannot ask: no VM can open a
  // connection to the host. So this dials in: it tells the service what only the host
  // knows, nudges it when a share changed, and collects the dashboard's requests, which it
  // runs as desolate's own CLI, from the fixed list in shared/actions.ts.
  const TOKEN_FILE = path.join(paths.state, "host-token");
  // Connections to the state service, opened ahead of need. Opening one costs what the VM
  // layer's exec costs (an ssh session; tens to hundreds of milliseconds), and the
  // dashboard's budget for showing state is 300 ms: so a few are kept ready, each used
  // once. An idle one is replaced before the service would close it for sending nothing.
  const ready: { stream: Duplex; at: number; dead: boolean }[] = [];
  // Only while a dashboard is in use: each one kept ready is an exec into the root VM,
  // made again every lifetime, and an unwatched stack should be idle.
  const READY = { count: 5, lifeMs: 40_000, afterUseMs: 180_000 } as const;
  let dashboardUsed = 0;
  const stock = () => {
    for (let i = ready.length - 1; i >= 0; i--)
      if (ready[i]!.dead || Date.now() - ready[i]!.at > READY.lifeMs) {
        ready[i]!.stream.destroy();
        ready.splice(i, 1);
      }
    while (rootUp && Date.now() - dashboardUsed < READY.afterUseMs && ready.length < READY.count) {
      const item = { stream: b.dial(ROOT_VM, ROOT_UI.port), at: Date.now(), dead: false };
      const die = () => (item.dead = true);
      item.stream.on("error", die);
      item.stream.on("close", die);
      ready.push(item);
    }
  };
  let rootUp = false;
  const toStateService = (): Duplex => {
    stock();
    const item = ready.shift();
    setImmediate(stock);
    if (!item || item.dead) return b.dial(ROOT_VM, ROOT_UI.port);
    item.stream.removeAllListeners("error");
    item.stream.removeAllListeners("close");
    return item.stream;
  };
  setInterval(stock, 5000).unref();
  const rootHttp = (method: string, pathname: string, body?: unknown, timeoutMs = 15_000): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      let token = "";
      try {
        token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
      } catch {
        return reject(new Error("no host token"));
      }
      const payload = body === undefined ? "" : JSON.stringify(body);
      const stream = toStateService();
      let data = Buffer.alloc(0);
      const timer = setTimeout(() => settle(new Error("the root's state service did not answer")), timeoutMs);
      let settled = false;
      const settle = (result: { status: number; body: string } | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stream.destroy();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      // The answer is complete when its Content-Length has arrived, not when the stream
      // closes: what carries the connection (ssh, an exec) may hold it open until this
      // side closes, which it does not do first (measured: a relay that sees its input
      // end drops the answer).
      const complete = () => {
        const split = data.indexOf("\r\n\r\n");
        if (split < 0) return;
        const head = data.subarray(0, split).toString("latin1");
        const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0);
        const length = Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1] ?? -1);
        if (status === 0 || length < 0) return settle(new Error("the root's state service sent something that is not an answer"));
        if (data.length >= split + 4 + length) settle({ status, body: data.subarray(split + 4, split + 4 + length).toString("utf8") });
      };
      stream.on("data", (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        complete();
      });
      stream.on("error", (error) => settle(error));
      stream.on("close", () => settle(new Error("the root's state service is not there")));
      stream.write(`${method} ${pathname} HTTP/1.1\r\nHost: root\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n${payload ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n` : ""}\r\n${payload}`);
    });

  let nudging: NodeJS.Timeout | null = null;
  const nudge = () => {
    if (nudging) return;
    nudging = setTimeout(() => {
      nudging = null;
      rootHttp("POST", "/host/nudge", {}).catch(() => {});
    }, 60);
  };

  let sentFacts = "";
  let sentAt = 0;
  const tellRoot = async () => {
    const vms = await b.list();
    rootUp = vms.find((vm) => vm.name === ROOT_VM)?.status === "running";
    if (!rootUp) return;
    const port = editorHostPort();
    const workspaces: Record<string, unknown> = {};
    for (const vm of vms) {
      if (vm.name === ROOT_VM) continue;
      const entry = entries.get(vm.name);
      workspaces[vm.name] = {
        status: vm.status,
        ...(entry ? {
          devcontainer: entry.devcontainer || undefined,
          editor: entry.editorToken && !editorError ? `http://${editorHostname(INSTANCE, entry.domain, entry.workspace)}:${port}/?tkn=${entry.editorToken}${entry.folder ? `&folder=${encodeURIComponent(entry.folder)}` : ""}` : undefined,
          ports: [...entry.listeners].sort((x, y) => x - y).filter((p) => !hostHeld.has(p)).map((p) => ({ port: p, url: `http://${devHostname(INSTANCE, entry.domain, entry.workspace)}:${p}` })),
        } : {}),
      };
    }
    const { kind } = await import("./approver.ts");
    const facts = { stack: { instance: INSTANCE, backend: b.kind, isolated: b.isolated, editorPort: port, approver: kind() }, workspaces };
    const text = JSON.stringify(facts);
    // Said when it changes, and now and then regardless, so the service knows the host is there.
    if (text === sentFacts && Date.now() - sentAt < 45_000) return;
    await rootHttp("PUT", "/host/facts", facts);
    sentFacts = text;
    sentAt = Date.now();
  };

  const runAction = (action: { id: string; kind: unknown; args: unknown }) => {
    // Built here, from the kind and its arguments: never a command line the root wrote.
    const argv = hostArgv(action.kind, action.args);
    const report = (lines: string[], done?: number) => rootHttp("POST", "/host/progress", { id: action.id, lines, ...(done === undefined ? {} : { done: true, code: done }) }).catch(() => {});
    if (!argv) return void report(["the host does not do that"], 64);
    log(`dashboard: desolate ${argv.join(" ")}`);
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(RELEASE_DIR, "host", "cli.ts"), ...argv], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DESOLATE_PROGRESS: "1", NO_COLOR: "1" } });
    let pending: string[] = [];
    let flushing: NodeJS.Timeout | null = null;
    const take = (chunk: Buffer) => {
      pending.push(...chunk.toString().split("\n").filter((line) => line.trim() !== ""));
      flushing ??= setTimeout(() => {
        flushing = null;
        void report(pending.splice(0));
      }, 150);
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    void report([]);
    child.on("close", (code) => {
      if (flushing) clearTimeout(flushing);
      void report(pending.splice(0), code ?? 1).then(() => tellRoot().catch(() => {}));
    });
  };
  /** Each request is run once, however many times the root hands it over. */
  const taken = new Set<string>();
  let lastFailure = "";
  const collect = async () => {
    for (;;) {
      try {
        const reply = await rootHttp("GET", "/host/requests", undefined, 70_000);
        if (reply.status !== 200) throw new Error(`status ${reply.status}`);
        for (const action of JSON.parse(reply.body) as { id: string; kind: unknown; args: unknown }[]) {
          if (typeof action.id !== "string" || taken.has(action.id)) continue;
          taken.add(action.id);
          runAction(action);
        }
        lastFailure = "";
      } catch (error) {
        // The root is not up, or its service is not: try again in a while.
        if (String(error) !== lastFailure) log(`dashboard requests: ${(lastFailure = String(error))}`);
        await sleep(3000);
      }
    }
  };
  void collect();

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
          tellRoot().catch(() => {});
          reply = { ok: true };
        } else if (request.op === "unregister") {
          unregister(request.vm!);
          tellRoot().catch(() => {});
          reply = { ok: true };
        } else if (request.op === "ports") {
          await Promise.all([...entries.values()].map(sync));
          reconcile();
          // A listen that fails says so a moment later; then one more round, so that the
          // reservations decided just now are in place inside the VMs before the answer.
          await sleep(50);
          reconcile();
          await Promise.all([...entries.values()].map(sync));
          reply = { ok: true, ports: view(), editor: { port: editorHostPort(), error: editorError } };
        } else if (request.op === "stop") {
          connection.end(JSON.stringify({ ok: true }) + "\n");
          editors.close();
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
    for (const d of domains)
      for (const w of d.workspaces)
        if (running.has(w.vm)) {
          const proxy = await rootctl<{ port: number }>("proxy.start", { vm: w.vm, domain: w.domain, workspace: w.workspace }, { quiet: true, timeoutMs: 60_000 });
          register({ vm: w.vm, domain: w.domain, workspace: w.workspace, proxyPort: proxy.port, checkouts: w.checkouts } as Registered);
        }
  } catch (error) {
    log(`could not list workspaces at start: ${String(error)}`);
  }
  for (;;) {
    const started = Date.now();
    await Promise.all([...entries.values()].map(sync));
    reconcile();
    await tellRoot().catch(() => {});
    // Asking a VM costs what its exec costs: little on a Mac, seconds under emulation. The
    // pause is never shorter than a second, and never so short that asking is all the VMs do.
    await sleep(Math.max(1000, 3 * (Date.now() - started)));
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
  const reply = await ask({ op: "register", vm: plan.vm, domain: plan.domain, workspace: plan.workspace, proxyPort: plan.proxyPort ?? null, checkouts: plan.checkouts });
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

/** The host port every editor is on, and why it is not, if it is not. */
export const editorPort = async (): Promise<{ port: number; error: string }> => {
  await ensureDaemon();
  const reply = await ask({ op: "ports" });
  if (reply.ok !== true) throw new Error(String(reply.error));
  return reply.editor as { port: number; error: string };
};

/** Where the dashboard is, for a browser on this machine. */
/** The dashboard's address, with the token that lets a browser in (the root's state
 *  service exchanges it for a cookie). Like an editor's address, it is the person's to
 *  open, and not to paste anywhere else. */
export const ui = async (): Promise<{ dashboard: string }> => {
  await ensureDaemon();
  let token = "";
  try {
    token = fs.readFileSync(path.join(paths.state, "ui-token"), "utf8").trim();
  } catch {
    /* not bootstrapped */
  }
  if (!/^[0-9a-f]{48}$/.test(token)) refuse("this stack has no dashboard credential yet", "desolate bootstrap");
  return { dashboard: `http://${ROOT_HOSTNAME}:${editorHostPort()}/?tkn=${token}` };
};

export const stopForwarder = async () => {
  if (await alive()) await ask({ op: "stop" }).catch(() => {});
};

if (process.argv[2] === "serve" && process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) void serve();
