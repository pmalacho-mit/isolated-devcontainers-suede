// T2 (fake backend). Section 4.8: the root UI. A state service in the root VM holds the
// stack's state and pushes changes; the dashboard draws from it; actions go to the host
// through a fixed list; a push from the dashboard still waits for the person on the host.
// The budgets are the spec's: state shown <= 300 ms after opening, a workspace's status
// change <= 1 s later, a click acknowledged <= 100 ms later.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack, REPO_ROOT } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
let port = 0;
let commit = "";
const HOST = "desolate.localhost";
type Answer = { status: number; headers: string; body: string; ms: number };
/** One request to the host's loopback, as a browser at the dashboard would send it. */
const http = (method: string, pathAndQuery: string, options: { host?: string; headers?: string[]; body?: unknown } = {}): Promise<Answer> =>
  new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect(port, "127.0.0.1");
    const payload = options.body === undefined ? "" : JSON.stringify(options.body);
    let data = "";
    socket.setTimeout(20_000, () => socket.destroy());
    socket.on("connect", () => socket.write([`${method} ${pathAndQuery} HTTP/1.1`, `Host: ${options.host ?? HOST}:${port}`, ...(options.headers ?? []), ...(payload ? ["Content-Type: application/json", `Content-Length: ${Buffer.byteLength(payload)}`] : []), "Connection: close", "", payload].join("\r\n")));
    // `ms` is when the whole answer had arrived (its Content-Length), as a browser sees
    // it: the connection itself may be closed a moment later by whatever carries it.
    let ms = 0;
    socket.on("data", (chunk) => {
      data += chunk;
      const split = data.indexOf("\r\n\r\n");
      const length = Number(/\r\ncontent-length: (\d+)/i.exec(data.slice(0, split))?.[1] ?? -1);
      if (ms === 0 && split >= 0 && length >= 0 && Buffer.byteLength(data.slice(split + 4)) >= length) ms = performance.now() - started;
    });
    socket.on("close", () => {
      const split = data.indexOf("\r\n\r\n");
      resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0), headers: data.slice(0, split), body: data.slice(split + 4), ms: ms || performance.now() - started });
    });
    socket.on("error", () => resolve({ status: 0, headers: "", body: data, ms: performance.now() - started }));
  });
