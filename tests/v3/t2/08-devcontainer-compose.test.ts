// T2 (fake backend). Section 4.2, shape A, for a compose spec: the project's services come up
// inside the workspace's VM, from its own compose file, with the VM's docker daemon; the
// primary service is where `desolate exec` and the editor run, on the VM's paths; and the
// services' ports reach desolate's hostnames as a single container's do (section 4.4):
//   - a listener in the primary service, even on its own loopback (bridge.ts, svcnet.ts);
//   - `forwardPorts` written `service:port`, and only those of another service;
//   - what a service publishes (`ports:`), which is docker's own listener in the VM.
//
// No registry: every service runs the image lib/devimage.sh makes inside the VM.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { devHostname } from "../../../release/shared/names.ts";
import { bootstrap, git, newStack, REPO_ROOT } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
const IMAGE = "registry.invalid/desolate-test/dev:1";
const W = "svc/w1";
let vm = "";
const inVm = (script: string, root = false) => stack.inVm(vm, ["bash", "-lc", script], { root });
const exec = (script: string, ...flags: string[]) => stack.quiet("exec", W, ...flags, "--", "sh", "-c", script);
const request = (port: number, host: string, pathAndQuery: string, headers: string[] = []): Promise<string> =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on("connect", () => socket.write([`GET ${pathAndQuery} HTTP/1.1`, `Host: ${host}:${port}`, ...headers, "Connection: close", "", ""].join("\r\n")));
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => resolve(data));
    socket.on("error", () => resolve(data || "ERROR"));
  });
const until = async (probe: () => boolean | Promise<boolean>, ms = 20_000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return probe();
};
type Ports = { workspace: string; forwarded: { port: number; url: string }[] }[];
const forwarded = () => (JSON.parse(stack.quiet("ports", "--json").stdout) as Ports).find((w) => w.workspace === W)?.forwarded.map((f) => f.port) ?? [];
let devHost = "";

// A tiny server for a service: a directory with one file saying who it is.
const serve = (who: string, port: number) => `sh -c 'mkdir -p /tmp/srv && echo ${who} > /tmp/srv/who && cd /tmp/srv && exec python3 -m http.server ${port}'`;

