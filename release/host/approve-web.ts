// The approval page: a push waiting for a person, approved with one click in a browser on
// this Mac. Served by the host daemon (outside every VM) at APPROVE_HOSTNAME on the editors'
// port. What it shows is parsed here, on the host, from the very text that gets signed; what
// a push would send is computed in the root by the reviewer (root/reviewer.ts), a user that
// cannot push and does not parse anything the root's user hands it until the push is named.
//
// WHY A CLICK IS ENOUGH, AND WHAT IT TAKES TO FAKE ONE. The page is the only thing that can
// ask this daemon to sign, and it asks only with:
//   - a cookie given in exchange for the address `desolate approve --web` prints on this
//     Mac's terminal (HttpOnly, SameSite=Strict, a name of this stack's own). Nothing in a VM
//     has the token: it is in the host's state directory and nowhere else;
//   - a request from this page's own origin: the Host, Origin and Sec-Fetch-Site headers are
//     checked (a page an agent wrote, on a workspace's name, is another origin, and the
//     browser does not let it read this page or send these headers as this page);
//   - a per-push token in the request's body, which only this page's own script can read
//     (it is in a JSON answer no other origin can read);
//   - a JSON body (so another origin's form cannot send it at all).
// The page cannot be framed (frame-ancestors 'none', X-Frame-Options), runs no inline
// script, keeps no opener (Cross-Origin-Opener-Policy), and its button arms only after the
// page has been visible and focused for a second and the pointer then moves onto it: a click
// that was already on its way when a window opened under it lands on nothing.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { parseApproval } from "../shared/approval.ts";
import type { PushApproval } from "../shared/approval.ts";
import { APPROVE_HOSTNAME, editorHostPort } from "../shared/names.ts";
import { refusal } from "../workspace/editor-gate.ts";
import { paths, RELEASE_DIR } from "./paths.ts";

export const TOKEN_FILE = path.join(paths.state, "approve-token");
const UI = path.join(RELEASE_DIR, "host", "approve-ui");

