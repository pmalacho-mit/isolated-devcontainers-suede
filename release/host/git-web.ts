// The git terminal: a bash in the git VM (host/git-vm.ts), in a browser tab on this Mac,
// served by the host daemon at GIT_HOSTNAME on the editors' port. `desolate git <repo>`
// prints its address.
//
// Who can use it: the browser tab that opened the address `desolate git` printed, as with the
// approval page (approve-web.ts): a cookie only that address gives (HttpOnly, SameSite=Strict,
// a name of this stack's own), requests from this page's own origin only (Sec-Fetch-Site,
// Origin), JSON bodies, and a token per shell that only this page's script was given. A page
// an agent wrote, on a workspace's name, can do none of that.
//
// What a person types there runs in the git VM: no network, no key, nothing of a project's,
// and a push from there still waits for the approval page. What the terminal draws is the
// shell's output, bytes an agent may have written: the page's xterm.js has links that do
// nothing, no clipboard, and no title (git-ui/git.js).
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { APPROVE_HOSTNAME, editorHostPort, GIT_HOSTNAME, parseRepo } from "../shared/names.ts";
import { embedAddress } from "./approve-web.ts";
import { refusal } from "../workspace/editor-gate.ts";
import { guest, paths, RELEASE_DIR } from "./paths.ts";

export const TOKEN_FILE = path.join(paths.state, "git-token");
const UI = path.join(RELEASE_DIR, "host", "git-ui");
/** idleMs: a shell with no tab reading it ends after this (a reload opens a new one). */
const LIMIT = { sessions: 6, input: 64 * 1024, kept: 256 * 1024, idleMs: 30_000 } as const;

export const gitToken = (): string => {
  try {
    const value = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (/^[0-9a-f]{48}$/.test(value)) return value;
  } catch {
    /* none yet */
  }
  const made = randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, `${made}\n`, { mode: 0o600 });
  return made;
};
export const gitAddress = (repo?: string) => `http://${GIT_HOSTNAME}:${editorHostPort()}/?tkn=${gitToken()}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`;

const cookieName = (token: string) => `desolate_git_${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const SECURITY: Record<string, string> = {
  // xterm.js makes <style> elements of its own: styles may be inline, scripts may not.
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};
/** The one page this one frames: the approval page's /embed, beside the terminal. */
const headers = () => ({ ...SECURITY, "content-security-policy": `${SECURITY["content-security-policy"]}; frame-src http://${APPROVE_HOSTNAME}:${editorHostPort()}` });
const send = (res: ServerResponse, status: number, type: string, content: string | Buffer) => {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(content), ...headers() });
  res.end(content);
};
const json = (res: ServerResponse, status: number, value: unknown) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
const STATIC: Record<string, [string, string]> = {
  "/": ["git.html", "text/html; charset=utf-8"],
  "/git.js": ["git.js", "text/javascript; charset=utf-8"],
  "/git.css": ["git.css", "text/css; charset=utf-8"],
  "/vendor/xterm.js": ["vendor/xterm.js", "text/javascript; charset=utf-8"],
  "/vendor/xterm.css": ["vendor/xterm.css", "text/css; charset=utf-8"],
  "/vendor/addon-fit.js": ["vendor/addon-fit.js", "text/javascript; charset=utf-8"],
};

type Session = { id: string; token: string; child: ChildProcess; kept: Buffer[]; keptBytes: number; streams: Set<ServerResponse>; ended: boolean; seen: number };

/** `spawn`: a process in the git VM with pipes (the backend's). */
/** `prepare`: the git VM up and the person's clone of `repo` there (git-vm.ts), before a
 *  shell opens in it. */
