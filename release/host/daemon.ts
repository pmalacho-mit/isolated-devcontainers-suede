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
import { printable } from "../shared/text.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { refuse } from "../shared/exit.ts";
import { accept as acceptLink } from "../shared/link.ts";
import { hostArgv } from "../shared/actions.ts";
import { createServer as createHttpServer } from "node:http";
import { parseApproval } from "../shared/approval.ts";
import { APPROVE_HOSTNAME, GIT_HOSTNAME, parseRepo, devHostname, EDITOR, editorHostname, editorHostPort, ROOT_HOSTNAME, ROOT_UI } from "../shared/names.ts";
import { handler as approvePage } from "./approve-web.ts";
import { handler as gitPage } from "./git-web.ts";
import { hub, pusherEvent, stateEvents } from "./events.ts";
import { ensureGitClone, ensureGitVm, GIT_VM, watchGitOut } from "./git-vm.ts";
import type { Backend as ApprovalBackend, Summary } from "./approve-web.ts";
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

type Registered = { vm: string; domain: string; workspace: string; proxy: string | null };
type Checkouts = { repo: string; kind: string; name: string; path?: string }[];
type Entry = Registered & { listeners: Set<number>; reserved: Set<number>; link: Server | null; lastError: string; editorToken: string; devcontainer: string; folder: string; watchers: fs.FSWatcher[] };
export type PortView = {
  workspace: string;
  forwarded: { port: number; url: string }[];
  reserved: { port: number; why: string }[];
};

// ------------------------------------------------------------------ the daemon itself
/** What code this daemon runs: the host's and the shared files. An updated desolate means
 *  nothing to a daemon still running the old (a fix to the link's handshake, say). */
const codeOf = () => {
  const hash = createHash("sha256");
  for (const dir of ["host", "host/vm", "shared"])
    for (const name of fs.readdirSync(path.join(RELEASE_DIR, dir)).filter((n) => n.endsWith(".ts")).sort()) hash.update(name).update(fs.readFileSync(path.join(RELEASE_DIR, dir, name)));
  return hash.digest("hex").slice(0, 16);
};
const CODE = codeOf();

/** How many connections one workspace's link may have open at once. */
const LINK_CONNECTIONS = 64;

/** `desolate events` (events.ts): every event the daemon learns of, for whoever listens. */
const events = hub();

/** What the approval page needs of the stack. The list of waiting pushes is the root's
 *  user's (only each one's message is used, parsed on the host); what a push would send is
 *  the reviewer's, asked as root; the signature is this host's. */
/** What a push would send, as desolate's reviewer in the root works it out (root/reviewer.ts):
 *  the approval page shows it, and so do the terminal's prompts. */
export const reviewerSummary = async (push: { repo: string; branch: string; commit: string; onto: string | null }): Promise<Summary> => {
  const result = await backend().exec(ROOT_VM, [...NODE, `${guest.release}/root/review-ask.ts`], { root: true, input: JSON.stringify({ repo: push.repo, branch: push.branch, commit: push.commit, onto: push.onto }), timeoutMs: 120_000 });
  try {
    return JSON.parse(result.stdout.trim().split("\n").pop() ?? "") as Summary;
  } catch {
    return { ok: false, error: `the reviewer could not be asked: ${(result.stderr || result.stdout).trim().slice(-200)}` };
  }
};

