// T2 (fake backend). Section 4.2, shape A: the project's devcontainer runs INSIDE its
// workspace's VM, from the project's own devcontainer.json, with the VM's own docker
// daemon. The spec is not policed (v2's policy.ts is gone): the VM is the boundary.
//
// No test needs a registry: the image is made inside the VM from the VM's own files
// (lib/devimage.sh), under a name whose registry does not exist.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack, REPO_ROOT } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
let forge = "";
const IMAGE = "registry.invalid/desolate-test/dev:1";
const vms = new Map<string, string>();
const vmOf = (target: string) => {
  if (!vms.has(target)) {
    const list = JSON.parse(stack.quiet("list", "--json").stdout) as { domain: string; workspaces: { workspace: string; vm: string }[] }[];
    for (const d of list) for (const w of d.workspaces) vms.set(`${d.domain}/${w.workspace}`, w.vm);
  }
  return vms.get(target)!;
};
const inVm = (target: string, script: string, root = false) => stack.inVm(vmOf(target), ["bash", "-lc", script], { root });
const exec = (target: string, script: string, ...flags: string[]) => stack.quiet("exec", target, ...flags, "--", "sh", "-c", script);
const makeImage = (target: string) => stack.inVm(vmOf(target), ["bash", "-s", "--", IMAGE], { root: true, input: fs.readFileSync(path.join(REPO_ROOT, "tests/v3/lib/devimage.sh"), "utf8") });
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
const until = async (probe: () => boolean | Promise<boolean>, ms = 15_000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return probe();
};

