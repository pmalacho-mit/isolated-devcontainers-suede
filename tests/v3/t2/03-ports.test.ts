// T2 (fake backend). Section 4.4: ports keep their numbers, nothing is declared, several
// workspaces share a number by name, and what has no name is reserved instead.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
let hostHolder: ChildProcess;
type Ports = { workspace: string; forwarded: { port: number; url: string }[]; reserved: { port: number; why: string }[] }[];
const ports = () => JSON.parse(stack.quiet("ports", "--json").stdout) as Ports;
const vms = new Map<string, string>();
const vmOf = (target: string) => {
  if (!vms.has(target)) {
    const list = JSON.parse(stack.quiet("list", "--json").stdout) as { domain: string; workspaces: { workspace: string; vm: string }[] }[];
    for (const d of list) for (const w of d.workspaces) vms.set(`${d.domain}/${w.workspace}`, w.vm);
  }
  return vms.get(target)!;
};
/** Start a server in a workspace, detached. */
const serve = (target: string, args: string, root = false) =>
  stack.inVm(vmOf(target), ["bash", "-c", `setsid nohup node /workspaces/serve.mjs ${args} >/tmp/serve-$$.log 2>&1 </dev/null & sleep 0.3`], { root });
const until = async (probe: () => boolean, ms = 8000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    if (probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return probe();
};
/** One HTTP request to the host's loopback, naming `host`. */
const request = (port: number, host: string, extra = ""): Promise<string> =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`));
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => resolve(data));
    socket.on("error", () => resolve(data || "ERROR"));
  });
/** Does anything accept a TCP connection at this address? */
const accepts = (address: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: address, port });
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
const otherAddresses = () => Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a!.address);
const hostOf = (url: string) => new URL(url).host;
const urlOf = (target: string, port: number) => ports().find((w) => w.workspace === target)?.forwarded.find((f) => f.port === port)?.url;

describe("T2 section 4.4: ports, forwarded by name", () => {
  before(() => {
    stack = newStack("ports");
    stack.seed("acme/app", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/app", "--no-domain").code, 0);
    assert.equal(stack.quiet("domain", "create", "web").code, 0);
    assert.equal(stack.quiet("domain", "web", "add", "--repo", "acme/app").code, 0);
    assert.equal(stack.quiet("up", "web", "--name", "one").code, 0);
    assert.equal(stack.quiet("up", "web", "--name", "two").code, 0);
    // A stand-in dev server: says which workspace it is, upgrades to a WebSocket-like echo
    // (HMR), can move to the next port when its own is taken (Vite without --strictPort),
    // and can be a nameless protocol whose server speaks first.
    fs.writeFileSync(path.join(stack.home, "domains/web/repos/serve.mjs"), `
import http from "node:http"; import net from "node:net";
const [, , name, portArg, mode] = process.argv; let port = Number(portArg);
if (mode === "raw") net.createServer((s) => { s.write("raw:" + name + "\\n"); s.on("data", (d) => s.write(d)); s.on("error", () => {}); }).listen(port, "0.0.0.0");
else {
  const server = http.createServer((req, res) => res.end("workspace:" + name + " host:" + req.headers.host + "\\n"));
  server.on("upgrade", (req, socket) => { socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\nhmr:" + name); socket.on("data", (d) => socket.write(d)); });
  server.on("error", (e) => { if (e.code === "EADDRINUSE" && mode === "move") server.listen(++port, "0.0.0.0"); else process.exit(1); });
  server.listen(port, mode === "loopback" ? "127.0.0.1" : "0.0.0.0");
}
`);
  });
  after(() => {
    hostHolder?.kill();
    stack.destroy();
  });

  it("a dev server started in a workspace appears at its URL, with nothing declared", async () => {
    stack.step("a dev server appears on its own");
    assert.deepEqual(ports().map((w) => w.forwarded.length), [0, 0], "nothing is forwarded before anything listens");
    serve("web/one", "one 5173");
    assert.ok(await until(() => urlOf("web/one", 5173) !== undefined), "the port is published within seconds of the server starting");
    const url = urlOf("web/one", 5173)!;
    assert.match(url, /^http:\/\/web-one-[0-9a-f]{6}\.localhost:5173$/, "the same number as inside, at the workspace's own hostname");
    assert.match(await request(5173, hostOf(url)), /workspace:one/);
    const shown = stack.desolate("ports");
    assert.match(shown.stdout, /web\/one\n {2}http:\/\/web-one-[0-9a-f]{6}\.localhost:5173/);
    assert.match(shown.stdout, /web\/two\n {2}nothing is listening yet/);
  });

  it("two workspaces on the same port: one URL each, each reaching its own server; HMR's upgrade too", async () => {
    serve("web/two", "two 5173 loopback");
    assert.ok(await until(() => urlOf("web/two", 5173) !== undefined));
    const one = hostOf(urlOf("web/one", 5173)!);
    const two = hostOf(urlOf("web/two", 5173)!);
    assert.notEqual(one, two);
    assert.match(await request(5173, one), /workspace:one/);
    assert.match(await request(5173, two), /workspace:two/, "a server bound to 127.0.0.1 inside is reached too");
    const upgrade = await new Promise<string>((resolve) => {
      const socket = net.connect(5173, "127.0.0.1");
      let data = "";
      socket.on("connect", () => socket.write(`GET /hmr HTTP/1.1\r\nHost: ${two}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`));
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("hmr:two") && !data.includes("ping")) socket.write("ping");
        if (data.includes("ping")) socket.destroy();
      });
      socket.on("close", () => resolve(data));
      setTimeout(() => socket.destroy(), 5000);
    });
    assert.match(upgrade, /101 Switching Protocols/);
    assert.match(upgrade, /hmr:two/);
    assert.match(upgrade, /ping/, "bytes flow both ways after the upgrade");
  });

  it("a request that names no workspace gets 421 and reaches nothing", async () => {
    stack.step("names that are not a workspace's");
    const good = hostOf(urlOf("web/one", 5173)!);
    assert.match(await request(5173, good), /200 OK[\s\S]*workspace:one/, "control: the right name is answered");
    for (const name of ["127.0.0.1:5173", "localhost:5173", "evil.example:5173", "web-one-000000.localhost:5173", good.replace("web-one", "web-three"), "desolate.localhost:5173"]) {
      const reply = await request(5173, name);
      assert.match(reply, /^HTTP\/1\.1 421 /, `Host: ${name} must be refused`);
      assert.doesNotMatch(reply, /workspace:/, `Host: ${name} must reach no server`);
    }
    // No Host header at all.
    const bare = await new Promise<string>((resolve) => {
      const socket = net.connect(5173, "127.0.0.1");
      let data = "";
      socket.on("connect", () => socket.write("GET / HTTP/1.0\r\n\r\n"));
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
    });
    assert.match(bare, /^HTTP\/1\.1 421 /);
    // The editor's hostname is another site: it never answers for a dev server.
    const editor = good.replace(/-([0-9a-f]{6})\.localhost/, "-editor-$1.localhost");
    assert.match(await request(5173, editor), /^HTTP\/1\.1 502 /);
  });

  it("the forwarder listens on 127.0.0.1 only, and never below port 1024", async () => {
    serve("web/one", "one 80", true);
    serve("web/one", "one 8080");
    assert.ok(await until(() => urlOf("web/one", 8080) !== undefined), "control: an unprivileged port from the same workspace is forwarded");
    assert.equal(urlOf("web/one", 80), undefined, "port 80 is never offered");
    assert.ok(await accepts("127.0.0.1", 5173), "control: the forwarder's listener answers on loopback");
    const others = otherAddresses();
    assert.ok(others.length > 0, "control: this machine has an address that is not loopback to try");
    for (const address of others) for (const port of [5173, 8080]) assert.equal(await accepts(address, port), false, `port ${port} answers on ${address}: it must be on loopback only`);
    assert.equal(await accepts("127.0.0.1", 80), false, "nothing listens on the host's port 80");
  });

  it("a protocol with no name reaches the first workspace that had the port; the others keep the number taken", async () => {
    stack.step("a raw TCP port");
    serve("web/one", "one 5432 raw");
    assert.ok(await until(() => urlOf("web/one", 5432) !== undefined));
    const raw = await new Promise<string>((resolve) => {
      const socket = net.connect(5432, "127.0.0.1");
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("\n")) socket.destroy();
      });
      socket.on("close", () => resolve(data));
      setTimeout(() => socket.destroy(), 5000);
    });
    assert.equal(raw, "raw:one\n", "a client that says nothing first is carried to the port's one workspace");
    assert.ok(await until(() => ports().find((w) => w.workspace === "web/two")!.reserved.some((r) => r.port === 5432)), "the other workspace is asked to keep 5432 taken");
    const bind = (port: number) => stack.inVm(vmOf("web/two"), ["node", "-e", `require("net").createServer().on("error", (e) => { console.log(e.code); process.exit(1); }).listen(${port}, "0.0.0.0", () => process.exit(0))`]);
    const taken = bind(5432);
    assert.equal(taken.code, 1);
    assert.match(taken.stdout, /EADDRINUSE/, "a server in the other workspace finds 5432 taken");
    assert.equal(bind(5433).code, 0, "control: the next number is free there");
    assert.match(stack.desolate("ports", "web/two").stdout, /port 5432 is kept taken here: no name in its protocol, and one had it first/);
  });

  it("a port the host itself holds is not published; workspaces keep it taken, and a server moves to the next number", async () => {
    stack.step("a port a program on the host holds");
    hostHolder = spawn(process.execPath, ["-e", `require("http").createServer((q, s) => s.end("the-host-program")).listen(5180, "127.0.0.1")`], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    serve("web/one", "one 5180");
    assert.ok(await until(() => ports().find((w) => w.workspace === "web/one")!.reserved.some((r) => r.port === 5180 && /not forwarded/.test(r.why))), "the workspace's 5180 is reported as not forwarded");
    assert.match(await request(5180, hostOf(urlOf("web/one", 5173)!).replace(":5173", ":5180")), /the-host-program/, "the host's own program still answers on its port: nothing was taken from it");
    assert.ok(await until(() => ports().find((w) => w.workspace === "web/two")!.reserved.some((r) => r.port === 5180)), "the other workspace keeps 5180 taken");
    serve("web/two", "two 5180 move");
    assert.ok(await until(() => urlOf("web/two", 5181) !== undefined), "a server that tries the next number lands on 5181, and that is forwarded");
    assert.match(await request(5181, hostOf(urlOf("web/two", 5181)!)), /workspace:two/);
  });

  it("stopping a workspace takes its ports down", async () => {
    stack.step("stop");
    assert.equal(stack.desolate("stop", "web/two").code, 0);
    assert.ok(await until(() => !ports().some((w) => w.workspace === "web/two")));
    const reply = await request(5173, "web-two-000000.localhost:5173");
    assert.match(reply, /^HTTP\/1\.1 421 /);
    assert.match(await request(5173, hostOf(urlOf("web/one", 5173)!)), /workspace:one/, "the other workspace's server is untouched");
  });

  it("destroy leaves no listener behind", async () => {
    assert.ok(await accepts("127.0.0.1", 5173), "control: a forwarded port is listening before destroy");
    assert.equal(stack.desolate("destroy", "--all").code, 0);
    for (const port of [5173, 8080, 5432, 5181]) assert.equal(await accepts("127.0.0.1", port), false, `port ${port} is still listening after destroy`);
    assert.equal(fs.existsSync(stack.home), false);
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-03-ports");
  });
});