describe("T2 section 4.2: a compose devcontainer, its services and their ports", () => {
  before(() => {
    stack = newStack("devcmp");
    stack.seed("acme/composed", (dir) => {
      fs.mkdirSync(path.join(dir, ".devcontainer"));
      // As the official compose templates write it: the parent of the checkout at /workspaces.
      fs.writeFileSync(path.join(dir, ".devcontainer", "devcontainer.json"), `{
  "name": "composed",
  "dockerComposeFile": ["compose.yaml"],
  "service": "app",
  "workspaceFolder": "/workspaces/\${localWorkspaceFolderBasename}",
  "remoteUser": "dev",
  "containerEnv": { "FROM_SPEC": "container-env" },
  "forwardPorts": [3917, "db:6917"],
}
`);
      fs.writeFileSync(path.join(dir, ".devcontainer", "compose.yaml"), `services:
  app:
    image: ${IMAGE}
    command: sleep infinity
    volumes:
      - ../..:/workspaces:cached
  db:
    image: ${IMAGE}
    # 6917 is declared in forwardPorts; 6918 is not
    command: sh -c 'mkdir -p /tmp/srv && echo i-am-db > /tmp/srv/who && cd /tmp/srv && (python3 -m http.server 6918 &) && exec python3 -m http.server 6917'
  web:
    image: ${IMAGE}
    command: ${serve("i-am-web", 7917)}
    ports:
      - "7917:7917"
`);
      fs.writeFileSync(path.join(dir, "README.md"), "# composed\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/composed").code, 0);
    assert.equal(stack.quiet("domain", "create", "svc", "--repo", "acme/composed").code, 0);
  });
  after(() => stack.destroy());

  it("the project's compose file comes up inside the VM, and exec runs in its primary service", () => {
    stack.step("a compose spec comes up");
    const first = stack.desolate("up", "svc");
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^ {2}devcontainer FAILED: /m, "the image is not there yet");
    const list = JSON.parse(stack.quiet("list", "--json").stdout) as { domain: string; workspaces: { workspace: string; vm: string }[] }[];
    vm = list.find((d) => d.domain === "svc")!.workspaces.find((w) => w.workspace === "w1")!.vm;
    const made = stack.inVm(vm, ["bash", "-s", "--", IMAGE], { root: true, input: fs.readFileSync(path.join(REPO_ROOT, "tests/v3/lib/devimage.sh"), "utf8") });
    assert.equal(made.code, 0, made.stderr.slice(-400));
    assert.equal(stack.quiet("stop", W).code, 0);
    const started = stack.desolate("start", W);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, /^ {2}devcontainer up \(service app, user dev, compose\)$/m, started.stdout);
    devHost = devHostname(stack.env.DESOLATE_INSTANCE!, "svc", "w1");
    assert.equal(inVm("docker ps --format '{{.Label \"com.docker.compose.service\"}}' | sort | tr '\\n' ' '").stdout, "app db web ", "three services, in this VM's docker");
    const inside = exec("cat /etc/desolate-test-image; id -un; pwd; echo $FROM_SPEC; cat /tmp/srv/who 2>/dev/null || echo not-a-server");
    assert.equal(inside.stdout, "desolate-test-devimage\ndev\n/workspaces/acme/composed\ncontainer-env\nnot-a-server\n", inside.stderr);
    // CONTROL: --vm is the VM itself.
    assert.equal(exec("cat /etc/desolate-test-image 2>/dev/null || echo in-the-vm", "--vm").stdout, "in-the-vm\n");
  });

  it("git, desolate's own commands and its mounts work in the service, on the VM's paths", () => {
    stack.step("git and mounts in the compose service");
    // The domain clone borrows the mirror's objects by its absolute path: git works only if
    // the mirror is there (it was not, before compose had desolate's mounts).
    const work = exec("git status --short | wc -l && git log --oneline | wc -l && git checkout -q -b from-compose && echo x >> README.md && git -c user.name=t -c user.email=t@example.test commit -qam 'in compose' && desolate offer");
    assert.equal(work.code, 0, work.stderr + work.stdout);
    assert.match(work.stdout, /^0\n1\n/);
    assert.match(stack.desolate("offers").stdout, /svc {2}acme\/composed {2}from-compose/);
    // The VM's /workspaces replaced the project's own mount there (compose merges by target).
    assert.equal(exec("ls -d /workspaces/composed 2>/dev/null || echo replaced").stdout, "replaced\n");
    // The mirrors are read-only in the service, though the CLI drops `readonly` for compose,
    // even to its root; CONTROL: the domain's cache, mounted the same way but writable, takes the same write.
    const ro = stack.inVm(vm, ["bash", "-c", "docker exec -u 0 $(docker ps -q --filter label=com.docker.compose.service=app) sh -c 'touch /desolate/mirrors/probe 2>&1; touch /desolate/cache/probe && rm /desolate/cache/probe && echo cache-written'"], { root: true });
    assert.match(ro.stdout, /Read-only file system\ncache-written\n$/, ro.stdout + ro.stderr);
  });

  it("a server on the service's own loopback is forwarded, like a single container's", async () => {
    stack.step("the primary service's listener");
    // CONTROL first: nothing on 3917 yet, so nothing is forwarded there.
    assert.ok(!forwarded().includes(3917));
    assert.doesNotMatch(await request(3917, devHost, "/who"), /i-am-app/);
    exec("(setsid nohup sh -c 'mkdir -p /tmp/srv && echo i-am-app > /tmp/srv/who && cd /tmp/srv && exec python3 -m http.server 3917 --bind 127.0.0.1' >/dev/null 2>&1 </dev/null &); sleep 1");
    assert.ok(await until(() => forwarded().includes(3917)), "port 3917 is forwarded");
    let page = "";
    assert.ok(await until(async () => /i-am-app/.test((page = await request(3917, devHost, "/who")))), page.slice(0, 300));
    // It is the service's, on the service's loopback: in the VM the port is held by desolate's
    // mirror in wsd, not by the server.
    const holder = inVm("ss -ltnpH 'sport = :3917' | grep -o 'pid=[0-9]*' | cut -d= -f2 | xargs -r ps -o args= -p", true).stdout;
    assert.match(holder, /wsd\.ts/, holder);
    assert.doesNotMatch(holder, /python/);
  });

  it("forwardPorts `db:6917` reaches the db service by name; its undeclared 6918 does not", async () => {
    stack.step("service:port forwards");
    assert.ok(await until(() => forwarded().includes(6917)), `forwarded: ${forwarded().join(",")}`);
    let page = "";
    assert.ok(await until(async () => /i-am-db/.test((page = await request(6917, devHost, "/who")))), page.slice(0, 300));
    // Beside it: the same service listens on 6918 (shown from the VM, at the service's
    // address), undeclared, and that is not forwarded.
    const db = inVm(`python3 -c "import socket; socket.create_connection(('$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $(docker ps -q --filter label=com.docker.compose.service=db))', 6918), 3); print('db-listens-on-6918')"`, true);
    assert.equal(db.stdout.trim(), "db-listens-on-6918", db.stderr);
    assert.ok(!forwarded().includes(6918), `forwarded: ${forwarded().join(",")}`);
  });

  it("a port a service publishes is docker's listener in the VM, and is forwarded too", async () => {
    stack.step("published ports");
    assert.ok(await until(() => forwarded().includes(7917)), `forwarded: ${forwarded().join(",")}`);
    let page = "";
    assert.ok(await until(async () => /i-am-web/.test((page = await request(7917, devHost, "/who")))), page.slice(0, 300));
    // It is docker's own proxy in the VM that holds it, not desolate's mirror.
    assert.match(inVm("ss -ltnpH 'sport = :7917'", true).stdout, /docker-proxy/);
  });

  it("the editor runs in the primary service, behind the gate on the VM's loopback", async () => {
    stack.step("the editor, in the compose service");
    const shown = stack.quiet("editor", W, "--json");
    assert.equal(shown.code, 0, shown.stderr);
    const url = new URL((JSON.parse(shown.stdout) as { url: string }).url);
    const cookie = `Cookie: vscode-tkn=${url.searchParams.get("tkn")}`;
    assert.match(await request(Number(url.port), url.hostname, "/", [cookie]), /^HTTP\/1\.1 200 /);
    // The app service's own file (made just now in it, in no other service and not in the VM), through the editor's server.
    exec("echo only-in-app > /tmp/only-in-app");
    let file = "";
    assert.ok(await until(async () => /only-in-app/.test((file = await request(Number(url.port), url.hostname, `/vscode-remote-resource?path=${encodeURIComponent("/tmp/only-in-app")}`, [cookie])))), file.slice(0, 300));
    const where = inVm("cat ~/.desolate-editor/server.where; echo; docker ps -q --no-trunc --filter label=com.docker.compose.service=app");
    const [recorded, app] = where.stdout.trim().split("\n");
    assert.equal(recorded, app, "the server is recorded as running in the app service");
    assert.equal(inVm("ss -ltnH | grep -E ':(31580|31581) ' | awk '{print $4}' | sort").stdout.trim(), "127.0.0.1:31580\n127.0.0.1:31581", "still on the VM's loopback only, behind the gate, which stays in the VM");
    // And the dev hostname never reaches it, mirrored or not.
    assert.ok(!forwarded().includes(31580));
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-08-devcontainer-compose");
  });
});