export const handler = (spawn: (argv: string[]) => ChildProcess, log: (line: string) => void, prepare: (repo: string | null) => Promise<void> = async () => {}) => {
  const sessions = new Map<string, Session>();
  const reap = setInterval(() => {
    for (const s of sessions.values())
      if ((s.ended || s.streams.size === 0) && Date.now() - s.seen > LIMIT.idleMs) {
        s.child.kill("SIGKILL");
        sessions.delete(s.id);
      }
  }, 5_000);
  reap.unref();

  const open = (repo: string) => {
    const where = parseRepo(repo) ? `${guest.git}/${repo}` : guest.git;
    const s: Session = { id: randomBytes(8).toString("hex"), token: randomBytes(24).toString("hex"), child: spawn(["python3", "-I", `${guest.release}/git/terminal.py`, where]), kept: [], keptBytes: 0, streams: new Set(), ended: false, seen: Date.now() };
    const out = (chunk: Buffer) => {
      s.kept.push(chunk);
      s.keptBytes += chunk.length;
      while (s.keptBytes > LIMIT.kept && s.kept.length > 1) s.keptBytes -= s.kept.shift()!.length;
      for (const res of s.streams) res.write(`data: ${chunk.toString("base64")}\n\n`);
    };
    s.child.stdout?.on("data", out);
    s.child.stderr?.on("data", out);
    s.child.stdin?.on("error", () => {});
    s.child.on("close", () => {
      s.ended = true;
      for (const res of s.streams) res.end("event: end\ndata: \n\n");
    });
    sessions.set(s.id, s);
    log(`git terminal: a shell in ${where}`);
    return s;
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const refused = refusal(GIT_HOSTNAME, req.headers);
    if (refused) return send(res, refused.status, "text/plain; charset=utf-8", `desolate: refused ${refused.why.replace(/this is the editor of/, "this is the git terminal at")}\n`);
    const token = gitToken();
    const name = cookieName(token);
    const url = new URL(req.url ?? "/", `http://${GIT_HOSTNAME}`);
    const given = url.searchParams.get("tkn");
    if (req.method === "GET" && url.pathname === "/" && given !== null) {
      if (!same(given, token)) return send(res, 403, "text/plain; charset=utf-8", "desolate: refused: that is not this stack's git terminal address; `desolate git` prints it\n");
      const repo = url.searchParams.get("repo");
      res.writeHead(303, { location: repo && parseRepo(repo) ? `/?repo=${encodeURIComponent(repo)}` : "/", "set-cookie": `${name}=${token}; HttpOnly; SameSite=Strict; Path=/`, "content-length": 0, ...SECURITY });
      return res.end();
    }
    const cookie = new RegExp(`(?:^|;\\s*)${name}=([0-9a-f]{48})(?:;|$)`).exec(String(req.headers.cookie ?? ""))?.[1];
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname]!;
      return send(res, 200, type, fs.readFileSync(path.join(UI, file)));
    }
    if (cookie === undefined || !same(cookie, token)) return json(res, 401, { error: "open the git terminal at the address `desolate git` prints, on this Mac's terminal: it carries this stack's token" });
    if (String(req.headers["sec-fetch-site"] ?? "") !== "same-origin") return json(res, 403, { error: "a request this page did not make" });

    // The approval page's address for the frame beside the terminal (its key in the
    // fragment): to this page's own script, which only the person's browser can load.
    if (req.method === "GET" && url.pathname === "/approvals-frame") return json(res, 200, { url: embedAddress() });
    const match = /^\/session\/([0-9a-f]{16})\/(stream|input|resize)$/.exec(url.pathname);
    if (req.method === "GET" && match?.[2] === "stream") {
      const s = sessions.get(match[1]!);
      if (!s || !same(url.searchParams.get("token") ?? "", s.token)) return json(res, 404, { error: "no such shell" });
      s.seen = Date.now();
      res.writeHead(200, { "content-type": "text/event-stream", ...SECURITY, connection: "keep-alive" });
      for (const chunk of s.kept) res.write(`data: ${chunk.toString("base64")}\n\n`);
      if (s.ended) return res.end("event: end\ndata: \n\n");
      s.streams.add(res);
      const beat = setInterval(() => res.write(": still here\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(beat);
        s.streams.delete(res);
        s.seen = Date.now();
      });
      return;
    }
    if (req.method !== "POST") return json(res, 404, { error: "no such thing" });
    if (!/^application\/json(;|$)/.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON only" });
    if (req.headers.origin !== `http://${GIT_HOSTNAME}:${editorHostPort()}`) return json(res, 403, { error: "a request from another origin" });
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > LIMIT.input * 2) return json(res, 413, { error: "too much at once" });
    }
    let asked: Record<string, unknown>;
    try {
      asked = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "not JSON" });
    }
    if (url.pathname === "/session") {
      const live = [...sessions.values()].filter((s) => !s.ended).length;
      if (live >= LIMIT.sessions) return json(res, 429, { error: `${LIMIT.sessions} shells are open already: close a tab (its shell ends half a minute later)` });
      const repo = parseRepo(asked.repo) ? String(asked.repo) : null;
      try {
        await prepare(repo);
      } catch (error) {
        return json(res, 502, { error: `the git VM could not be readied: ${(error as Error).message}` });
      }
      const s = open(repo ?? "");
      return json(res, 200, { id: s.id, token: s.token });
    }
    const s = match ? sessions.get(match[1]!) : undefined;
    if (!s || !same(String(asked.token ?? ""), s.token)) return json(res, 404, { error: "no such shell" });
    s.seen = Date.now();
    if (s.ended) return json(res, 410, { error: "the shell ended" });
    if (match![2] === "input") {
      const data = String(asked.data ?? "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > LIMIT.input) return json(res, 400, { error: "input is base64, at most 64 KiB at once" });
      s.child.stdin?.write(`i ${data}\n`);
      return json(res, 200, { ok: true });
    }
    const cols = Number(asked.cols);
    const rows = Number(asked.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 1000 || rows < 1 || rows > 500) return json(res, 400, { error: "a size is whole columns and rows" });
    s.child.stdin?.write(`r ${cols} ${rows}\n`);
    return json(res, 200, { ok: true });
  };
};