const approvalBackend = (): ApprovalBackend => {
  return {
    pending: async () => (await rootctl<{ message: string; at: string }[]>("approvals.pending", {}, { quiet: true, timeoutMs: 30_000 })).map((p) => ({ message: p.message, at: p.at })),
    summary: reviewerSummary,
    approve: async (message) => {
      if (!parseApproval(message)) throw new Error("not a push approval");
      const { signClicked } = await import("./approver.ts");
      await rootctl("approvals.answer", { message, signature: signClicked(message) }, { quiet: true, timeoutMs: 60_000 });
      const push = parseApproval(message)!;
      events.publish(events.host("approved", { repo: push.repo, branch: push.branch, commit: push.commit, onto: push.onto }));
    },
    refuse: async (message) => {
      await rootctl("approvals.refuse", { message }, { quiet: true, timeoutMs: 30_000 });
      const push = parseApproval(message);
      if (push) events.publish(events.host("refused", { repo: push.repo, branch: push.branch, commit: push.commit }));
    },
  };
};

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
  // The approval page (approve-web.ts): served here, by the host, never by a VM.
  const approvals = createHttpServer(approvePage(approvalBackend(), log));
  // The git terminal (git-web.ts): a shell in the git VM, and what the git VM hands over.
  const gitReady = new Set<string>();
  const gitTerminals = createHttpServer(gitPage((argv) => b.spawn(GIT_VM, argv), log, async (repo) => {
    // A shell asked for from a link (the dashboard's "Open in git"): the VM and the clone
    // are made on the way, as `desolate git <repo>` would.
    if (!gitReady.has("")) {
      await ensureGitVm();
      gitReady.add("");
    }
    if (repo && !gitReady.has(repo)) {
      await ensureGitClone(parseRepo(repo)!);
      gitReady.add(repo);
    }
  }));
  watchGitOut(log, (fields) => events.publish(events.host(fields.domain ? "git-delivery-handed" : "git-push-handed", fields)));
  const editors = createServer((client) => {
    client.on("error", () => client.destroy());
    void sniffSocket(client, 400).then(({ sniffed, head }) => {
      if (sniffed.kind === "http" && sniffed.name === GIT_HOSTNAME) {
        client.setTimeout(30 * 60_000, () => client.destroy());
        client.unshift(head);
        gitTerminals.emit("connection", client);
        client.resume();
        return;
      }
      if (sniffed.kind === "http" && sniffed.name === APPROVE_HOSTNAME) {
        // (Emitted, not listened: node's own slow-client timeouts are not set up, so this is.)
        client.setTimeout(120_000, () => client.destroy());
        client.unshift(head);
        approvals.emit("connection", client);
        client.resume();
        return;
      }
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
      entry.devcontainer = typeof reply.devcontainer === "string" ? printable(reply.devcontainer, 400, " ") : "";
      if (!entry.folder.startsWith("workspace:") && typeof reply.folder === "string" && /^\/workspaces\/[A-Za-z0-9._\/-]+$/.test(reply.folder)) entry.folder = reply.folder;
      if (!reply.ok || !Array.isArray(reply.listeners)) throw new Error(reply.error ?? `exit ${result.code}`);
      // Fail closed on what the VM says: integers, 1024 and up, and a sane number of them.
      // The editor's two in-VM ports are never dev-server ports: a dev hostname must not
      // reach the editor, and nothing may reach its server around its gate.
      // Nor any port desolate itself uses on this machine (a VM's ssh, a link): a workspace
      // listening there must not get the host to bind it.
      const ours = b.hostPorts?.() ?? new Set<number>();
      entry.listeners = new Set(reply.listeners.filter((port) => Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== EDITOR.server && port !== EDITOR.gate && port !== editorHostPort() && !ours.has(port)).slice(0, 256));
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
      if (entry.proxy === null) return client.destroy();
      // To this workspace's proxy in the root, and nowhere else.
      pipe(client, b.dial(ROOT_VM, entry.proxy), Buffer.alloc(0));
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
      // Each connection costs a session into the root VM and processes here: a workspace
      // gets this many at once, and no more.
      let open = 0;
      const tcp = createServer((client) => {
        client.on("error", () => client.destroy());
        if (!token || entry.proxy === null || open >= LINK_CONNECTIONS) return client.destroy();
        open += 1;
        client.once("close", () => (open -= 1));
        void acceptLink(client, token).then((rest) => {
          if (rest === null || entry.proxy === null) return client.destroy();
          pipe(client, b.dial(ROOT_VM, entry.proxy), rest);
        });
      });
      // If something else holds the port (it was free a moment, and another program took
      // it), keep trying while the workspace is ours: the guest will not talk to what does
      // not prove it knows the token (shared/link.ts), but it needs its own host to talk to.
      let closed = false;
      tcp.on("error", (error: NodeJS.ErrnoException) => {
        log(`link ${entry.vm} on port ${hostPort}: ${error.message}`);
        if (error.code === "EADDRINUSE" && !closed) setTimeout(() => !closed && tcp.listen({ port: hostPort, host: "127.0.0.1", exclusive: true }), 2000);
      });
      tcp.listen({ port: hostPort, host: "127.0.0.1", exclusive: true });
      server.on("close", () => {
        closed = true;
        tcp.close();
      });
    }
  };

  const register = (r: Registered) => {
    const existing = entries.get(r.vm);
    if (existing) {
      existing.proxy = r.proxy;
      return;
    }
    const entry: Entry = { vm: r.vm, domain: r.domain, workspace: r.workspace, proxy: r.proxy, listeners: new Set(), reserved: new Set(), link: null, lastError: "", editorToken: "", devcontainer: "", folder: "", watchers: [] };
    entries.set(r.vm, entry);
    // A status set in the workspace is a file changing in a share. A VM gets no events for
    // a share, so the host watches (the directory, for a change: it reads nothing) and
    // tells the root's state service to look.
    const checkouts = (r as Registered & { checkouts?: Checkouts }).checkouts ?? [];
    // The folder the editor opens: the first checkout (as `desolate editor` prints it).
    if (typeof checkouts[0]?.path === "string" && /^\/workspaces\/[A-Za-z0-9._\/-]+$/.test(checkouts[0].path)) entry.folder = checkouts[0].path;
    // More than one checkout: the workspace file with all of them (workspace/init.ts).
    if (checkouts.length > 1) entry.folder = `workspace:/workspaces/.desolate/${r.workspace}.code-workspace`;
    const base = paths.domainRepos(r.domain);
    const watch = (dir: string, recursive: boolean, wanted: (file: string | null) => boolean) => {
      try {
        // The domain's own tree: a directory there may be a link anywhere on the Mac, which
        // a watch (recursive above all) would follow. Nothing is read through one, but
        // only a real directory inside the domain's tree is watched.
        if (!fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== path.join(fs.realpathSync(base), path.relative(base, dir))) return;
        const watcher = fs.watch(dir, { recursive }, (_event, file) => {
          if (wanted(file === null ? null : String(file))) nudge();
        });
        // The directory is the workspace's: it can vanish or be replaced at any moment. A
        // watcher that fails is closed; it must never be an error nobody listens to,
        // which would end this daemon and with it every workspace's link.
        watcher.on("error", () => watcher.close());
        entry.watchers.push(watcher);
      } catch {
        /* no such checkout yet: the state service's own slow look covers it */
      }
    };
    const repos = new Set<string>();
    for (const c of checkouts) {
      // Its status or note, or what it has checked out (HEAD: a `git switch`, a commit on a
      // detached HEAD, a rebase starting or ending).
      watch(statusDir(base, c), false, (file) => file === null || file.startsWith("desolate-") || file === "HEAD");
      repos.add(c.repo);
    }
    // A commit moves a branch: a file under refs/heads (or packed-refs). A share's files are
    // the Mac's, so their changes are the Mac's file events, whichever VM made them. Only
    // on macOS is a recursive watch one cheap subscription (FSEvents); elsewhere the state
    // service's look every second covers it.
    if (process.platform === "darwin")
      for (const repo of repos) {
        if (typeof repo !== "string" || !parseRepo(repo)) continue;
        const common = path.join(base, repo, ".git");
        watch(path.join(common, "refs", "heads"), true, () => true);
        watch(common, false, (file) => file === null || file === "packed-refs");
      }
    openLink(entry);
    events.publish(events.host("workspace-up", { domain: r.domain, workspace: r.workspace, vm: r.vm }));
  };
  const unregister = (vm: string) => {
    const entry = entries.get(vm);
    if (!entry) return;
    events.publish(events.host("workspace-down", { domain: entry.domain, workspace: entry.workspace, vm }));
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
        // What the root's user's service says is bounded: it parses what domains send.
        if (data.length > 16 * 1024 * 1024) return settle(new Error("the root's state service said too much"));
        complete();
      });
      stream.on("error", (error) => settle(error));
      stream.on("close", () => settle(new Error("the root's state service is not there")));
      stream.write(`${method} ${pathname} HTTP/1.1\r\nHost: root\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n${payload ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n` : ""}\r\n${payload}`);
    });

  let nudging: NodeJS.Timeout | null = null;
  // At most two a second: a workspace touching its refs in a loop costs the state service
  // two looks a second, not one per touch (found by the audit of #92). The first change in a
  // while is passed on at once.
  let nudgedAt = 0;
  const nudge = () => {
    if (nudging) return;
    nudging = setTimeout(() => {
      nudging = null;
      nudgedAt = Date.now();
      rootHttp("POST", "/host/nudge", {}).catch(() => {});
    }, Math.max(60, 500 - (Date.now() - nudgedAt)));
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
          editor: entry.editorToken && !editorError ? `http://${editorHostname(INSTANCE, entry.domain, entry.workspace)}:${port}/?tkn=${entry.editorToken}${entry.folder.startsWith("workspace:") ? `&workspace=${encodeURIComponent(entry.folder.slice(10))}` : entry.folder ? `&folder=${encodeURIComponent(entry.folder)}` : ""}` : undefined,
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

  // `desolate events`: the root's state, as it changes (its word: events.ts), and the
  // pusher's log, read as root (a log only root writes, of what the forge answered).
  const followState = async () => {
    let tag = "";
    let before: Parameters<typeof stateEvents>[0] = null;
    for (;;) {
      try {
        const reply = await rootHttp("GET", `/host/state?since=${tag}`, undefined, 70_000);
        if (reply.status !== 200) throw new Error(`status ${reply.status}`);
        const { tag: next, state } = JSON.parse(reply.body) as { tag: string; state: Parameters<typeof stateEvents>[1] };
        // The first state is where things stand, not news.
        if (before) for (const e of stateEvents(before, state)) events.publish(e);
        before = state;
        tag = /^[0-9a-f]{16}$/.test(next) ? next : "";
        // At most four looks a second, whatever the root's user's service answers.
        await sleep(250);
      } catch {
        await sleep(3000);
      }
    }
  };
  void followState();
  const followPusher = async () => {
    const file = "/var/lib/desolate-root/pusher.log";
    let where: { inode: string; offset: number } | null = null;
    for (;;) {
      await sleep(2000);
      // Asked only while someone listens: the log is read where it stands when they start.
      if (!rootUp || !events.listening()) {
        where = null;
        continue;
      }
      try {
        // One look: the file's identity and size, and up to a MiB of what is new, as base64
        // (bytes, so an offset is never miscounted).
        const from = where ? where.offset : -1;
        const read = await b.exec(ROOT_VM, ["bash", "-c", `stat -c '%i %s' "$1"; if [ "$2" -ge 0 ]; then tail -c +$(( $2 + 1 )) "$1" | head -c 1048576 | base64 -w0; fi`, "_", file, String(from)], { root: true, timeoutMs: 20_000 });
        const [head = "", body = ""] = read.stdout.split("\n");
        const [inode = "", sizeText = ""] = head.split(" ");
        const size = Number(sizeText);
        if (!/^\d+$/.test(inode) || !Number.isInteger(size)) continue;
        // A new file (rotated, recreated), or one cut shorter: from its start. First look:
        // from where it is now.
        if (!where) {
          where = { inode, offset: size };
          continue;
        }
        if (where.inode !== inode || size < where.offset) {
          where = { inode, offset: 0 };
          continue;
        }
        const bytes = Buffer.from(body, "base64");
        const end = bytes.lastIndexOf(10);
        if (end < 0) continue;
        where.offset += end + 1;
        for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
          const e = pusherEvent(line);
          if (e) events.publish(e);
        }
      } catch {
        /* the root is not answering: next time */
      }
    }
  };
  void followPusher();

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
        } else if (request.op === "approved") {
          // An approval given at a terminal (desolate approve, desolate push): the same event
          // the approval page's gives, from the text that was signed (parsed here).
          const message = (request as { message?: unknown }).message;
          const push = typeof message === "string" ? parseApproval(message) : null;
          if (push) events.publish(events.host("approved", { repo: push.repo, branch: push.branch, commit: push.commit, onto: push.onto, via: "terminal" }));
          reply = { ok: push !== null };
        } else if (request.op === "events") {
          // A stream, not an answer: the last ones asked for, then each as it comes.
          // Once: nothing more the client sends is read. A listener that does not read is
          // told it fell behind and let go (its lines would otherwise pile up here, beside
          // the approval page and every forward).
          connection.removeAllListeners("data");
          const replay = Number((request as { replay?: unknown }).replay) || 0;
          const stop = events.listen(replay, (line) => {
            if (connection.writableLength > 1024 * 1024) {
              stop();
              connection.end(`${JSON.stringify({ v: 1, at: new Date().toISOString(), type: "lagged", source: "host" })}\n`);
              return;
            }
            connection.write(`${line}\n`);
          });
          connection.on("close", stop);
          connection.on("error", stop);
          return;
        } else if (request.op === "code") {
          reply = { ok: true, code: CODE };
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
    const domains = await rootctl<{ slug: string; workspaces: (WorkspacePlan & { proxy?: string })[] }[]>("domain.list", {}, { quiet: true, timeoutMs: 30_000 });
    const running = new Set((await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name));
    for (const d of domains)
      for (const w of d.workspaces)
        if (running.has(w.vm)) {
          const proxy = await rootctl<{ socket: string }>("proxy.start", { vm: w.vm, domain: w.domain, workspace: w.workspace }, { quiet: true, timeoutMs: 60_000 });
          register({ vm: w.vm, domain: w.domain, workspace: w.workspace, proxy: proxy.socket, checkouts: w.checkouts } as Registered);
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

/** Tell `desolate events` of an approval given at a terminal. Best effort: no daemon, no event. */
export const announceApproved = (message: string) => ask({ op: "approved", message }, 3000).catch(() => ({}));

export const ensureDaemon = async () => {
  if (await alive()) {
    const running = await ask({ op: "code" }).catch(() => ({}) as Record<string, unknown>);
    if (running.code === CODE) return;
    // Started from other code: stopped, and started again below (it registers every
    // running workspace again as it starts).
    await stopForwarder();
    await waitFor(async () => !(await alive()), 10_000, 100);
  }
  fs.mkdirSync(paths.logs, { recursive: true });
  const log = fs.openSync(LOG, "a");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), "serve"], { detached: true, stdio: ["ignore", log, log], env: process.env });
  child.unref();
  if (!(await waitFor(alive, 20_000, 100))) throw new Error(`the host daemon did not start; see ${LOG}`);
};

