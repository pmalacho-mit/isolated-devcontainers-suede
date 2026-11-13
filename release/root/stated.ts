// The state service (section 4.8): one long-running process in the root VM that holds the
// stack's current state in memory and PUSHES changes to whoever is watching. The dashboard
// renders from it, so nothing is spawned to draw anything: v2's panel waited on process
// start-up, not on data.
//
//   node stated.ts          as the root's user; listens on the root VM's loopback
//
// WHAT IT KNOWS, AND FROM WHERE
//   the root's own facts   repositories, domains, workspaces and their checkouts, offers,
//                          each domain's network mode and secret names, raw pushes waiting
//                          for approval. Read from the root's files when one changes.
//   what workspaces say    each checkout's status and note, read as data (P4).
//   the host's facts       which VMs run, forwarded ports, each editor's address, a
//                          start's progress. The root cannot see these, and cannot ask: no
//                          VM can open a connection to the host. The host's daemon dials
//                          IN and tells it (PUT /host/facts), and nudges it when a file in
//                          a share changed (a VM gets no change events for a share).
//
// WHAT IT CAN DO
//   Nothing on the host by itself. The dashboard's actions are queued here; the host's
//   daemon collects them (GET /host/requests) and runs, as its own CLI, the ones on its
//   fixed list. A push is the exception that proves the rule: it starts here, as a
//   `git push origin` in the root clone, and then WAITS, like any raw push, for the person
//   to approve it on the host (`desolate approve`). Nothing here can approve.
//
// WHO MAY TALK TO IT
//   a browser   only as desolate.localhost, only same-origin (the editor gate's rules),
//               only with the cookie it got for the address `desolate ui` prints (so no
//               other program on the machine), and for actions only with a header a
//               cross-site page cannot send.
//   the host    with the token the host installed as root at bootstrap.
// Repository content (branch names, commit subjects, statuses, notes) leaves here as JSON
// strings and is put on the page as text, never as HTML.
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { hostArgv } from "../shared/actions.ts";
import { parseApproval } from "../shared/approval.ts";
import { isBranch, isCommit, isSlug, parseRepo, ROOT_HOSTNAME, ROOT_UI } from "../shared/names.ts";
import { statusView } from "../shared/status.ts";
import type { Head } from "../shared/status.ts";
import { refusal } from "../workspace/editor-gate.ts";
import * as domains from "./domains.ts";
import { branchesOf, refusalsOf } from "./outbox.ts";
import { safeIn } from "./git.ts";
import { APPROVALS, clonePath, domainPath, GITCONFIG, ROOT } from "./layout.ts";
import * as offers from "./offers.ts";
import * as proxy from "./proxy/manage.ts";
import * as secrets from "./proxy/secrets.ts";
import * as repos from "./repos.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TOKEN_FILE = "/etc/desolate/host-token";
const readToken = (file: string): string | null => {
  try {
    const token = fs.readFileSync(file, "utf8").trim();
    return /^[0-9a-f]{48}$/.test(token) ? token : null;
  } catch {
    return null;
  }
};
const hostToken = () => readToken(TOKEN_FILE);
/** The person's browser's credential for the dashboard. The host made it and installed it
 *  as root; `desolate ui` prints the dashboard's address with it. The name and the origin
 *  checks keep other web pages out; they do not keep out another program on the machine,
 *  which can connect to the loopback port and send any Host and no Origin. Without this,
 *  any user of the Mac, or a sandboxed app allowed to reach localhost, read every
 *  workspace's editor address with its token (found on the M1; release/docs/incidents.md). */
const UI_TOKEN_FILE = "/etc/desolate/ui-token";
const uiToken = () => readToken(UI_TOKEN_FILE);
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** A cookie's name of this stack's own: cookies are kept per host name, not per port, and
 *  two stacks on one machine (a test beside the real one) share `desolate.localhost`. */
