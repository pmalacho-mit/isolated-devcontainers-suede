/// <reference types="node" />
// `desolate --push` and `--pull` (transfer.ts), with real git: the editor's
// half here, with its cache, and the sandbox's half (docker.ts bundleScript /
// pullScript) run as the runner runs it -- against a project whose .git is
// hostile: a pre-push hook, a core.sshCommand, a url rewrite to another
// repository. None of it may run, or decide where anything goes.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "desolate-transfer-"));
const workspaces = join(root, "workspaces");
const cacheRoot = join(root, "cache");
process.env.DESOLATE_WORKSPACES = workspaces;
process.env.DESOLATE_REMOTE_CACHE = cacheRoot;
const { push, pull, registrationOf, defaultBranchOf, cloneThroughCache, TransferError } = await import("../../../release/vscode-image/transfer.ts");
const { bundleScript, pullScript } = await import("../../../release/vscode-image/docker.ts");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();
const project = join(workspaces, "acme", "widgets");
const remote = join(root, "remote.git");
const elsewhere = join(root, "elsewhere.git");
const upstream = join(root, "upstream-clone");
const marker = (name: string) => join(root, `ran-${name}`);
const registration = { tag: "acme__widgets", ownerRepo: "acme/widgets", url: remote };
const commitIn = (dir: string, file: string, text: string) => {
  writeFileSync(join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "--quiet", "-m", text.trim());
};

/** What each sandbox run was handed: for a bundle, whether it carried history
 *  the other side was expected to have already (prerequisites), or nothing. */
const seen: { op: string; bundle: "none" | "whole" | "only what is new" }[] = [];
const describeBundle = (file: string): "none" | "whole" | "only what is new" => {
  if (!existsSync(file)) return "none";
  const said = spawnSync("git", ["bundle", "list-heads", file], { encoding: "utf8" });
  const header = readFileSync(file, "latin1").split("\n\n")[0];
  return said.status === 0 && /^-[0-9a-f]{40}/m.test(header) ? "only what is new" : "whole";
};

/** The sandbox's half, run as the runner runs it: its script, its arguments,
 *  its last line read back through the broker's relay. */
const sandbox = (op: string) => async (request: Record<string, unknown>, onLog: (line: string) => boolean) => {
  const stem = join(project, ".git", String(request.transfer).replace(/\.bundle$/, ""));
  const args = op === "bundle"
    ? [bundleScript, [project, `${stem}.bundle`, `${stem}.haves`]] as const
    : [pullScript, [project, `${stem}.bundle`, `${stem}.refs`, "/dev/null", request.fetch ? "fetch" : "merge"]] as const;
  if (op === "pull") seen.push({ op, bundle: describeBundle(`${stem}.bundle`) });
  const result = spawnSync("sh", ["-c", args[0], op, ...args[1]], { encoding: "utf8" });
  if (op === "bundle") seen.push({ op, bundle: describeBundle(`${stem}.bundle`) });
  for (const line of (result.stdout ?? "").split("\n").filter(Boolean))
    onLog(line.replace(/^desolate-bundled/, "BUNDLED").replace(/^desolate-pulled/, "PULLED"));
  return result.status ?? 1;
};
const bundler = sandbox("bundle"), puller = sandbox("pull");
const lastSeen = () => seen.at(-1)!.bundle;
const leftovers = () => readdirSync(join(project, ".git")).filter((f) => f.startsWith("desolate-transfer-"));