export const connectWorkspace = async (plan: WorkspacePlan & { proxy?: string | null }) => {
  await ensureDaemon();
  const reply = await ask({ op: "register", vm: plan.vm, domain: plan.domain, workspace: plan.workspace, proxy: plan.proxy ?? null, checkouts: plan.checkouts });
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
export const ui = async (): Promise<{ dashboard: string; approvals: string }> => {
  await ensureDaemon();
  let token = "";
  try {
    token = fs.readFileSync(path.join(paths.state, "ui-token"), "utf8").trim();
  } catch {
    /* not bootstrapped */
  }
  if (!/^[0-9a-f]{48}$/.test(token)) refuse("this stack has no dashboard credential yet", "desolate bootstrap");
  const { approveAddress } = await import("./approve-web.ts");
  return { dashboard: `http://${ROOT_HOSTNAME}:${editorHostPort()}/?tkn=${token}`, approvals: approveAddress() };
};

/** `desolate events`: the daemon's events, as they come, to `onLine`, for as long as this
 *  process runs (a daemon that restarts is connected to again; what it missed meanwhile is
 *  not replayed, but `replay` asks for the last ones the daemon still holds). */
export const followEvents = async (replay: number, onLine: (line: string) => boolean | void, drained?: (resume: () => void) => void): Promise<never> => {
  for (let first = true; ; first = false) {
    // The daemon is started once, here. A daemon that went away later (desolate down,
    // destroy) is waited for, never started again: a listener left running must not bring
    // back a stack that was taken down (found: one did, in a home destroy then deleted).
    if (first) await ensureDaemon();
    else while (!(await alive())) await sleep(2000);
    await new Promise<void>((resolve) => {
      const connection = connect(SOCKET);
      let buffer = "";
      connection.setEncoding("utf8");
      connection.on("connect", () => connection.write(JSON.stringify({ op: "events", replay: first ? replay : 0 }) + "\n"));
      connection.on("data", (chunk: string) => {
        buffer += chunk;
        let full = false;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          if (onLine(buffer.slice(0, end)) === false) full = true;
          buffer = buffer.slice(end + 1);
        }
        // Where the lines go is full: read no more until it drains.
        if (full && drained) {
          connection.pause();
          drained(() => connection.resume());
        }
      });
      connection.on("close", () => resolve());
      connection.on("error", () => resolve());
    });
    await sleep(1000);
  }
};

export const stopForwarder = async () => {
  if (await alive()) await ask({ op: "stop" }).catch(() => {});
};

if (process.argv[2] === "serve" && process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) void serve();
