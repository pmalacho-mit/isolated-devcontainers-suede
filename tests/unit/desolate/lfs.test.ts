/// <reference types="node" />
// Git LFS through `desolate --push` and `--pull` (transfer.ts, docs/lfs.md),
// with the real git-lfs binary and a stand-in LFS server: the editor's half
// here, the sandbox's half (docker.ts lfsPushScript, pullScript,
// checkoutScript) run as the runner runs them -- against a project whose git
// config and committed .lfsconfig are hostile, pointing the LFS endpoint at a
// second server. That server must see nothing, ever.
//
// Skipped where there is no git-lfs (the image has one; `git lfs version`).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lfsServer, type LfsServer } from "../fixtures/lfs-server.ts";

const haveLfs = spawnSync("git", ["lfs", "version"]).status === 0;

const root = mkdtempSync(join(tmpdir(), "desolate-lfs-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
const workspaces = join(root, "workspaces");
process.env.DESOLATE_WORKSPACES = workspaces;
process.env.DESOLATE_REMOTE_CACHE = join(root, "cache");
// What the image's `git lfs install --system` is to its sandboxes: the filter,
// `required`. Here in a HOME of its own, so the machine's config is not touched.
process.env.HOME = home;
const { push, pull, cloneThroughCache, parsePointer, lfsAuthFrom, describeLfs, lfsObjectsAdded, TransferError } =
  await import("../../../release/vscode-image/transfer.ts");
const { bundleScript, pullScript, lfsPushScript, checkoutScript } = await import("../../../release/vscode-image/docker.ts");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();

/** A script as a sandbox runs it. Asynchronously: the stand-in server is in
 *  this process, and a blocked event loop would never answer it. */
const sandboxRun = (script: string, name: string, args: string[], cwd: string) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = spawn("sh", ["-c", script, name, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let out = "", err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });

const remote = join(root, "remote.git");
const registration = { tag: "acme__widgets", ownerRepo: "acme/widgets", url: remote };
const projectDir = (name: string) => join(workspaces, "acme", name);
let real: LfsServer, evil: LfsServer;
const sha256 = (file: string) => execFileSync("sha256sum", [file], { encoding: "utf8" }).split(" ")[0];
const pointerOf = (dir: string, file: string) => git(dir, "cat-file", "-p", `HEAD:${file}`);
const oidOf = (dir: string, file: string) => /oid sha256:([0-9a-f]{64})/.exec(pointerOf(dir, file))![1];

/** What each sandbox was asked, in order, with the remote's branches as they stood. */
const asked: { op: string; remoteHad: string[] }[] = [];
const remoteBranches = () => git(root, "--git-dir", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean);

/** The broker's half for a project: its ops, run as the runner would. */
const broker = (name: string) => async (request: Record<string, unknown>, onLog: (line: string) => boolean) => {
  const dir = projectDir(name);
  const stem = join(dir, ".git", String(request.transfer).replace(/\.bundle$/, ""));
  asked.push({ op: String(request.op), remoteHad: remoteBranches() });
  const run = request.op === "bundle" ? await sandboxRun(bundleScript, "bundle", [dir, `${stem}.bundle`, `${stem}.haves`], dir)
    : request.op === "lfs-push" ? await sandboxRun(lfsPushScript, "lfs-push", [dir, `${stem}.lfsneed`, `${stem}.lfsauth`, "/dev/null"], dir)
      : await sandboxRun(pullScript, "pull", [dir, `${stem}.bundle`, `${stem}.refs`, "/dev/null", request.fetch ? "fetch" : "merge", `${stem}.lfsauth`], dir);
  if (run.err) process.stderr.write(run.err.split("\n").map((line) => `      | ${line}`).join("\n") + "\n");
  for (const line of run.out.split("\n").filter(Boolean))
    onLog(line.replace(/^desolate-bundled/, "BUNDLED").replace(/^desolate-pulled/, "PULLED").replace(/^desolate-lfs/, "LFS"));
  return run.code;
};
const leftovers = (name: string) => readdirSync(join(projectDir(name), ".git")).filter((f) => f.startsWith("desolate-transfer-"));

describe("Git LFS through push and pull", { skip: !haveLfs && "no git-lfs" }, () => {
  const said: string[] = [];
  const auth = (server: () => LfsServer) => () => ({ href: server().url, header: `Authorization: ${server().token}` });

  before(async () => {
    real = await lfsServer();
    evil = await lfsServer("acme/widgets", "evil");
    // (Where the system config already has the filter, as the image's does, that is it.)
    if (spawnSync("git", ["config", "--get", "filter.lfs.required"], { cwd: root }).status !== 0)
      execFileSync("git", ["lfs", "install", "--skip-repo"], { cwd: root, env: { ...process.env, HOME: home } });
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
    const dir = projectDir("widgets");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "--quiet");
    writeFileSync(join(dir, "README"), "widgets\n");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "start");
    git(dir, "push", "--quiet", remote, "main");
    git(dir, "checkout", "--quiet", "-b", "feature");
    git(dir, "lfs", "track", "*.bin");
    writeFileSync(join(dir, "a.bin"), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7 + 3) % 256)));
    writeFileSync(join(dir, "notes.txt"), "not large\n");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "a large file");
    // What a project could do to send the editor's credential somewhere else:
    // every way git-lfs is told where its server is, to a server of the attacker's.
    const base = evil.url.replace(/\/acme\/widgets$/, "/");
    git(dir, "config", "lfs.url", evil.url);
    git(dir, "config", "lfs.pushurl", evil.url);
    git(dir, "config", `url.${base}.insteadOf`, real.url.replace(/\/acme\/widgets$/, "/"));
    git(dir, "config", "http.proxy", "http://127.0.0.1:9");
    git(dir, "config", "http.sslVerify", "false");
    git(dir, "config", "credential.helper", "!echo password=evil #");
    writeFileSync(join(dir, ".lfsconfig"), `[lfs]\n\turl = ${evil.url}\n`);
    git(dir, "add", ".lfsconfig");
    git(dir, "commit", "--quiet", "-m", "a hostile .lfsconfig");
  });
  after(async () => {
    await real?.close();
    await evil?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a push says what it will upload, uploads it BEFORE the branch, and only to its own server", async () => {
    const dir = projectDir("widgets");
    const oid = oidOf(dir, "a.bin");
    // A program in the project's config, to run on any git that reads it.
    git(dir, "config", "core.fsmonitor", `touch ${join(root, "ran-fsmonitor")}; false`);
    const result = await push("acme/widgets", {
      registration, ssh: "/bin/false", lfsAuth: auth(() => real), ask: broker("widgets"), log: (line) => said.push(line),
    });
    assert.match(result, /^pushed feature /);
    // What will be uploaded, said first: the file, its size, the quota.
    assert.match(said[0], /^uploading 1 LFS object \(4\.9 KiB\) to acme\/widgets's LFS storage, which counts against its owner's quota:$/);
    assert.match(said[1], new RegExp(`^  a\\.bin  4\\.9 KiB  ${oid.slice(0, 12)}$`));
    assert.equal(said.length, 2, "notes.txt is not an LFS file, and .lfsconfig is not either");
    // The object is on the server, whole.
    assert.equal(real.objects.get(oid)?.length, 5000);
    // Ordered: when the objects went up, the branch was not on the remote yet.
    assert.deepEqual(asked.filter((a) => a.op === "lfs-push").map((a) => a.remoteHad), [["main"]]);
    assert.ok(remoteBranches().includes("feature"));
    // The hostile project could redirect nothing: no request reached the other
    // server, and the token went to the batch endpoint alone.
    assert.deepEqual(evil.seen, []);
    assert.ok(real.seen.every((s) => (s.authorization !== undefined) === s.path.endsWith("/objects/batch")), JSON.stringify(real.seen));
    assert.ok(!existsSync(join(root, "ran-fsmonitor")), "the project's fsmonitor ran with the credential in reach");
    git(dir, "config", "--unset", "core.fsmonitor");
    // Nothing of the credential is left in the project.
    assert.deepEqual(leftovers("widgets"), []);
  });

  test("a push that adds no LFS file asks for no credential and says nothing", async () => {
    const dir = projectDir("widgets");
    writeFileSync(join(dir, "plain.txt"), "plain\n");
    git(dir, "add", "plain.txt");
    git(dir, "commit", "--quiet", "-m", "plain");
    said.length = 0;
    let asks = 0;
    await push("acme/widgets", { registration, ssh: "/bin/false", lfsAuth: () => { asks++; return auth(() => real)(); }, ask: broker("widgets"), log: (line) => said.push(line) });
    assert.equal(asks, 0);
    assert.deepEqual(said, []);
    assert.equal(asked.at(-1)!.op, "bundle");
  });

  test("an object the project does not have stops the push: the branch is NOT pushed", async () => {
    const dir = projectDir("widgets");
    writeFileSync(join(dir, "b.bin"), Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 11 + 5) % 256)));
    git(dir, "add", "b.bin");
    git(dir, "commit", "--quiet", "-m", "another large file, whose object is lost");
    const oid = oidOf(dir, "b.bin");
    rmSync(join(dir, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid));
    const tip = git(dir, "rev-parse", "HEAD");
    await assert.rejects(
      push("acme/widgets", { registration, ssh: "/bin/false", lfsAuth: auth(() => real), ask: broker("widgets"), log: () => {} }),
      (err: Error) => err instanceof TransferError && /could not upload the LFS objects.*NOT pushed/.test(err.message),
    );
    assert.notEqual(git(root, "--git-dir", remote, "rev-parse", "refs/heads/feature"), tip);
    assert.deepEqual(leftovers("widgets"), []);
    assert.equal(real.objects.has(oid), false);
    assert.deepEqual(evil.seen, []);
  });

  test("the credential is asked of GitHub over the registration's own host alias, and refused if it names another repository", async () => {
    const dir = projectDir("widgets");
    writeFileSync(join(dir, "d.bin"), Buffer.from(Array.from({ length: 1500 }, (_, i) => (i * 17 + 9) % 256)));
    git(dir, "add", "d.bin");
    git(dir, "commit", "--quiet", "-m", "a file whose credential comes back wrong");
    const tip = git(dir, "rev-parse", "HEAD");
    // A stand-in for ssh: records how it was called, answers for ANOTHER repository.
    const fake = join(root, "fake-ssh");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" > ${join(root, "ssh-argv")}\n` +
      `echo '{"href":"https://lfs.github.com/octocat/Hello-World","header":{"Authorization":"RemoteAuth x"}}'\n`, { mode: 0o755 });
    const before = asked.length;
    await assert.rejects(
      push("acme/widgets", { registration, ssh: fake, ask: broker("widgets"), log: () => {} }),
      (err: Error) => err instanceof TransferError && /names an endpoint that is not lfs\.github\.com\/acme\/widgets: refusing it/.test(err.message),
    );
    assert.equal(readFileSync(join(root, "ssh-argv"), "utf8").trim(),
      "-o BatchMode=yes -o ConnectTimeout=15 git@github.com-acme__widgets git-lfs-authenticate acme/widgets upload");
    assert.deepEqual(asked.slice(before).map((a) => a.op), ["bundle"], "no sandbox was asked to upload anything");
    assert.notEqual(git(root, "--git-dir", remote, "rev-parse", "refs/heads/feature"), tip);
    assert.deepEqual(leftovers("widgets"), []);
    git(dir, "reset", "--quiet", "--hard", "HEAD~1");
  });

  test("a pull brings the objects down and fills the files in; the first checkout leaves pointers", async () => {
    // The lost object's commit is put right: re-create the file's object.
    const dir = projectDir("widgets");
    git(dir, "reset", "--quiet", "--hard", "HEAD~1");
    cloneThroughCache(registration, projectDir("copy"), { ssh: "/bin/false" });
    const copy = projectDir("copy");
    git(copy, "branch", "feature", "origin/feature");
    git(copy, "symbolic-ref", "HEAD", "refs/heads/feature");
    const first = await sandboxRun(checkoutScript, "checkout", ["/dev/null"], copy);
    assert.equal(first.code, 0, first.err);
    // Pointers, not a half-written tree: the objects are not here and the first
    // checkout does not fail on them.
    assert.match(readFileSync(join(copy, "a.bin"), "utf8"), /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/);
    assert.equal(git(copy, "status", "--porcelain"), "");

    let asks = 0;
    const result = await pull("acme/copy", {
      registration, ssh: "/bin/false", lfsAuth: (op) => { asks++; assert.equal(op, "download"); return auth(() => real)(); }, ask: broker("copy"),
    });
    assert.equal(asks, 1);
    assert.match(result, /up to date/);
    assert.match(result, /; fetched 1 LFS object$/);
    assert.equal(sha256(join(copy, "a.bin")), sha256(join(dir, "a.bin")));
    assert.equal(git(copy, "status", "--porcelain"), "");
    assert.deepEqual(evil.seen, []);
    assert.deepEqual(leftovers("copy"), []);

    // Pulling again needs nothing: no credential asked for.
    await pull("acme/copy", { registration, ssh: "/bin/false", lfsAuth: () => { asks++; return auth(() => real)(); }, ask: broker("copy") });
    assert.equal(asks, 1);
  });

  test("a pull fast-forwards over new LFS files, and says when it could not get them", async () => {
    const dir = projectDir("widgets");
    writeFileSync(join(dir, "c.bin"), Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 13 + 1) % 256)));
    git(dir, "add", "c.bin");
    git(dir, "commit", "--quiet", "-m", "a third large file");
    await push("acme/widgets", { registration, ssh: "/bin/false", lfsAuth: auth(() => real), ask: broker("widgets"), log: () => {} });
    const copy = projectDir("copy");
    // GitHub "loses" it: the pull still lands the commit, and does not call it blocked.
    real.objects.delete(oidOf(dir, "c.bin"));
    const result = await pull("acme/copy", { registration, ssh: "/bin/false", lfsAuth: auth(() => real), ask: broker("copy") });
    assert.match(result, /^feature fast-forwarded to origin\/feature/);
    assert.match(result, /its LFS objects could NOT be fetched/);
    assert.match(readFileSync(join(copy, "c.bin"), "utf8"), /^version https:\/\/git-lfs/);
    assert.equal(git(copy, "rev-parse", "HEAD"), git(dir, "rev-parse", "HEAD"));
    assert.deepEqual(evil.seen, []);
    // And once GitHub has it, the next pull fills it in.
    real.objects.set(oidOf(dir, "c.bin"), readFileSync(join(dir, "c.bin")));
    const again = await pull("acme/copy", { registration, ssh: "/bin/false", lfsAuth: auth(() => real), ask: broker("copy") });
    assert.match(again, /fetched 1 LFS object$/);
    assert.equal(sha256(join(copy, "c.bin")), sha256(join(dir, "c.bin")));
  });

  test("a fetch-only pull touches no LFS and asks for no credential", async () => {
    let asks = 0;
    const result = await pull("acme/copy", { registration, ssh: "/bin/false", fetchOnly: true, lfsAuth: () => { asks++; return auth(() => real)(); }, ask: broker("copy") });
    assert.match(result, /^fetched acme\/widgets's branches as origin\/\*$/);
    assert.equal(asks, 0);
  });
});

