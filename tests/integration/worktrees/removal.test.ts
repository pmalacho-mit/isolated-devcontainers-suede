/// <reference types="node" />
// What removing a project would lose (#63), asked of a real repository.
//
// docker.ts lossesScript is what the orchestrator runs in a project root's
// sandbox before `repo rm` deletes it; here it runs against a real clone of a
// real "GitHub" (a bare repository), with the same positional parameters, so
// what is measured is what git answers. The unit test reads its output; this
// one makes git produce it -- each kind of work that is nowhere else, and the
// clean clone that must read as clean, or nobody could remove one without
// --force.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lossesScript } from "../../../release/vscode-image/docker.ts";
import { describeLosses, nothingLost, parseLosses } from "../../../release/vscode-image/removal.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The script as the sandbox runs it: `sh -c <script> desolate-losses <seconds>`,
 *  in the root. */
const check = (dir: string) => {
  const result = spawnSync("sh", ["-c", lossesScript, "desolate-losses", "30"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `the script always exits 0: ${result.stderr}`);
  return parseLosses(result.stdout.trim());
};

/** A bare "GitHub" with main and a pushed branch, and a fresh clone of it
 *  the way `repo add` leaves one once checked out: origin/* = GitHub's. */
const clone = () => {
  const root = fs.mkdtempSync(join(tmpdir(), "desolate-losses-"));
  const seed = join(root, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main", ".");
  git(seed, "config", "user.email", "t@example.com");
  git(seed, "config", "user.name", "t");
  fs.writeFileSync(join(seed, "a.txt"), "a\n");
  git(seed, "add", "a.txt");
  git(seed, "commit", "-q", "-m", "first");
  git(seed, "branch", "pushed");
  execFileSync("git", ["clone", "-q", "--bare", seed, join(root, "github.git")]);
  const dir = join(root, "acme", "widgets");
  execFileSync("git", ["clone", "-q", join(root, "github.git"), dir]);
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  return dir;
};

describe("lossesScript, against a real clone", () => {
  before(() => {
    const ok = spawnSync("git", ["--version"]).status === 0 && spawnSync("timeout", ["1", "true"]).status === 0;
    if (!ok) throw new Error("needs git and timeout");
  });

  test("a fresh clone loses nothing -- or no clone could be removed without --force", () => {
    const losses = check(clone());
    assert.ok(losses, "the check ran to the end");
    assert.ok(nothingLost(losses!), describeLosses(losses!).join("; "));
  });

  test("a local branch pushed and fetched since loses nothing", () => {
    const dir = clone();
    git(dir, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(join(dir, "b.txt"), "b\n");
    git(dir, "add", "b.txt");
    git(dir, "commit", "-q", "-m", "feature");
    git(dir, "push", "-q", "origin", "feature");
    assert.ok(nothingLost(check(dir)!));
  });

  test("uncommitted and untracked files", () => {
    const dir = clone();
    fs.writeFileSync(join(dir, "a.txt"), "changed\n");
    fs.writeFileSync(join(dir, "new.txt"), "new\n");
    assert.deepEqual(check(dir)!.changes, [" M a.txt", "?? new.txt"]);
  });

  test("ignored files are not work: `git worktree remove` does not count them either", () => {
    const dir = clone();
    fs.writeFileSync(join(dir, ".git", "info", "exclude"), "dist/\n");
    fs.mkdirSync(join(dir, "dist"));
    fs.writeFileSync(join(dir, "dist", "out.js"), "x\n");
    assert.ok(nothingLost(check(dir)!));
  });

  test("commits on a branch that is on no remote, counted", () => {
    const dir = clone();
    git(dir, "checkout", "-q", "-b", "agent/work");
    for (const n of [1, 2]) {
      fs.writeFileSync(join(dir, `w${n}.txt`), `${n}\n`);
      git(dir, "add", `w${n}.txt`);
      git(dir, "commit", "-q", "-m", `work ${n}`);
    }
    git(dir, "checkout", "-q", "main");
    assert.deepEqual(check(dir)!.branches, [{ name: "agent/work", commits: 2 }]);
  });

  test("main ahead of origin/main", () => {
    const dir = clone();
    fs.writeFileSync(join(dir, "c.txt"), "c\n");
    git(dir, "add", "c.txt");
    git(dir, "commit", "-q", "-m", "local only");
    assert.deepEqual(check(dir)!.branches, [{ name: "main", commits: 1 }]);
  });

  test("a stash", () => {
    const dir = clone();
    fs.writeFileSync(join(dir, "a.txt"), "stashed\n");
    git(dir, "stash", "-q");
    const losses = check(dir)!;
    assert.equal(losses.stashes, 1);
    assert.deepEqual(losses.changes, []);
  });

  test("a detached HEAD's commits that no branch has", () => {
    const dir = clone();
    git(dir, "checkout", "-q", "--detach");
    fs.writeFileSync(join(dir, "d.txt"), "d\n");
    git(dir, "add", "d.txt");
    git(dir, "commit", "-q", "-m", "detached");
    assert.equal(check(dir)!.detached, 1);
    // ...and one with nothing new is nothing.
    const clean = clone();
    git(clean, "checkout", "-q", "--detach");
    assert.ok(nothingLost(check(clean)!));
  });

  test("a worktree's branch is the repository's, so the root's check sees it", () => {
    const dir = clone();
    const wt = join(dir, ".worktrees", "wip");
    git(dir, "worktree", "add", "-q", "-b", "wip", wt);
    fs.writeFileSync(join(wt, "w.txt"), "w\n");
    git(wt, "add", "w.txt");
    git(wt, "commit", "-q", "-m", "in the worktree");
    const losses = check(dir)!;
    assert.deepEqual(losses.branches, [{ name: "wip", commits: 1 }]);
    // `.worktrees/` itself, untracked where the exclude was not written, is
    // not the root's to lose: each worktree is checked on its own.
    assert.deepEqual(losses.changes, []);
  });

  test("not a repository at all: never read as clean", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "desolate-losses-none-"));
    fs.writeFileSync(join(dir, "file"), "x\n");
    // GIT_CEILING_DIRECTORIES: tmpdir() must not sit inside some repository.
    const result = spawnSync("sh", ["-c", lossesScript, "desolate-losses", "30"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    assert.equal(parseLosses(result.stdout.trim()), null);
  });
});
