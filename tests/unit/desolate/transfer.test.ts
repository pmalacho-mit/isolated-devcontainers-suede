/// <reference types="node" />
// `desolate --push` and `--pull` (transfer.ts), with real git: the editor's
// half here, the sandbox's half (docker.ts bundleScript / pullScript) run as
// the sandbox would run it, against a project whose .git is hostile -- a
// pre-push hook, a core.sshCommand, a url rewrite to another repository.
// None of it may run, or decide where anything goes.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "desolate-transfer-"));
const workspaces = join(root, "workspaces");
process.env.DESOLATE_WORKSPACES = workspaces;
const { push, pull, registrationOf, defaultBranchOf, TransferError } = await import("../../../release/vscode-image/transfer.ts");
const { bundleScript, pullScript } = await import("../../../release/vscode-image/docker.ts");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();
const project = join(workspaces, "acme", "widgets");
const remote = join(root, "remote.git");
const elsewhere = join(root, "elsewhere.git");
const marker = (name: string) => join(root, `ran-${name}`);
const registration = { tag: "acme__widgets", ownerRepo: "acme/widgets", url: remote };

/** The sandbox's half, run as the runner runs it: its script, its arguments,
 *  its last line read back through the broker's relay. */
const sandbox = (script: string, args: string[]) => async (_request: Record<string, unknown>, onLog: (line: string) => boolean) => {
  const result = spawnSync("sh", ["-c", script, "sandbox", ...args], { encoding: "utf8" });
  for (const line of (result.stdout ?? "").split("\n").filter(Boolean)) onLog(line.replace(/^desolate-bundled/, "BUNDLED").replace(/^desolate-pulled/, "PULLED"));
  return result.status ?? 1;
};
const bundler = (request: Record<string, unknown>, onLog: (line: string) => boolean) =>
  sandbox(bundleScript, [project, String(request.transfer)])(request, onLog);
const puller = (request: Record<string, unknown>, onLog: (line: string) => boolean) =>
  sandbox(pullScript, [project, join(project, ".git", String(request.transfer)), "/dev/null"])(request, onLog);