const cookieName = (token: string) => `desolate_ui_${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;

// ------------------------------------------------------------------ state
type HostFacts = {
  stack?: { instance: string; backend: string; isolated: boolean; editorPort: number; approver: string | null };
  workspaces?: Record<string, { status: string; devcontainer?: string; editor?: string; ports?: { port: number; url: string }[]; reserved?: number[] }>;
  at?: string;
};
type Action = { id: string; kind: string; args: Record<string, string>; command: string; state: "queued" | "running" | "done" | "failed"; lines: string[]; at: string; code?: number };
let facts: HostFacts = {};
let hostSeen = 0;
const actions: Action[] = [];
/** The host's long polls that are waiting for something to do. An action stays "queued"
 *  (and is handed to every poll) until the host reports on it: a poll whose connection
 *  died takes nothing with it. The host runs each id once. */
const waiters = new Set<() => void>();
const queued = () => actions.filter((action) => action.state === "queued" && action.kind !== "offer.push");

const pendingApprovals = () => {
  const out: { repo: string; branch: string; commit: string; summary: string }[] = [];
  try {
    for (const file of fs.readdirSync(APPROVALS)) {
      const entry = JSON.parse(fs.readFileSync(path.join(APPROVALS, file), "utf8")) as { message: string; summary?: string; at: string };
      const parsed = parseApproval(entry.message);
      if (parsed && Date.now() - Date.parse(entry.at) < 120_000) out.push({ repo: parsed.repo, branch: parsed.branch, commit: parsed.commit, summary: String(entry.summary ?? "").slice(0, 200) });
    }
  } catch {
    /* none */
  }
  return out;
};

/** The last HEAD each checkout was seen on: a read that caught one half written (null) shows
 *  that instead, so a `git switch` is one change and not two. */
const heads = new Map<string, Head>();
const settled = (key: string, head: Head | null): Head | null => {
  if (head) heads.set(key, head);
  return head ?? heads.get(key) ?? null;
};

const snapshot = () => {
  const list = domains.domains().map((d) => ({
    slug: d.slug, title: d.title, repos: d.repos,
    branches: branchesOf(d.slug, d.repos),
    net: proxy.policy(d.slug).mode,
    secrets: secrets.list(d.slug).map((s) => ({ name: s.name, on: s.on })),
    workspaces: domains.workspaces(d.slug).map((w) => {
      const says = statusView(path.join(domainPath(d.slug), "repos"), w);
      return {
        workspace: w.workspace, vm: w.vm, state: w.state,
        // `branch` is what the checkout started on; `head`, what it has checked out now (its
        // HEAD, read as data: the host's daemon nudges when one changes).
        checkouts: w.checkouts.map((c, i) => ({ repo: c.repo, branch: c.branch, kind: c.kind, head: settled(`${d.slug}/${w.workspace}/${c.repo}`, says.checkouts[i]?.head ?? null) })),
        says,
        host: facts.workspaces?.[w.vm] ?? null,
      };
    }),
  }));
  return {
    stack: facts.stack ?? null,
    // The host's daemon tells this service what only the host knows. If it has gone quiet,
    // what is shown about VMs is stale, and the page says so.
    hostConnected: Date.now() - hostSeen < 150_000,
    repos: repos.list().map((r) => ({ repo: r.repo, pushable: r.pushable, defaultBranch: r.defaultBranch })),
    domains: list,
    offers: offers.allOffers(),
    refused: domains.domains().flatMap((d) => refusalsOf(d.slug)),
    approvals: pendingApprovals(),
    actions: actions.slice(-12),
  };
};

// ------------------------------------------------------------------ pushing changes
let last = "";
const subscribers = new Set<ServerResponse>();
const publish = () => {
  let text: string;
  try {
    text = JSON.stringify(snapshot());
  } catch (error) {
    console.error(`stated: the state could not be read: ${String(error)}`);
    return;
  }
  if (text === last) return;
  last = text;
  for (const subscriber of subscribers) subscriber.write(`data: ${text}\n\n`);
  for (const wake of [...stateWaiters]) wake();
};
/** The host's `GET /host/state` (host/events.ts), held until the state changes. */
const stateWaiters = new Set<() => void>();
const stateTag = () => createHash("sha256").update(last).digest("hex").slice(0, 16);
let scheduled: NodeJS.Timeout | null = null;
/** Something changed, or may have: look, soon, once. */
const changed = () => {
  if (scheduled) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    publish();
  }, 40);
};

// ------------------------------------------------------------------ actions
const quote = (word: string) => (/^[A-Za-z0-9_./:=@-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);

const act = (kind: string, args: Record<string, string>): Action | { error: string } => {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const record = (command: string): Action => {
    const action: Action = { id, kind, args, command, state: "queued", lines: [], at: new Date().toISOString() };
    actions.push(action);
    if (actions.length > 50) actions.shift();
    return action;
  };
  if (kind === "offer.push") return push(args, record);
  const argv = hostArgv(kind, args);
  if (!argv) return { error: `'${kind}' with those arguments is not something the dashboard does` };
  // The command shown is the one the host will run: the dashboard teaches the CLI.
  const action = record(`desolate ${argv.map(quote).join(" ")}`);
  for (const wake of [...waiters]) wake();
  return action;
};

/** A push from the dashboard: `git push origin <commit>:<branch>` in the root clone. That
 *  goes to git-remote-desolate-push, which asks the keyring for a challenge and waits for
 *  the person to approve it on the host. This process cannot approve it. */
const push = (args: Record<string, string>, record: (command: string) => Action): Action | { error: string } => {
  const repo = parseRepo(args.repo);
  if (!isSlug(args.domain) || !repo || !isBranch(args.branch) || !isCommit(args.commit)) return { error: "a push names a domain, a repository, a branch and the commit that was reviewed" };
  const offer = offers.offersOf(args.domain).find((o) => o.repo === args.repo && o.branch === args.branch);
  if (!offer || offer.commit !== args.commit) return { error: `${args.branch} is no longer offered at ${args.commit.slice(0, 12)}: it moved, or was withdrawn. Review it again.` };
  const action = record(`desolate push ${args.domain} ${args.repo} ${args.branch} --expect ${args.commit}`);
  action.state = "running";
  action.lines.push("waiting for your approval on the host: run `desolate approve` in a terminal there");
  const child = spawn("git", [...safeIn(clonePath(repo)), "-C", clonePath(repo), "push", "--porcelain", "origin", `${args.commit}:refs/heads/${args.branch}`], { env: { ...process.env, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  const take = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").map((l) => l.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim()).filter(Boolean)) action.lines.push(line.slice(0, 300));
    if (action.lines.length > 60) action.lines.splice(0, action.lines.length - 60);
    changed();
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  child.on("close", (code) => {
    action.code = code ?? 1;
    action.state = code === 0 ? "done" : "failed";
    if (code === 0) {
      offers.withdraw(args.domain!, args.repo!, args.branch!);
      action.lines.push(`pushed ${args.repo} ${args.branch} at ${args.commit}`);
    }
    changed();
  });
  return action;
};

// ------------------------------------------------------------------ http
const body = (req: IncomingMessage, limit = 262_144): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > limit) reject(new Error("too large"));
    });
    req.on("end", () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error as Error);
      }
    });
    req.on("error", reject);
  });
const SECURITY = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store", "cross-origin-resource-policy": "same-origin",
};
const send = (res: ServerResponse, status: number, type: string, content: string) => {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(content), ...SECURITY });
  res.end(content);
};
const json = (res: ServerResponse, status: number, value: unknown) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
const STATIC: Record<string, [string, string]> = {
  "/": ["dashboard.html", "text/html; charset=utf-8"], "/ui.js": ["dashboard.js", "text/javascript; charset=utf-8"], "/ui.css": ["dashboard.css", "text/css; charset=utf-8"],
};

const fromHost = (req: IncomingMessage) => {
  const token = hostToken();
  const given = /^Bearer ([0-9a-f]{48})$/.exec(String(req.headers.authorization ?? ""))?.[1];
  return token !== null && given !== undefined && timingSafeEqual(Buffer.from(given), Buffer.from(token));
};

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname.startsWith("/host/")) {
    if (!fromHost(req)) return json(res, 403, { error: "this is the host daemon's side" });
    hostSeen = Date.now();
    if (req.method === "PUT" && url.pathname === "/host/facts") {
      facts = (await body(req)) as HostFacts;
      changed();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/host/nudge") {
      changed();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/host/progress") {
      const report = (await body(req)) as { id?: string; lines?: string[]; done?: boolean; code?: number };
      const action = actions.find((a) => a.id === report.id);
      if (action) {
        action.state = report.done ? (report.code === 0 ? "done" : "failed") : "running";
        if (report.done) action.code = report.code;
        for (const line of report.lines ?? []) action.lines.push(String(line).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 300));
        if (action.lines.length > 60) action.lines.splice(0, action.lines.length - 60);
        changed();
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/host/state") {
      // The state, when it is not the one the host has (by its tag): for `desolate events`.
      if (!last) publish();
      const send = () => json(res, 200, { tag: stateTag(), state: JSON.parse(last || "{}") });
      if (url.searchParams.get("since") !== stateTag()) return send();
      const answer = () => {
        clearTimeout(timer);
        stateWaiters.delete(answer);
        if (!res.writableEnded) send();
      };
      const timer = setTimeout(answer, 50_000);
      stateWaiters.add(answer);
      res.on("close", () => {
        clearTimeout(timer);
        stateWaiters.delete(answer);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/host/requests") {
      // Held open until there is something to do: the host learns of a click at once.
      if (queued().length > 0) return json(res, 200, queued());
      const answer = () => {
        clearTimeout(timer);
        waiters.delete(answer);
        if (!res.writableEnded) json(res, 200, queued());
      };
      const timer = setTimeout(answer, 50_000);
      waiters.add(answer);
      res.on("close", () => {
        clearTimeout(timer);
        waiters.delete(answer);
      });
      return;
    }
    return json(res, 404, { error: "no such thing" });
  }

  // A browser. The gate's rules: this name only, this origin only.
  const refused = refusal(ROOT_HOSTNAME, req.headers);
  if (refused) return send(res, refused.status, "text/plain; charset=utf-8", `desolate: refused ${refused.why.replace("this is the editor of", "this is the dashboard at")}\n`);
  const ui = uiToken();
  if (!ui) return send(res, 503, "text/plain; charset=utf-8", "desolate: the dashboard has no credential installed yet; run `desolate bootstrap` on the host\n");
  const name = cookieName(ui);
  const given = url.searchParams.get("tkn");
  if (req.method === "GET" && url.pathname === "/" && given !== null) {
    if (!same(given, ui)) return send(res, 403, "text/plain; charset=utf-8", "desolate: refused: that is not this dashboard's address; `desolate ui` prints it\n");
    // Exchanged for a cookie the page's own script cannot read, sent to this name only,
    // and never on a request another site starts; the token leaves the address bar.
    const rest = url.search.slice(1).split("&").filter((part) => part !== "" && !part.startsWith("tkn=")).join("&");
    res.writeHead(303, { location: `/${rest ? `?${rest}` : ""}`, "set-cookie": `${name}=${ui}; HttpOnly; SameSite=Strict; Path=/`, "content-length": 0, ...SECURITY });
    return res.end();
  }
  const cookie = new RegExp(`(?:^|;\\s*)${name}=([0-9a-f]{48})(?:;|$)`).exec(String(req.headers.cookie ?? ""))?.[1];
  if (!cookie || !same(cookie, ui)) return send(res, 401, "text/plain; charset=utf-8", "desolate: open the dashboard at the address `desolate ui` prints: it carries this dashboard's token\n");
  if (req.method === "GET" && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname]!;
    return send(res, 200, type, fs.readFileSync(path.join(HERE, "ui", file), "utf8"));
  }
  if (req.method === "GET" && url.pathname === "/state") return send(res, 200, "application/json; charset=utf-8", last || JSON.stringify(snapshot()));
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", ...SECURITY, connection: "keep-alive" });
    res.write(`data: ${last || JSON.stringify(snapshot())}\n\n`);
    subscribers.add(res);
    const beat = setInterval(() => res.write(": still here\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(beat);
      subscribers.delete(res);
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/review") {
    try {
      return json(res, 200, await offers.review(domains.slugOf(url.searchParams.get("domain"), "domain"), url.searchParams.get("repo"), url.searchParams.get("branch"), url.searchParams.get("against")));
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === "GET" && url.pathname === "/diff") {
    try {
      return json(res, 200, await offers.diff(domains.slugOf(url.searchParams.get("domain"), "domain"), url.searchParams.get("repo"), url.searchParams.get("branch"), url.searchParams.get("against")));
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === "POST" && url.pathname === "/action") {
    // A header a cross-site page cannot add without a preflight this server never grants,
    // on top of the gate: a form or an image cannot press a button here.
    if (req.headers["x-desolate-ui"] !== "1" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 403, { error: "actions come from the dashboard itself" });
    const request = (await body(req)) as { kind?: string; args?: Record<string, string> };
    const args: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.args ?? {})) if (typeof value === "string" && value.length <= 200) args[key] = value;
    const result = act(String(request.kind ?? ""), args);
    changed();
    return "error" in result ? json(res, 400, result) : json(res, 202, { id: result.id, command: result.command });
  }
  return json(res, 404, { error: "no such thing" });
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  createServer((req, res) => {
    handle(req, res).catch((error: Error) => {
      if (!res.headersSent) json(res, 500, { error: error.message });
      else res.end();
    });
  }).listen(ROOT_UI.port, "127.0.0.1", () => console.error(`stated: listening on 127.0.0.1:${ROOT_UI.port}`));
  // The root's own files: looked at when one changes. (The shares cannot be watched from
  // inside a VM; the host's daemon watches those and nudges.) And a look every second
  // regardless, which costs a few small files read, so that a missed event is a second
  // late and not lost.
  //
  // EACH DIRECTORY BY ITSELF, NEVER A TREE. node's recursive watch on Linux scans every
  // directory that appears under the tree. One that is gone again by then (git's
  // quarantine, while a bundle is checked) is an error it raises on the watcher, and with
  // nobody listening that ended this process: the dashboard died the first time a domain
  // sent work, on real VMs only, where the timing allows it (found by tier T3). So: no
  // recursion, and every watcher has a listener. One that fails is dropped; the look
  // every second remains.
  for (const dir of [ROOT.state, APPROVALS, path.join(ROOT.state, "refused"), path.join(ROOT.state, "secrets"), ROOT.domains])
    try {
      if (!fs.existsSync(dir)) continue;
      const watcher = fs.watch(dir, changed);
      watcher.on("error", (error) => {
        console.error(`stated: no longer watching ${dir}: ${String(error)}`);
        watcher.close();
      });
    } catch (error) {
      console.error(`stated: cannot watch ${dir}: ${String(error)}`);
    }
  setInterval(publish, 1000);
  publish();
}
