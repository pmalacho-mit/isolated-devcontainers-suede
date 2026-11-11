// T2 (fake backend). P1: every workspace has its editor, inside its VM, reached from a
// browser by a hostname of its own (sections 4.5 and 13.4, phase 2: "the editor works";
// "its editor's cookie is not readable from its dev server's page").
//
// The editor here is the real one: the pinned VSCodium server baked into the base image.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
type Editor = { host: string; port: number; token: string; url: string };
const editors: Record<string, Editor> = {};
const vms = new Map<string, string>();
const vmOf = (target: string) => {
  if (!vms.has(target)) {
    const list = JSON.parse(stack.quiet("list", "--json").stdout) as { domain: string; workspaces: { workspace: string; vm: string }[] }[];
    for (const d of list) for (const w of d.workspaces) vms.set(`${d.domain}/${w.workspace}`, w.vm);
  }
  return vms.get(target)!;
};
const editorOf = (target: string): Editor => {
  const result = stack.quiet("editor", target, "--json");
  assert.equal(result.code, 0, result.stderr);
  const url = new URL((JSON.parse(result.stdout) as { url: string }).url);
  return { host: url.hostname, port: Number(url.port), token: url.searchParams.get("tkn") ?? "", url: url.href };
};
/** One raw HTTP request to the host's loopback: the first line and headers are the caller's. */
const raw = (port: number, lines: string[], ms = 15_000): Promise<string> =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.setTimeout(ms, () => socket.destroy());
    socket.on("connect", () => socket.write(lines.join("\r\n") + "\r\n\r\n"));
    socket.on("data", (chunk) => {
      data += chunk;
      // An upgraded connection stays open: its status line is the answer.
      if (/^HTTP\/1\.1 101 /.test(data) && data.includes("\r\n\r\n")) socket.destroy();
    });
    socket.on("close", () => resolve(data));
    socket.on("error", () => resolve(data || "ERROR"));
  });
const get = (e: Editor, pathAndQuery: string, headers: string[] = [], host = e.host, port = e.port) =>
  raw(port, [`GET ${pathAndQuery} HTTP/1.1`, `Host: ${host}:${port}`, ...headers, "Connection: close"]);