describe("T2 section 4.2: the project's devcontainer, inside the workspace's VM", () => {
  before(() => {
    stack = newStack("devc");
    stack.seed("acme/app", (dir) => {
      fs.mkdirSync(path.join(dir, ".devcontainer"));
      // JSONC, as specs are written: comments and a trailing comma.
      fs.writeFileSync(path.join(dir, ".devcontainer", "devcontainer.json"), `{
  // the project's own environment
  "name": "app",
  "image": "${IMAGE}",
  "remoteUser": "dev",
  "containerEnv": { "FROM_SPEC": "container-env" },
  "remoteEnv": { "REMOTE_SPEC": "remote-env" },
  "postCreateCommand": "echo created-by-the-spec > /tmp/created",
  /* a spec may ask for anything: the VM is the boundary */
  "privileged": true,
}
`);
      fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    stack.seed("acme/built", (dir) => {
      fs.mkdirSync(path.join(dir, ".devcontainer"));
      fs.writeFileSync(path.join(dir, ".devcontainer", "devcontainer.json"), JSON.stringify({ build: { dockerfile: "Dockerfile", context: ".." }, remoteUser: "dev" }));
      fs.writeFileSync(path.join(dir, ".devcontainer", "Dockerfile"), `FROM ${IMAGE}\nCOPY marker.txt /etc/built-from-the-project\n`);
      fs.writeFileSync(path.join(dir, "marker.txt"), "built in the VM, from the project's Dockerfile and context\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    stack.seed("acme/plain", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# plain\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    forge = stack.env.DESOLATE_FORGE_SPEC!.replace(/^.*@/, "").replace(/:\d+$/, "");
    assert.equal(bootstrap(stack).code, 0);
    for (const [domain, repo] of [["app", "acme/app"], ["built", "acme/built"], ["plain", "acme/plain"]] as const) {
      assert.equal(stack.quiet("clone", repo, "--no-domain").code, 0);
      assert.equal(stack.quiet("domain", "create", domain).code, 0);
      assert.equal(stack.quiet("domain", domain, "add", "--repo", repo).code, 0);
    }
    assert.equal(stack.inRoot(["bash", "-c", `printf '%s api.example.test\\n' ${forge} >> /etc/hosts`], { root: true }).code, 0);
    assert.equal(stack.quiet("domain", "app", "net", "allow-internal", forge).code, 0);
  });
  after(() => stack.destroy());

  it("a spec that cannot come up does not take the workspace down, and says why", () => {
    stack.step("a devcontainer whose image cannot be had");
    const up = stack.desolate("up", "app");
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /^ {2}devcontainer FAILED: .*\(the whole log: \S+\/up\.log in the workspace\)$/m);
    assert.match(up.stdout, /^ {2}editor {7}http:/m, "the editor is there all the same, in the VM");
    const there = exec("app/w1", "cat /etc/desolate-test-image 2>/dev/null || echo in-the-vm; pwd");
    assert.equal(there.stdout, "in-the-vm\n/workspaces/acme/app\n", "exec runs in the VM itself");
    const refused = JSON.parse(stack.quiet("net", "log", "app", "--json").stdout) as { host: string; verdict: string; workspace: string }[];
    assert.ok(refused.some((e) => e.host === "registry.invalid" && e.verdict === "refused" && e.workspace === "w1"), "the VM's docker daemon went out through the workspace's own proxy, like everything else in it");
  });

  it("the project's devcontainer.json, unchanged, comes up inside the VM", () => {
    stack.step("the devcontainer comes up");
    const made = makeImage("app/w1");
    assert.equal(made.code, 0, made.stderr.slice(-400));
    assert.equal(stack.quiet("stop", "app/w1").code, 0);
    const started = stack.desolate("start", "app/w1");
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, new RegExp(`^  devcontainer up \\(${IMAGE.replace(/[./]/g, "\\$&")}, user dev\\)$`, "m"));
    const inside = exec("app/w1", "cat /etc/desolate-test-image; id -un; pwd; echo $FROM_SPEC $REMOTE_SPEC; cat /tmp/created; cat .devcontainer/devcontainer.json | head -2 | tail -1");
    assert.equal(inside.stdout, "desolate-test-devimage\ndev\n/workspaces/acme/app\ncontainer-env remote-env\ncreated-by-the-spec\n  // the project's own environment\n", inside.stderr);
    // CONTROL: the same command with --vm is in the VM, where none of that is.
    assert.equal(exec("app/w1", "cat /etc/desolate-test-image 2>/dev/null || echo in-the-vm; echo \"[$FROM_SPEC]\"", "--vm").stdout, "in-the-vm\n[]\n");
    // The container is in the workspace's VM and nowhere else: the host's docker has no such container.
    assert.equal(inVm("app/w1", "docker ps -q | wc -l").stdout.trim(), "1");
    assert.equal(exec("app/w1", "exit 7").code, 7, "the command's exit code comes back");
    assert.equal(stack.quiet("exec", "app/w1", "--", "cat").code, 0);
  });

  it("git, offers and desolate's own commands work in the container, on the VM's paths", () => {
    stack.step("git inside the devcontainer");
    const work = exec("app/w1", "git status --short | wc -l && git log --oneline | wc -l && git checkout -q -b from-container && echo x >> README.md && git -c user.name=t -c user.email=t@example.test commit -qam 'in the container' && git fetch -q origin && desolate offer");
    assert.equal(work.code, 0, work.stderr + work.stdout);
    assert.match(work.stdout, /^0\n1\n/);
    assert.match(stack.desolate("offers").stdout, /app {2}acme\/app {2}from-container/);
    assert.equal(exec("app/w1", "/desolate/status set green 'ready: from the container' && /desolate/status get | head -1").code, 0);
  });

  it("the container's traffic takes the VM's one way out, and a dev server in it is forwarded", async () => {
    stack.step("network inside the devcontainer");
    const out = exec("app/w1", "curl -sS -m 20 http://api.example.test/from-the-container");
    assert.equal(out.stdout.trim(), "upstream http host=api.example.test path=/from-the-container", out.stderr);
    // A container on a docker bridge of the VM (what `docker run` gives by default, and what
    // a compose service gets) goes the same way: names and connections both.
    const bridged = inVm("app/w1", `docker run --rm ${IMAGE} curl -sS -m 20 http://api.example.test/from-a-bridge 2>&1`);
    assert.equal(bridged.stdout.trim(), "upstream http host=api.example.test path=/from-a-bridge");
    const log = JSON.parse(stack.quiet("net", "log", "app", "--json").stdout) as { host: string; verdict: string; workspace: string; domain: string }[];
    assert.equal(log.filter((e) => e.host === "api.example.test" && e.verdict === "allowed" && e.domain === "app" && e.workspace === "w1").length, 2, "both attributed to this workspace");
    const elsewhere = inVm("app/w1", `docker run --rm ${IMAGE} curl -sS -m 8 http://192.0.2.7:8080/ 2>&1; true`);
    assert.doesNotMatch(elsewhere.stdout, /upstream/, "and nothing else leaves: a port that is not 80 or 443");
    // A dev server started in the container is a listener in the VM, so it appears at the
    // workspace's hostname with nothing declared.
    exec("app/w1", "(setsid nohup python3 -m http.server 3000 >/tmp/http.log 2>&1 </dev/null &); sleep 1");
    type Ports = { workspace: string; forwarded: { port: number; url: string }[] }[];
    let url: string | undefined;
    assert.ok(await until(() => (url = (JSON.parse(stack.quiet("ports", "--json").stdout) as Ports).find((w) => w.workspace === "app/w1")?.forwarded.find((f) => f.port === 3000)?.url) !== undefined), "port 3000 is forwarded");
    const page = await request(3000, new URL(url!).hostname, "/README.md");
    assert.match(page, /^HTTP\/1\.0 200 [\s\S]*# app\nx\n$/, page.slice(0, 200));
  });

  it("the editor runs in the devcontainer: it sees the project's environment, not the VM's", async () => {
    stack.step("the editor, in the devcontainer");
    const shown = stack.quiet("editor", "app/w1", "--json");
    assert.equal(shown.code, 0, shown.stderr);
    const url = new URL((JSON.parse(shown.stdout) as { url: string }).url);
    const cookie = `Cookie: vscode-tkn=${url.searchParams.get("tkn")}`;
    assert.match(await request(Number(url.port), url.hostname, "/", [cookie]), /^HTTP\/1\.1 200 /);
    // A file that exists only in the container's image, read through the editor's server.
    let file = "";
    assert.ok(await until(async () => /desolate-test-devimage/.test((file = await request(Number(url.port), url.hostname, `/vscode-remote-resource?path=${encodeURIComponent("/etc/desolate-test-image")}`, [cookie])))), file.slice(0, 300));
    const where = inVm("app/w1", "cat ~/.desolate-editor/server.where; echo; docker ps -q --no-trunc; docker top $(docker ps -q) -eo pid,args | grep -c 'server-main.js --host 127.0.0.1 --port 31580'");
    const [recorded, running, count] = where.stdout.trim().split("\n");
    assert.equal(recorded, running, "the server is recorded as running in the devcontainer");
    assert.ok(Number(count) >= 1, "and it is: its process is one of the container's");
    assert.equal(inVm("app/w1", "ss -ltnH | grep -E ':(31580|31581) ' | awk '{print $4}' | sort").stdout.trim(), "127.0.0.1:31580\n127.0.0.1:31581", "still on the VM's loopback only, behind the gate, which stays in the VM");
  });

  it("a spec with a Dockerfile is built in the VM, from the project's own context", () => {
    stack.step("a spec that builds");
    assert.match(stack.quiet("up", "built").stdout, /devcontainer FAILED/);
    assert.equal(makeImage("built/w1").code, 0);
    assert.equal(stack.quiet("stop", "built/w1").code, 0);
    const started = stack.desolate("start", "built/w1");
    assert.match(started.stdout, /^ {2}devcontainer up \(/m, started.stdout + started.stderr);
    assert.equal(exec("built/w1", "cat /etc/built-from-the-project; id -un").stdout, "built in the VM, from the project's Dockerfile and context\ndev\n");
  });

  it("a repository with no spec: the workspace is the VM itself, and says so", () => {
    stack.step("no devcontainer.json");
    const up = stack.desolate("up", "plain");
    assert.match(up.stdout, /^ {2}devcontainer none: no checkout has a devcontainer\.json; this workspace is the VM itself$/m);
    assert.equal(exec("plain/w1", "pwd; cat /etc/desolate-test-image 2>/dev/null || echo in-the-vm").stdout, "/workspaces/acme/plain\nin-the-vm\n");
  });

  it("a changed spec gets a new container at the next start; an unchanged one keeps its container", () => {
    stack.step("the spec changes");
    const id = () => inVm("app/w1", "docker ps -q --no-trunc").stdout.trim();
    const first = id();
    assert.equal(stack.quiet("stop", "app/w1").code, 0);
    assert.equal(stack.quiet("start", "app/w1").code, 0);
    assert.equal(id(), first, "unchanged: the same container, started again");
    assert.equal(exec("app/w1", "cat /tmp/created").stdout, "created-by-the-spec\n");
    inVm("app/w1", "cd /workspaces/acme/app && sed -i 's/container-env/changed-env/' .devcontainer/devcontainer.json");
    assert.equal(stack.quiet("stop", "app/w1").code, 0);
    assert.equal(stack.quiet("start", "app/w1").code, 0);
    assert.notEqual(id(), first);
    assert.equal(exec("app/w1", "echo $FROM_SPEC").stdout, "changed-env\n");
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-08-devcontainer");
  });
});