/** The page's credential: made once, the host's alone (0600). */
export const approveToken = (): string => {
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
export const approveAddress = () => `http://${APPROVE_HOSTNAME}:${editorHostPort()}/?tkn=${approveToken()}`;

const cookieName = (token: string) => `desolate_approve_${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** A push's own token: tied to the credential and to the very text the page showed. The
 *  list of waiting pushes is the root's user's: if it lists another text under the same
 *  nonce by the time of the click, the token no longer matches and nothing is signed. */
export const pushToken = (token: string, message: string) => createHmac("sha256", Buffer.from(token, "hex")).update(`approve\n${message}`).digest("hex");
const digestOf = (message: string) => createHash("sha256").update(message).digest("hex");

export const SECURITY: Record<string, string> = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
const send = (res: ServerResponse, status: number, type: string, content: string | Buffer, extra: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(content), ...SECURITY, ...extra });
  res.end(content);
};
const text = (res: ServerResponse, status: number, message: string) => send(res, status, "text/plain; charset=utf-8", `desolate: ${message}\n`);
const json = (res: ServerResponse, status: number, value: unknown) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
const STATIC: Record<string, [string, string]> = {
  "/": ["approve.html", "text/html; charset=utf-8"],
  "/approve.js": ["approve.js", "text/javascript; charset=utf-8"],
  "/approve.css": ["approve.css", "text/css; charset=utf-8"],
};

/** What a push would send, as the reviewer in the root computed it: shown as data. */
export type Summary = {
  ok: boolean; error?: string; waiting?: boolean; warnings?: string[];
  commits?: { commit: string; subject: string; author: string }[]; more?: number;
  files?: { path: string; added: number; removed: number; binary?: boolean; sensitive?: boolean }[]; moreFiles?: number;
  base?: string | null; remote?: string | null; fastForward?: boolean | null; lfs?: number;
};
export type Waiting = { message: string; at: string };
const SUMMARY = { deadlineMs: 90_000, keepMs: 120_000 } as const;
export type Backend = {
  /** Pushes waiting for a person, as the root lists them (the root's word: only the
   *  message is used, and it is parsed here). */
  pending: () => Promise<Waiting[]>;
  /** What the push would send, from the reviewer. */
  summary: (push: PushApproval) => Promise<Summary>;
  /** Sign the message and give the signature to the keyring. */
  approve: (message: string) => Promise<void>;
  /** Take a waiting push off the list: the push that asked is refused. */
  refuse: (message: string) => Promise<void>;
};

const readBody = (req: IncomingMessage, limit = 4096): Promise<string | null> =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > limit) {
        resolve(null);
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(null));
  });

export const handler = (backend: Backend, log: (line: string) => void) => {
  // What the reviewer said of each text, by the text's own digest: a text listed again under
  // the same nonce is another push, with a summary of its own. Asked once per text, in the
  // background, with a deadline: a slow reviewer never holds up the list.
  const summaries = new Map<string, { at: number; value: Summary | null }>();
  const summaryOf = (push: PushApproval, message: string): Summary => {
    const key = digestOf(message);
    for (const [k, entry] of summaries) if (Date.now() - entry.at > SUMMARY.keepMs && entry.value) summaries.delete(k);
    const known = summaries.get(key);
    if (known) return known.value ?? { ok: false, waiting: true, error: "the reviewer is working it out" };
    const entry: { at: number; value: Summary | null } = { at: Date.now(), value: null };
    summaries.set(key, entry);
    const deadline = new Promise<Summary>((resolve) => setTimeout(() => resolve({ ok: false, error: "the reviewer did not answer in time" }), SUMMARY.deadlineMs).unref());
    void Promise.race([backend.summary(push), deadline])
      .catch((error: Error): Summary => ({ ok: false, error: error.message }))
      .then((value) => {
        entry.value = value;
        entry.at = Date.now();
      });
    return { ok: false, waiting: true, error: "the reviewer is working it out" };
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
  // This name only, this origin only: a page on any other name is refused before anything.
  const refused = refusal(APPROVE_HOSTNAME, req.headers);
  if (refused) return text(res, refused.status, `refused ${refused.why.replace(/this is the editor of/, "this is the approval page at")}`);
  const token = approveToken();
  const name = cookieName(token);
  const url = new URL(req.url ?? "/", `http://${APPROVE_HOSTNAME}`);
  const given = url.searchParams.get("tkn");
  if (req.method === "GET" && url.pathname === "/" && given !== null) {
    if (!same(given, token)) return text(res, 403, "refused: that is not this stack's approval address; `desolate approve --web` prints it");
    res.writeHead(303, { location: "/", "set-cookie": `${name}=${token}; HttpOnly; SameSite=Strict; Path=/`, "content-length": 0, ...SECURITY });
    return res.end();
  }
  const cookie = new RegExp(`(?:^|;\\s*)${name}=([0-9a-f]{48})(?:;|$)`).exec(String(req.headers.cookie ?? ""))?.[1];
  const signedIn = cookie !== undefined && same(cookie, token);
  if (req.method === "GET" && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname]!;
    return send(res, 200, type, fs.readFileSync(path.join(UI, file)));
  }
  if (!signedIn) return json(res, 401, { error: "open the approval page at the address `desolate approve --web` prints, on this Mac's terminal: it carries this stack's token" });
  // Below, every request is this page's own script's: the same origin, said by the browser.
  if (String(req.headers["sec-fetch-site"] ?? "") !== "same-origin") return json(res, 403, { error: "a request this page did not make" });

  if (req.method === "GET" && url.pathname === "/pending") {
    const out = [];
    for (const waiting of await backend.pending().catch(() => [] as Waiting[])) {
      const push = parseApproval(waiting.message);
      if (!push) continue;
      // Everything shown is the parsed text and the reviewer's account; the root's user's own
      // words about a push are not shown at all.
      out.push({
        nonce: push.nonce, repo: push.repo, branch: push.branch, commit: push.commit, onto: push.onto,
        token: pushToken(token, waiting.message), summary: summaryOf(push, waiting.message),
      });
    }
    return json(res, 200, { pending: out });
  }
  if (req.method === "POST" && (url.pathname === "/approve" || url.pathname === "/refuse")) {
    if (!/^application\/json(;|$)/.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON only" });
    if (req.headers.origin !== `http://${APPROVE_HOSTNAME}:${editorHostPort()}`) return json(res, 403, { error: "a request from another origin" });
    const body = await readBody(req);
    let asked: { nonce?: unknown; token?: unknown; commit?: unknown };
    try {
      asked = JSON.parse(body ?? "") as typeof asked;
    } catch {
      return json(res, 400, { error: "not JSON" });
    }
    const nonce = String(asked.nonce ?? "");
    const given = String(asked.token ?? "");
    if (!/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(given)) return json(res, 403, { error: "not a push this page showed" });
    // The push, as the root lists it now. Signed only if it is the very text the page showed:
    // the token is over that text, so another text under the same nonce does not match.
    const waiting = (await backend.pending()).find((w) => parseApproval(w.message)?.nonce === nonce);
    const push = waiting ? parseApproval(waiting.message) : null;
    if (!waiting || !push) return json(res, 410, { error: "that push is no longer waiting (each waits two minutes)" });
    if (!same(given, pushToken(token, waiting.message))) return json(res, 409, { error: "that push is not the one this page showed: it changed, so nothing was signed; look at it again" });
    if (asked.commit !== push.commit) return json(res, 409, { error: "that is not the commit this push names" });
    try {
      if (url.pathname === "/approve") {
        await backend.approve(waiting.message);
        log(`approve page: approved ${push.repo} ${push.branch} ${push.commit}${push.onto ? ` (from ${push.onto})` : " (a new branch)"}`);
      } else {
        await backend.refuse(waiting.message);
        log(`approve page: refused ${push.repo} ${push.branch} ${push.commit}`);
      }
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 502, { error: (error as Error).message });
    }
  }
  return json(res, 404, { error: "no such thing" });
  };
};