const status = (response: string) => Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1] ?? 0);
const accepts = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
const upgrade = (e: Editor, headers: string[] = [], host = e.host) =>
  raw(e.port, [`GET /?reconnectionToken=${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}&reconnection=false&skipWebSocketFrames=false HTTP/1.1`, `Host: ${host}:${e.port}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", ...headers]);

describe("T2 P1: a workspace's editor, inside its VM, by its own hostname", () => {
  before(() => {
    stack = newStack("editor");
    stack.seed("acme/app", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
      fs.writeFileSync(path.join(dir, "page.html"), "<script>document.title = 'cookies:[' + document.cookie + ']'</script>\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/app").code, 0);
    assert.equal(stack.quiet("domain", "create", "web").code, 0);
    assert.equal(stack.quiet("domain", "web", "add", "--repo", "acme/app").code, 0);
  });
  after(() => {
    stack.destroy();
  });

  it("up starts the editor and prints its address: its own hostname, a token, the checkout as the folder", () => {
    stack.step("two workspaces, each with its editor");
    const up = stack.desolate("up", "web", "--name", "one");
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /^ {2}editor {7}http:\/\/web-one-editor-[0-9a-f]+\.localhost:\d+\/\?tkn=[0-9a-f]{48}&folder=%2Fworkspaces%2Facme%2Fapp$/m);
    assert.equal(stack.quiet("up", "web", "--name", "two", "--checkout", "acme/app=worktree:other").code, 0);
    editors.one = editorOf("web/one");
    editors.two = editorOf("web/two");
    assert.equal(editors.one.port, editors.two.port, "one host port carries every editor");
    assert.notEqual(editors.one.host, editors.two.host);
    assert.notEqual(editors.one.token, editors.two.token);
    // The editor is in the workspace's VM, running as its user, on loopback only.
    const inside = stack.inVm(vmOf("web/one"), ["bash", "-c", "ss -ltnpH | grep -E ':(31580|31581) ' | awk '{print $4}' | sort; ps -o user= -C node | sort -u"]);
    assert.deepEqual(inside.stdout.trim().split("\n").slice(0, 2), ["127.0.0.1:31580", "127.0.0.1:31581"]);
  });

  it("the editor works: the real VSCodium workbench, its token, and its WebSocket", async () => {
    const e = editors.one!;
    const page = await get(e, `/?tkn=${e.token}`);
    // The server answers the token with a redirect that sets its cookie.
    assert.equal(status(page), 302, page.slice(0, 300));
    assert.match(page, /set-cookie: vscode-tkn=[0-9a-f]{48}/i);
    const workbench = await get(e, "/", [`Cookie: vscode-tkn=${e.token}`]);
    assert.equal(status(workbench), 200, workbench.slice(0, 300));
    assert.match(workbench, /workbench\.js|vs\/code\/browser\/workbench/, "the page is the VSCodium web workbench");
    assert.match(workbench, /enableWorkspaceTrust&quot;:false/, "inside the boundary the editor does not ask about trust");
    // CONTROL for everything below: the same requests without the right token are refused
    // BY THE EDITOR, so an answer above is the editor's, and the token is what opened it.
    assert.equal(status(await get(e, "/", ["Cookie: vscode-tkn=" + "0".repeat(48)])), 403);
    assert.equal(status(await get(e, "/")), 403);
    assert.equal(status(await upgrade(e)), 101, "the editor's WebSocket upgrades through the forwarder and the gate");
  });

  it("each editor answers to its own hostname and no other", async () => {
    stack.step("names that are not the editor's");
    const e = editors.one!;
    const dev = e.host.replace("-editor-", "-");
    // The dev-server name of the same workspace, on the editors' port.
    const viaDev = await get(e, "/", [`Cookie: vscode-tkn=${e.token}`], dev);
    assert.equal(status(viaDev), 421, viaDev.slice(0, 200));
    assert.equal(status(await get(e, "/", [`Cookie: vscode-tkn=${e.token}`], "127.0.0.1")), 421);
    assert.equal(status(await get(e, "/", [`Cookie: vscode-tkn=${e.token}`], "localhost")), 421);
    // Another workspace's editor name reaches THAT workspace's editor: this token is not its.
    assert.equal(status(await get(e, "/", [`Cookie: vscode-tkn=${e.token}`], editors.two!.host)), 403);
    assert.equal(status(await get(editors.two!, "/", [`Cookie: vscode-tkn=${editors.two!.token}`])), 200, "control: with its own token it answers");
    // The editor's in-VM ports are not forwarded as dev-server ports, under any name.
    const forwarded = JSON.parse(stack.quiet("ports", "--json").stdout) as { forwarded: { port: number }[] }[];
    assert.deepEqual(forwarded.flatMap((w) => w.forwarded.map((f) => f.port)).filter((port) => port === 31580 || port === 31581 || port === e.port), []);
    assert.equal(await accepts(31580), false, "nothing on the host leads to the editor's server around its gate");
    // A request that changes its name after the first one on a connection is the gate's to refuse.
    const second = await raw(e.port, [`GET / HTTP/1.1`, `Host: ${e.host}:${e.port}`, `Cookie: vscode-tkn=${"0".repeat(48)}`, "", `GET / HTTP/1.1`, `Host: ${dev}:${e.port}`, `Cookie: vscode-tkn=${e.token}`, "Connection: close"]);
    assert.match(second, /HTTP\/1\.1 421 [\s\S]*desolate editor-gate: refused this is the editor of/, second.slice(-300));
  });

  it("a page somewhere else cannot drive the editor: cross-site requests and foreign origins are refused", async () => {
    stack.step("requests another page started");
    const e = editors.one!;
    const cookie = `Cookie: vscode-tkn=${e.token}`;
    for (const site of ["cross-site", "same-site"]) {
      const response = await get(e, "/", [cookie, `Sec-Fetch-Site: ${site}`]);
      assert.equal(status(response), 403, site);
      assert.match(response, /desolate editor-gate: refused a request another site started/);
    }
    assert.equal(status(await get(e, "/", [cookie, "Sec-Fetch-Site: same-origin"])), 200, "control: the editor's own page may");
    assert.equal(status(await get(e, "/", [cookie, "Sec-Fetch-Site: none"])), 200, "control: so may a typed address");
    const dev = e.host.replace("-editor-", "-");
    assert.equal(status(await get(e, "/", [cookie, `Origin: http://${dev}:3000`])), 403, "the workspace's own dev server is another origin");
    assert.equal(status(await upgrade(e, [`Origin: http://${dev}:3000`])), 403, "WebSocket upgrades included");
    assert.equal(status(await upgrade(e, ["Sec-Fetch-Site: cross-site"])), 403);
    assert.equal(status(await upgrade(e, [`Origin: http://${e.host}:${e.port}`])), 101, "control: the editor's own origin upgrades");
    // A file from a checkout, opened as a page at the editor's origin, is sandboxed: it
    // cannot read the editor's cookie.
    const resource = `/vscode-remote-resource?path=${encodeURIComponent("/workspaces/acme/app/page.html")}`;
    const asPage = await get(e, resource, [cookie, "Sec-Fetch-Dest: document"]);
    assert.match(asPage, /content-security-policy: sandbox/i, asPage.slice(0, 400));
    const asFetch = await get(e, resource, [cookie, "Sec-Fetch-Dest: empty"]);
    assert.doesNotMatch(asFetch, /content-security-policy: sandbox/i, "control: the workbench's own fetches are untouched");
  });

  it("in a real browser the workbench loads, and the dev server's page cannot see the editor's cookie", async () => {
    stack.step("a browser opens the editor");
    const chrome = [process.env.DESOLATE_CHROME, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((file) => file && fs.existsSync(file));
    assert.ok(chrome, "this check needs Chrome or Chromium: install one, or set DESOLATE_CHROME to its path");
    const e = editors.one!;
    const profile = fs.mkdtempSync(path.join(stack.work, "chrome-"));
    const dump = (url: string) =>
      spawnSync(chrome!, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "--host-resolver-rules=MAP *.localhost 127.0.0.1", "--enable-logging=stderr", "--log-level=0", "--virtual-time-budget=60000", "--dump-dom", url], { encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
    // The first load of a just-started server can end before the workbench has run (headless
    // Chrome stops at its time budget), so this asks until it has, a bounded number of times.
    let page = dump(e.url);
    for (let i = 0; i < 8 && !/renderer-ExtensionHost-[0-9a-f-]+\) was successful/.test(page.stderr); i++) page = dump(e.url);
    // The workbench's own console, in Chrome's log: it started, and both of its WebSockets
    // (the management connection and the extension host's) connected, through the host's
    // forwarder and the gate, to the editor's server in the VM.
    const consoleOf = (text: string) => text.split("\n").filter((line) => line.includes("INFO:CONSOLE")).join("\n");
    assert.match(consoleOf(page.stderr), /Creating a socket \(renderer-Management-[0-9a-f-]+\) was successful/, consoleOf(page.stderr).slice(0, 1500) || page.stderr.slice(-600));
    assert.match(consoleOf(page.stderr), /Creating a socket \(renderer-ExtensionHost-[0-9a-f-]+\) was successful/);
    // The same browser profile now holds the editor's cookie. A page served by the
    // workspace's dev server, on the dev hostname, asks for its cookies.
    stack.inVm(vmOf("web/one"), ["bash", "-c", "cd /workspaces/acme/app && (setsid nohup python3 -m http.server 3000 --bind 127.0.0.1 >/tmp/http.log 2>&1 </dev/null &) ; sleep 1"]);
    const dev = e.host.replace("-editor-", "-");
    let seen = "";
    // The forwarder publishes the port a moment after the server starts listening.
    for (let i = 0; i < 40 && !/<title>cookies:/.test(seen); i++) {
      seen = dump(`http://${dev}:3000/page.html`).stdout;
      if (!/<title>cookies:/.test(seen)) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.match(seen, /<title>cookies:\[\]<\/title>/, `the dev server's page ran its script and saw no cookie: ${seen.slice(0, 300)}`);
    // CONTROL: that profile does hold the editor's cookie, and sends it to the editor's own
    // name: the bare address, with no token in it, is answered with the workbench. A fresh
    // profile gets the editor's refusal.
    assert.match(dump(`http://${e.host}:${e.port}/`).stdout, /vscode-workbench-web-configuration/);
    const fresh = fs.mkdtempSync(path.join(stack.work, "chrome-fresh-"));
    const stranger = spawnSync(chrome!, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", `--user-data-dir=${fresh}`, "--host-resolver-rules=MAP *.localhost 127.0.0.1", "--virtual-time-budget=5000", "--dump-dom", `http://${e.host}:${e.port}/`], { encoding: "utf8", timeout: 120_000 });
    assert.match(stranger.stdout, /Forbidden/);
    assert.doesNotMatch(stranger.stdout, /vscode-workbench-web-configuration/);
  });

  it("the editor comes back with the workspace, and a stopped workspace's name answers nothing", async () => {
    stack.step("stop and start");
    assert.equal(stack.quiet("stop", "web/one").code, 0);
    const down = await get(editors.one!, "/", [`Cookie: vscode-tkn=${editors.one!.token}`]);
    assert.equal(status(down), 421, "a stopped workspace's editor name is no workspace's");
    assert.equal(stack.quiet("start", "web/one").code, 0);
    const again = editorOf("web/one");
    assert.equal(again.token, editors.one!.token, "the token is the VM's own and survives a restart");
    assert.equal(status(await get(again, "/", [`Cookie: vscode-tkn=${again.token}`])), 200);
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-06-editor");
  });
});