before(() => {
  mkdirSync(project, { recursive: true });
  git(root, "init", "--quiet", "--bare", remote);
  git(root, "init", "--quiet", "--bare", elsewhere);
  git(project, "init", "--quiet");
  writeFileSync(join(project, "a.txt"), "one\n");
  git(project, "add", "a.txt");
  git(project, "commit", "--quiet", "-m", "one");
  git(project, "push", "--quiet", remote, "main");
  git(project, "checkout", "--quiet", "-b", "feature");
  writeFileSync(join(project, "a.txt"), "two\n");
  git(project, "commit", "--quiet", "-am", "two");
  // What an agent in the project could have left for the editor's git.
  writeFileSync(join(project, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch ${marker("pre-push")}\n`, { mode: 0o755 });
  git(project, "config", "core.sshCommand", `touch ${marker("ssh-command")}; ssh`);
  git(project, "config", `url.${elsewhere}.insteadOf`, remote);
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("which repository a project pushes to", () => {
  test("the one `repo add` registered, read from the editor's own config", () => {
    const config = "url.git@github.com-acme__widgets:acme/widgets.insteadof git@github.com:acme/widgets\n" +
      "url.ssh://git@github.com-acme__widgets/acme/widgets.insteadof ssh://git@github.com/acme/widgets\n" +
      "url.git@github.com-other__x:other/x.insteadof git@github.com:other/x\n";
    assert.deepEqual(registrationOf("acme/widgets", config),
      { tag: "acme__widgets", ownerRepo: "acme/widgets", url: "git@github.com-acme__widgets:acme/widgets.git" });
  });

  test("none for a project nothing registered, or a name that is no owner/repo", () => {
    assert.equal(registrationOf("acme/widgets", "url.git@github.com-other__x:other/x.insteadof x\n"), undefined);
    assert.equal(registrationOf("solo", "url.git@github.com-solo:solo/solo.insteadof x\n"), undefined);
  });

  test("the remote's default branch, from ls-remote --symref", () => {
    assert.equal(defaultBranchOf("ref: refs/heads/main\tHEAD\nabc\tHEAD\n"), "main");
    assert.equal(defaultBranchOf("abc\tHEAD\n"), undefined);
  });
});

describe("push", () => {
  test("the checked-out branch reaches the registered repository -- and nothing of the project's git ran", async () => {
    const said = await push("acme/widgets", { registration, ask: bundler });
    assert.match(said, /^pushed feature \([0-9a-f]{12}\) to acme\/widgets$/);
    assert.equal(git(root, "--git-dir", remote, "rev-parse", "refs/heads/feature"), git(project, "rev-parse", "HEAD"));
    assert.equal(git(root, "--git-dir", elsewhere, "for-each-ref").length, 0, "the project's url rewrite sent it elsewhere");
    for (const name of ["pre-push", "ssh-command"]) assert.ok(!existsSync(marker(name)), `the project's ${name} ran`);
    assert.deepEqual(readdirSync(join(project, ".git")).filter((f) => f.startsWith("desolate-transfer-")), [], "the bundle is left behind");
  });

  test("the remote's default branch is refused unless asked for", async () => {
    git(project, "checkout", "--quiet", "main");
    try {
      await assert.rejects(push("acme/widgets", { registration, ask: bundler }), (err: Error) =>
        err instanceof TransferError && /default branch/.test(err.message));
      writeFileSync(join(project, "a.txt"), "main moves\n");
      git(project, "commit", "--quiet", "-am", "main moves");
      assert.match(await push("acme/widgets", { registration, ask: bundler, allowDefault: true }), /^pushed main/);
    } finally {
      git(project, "checkout", "--quiet", "feature");
    }
  });

  test("a bundle that is a link out of the project is not read", async () => {
    const other = join(workspaces, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "secret.bundle"), "another project's");
    const linking = async (request: Record<string, unknown>, onLog: (line: string) => boolean) => {
      const file = join(project, ".git", String(request.transfer));
      symlinkSync(join(other, "secret.bundle"), file);
      onLog(`BUNDLED feature ${"a".repeat(40)} ${file}`);
      return 0;
    };
    await assert.rejects(push("acme/widgets", { registration, ask: linking }), (err: Error) =>
      err instanceof TransferError && /not a file of acme\/widgets's own/.test(err.message));
  });

  test("a bundle named outside the project is not read", async () => {
    const outside = async (_request: Record<string, unknown>, onLog: (line: string) => boolean) => {
      onLog(`BUNDLED feature ${"a".repeat(40)} ${join(root, "desolate-transfer-0000000000000000.bundle")}`);
      return 0;
    };
    await assert.rejects(push("acme/widgets", { registration, ask: outside }), TransferError);
  });
});

describe("pull", () => {
  test("the remote's branches arrive as origin/*, and the checked-out one fast-forwards", async () => {
    const other = join(root, "other-clone");
    git(root, "clone", "--quiet", "--branch", "feature", remote, other);
    writeFileSync(join(other, "a.txt"), "three\n");
    git(other, "commit", "--quiet", "-am", "three");
    git(other, "push", "--quiet", "origin", "feature");
    const said = await pull("acme/widgets", { registration, ask: puller });
    assert.equal(said, "feature fast-forwarded to origin/feature (acme/widgets)");
    assert.equal(git(project, "rev-parse", "HEAD"), git(other, "rev-parse", "HEAD"));
    assert.equal(git(project, "rev-parse", "refs/remotes/origin/main"), git(root, "--git-dir", remote, "rev-parse", "main"));
    assert.deepEqual(readdirSync(join(project, ".git")).filter((f) => f.startsWith("desolate-transfer-")), [], "the bundle is left behind");
    assert.ok(!existsSync(marker("ssh-command")), "the project's core.sshCommand ran");
  });

  test("a branch that has moved on from origin is said to have diverged, and left alone", async () => {
    writeFileSync(join(project, "b.txt"), "mine\n");
    git(project, "add", "b.txt");
    git(project, "commit", "--quiet", "-m", "mine");
    const other = join(root, "other-clone");
    writeFileSync(join(other, "a.txt"), "four\n");
    git(other, "commit", "--quiet", "-am", "four");
    git(other, "push", "--quiet", "origin", "feature");
    const before = git(project, "rev-parse", "HEAD");
    assert.match(await pull("acme/widgets", { registration, ask: puller }), /have diverged/);
    assert.equal(git(project, "rev-parse", "HEAD"), before);
  });
});
