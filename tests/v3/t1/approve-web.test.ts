// T1. The approval page (host/approve-web.ts): what it takes before it signs. A real HTTP
// server on loopback, a stand-in for the stack behind it, and each way a request that is not
// the person's own page could arrive: another name, another origin, no cookie, a form, a
// made-up push, a push with another commit. Only the page's own request signs.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo, Server } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-approve-"));
process.env.DESOLATE_HOME = home;
process.env.DESOLATE_EDITOR_PORT = "31599";
const { approveToken, handler, pushToken } = await import("../../../release/host/approve-web.ts");
const { formatApproval } = await import("../../../release/shared/approval.ts");

const NAME = "desolate-approve.localhost";
const ORIGIN = `http://${NAME}:31599`;
const push = { repo: "acme/widgets", branch: "issue/12", commit: "a".repeat(40), onto: null, nonce: "1".repeat(32) };
const message = formatApproval(push);
// What the root's user lists: a test can change it under the page, as a compromised one could.
let listed = [{ message, at: "2026-11-12T00:00:00Z" }];
const approved: string[] = [];
const refused: string[] = [];
let server: Server;
let port = 0;

before(async () => {
  server = createServer(handler({
    pending: async () => listed,
    summary: async () => ({ ok: true, commits: [{ commit: "a".repeat(40), subject: "<img src=x onerror=alert(1)>", author: "agent" }] }),
    approve: async (m) => void approved.push(m),
    refuse: async (m) => void refused.push(m),
  }, () => {}));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
const call = (method: string, url: string, headers: Record<string, string>, body?: string): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: url, headers: { host: `${NAME}:31599`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });

let cookie = "";
const page = { "sec-fetch-site": "same-origin" };
const asPage = () => ({ cookie, ...page });
const approve = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  call("POST", "/approve", { ...asPage(), origin: ORIGIN, "content-type": "application/json", ...headers }, JSON.stringify(body));
const good = () => ({ nonce: push.nonce, token: pushToken(approveToken(), message), commit: push.commit });

describe("T1 the approval page", () => {
  it("the address with the token gives a cookie the page's script cannot read; a wrong token gives nothing", async () => {
    const wrong = await call("GET", `/?tkn=${"0".repeat(48)}`, {});
    assert.equal(wrong.status, 403);
    assert.equal(wrong.headers["set-cookie"], undefined);
    const right = await call("GET", `/?tkn=${approveToken()}`, {});
    assert.equal(right.status, 303);
    const set = String(right.headers["set-cookie"]);
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    cookie = set.split(";")[0]!;
  });

  it("every answer forbids framing, inline script and an opener", async () => {
    const html = await call("GET", "/", { cookie });
    assert.equal(html.status, 200);
    assert.match(String(html.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.match(String(html.headers["content-security-policy"]), /script-src 'self'/);
    assert.doesNotMatch(String(html.headers["content-security-policy"]), /unsafe-inline/);
    assert.equal(html.headers["x-frame-options"], "DENY");
    assert.equal(html.headers["cross-origin-opener-policy"], "same-origin");
    assert.doesNotMatch(html.body, /<script>[^<]/, "no inline script in the page");
  });

  it("another name, another origin, another site: refused before anything", async () => {
    assert.equal((await call("GET", "/pending", { ...asPage(), host: `evil.example:31599` })).status, 421, "a DNS-rebound name");
    assert.equal((await call("GET", "/pending", { ...asPage(), host: `web-one-editor-abc123.localhost:31599` })).status, 421, "a workspace's editor name");
    assert.equal((await call("GET", "/pending", { cookie, "sec-fetch-site": "same-site" })).status, 403, "a request a workspace's page started");
    assert.equal((await call("GET", "/pending", { cookie, "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await call("GET", "/pending", { cookie, origin: "http://web-one-abc123.localhost:31599" })).status, 403);
    assert.equal((await call("GET", "/pending", { cookie })).status, 403, "a request that says nothing of where it came from is not the page's");
    assert.equal((await call("GET", "/pending", page)).status, 401, "no cookie");
  });

  it("control: the page's own request lists the push, and the summary is data", async () => {
    await call("GET", "/pending", asPage());
    // (The summary is worked out in the background: the first answer says it is coming.)
    await new Promise((resolve) => setTimeout(resolve, 50));
    const listed = await call("GET", "/pending", asPage());
    assert.equal(listed.status, 200);
    const body = JSON.parse(listed.body) as { pending: { nonce: string; token: string; summary: { commits: { subject: string }[] } }[] };
    assert.equal(body.pending.length, 1);
    assert.equal(body.pending[0]!.token, pushToken(approveToken(), message));
    assert.equal(body.pending[0]!.summary.commits[0]!.subject, "<img src=x onerror=alert(1)>", "passed on as JSON text; the page sets it as text, never markup");
    assert.match(String(listed.headers["content-type"]), /^application\/json/);
  });

  it("nothing signs without everything: a form, another origin, no push token, a made-up push, another commit", async () => {
    assert.equal((await approve(good(), { "content-type": "application/x-www-form-urlencoded" })).status, 415, "a form another site could send");
    assert.equal((await approve(good(), { "content-type": "text/plain" })).status, 415);
    assert.equal((await approve(good(), { origin: "http://web-one-abc123.localhost:31599" })).status, 403, "another origin");
    assert.equal((await approve(good(), { origin: "null" })).status, 403);
    assert.equal((await approve({ ...good(), token: "0".repeat(64) })).status, 409, "a push token it did not give");
    assert.equal((await approve({ ...good(), token: "short" })).status, 403, "not a token at all");
    assert.equal((await approve({ ...good(), nonce: "2".repeat(32) })).status, 410, "a push that is not waiting");
    assert.equal((await approve({ ...good(), commit: "b".repeat(40) })).status, 409, "a commit the push does not name");
    assert.equal((await approve(good(), { cookie: "desolate_approve_x=" + "0".repeat(48) })).status, 401, "another cookie");
    assert.deepEqual(approved, [], "nothing was signed");
  });

  it("the root's user lists another text under the same nonce after the page drew it: nothing is signed", async () => {
    // A decoy was shown (same nonce, same commit, another branch); the real text is listed at
    // the click. The token is over the text the page showed, so it does not match.
    const decoy = formatApproval({ ...push, branch: "harmless" });
    const shownToken = pushToken(approveToken(), decoy);
    const swapped = await approve({ nonce: push.nonce, token: shownToken, commit: push.commit });
    assert.equal(swapped.status, 409);
    assert.match(swapped.body, /not the one this page showed/);
    assert.deepEqual(approved, []);
    listed = [{ message, at: "2026-11-12T00:00:00Z" }];
  });

  it("control: the page's own approval signs exactly the message it showed", async () => {
    const answer = await approve(good());
    assert.equal(answer.status, 200, answer.body);
    assert.deepEqual(approved, [message]);
    const no = await call("POST", "/refuse", { ...asPage(), origin: ORIGIN, "content-type": "application/json" }, JSON.stringify(good()));
    assert.equal(no.status, 200);
    assert.deepEqual(refused, [message]);
  });
});