before(() => {
  mkdirSync(project, { recursive: true });
  git(root, "init", "--quiet", "--bare", remote);
  git(root, "init", "--quiet", "--bare", elsewhere);
  git(project, "init", "--quiet");
  for (let i = 1; i <= 30; i++) commitIn(project, "a.txt", `history ${i}\n`);
  git(project, "push", "--quiet", remote, "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git(project, "checkout", "--quiet", "-b", "feature");
  commitIn(project, "a.txt", "the agent's\n");
  // What an agent in the project could have left for the editor's git.
  writeFileSync(join(project, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch ${marker("pre-push")}\n`, { mode: 0o755 });
  git(project, "config", "core.sshCommand", `touch ${marker("ssh-command")}; ssh`);
  git(project, "config", `url.${elsewhere}.insteadOf`, remote);
  git(root, "clone", "--quiet", remote, upstream);
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
  test("the branch reaches the registered repository, as only what it lacks -- and nothing of the project's git ran", async () => {
    const said = await push("acme/widgets", { registration, ask: bundler });
    assert.match(said, /^pushed feature \([0-9a-f]{12}\) to acme\/widgets$/);
    assert.equal(lastSeen(), "only what is new", "the cache had main's history; the sandbox sent it anyway");
    assert.equal(git(root, "--git-dir", remote, "rev-parse", "refs/heads/feature"), git(project, "rev-parse", "HEAD"));
    assert.equal(git(root, "--git-dir", elsewhere, "for-each-ref").length, 0, "the project's url rewrite sent it elsewhere");
    for (const name of ["pre-push", "ssh-command"]) assert.ok(!existsSync(marker(name)), `the project's ${name} ran`);
    assert.deepEqual(leftovers(), [], "a transfer file is left behind");
  });

  test("again, with nothing new: no bundle at all, and nothing refused", async () => {
    assert.match(await push("acme/widgets", { registration, ask: bundler }), /^pushed feature/);
    assert.equal(lastSeen(), "none");
  });

  test("the remote's default branch is refused unless asked for", async () => {
    git(project, "checkout", "--quiet", "main");
    try {
      await assert.rejects(push("acme/widgets", { registration, ask: bundler }), (err: Error) =>
        err instanceof TransferError && /default branch/.test(err.message) &&
        err.defaultBranch === "main" && !err.busy, "refused as the default branch, which a caller can ask about");
      commitIn(project, "a.txt", "main moves\n");
      assert.match(await push("acme/widgets", { registration, ask: bundler, allowDefault: true }), /^pushed main/);
    } finally {
      git(project, "checkout", "--quiet", "feature");
    }
  });

  test("a target busy with something else is said as busy, not as a failure (locks.ts)", async () => {
    const busy = async (_request: Record<string, unknown>, onLog: (line: string) => boolean) => {
      onLog("desolate: acme/widgets is in use: starting, since 2026-10-29T14:28:47Z (pid 12 in the orchestrator). Try again once that is done.");
      return 75;
    };
    await assert.rejects(push("acme/widgets", { registration, ask: busy }), (err: Error) =>
      err instanceof TransferError && err.busy && /busy with something else/.test(err.message));
    await assert.rejects(pull("acme/widgets", { registration, ask: busy }), (err: Error) =>
      err instanceof TransferError && err.busy);
    assert.deepEqual(leftovers(), [], "nothing is left in the project");
  });

  test("a bundle that is a link out of the project is not read", async () => {
    const other = join(workspaces, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "secret.bundle"), "another project's");
    const linking = async (request: Record<string, unknown>, onLog: (line: string) => boolean) => {
      symlinkSync(join(other, "secret.bundle"), join(project, ".git", String(request.transfer)));
      onLog(`BUNDLED feature ${"a".repeat(40)} bundled`);
      return 0;
    };
    await assert.rejects(push("acme/widgets", { registration, ask: linking }), (err: Error) =>
      err instanceof TransferError && /is not a file of .*widgets's own/.test(err.message));
    assert.deepEqual(leftovers(), [], "the link is left behind");
  });

  test("a sandbox that names a commit it did not send is refused", async () => {
    const lying = async (_request: Record<string, unknown>, onLog: (line: string) => boolean) => {
      onLog(`BUNDLED feature ${"b".repeat(40)} none`);
      return 0;
    };
    await assert.rejects(push("acme/widgets", { registration, ask: lying }), /the cache does not have/);
  });
});

describe("pull", () => {
  test("the remote's branches arrive as origin/*, and the checked-out one fast-forwards", async () => {
    git(upstream, "fetch", "--quiet", "origin");
    git(upstream, "checkout", "--quiet", "-b", "feature", "origin/feature");
    commitIn(upstream, "a.txt", "upstream's\n");
    git(upstream, "push", "--quiet", "origin", "feature");
    const said = await pull("acme/widgets", { registration, ask: puller });
    assert.equal(said, "feature fast-forwarded to origin/feature (acme/widgets)");
    assert.equal(git(project, "rev-parse", "HEAD"), git(upstream, "rev-parse", "HEAD"));
    assert.equal(git(project, "rev-parse", "refs/remotes/origin/main"), git(root, "--git-dir", remote, "rev-parse", "main"));
    assert.deepEqual(leftovers(), [], "a transfer file is left behind");
    assert.ok(!existsSync(marker("ssh-command")), "the project's core.sshCommand ran");
  });

  test("the next pull is only what is new -- and one with nothing new sends no bundle", async () => {
    commitIn(upstream, "a.txt", "more upstream\n");
    git(upstream, "push", "--quiet", "origin", "feature");
    assert.match(await pull("acme/widgets", { registration, ask: puller }), /fast-forwarded/);
    assert.equal(lastSeen(), "only what is new");
    assert.match(await pull("acme/widgets", { registration, ask: puller }), /up to date/);
    assert.equal(lastSeen(), "none");
  });

  test("a branch deleted upstream leaves origin/* too", async () => {
    git(upstream, "push", "--quiet", "origin", "feature:gone-soon");
    await pull("acme/widgets", { registration, ask: puller });
    assert.ok(git(project, "branch", "-r").includes("origin/gone-soon"));
    git(upstream, "push", "--quiet", "origin", ":gone-soon");
    await pull("acme/widgets", { registration, ask: puller });
    assert.ok(!git(project, "branch", "-r").includes("origin/gone-soon"));
  });

  test("a project that lacks what the cache thought it had is sent all of it, once", async () => {
    // Upstream moves on, and the cache is told -- wrongly -- that the project
    // already has the new commit: the small bundle cannot apply.
    commitIn(upstream, "a.txt", "the project never saw this\n");
    git(upstream, "push", "--quiet", "origin", "feature");
    const before = seen.length;
    execFileSync("git", ["-C", join(cacheRoot, "acme__widgets.git"), "fetch", "--quiet", remote, "+refs/heads/*:refs/heads/*"]);
    writeFileSync(join(cacheRoot, "acme__widgets.known"), `${git(upstream, "rev-parse", "HEAD")}\n`);
    assert.match(await pull("acme/widgets", { registration, ask: puller }), /fast-forwarded/);
    assert.deepEqual(seen.slice(before).map((s) => s.bundle), ["only what is new", "whole"]);
    assert.equal(git(project, "rev-parse", "HEAD"), git(upstream, "rev-parse", "HEAD"));
  });

  test("fetch-only sets origin/* and moves nothing checked out", async () => {
    commitIn(upstream, "a.txt", "fetched, not merged\n");
    git(upstream, "push", "--quiet", "origin", "feature");
    const head = git(project, "rev-parse", "HEAD");
    assert.match(await pull("acme/widgets", { registration, ask: puller, fetchOnly: true }), /^fetched acme\/widgets's branches/);
    assert.equal(git(project, "rev-parse", "HEAD"), head, "the checked-out branch moved");
    assert.equal(git(project, "rev-parse", "refs/remotes/origin/feature"), git(upstream, "rev-parse", "HEAD"));
  });

  test("a branch that has moved on from origin is said to have diverged, and left alone", async () => {
    commitIn(project, "b.txt", "mine\n");
    commitIn(upstream, "a.txt", "theirs\n");
    git(upstream, "push", "--quiet", "origin", "feature");
    const before = git(project, "rev-parse", "HEAD");
    assert.match(await pull("acme/widgets", { registration, ask: puller }), /have diverged/);
    assert.equal(git(project, "rev-parse", "HEAD"), before);
  });
});

describe("a project cloned through its cache (`repo add`)", () => {
  const cloned = join(workspaces, "acme", "gadgets");
  const gadgets = { tag: "acme__gadgets", ownerRepo: "acme/gadgets", url: remote };

  test("the clone is the remote's, with origin pointing there and the default branch checked out", () => {
    cloneThroughCache(gadgets, cloned);
    assert.equal(git(cloned, "remote", "get-url", "origin"), remote);
    assert.equal(git(cloned, "symbolic-ref", "--short", "HEAD"), "main");
    assert.equal(git(cloned, "rev-parse", "refs/remotes/origin/feature"), git(root, "--git-dir", remote, "rev-parse", "feature"));
  });

  test("its objects are copies: no file is shared with the cache", () => {
    const objects = (dir: string) => execFileSync("find", [dir, "-type", "f", "-path", "*objects*", "-links", "+1"], { encoding: "utf8" }).trim();
    assert.equal(objects(join(cloned, ".git")), "", "a hardlinked object file is the cache's own, writable from the project");
  });

  test("and the cache knows it has every branch: the first pull sends no bundle", async () => {
    const before = seen.length;
    const ask = async (request: Record<string, unknown>, onLog: (line: string) => boolean) => {
      const stem = join(cloned, ".git", String(request.transfer).replace(/\.bundle$/, ""));
      seen.push({ op: "pull", bundle: describeBundle(`${stem}.bundle`) });
      const result = spawnSync("sh", ["-c", pullScript, "pull", cloned, `${stem}.bundle`, `${stem}.refs`, "/dev/null"], { encoding: "utf8" });
      for (const line of (result.stdout ?? "").split("\n").filter(Boolean)) onLog(line.replace(/^desolate-pulled/, "PULLED"));
      return result.status ?? 1;
    };
    assert.match(await pull("acme/gadgets", { registration: gadgets, ask }), /up to date/);
    assert.deepEqual(seen.slice(before).map((s) => s.bundle), ["none"]);
  });
});

describe("the cache's lock", () => {
  test("one push or pull of a project at a time; a lock its process left behind is taken over", async () => {
    const lock = join(cacheRoot, "acme__widgets.lock");
    writeFileSync(lock, "1");   // pid 1 is always alive
    try {
      await assert.rejects(pull("acme/widgets", { registration, ask: puller }), /another push or pull/);
    } finally {
      rmSync(lock, { force: true });
    }
    writeFileSync(lock, "999999999");   // no such process
    await pull("acme/widgets", { registration, ask: puller });
    assert.ok(!existsSync(lock), "the lock outlived the pull");
  });
});