type State = {
  stack: { backend: string; isolated: boolean } | null; hostConnected: boolean; rootEditor: string | null;
  repos: { repo: string }[]; offers: { repo: string; branch: string; commit: string }[]; approvals: { repo: string; branch: string; commit: string }[];
  domains: { slug: string; workspaces: { workspace: string; says: { status: { color: string; message: string } | null }; host: { status: string; editor?: string; devcontainer?: string } | null }[] }[];
  actions: { id: string; kind: string; command: string; state: string; lines: string[] }[];
};
const state = async () => JSON.parse((await http("GET", "/state")).body) as State;
const ws = (s: State, target: string) => s.domains.find((d) => d.slug === target.split("/")[0])?.workspaces.find((w) => w.workspace === target.split("/")[1]);
const action = (kind: string, args: Record<string, string>) => http("POST", "/action", { headers: ["X-Desolate-UI: 1", "Sec-Fetch-Site: same-origin", `Origin: http://${HOST}:${port}`], body: { kind, args } });
const until = async (probe: () => Promise<boolean>, ms = 30_000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return probe();
};
/** The event stream: resolves with the first pushed state that satisfies `wanted`, and when. */
const pushed = (wanted: (s: State) => boolean, ms = 15_000): Promise<{ at: number; state: State } | null> =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); resolve(null); }, ms);
    socket.on("connect", () => socket.write(`GET /events HTTP/1.1\r\nHost: ${HOST}:${port}\r\nAccept: text/event-stream\r\n\r\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (const match of buffer.matchAll(/data: (\{.*\})\n\n/g)) {
        const s = JSON.parse(match[1]!) as State;
        if (wanted(s)) { clearTimeout(timer); socket.destroy(); return resolve({ at: performance.now(), state: s }); }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
    });
    socket.on("error", () => resolve(null));
  });

describe("T2 section 4.8: the root UI", () => {
  before(() => {
    stack = newStack("ui");
    stack.seed("acme/app", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    const booted = bootstrap(stack);
    assert.equal(booted.code, 0);
    assert.match(booted.stdout, /^ {2}dashboard {4}http:\/\/desolate\.localhost:\d+\/ {3}\(and: desolate ui\)$/m);
    port = Number(new URL((JSON.parse(stack.quiet("ui", "--json").stdout) as { dashboard: string }).dashboard).port);
  });
  after(() => stack.destroy());

  it("first run: the dashboard is there before anything else is, and walks through setting up", async () => {
    stack.step("an empty stack");
    const page = await http("GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.headers, /content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'/i, "its own code only: no inline script, no remote resource");
    assert.doesNotMatch(page.body, /<script(?![^>]* src="\/ui\.js")|\son[a-z]+="|https?:\/\//i, "no inline script, handler or remote address in the page");
    for (const file of ["/ui.js", "/ui.css"]) assert.equal((await http("GET", file)).status, 200, file);
    const empty = await state();
    assert.deepEqual([empty.repos, empty.domains, empty.offers], [[], [], []]);
    assert.ok(await until(async () => (await state()).hostConnected), "the host's daemon has told the state service about the host");
    assert.deepEqual((await state()).stack, { instance: stack.instance, backend: "fake", isolated: false, editorPort: port, approver: "terminal" });
    // The first-run steps, done from the dashboard; each records the command it ran.
    assert.equal(stack.quiet("clone", "acme/app").code, 0);
    assert.equal((await action("domain.create", { domain: "web", title: "the web app" })).status, 202);
    assert.ok(await until(async () => (await state()).domains.some((d) => d.slug === "web")));
    assert.equal((await action("domain.add", { domain: "web", repo: "acme/app" })).status, 202);
    assert.ok(await until(async () => (await state()).actions.filter((a) => a.state === "done").length === 2));
    const up = await action("workspace.up", { domain: "web", workspace: "one" });
    assert.equal(up.status, 202);
    assert.equal((JSON.parse(up.body) as { command: string }).command, "desolate up web --name one", "the dashboard shows the command the host runs");
    assert.ok(await until(async () => ws(await state(), "web/one")?.host?.status === "running" && (await state()).actions.at(-1)?.state === "done", 120_000));
    const done = (await state()).actions.at(-1)!;
    assert.ok(done.lines.some((line) => /^progress: VM booted \([\d.]+ s\)$/.test(line)), `a start shows its phases as they end: ${done.lines.join(" | ")}`);
    const one = ws(await state(), "web/one")!;
    assert.match(one.host!.editor ?? "", /^http:\/\/web-one-editor-[0-9a-f]+\.localhost:\d+\/\?tkn=[0-9a-f]{48}&folder=/, "the editor's address is known: one click, no token to copy");
    assert.equal(one.host!.devcontainer, "none");
  });

  it("only the dashboard's own page may talk to it, and only the host's daemon to the host's side", async () => {
    stack.step("who may talk to the state service");
    assert.equal((await http("GET", "/state", { host: "127.0.0.1" })).status, 421);
    assert.equal((await http("GET", "/state", { host: "web-one-editor-000000.localhost" })).status, 421);
    assert.equal((await http("GET", "/state", { headers: ["Sec-Fetch-Site: cross-site"] })).status, 403);
    assert.equal((await http("GET", "/events", { headers: ["Origin: http://evil.example"] })).status, 403);
    // A page elsewhere cannot press a button: no header, no JSON, another origin.
    assert.equal((await http("POST", "/action", { body: { kind: "workspace.stop", args: { domain: "web", workspace: "one" } } })).status, 403);
    assert.equal((await http("POST", "/action", { headers: ["X-Desolate-UI: 1", "Sec-Fetch-Site: same-site"], body: { kind: "workspace.stop", args: { domain: "web", workspace: "one" } } })).status, 403);
    // The host's side takes the host's token, which no browser has.
    for (const [method, target] of [["GET", "/host/requests"], ["PUT", "/host/facts"], ["POST", "/host/progress"]] as const) assert.equal((await http(method, target, { body: {} })).status, 403, target);
    assert.equal((await http("PUT", "/host/facts", { headers: [`Authorization: Bearer ${"0".repeat(48)}`], body: { stack: { isolated: true } } })).status, 403);
    // Only what is on the list, with arguments that are names.
    for (const [kind, args] of [["workspace.rm", { domain: "web", workspace: "one" }], ["workspace.stop", { domain: "../etc", workspace: "one" }], ["workspace.up", { domain: "web", workspace: "--fetch" }], ["repo.fetch", { repo: "--upload-pack=x" }], ["domain.create", { domain: "ok", title: "--help" }], ["constructor", {}]] as [string, Record<string, string>][]) {
      const refused = await action(kind, args);
      // An option-like title is dropped, not passed on: the domain is made without one.
      if (kind === "domain.create") assert.deepEqual([refused.status, (JSON.parse(refused.body) as { command: string }).command], [202, "desolate domain create ok"]);
      else assert.equal(refused.status, 400, `${kind} ${JSON.stringify(args)}`);
    }
    assert.equal(ws(await state(), "web/one")?.host?.status, "running", "control: nothing above stopped it");
    assert.equal((await state()).stack?.isolated, false, "nor changed what the host said");
  });

  it("budgets: state at once, a status change within a second, a click acknowledged within 100 ms", async () => {
    stack.step("the budgets");
    // Opening: the page, its script, its style and the first pushed state, as a browser asks for them.
    const opens: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const [page, script, style, first] = await Promise.all([http("GET", "/"), http("GET", "/ui.js"), http("GET", "/ui.css"), pushed(() => true)]);
      opens.push(Math.max(page.ms, script.ms, style.ms, first!.at - started));
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    assert.ok(Math.min(...opens) <= 300, `the dashboard has current state ${Math.round(Math.min(...opens))} ms after it opens (budget 300)`);
    // A workspace says something: the dashboard is told, it does not ask.
    const waiting = pushed((s) => ws(s, "web/one")?.says.status?.message === "need: a decision about <b>the API</b> <script>alert(1)</script>");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const child = spawn(path.join(REPO_ROOT, "release", "cli.sh"), ["exec", "web/one", "--", "/desolate/status", "set", "orange", "need: a decision about <b>the API</b> <script>alert(1)</script>"], { env: stack.env, stdio: "ignore" });
    const exited = await new Promise<number>((resolve) => child.on("close", () => resolve(performance.now())));
    const told = await waiting;
    assert.ok(told, "the change was pushed");
    assert.ok(told!.at - exited <= 1000, `pushed ${Math.round(told!.at - exited)} ms after the command that set it returned (budget 1000)`);
    assert.equal(ws(told!.state, "web/one")!.says.status!.color, "orange");
    // A click: acknowledged with the command it will run, before anything has run.
    const clicks: number[] = [];
    for (let i = 0; i < 3; i++) clicks.push((await action("repo.fetch", { repo: "acme/app" })).ms);
    assert.ok(Math.min(...clicks) <= 100, `a click is acknowledged in ${Math.round(Math.min(...clicks))} ms (budget 100)`);
    assert.ok(await until(async () => (await state()).actions.filter((a) => a.kind === "repo.fetch" && a.state === "done").length === 3));
  });

  it("in a browser: cards, Needs you, and a workspace's words shown as text, never run", async () => {
    stack.step("the dashboard in a browser");
    const chrome = [process.env.DESOLATE_CHROME, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((file) => file && fs.existsSync(file));
    assert.ok(chrome, "this check needs Chrome or Chromium: install one, or set DESOLATE_CHROME to its path");
    const profile = fs.mkdtempSync(path.join(stack.work, "chrome-"));
    // `?once` draws the current state and leaves no stream open, so the browser finishes.
    const dump = (...extra: string[]) => spawnSync(chrome!, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "--host-resolver-rules=MAP *.localhost 127.0.0.1", "--enable-logging=stderr", "--log-level=0", "--virtual-time-budget=4000", "--window-size=1180,1500", ...extra, `http://${HOST}:${port}/?once`], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    let page = dump("--dump-dom");
    for (let i = 0; i < 4 && !/data-domain="web"/.test(page.stdout); i++) page = dump("--dump-dom");
    // A picture of it, for a person to look at (section 4.8: the owner reviews screenshots).
    if (process.env.DESOLATE_SCREENSHOTS) dump(`--screenshot=${path.join(process.env.DESOLATE_SCREENSHOTS, "dashboard.png")}`);
    const dom = page.stdout;
    assert.match(dom, /<div class="card" data-domain="web">[\s\S]*<h3>the web app<\/h3>/, dom.slice(0, 600));
    assert.match(dom, /<li data-workspace="web\/one"><span class="dot orange"/, "the workspace's colour, visible at a glance");
    assert.match(dom, /<section id="needs">[\s\S]*web\/one[\s\S]*need: a decision about &lt;b&gt;the API&lt;\/b&gt; &lt;script&gt;alert\(1\)&lt;\/script&gt;/, "what the workspace said is on the page as text");
    assert.equal((dom.match(/<script/g) ?? []).length, 1, "and the only script on the page is the dashboard's own");
    assert.doesNotMatch(page.stderr, /Refused to|Content Security Policy|Uncaught/i, "nothing the page did was refused by its own policy, and nothing threw");
    assert.match(dom, /<a class="button" href="http:\/\/web-one-editor-[0-9a-f]+\.localhost:\d+\/\?tkn=[0-9a-f]{48}[^"]*" target="_blank" rel="noopener" data-editor="">Open editor<\/a>/);
    assert.doesNotMatch(dom.replace(/href="[^"]*"/g, ""), /tkn=[0-9a-f]{8}/, "a token is in a link's address and never in what is shown");
    assert.match(dom, /NOT ISOLATED: fake backend/);
  });

  it("stop and start from the dashboard", async () => {
    stack.step("stop and start");
    assert.equal((await action("workspace.stop", { domain: "web", workspace: "one" })).status, 202);
    assert.ok(await until(async () => ws(await state(), "web/one")?.host?.status === "stopped", 60_000));
    assert.equal((await action("workspace.start", { domain: "web", workspace: "one" })).status, 202);
    assert.ok(await until(async () => ws(await state(), "web/one")?.host?.status === "running" && (await state()).actions.at(-1)?.state === "done", 120_000));
    assert.equal((await state()).actions.at(-1)!.command, "desolate start web/one");
  });

  it("an offer appears, is reviewed, and a push from the dashboard still waits for the person on the host", async () => {
    stack.step("review and push");
    const work = stack.quiet("exec", "web/one", "--", "sh", "-c", "git checkout -q -b fix && echo fixed >> README.md && git -c user.name=t -c user.email=t@example.test commit -qam 'fix: the thing' && desolate offer && git rev-parse HEAD");
    assert.equal(work.code, 0, work.stderr);
    commit = work.stdout.trim().split("\n").pop()!;
    assert.ok(await until(async () => (await state()).offers.some((o) => o.branch === "fix" && o.commit === commit)), "the offer is on the dashboard");
    const review = JSON.parse((await http("GET", "/review?domain=web&repo=acme%2Fapp&branch=fix")).body) as { commit: string; commits: { subject: string }[]; files: string[]; pushable: boolean };
    assert.deepEqual([review.commit, review.commits.map((c) => c.subject), review.files, review.pushable], [commit, ["fix: the thing"], ["README.md"], true]);
    // Not the commit that was reviewed: refused before anything is asked.
    assert.equal((await action("offer.push", { domain: "web", repo: "acme/app", branch: "fix", commit: "0".repeat(40) })).status, 400);
    const asked = await action("offer.push", { domain: "web", repo: "acme/app", branch: "fix", commit });
    assert.equal(asked.status, 202);
    assert.ok(await until(async () => (await state()).approvals.some((a) => a.branch === "fix" && a.commit === commit)), "it is waiting, and the dashboard says so under Needs you");
    assert.equal(stack.forge("refs", "acme/app").includes("fix"), false, "nothing has been pushed: the dashboard cannot approve");
    const approved = stack.person("Type the branch name", "fix", "approve");
    assert.equal(approved.code, 0, approved.stdout);
    assert.ok(await until(async () => (await state()).actions.some((a) => a.kind === "offer.push" && a.state === "done")), JSON.stringify((await state()).actions.at(-1)));
    assert.match(stack.forge("refs", "acme/app"), new RegExp(`^fix ${commit}$`, "m"));
    const end = await state();
    assert.deepEqual([end.offers.length, end.approvals.length], [0, 0], "the offer is no longer waiting");
  });

  it("the root has an editor, for review: Restricted Mode, at a name of its own", async () => {
    stack.step("the root editor");
    const shown = stack.desolate("ui");
    assert.match(shown.stdout, /^dashboard {4}http:\/\/desolate\.localhost:\d+\/\nroot editor {2}http:\/\/desolate-editor\.localhost:\d+\/\?tkn=[0-9a-f]{48}&folder=%2Fdesolate%2Froot$/m);
    const url = new URL((JSON.parse(stack.quiet("ui", "--json").stdout) as { rootEditor: string }).rootEditor);
    const cookie = `Cookie: vscode-tkn=${url.searchParams.get("tkn")}`;
    const page = await http("GET", "/", { host: url.hostname, headers: [cookie] });
    assert.equal(page.status, 200, page.body.slice(0, 200));
    assert.match(page.body, /enableWorkspaceTrust&quot;:true/, "workspace trust is on: content is not trusted here");
    assert.equal((await http("GET", "/", { host: url.hostname })).status, 403, "control: the editor wants its token");
    assert.equal((await http("GET", "/", { host: url.hostname, headers: [cookie, `Origin: http://${HOST}:${port}`] })).status, 403, "the dashboard's page is another origin to it");
    assert.equal((await state()).rootEditor, url.href);
    const held = JSON.parse(stack.inRoot(["bash", "-lc", "cat ~/.desolate-root-editor/data/Machine/settings.json"]).stdout) as Record<string, unknown>;
    assert.deepEqual([held["security.workspace.trust.enabled"], held["security.workspace.trust.startupPrompt"], held["task.allowAutomaticTasks"], held["extensions.ignoreRecommendations"]], [true, "never", "off", true]);
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-09-ui");
  });
});