describe("what the editor holds an LFS pointer and credential to", () => {
  const oid = "a".repeat(64);
  const pointer = (extra = "") => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 123\n${extra}`;
  test("a pointer is git-lfs's three lines and nothing else", () => {
    assert.deepEqual(parsePointer(pointer()), { oid, size: 123 });
    for (const bad of [
      pointer("ext-0-foo sha256:" + oid + "\n"), pointer().replace("\n", "\r\n"), pointer().slice(0, -1),
      pointer().replace(oid, "A".repeat(64)), pointer().replace(oid, "a".repeat(63)), pointer().replace("size 123", "size -1"),
      pointer().replace("size 123", "size 0123"), pointer().replace("v1", "v2"), `\n${pointer()}`, "hello\n",
    ]) assert.equal(parsePointer(bad), undefined, JSON.stringify(bad));
  });

  const registration = { tag: "acme__widgets", ownerRepo: "acme/widgets", url: "git@github.com-acme__widgets:acme/widgets.git" };
  const answer = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ href: "https://lfs.github.com/acme/widgets", header: { Authorization: "RemoteAuth abc123" }, expires_in: 599, ...over });
  test("GitHub's answer for this repository is taken", () => {
    assert.deepEqual(lfsAuthFrom(registration, answer()), { href: "https://lfs.github.com/acme/widgets", header: "Authorization: RemoteAuth abc123" });
    assert.equal(lfsAuthFrom(registration, answer({ href: "https://lfs.github.com/Acme/Widgets.git/info/lfs" })).href, "https://lfs.github.com/Acme/Widgets.git/info/lfs");
  });
  test("other headers GitHub names are not passed on, and one that is missing is said by name only", () => {
    const extra = lfsAuthFrom(registration, answer({ header: { Accept: "x", Authorization: "RemoteAuth abc123", "X-Other": "y" } }));
    assert.equal(extra.header, "Authorization: RemoteAuth abc123");
    assert.throws(() => lfsAuthFrom(registration, answer({ header: { "X-Auth": "secret-value" } })),
      (err: Error) => /has no Authorization header \(it has: "X-Auth"\)/.test(err.message) && !err.message.includes("secret-value"));
  });
  test("anything else is refused: another repository, another host, a scheme, a bad header, a newline", () => {
    for (const bad of [
      answer({ href: "https://lfs.github.com/octocat/Hello-World" }),
      answer({ href: "https://lfs.github.com/acme/widgets-evil" }),
      answer({ href: "https://lfs.github.com/acme/widgets/../x" }),
      answer({ href: "https://evil.example/acme/widgets" }),
      answer({ href: "https://lfs.github.com.evil.example/acme/widgets" }),
      answer({ href: "http://lfs.github.com/acme/widgets" }),
      answer({ href: "https://lfs.github.com/acme/widgets\nevil" }),
      answer({ href: "https://user@lfs.github.com/acme/widgets" }),
      answer({ header: { Authorization: "RemoteAuth a\nHost: evil" } }),
      answer({ header: { Authorization: "" } }),
      answer({ header: { "X-Auth": "x" } }),
      answer({ header: "Authorization: x" }),
      answer({ href: 5 }), "not json", "null",
    ]) assert.throws(() => lfsAuthFrom(registration, bad), TransferError, bad);
  });

  test("what a push will upload is described for a person", () => {
    const lines = describeLfs([
      { oid, size: 5000, path: "assets/a.bin" },
      { oid: "b".repeat(64), size: 3 * 1024 ** 3, path: "" },
    ], "acme/widgets");
    assert.equal(lines[0], "uploading 2 LFS objects (3.0 GiB) to acme/widgets's LFS storage, which counts against its owner's quota:");
    assert.equal(lines[1], `  assets/a.bin  4.9 KiB  ${oid.slice(0, 12)}`);
    assert.equal(lines[2], `  ${"b".repeat(12)}  3.0 GiB  ${"b".repeat(12)}`);
  });
});

describe("which objects a commit adds", { skip: !haveLfs && "no git-lfs" }, () => {
  test("the pointers among the new blobs, by content, once each (at the first path git names), and not what the remote's branches already lead to", () => {
    const repo = join(root, "scan.git");
    const work = join(root, "scan");
    execFileSync("git", ["init", "--quiet", "--bare", repo]);
    mkdirSync(work, { recursive: true });
    git(work, "init", "--quiet");
    const pointerText = (n: string) => `version https://git-lfs.github.com/spec/v1\noid sha256:${n.repeat(64)}\nsize 10\n`;
    // No .gitattributes at all: by content, as git-lfs's own push finds them.
    writeFileSync(join(work, "old.dat"), pointerText("1"));
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "old");
    git(work, "push", "--quiet", repo, "main");
    writeFileSync(join(work, "new one.dat"), pointerText("2"));
    mkdirSync(join(work, "d"));
    writeFileSync(join(work, "d", "again.dat"), pointerText("2"));
    writeFileSync(join(work, "almost.dat"), pointerText("3").replace("size 10", "size 10 "));
    writeFileSync(join(work, "small.txt"), "small\n");
    writeFileSync(join(work, "big.txt"), "x".repeat(5000));
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "new");
    git(work, "push", "--quiet", repo, "HEAD:refs/heads/topic");
    // The cache's branches: main only. (topic is the push's own, not the remote's.)
    git(repo, "update-ref", "-d", "refs/heads/topic");
    git(repo, "update-ref", "refs/desolate/outgoing/topic", git(work, "rev-parse", "HEAD"));
    const found = lfsObjectsAdded(repo, git(work, "rev-parse", "HEAD"));
    assert.deepEqual(found.map(({ oid, size, path }) => ({ oid: oid[0], size, path })), [{ oid: "2", size: 10, path: "d/again.dat" }]);
  });
});
