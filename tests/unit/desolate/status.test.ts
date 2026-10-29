/// <reference types="node" />
// A target's status through `.git`: what /desolate/status writes,
// where, and what the editor's reader (status.ts) makes of it -- including
// what a project could put there to make the editor misbehave.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { target } from "../../../release/vscode-image/projects.ts";
import { STATUS_FILE, gitDirectoryOf, parseStatus, readStatus } from "../../../release/vscode-image/status.ts";

const HELPER = fileURLToPath(new URL("../../../release/proxy/container/desolate-status", import.meta.url));

const repository = () => {
  const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-status-"));
  const dir = path.join(workspaces, "acme", "widgets");
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", "-b", "wip", ".worktrees/wip");
  return { workspaces, dir, git };
};
const helper = (cwd: string, ...args: string[]) =>
  execFileSync("sh", [HELPER, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("desolate-status writes it; the editor reads it", () => {
  test("for the project's own tree, in .git", () => {
    const box = repository();
    helper(box.dir, "set", "orange", "needs a human: which API version?");
    assert.ok(fs.existsSync(path.join(box.dir, ".git", STATUS_FILE)));
    const status = readStatus(target(box.workspaces, "acme/widgets"));
    assert.equal(status?.color, "orange");
    assert.equal(status?.message, "needs a human: which API version?");
    assert.match(status!.updated, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  test("for a worktree, in its own admin directory -- not its project's", () => {
    const box = repository();
    helper(path.join(box.dir, ".worktrees", "wip"), "set", "green", "ready for a PR");
    assert.equal(readStatus(target(box.workspaces, "acme/widgets", "wip"))?.color, "green");
    assert.equal(readStatus(target(box.workspaces, "acme/widgets")), undefined, "the main tree says nothing");
    assert.equal(gitDirectoryOf(target(box.workspaces, "acme/widgets", "wip")), ".git/worktrees/wip");
  });

  test("never in the repository's content", () => {
    const box = repository();
    const before = box.git("status", "--porcelain");
    helper(box.dir, "set", "blue", "working");
    assert.equal(box.git("status", "--porcelain"), before);
  });

  test("a message with quotes, backslashes and newlines survives as one line", () => {
    const box = repository();
    helper(box.dir, "set", "red", 'auth "failed"\\ at\nline two');
    assert.equal(readStatus(target(box.workspaces, "acme/widgets"))?.message, 'auth "failed"\\ at line two');
  });

  test("clear removes it; a colour it does not know is refused", () => {
    const box = repository();
    helper(box.dir, "set", "green", "done");
    helper(box.dir, "clear");
    assert.equal(readStatus(target(box.workspaces, "acme/widgets")), undefined);
    assert.throws(() => helper(box.dir, "set", "purple", "x"), /not a colour/);
  });
});

describe("the reader holds what a project wrote to its shape", () => {
  test("an unknown colour is gray, the message one printable line, at most 200", () => {
    const status = parseStatus(JSON.stringify({ color: "#ff0000", message: `a\u001b[31m\u2028b ${"x".repeat(300)}` }));
    assert.equal(status?.color, "gray");
    assert.ok(!/[\u0000-\u001f\u2028]/.test(status!.message));
    assert.equal(status!.message.length, 200);
  });

  test("what is not a status object says nothing", () => {
    for (const text of ["not json", "[]", "null", '"x"']) assert.equal(parseStatus(text), undefined, text);
  });

  test("a status file that is a link into another project is not read", () => {
    const box = repository();
    const victim = path.join(box.workspaces, "victim");
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, "secret.json"), JSON.stringify({ color: "red", message: "victim private" }));
    fs.symlinkSync(path.join(victim, "secret.json"), path.join(box.dir, ".git", STATUS_FILE));
    assert.equal(readStatus(target(box.workspaces, "acme/widgets")), undefined);
  });

  test("nor a .git that is a link, nor a worktree whose .git names another project", () => {
    const box = repository();
    const victim = path.join(box.workspaces, "victim", ".git");
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, STATUS_FILE), JSON.stringify({ color: "red", message: "victim private" }));
    fs.writeFileSync(path.join(box.dir, ".worktrees", "wip", ".git"), `gitdir: ${victim}\n`);
    assert.equal(readStatus(target(box.workspaces, "acme/widgets", "wip")), undefined);
    fs.renameSync(path.join(box.dir, ".git"), path.join(box.dir, ".git-real"));
    fs.symlinkSync(victim, path.join(box.dir, ".git"));
    assert.equal(readStatus(target(box.workspaces, "acme/widgets")), undefined);
  });

  test("a FIFO -- as the status, or as a worktree's .git -- does not hang it", () => {
    const box = repository();
    execFileSync("mkfifo", [path.join(box.dir, ".git", STATUS_FILE)]);
    assert.equal(readStatus(target(box.workspaces, "acme/widgets")), undefined);
    fs.rmSync(path.join(box.dir, ".worktrees", "wip", ".git"));
    execFileSync("mkfifo", [path.join(box.dir, ".worktrees", "wip", ".git")]);
    assert.equal(readStatus(target(box.workspaces, "acme/widgets", "wip")), undefined);
  });

  test("a huge file is read only as far as 4 KiB", () => {
    const box = repository();
    fs.writeFileSync(path.join(box.dir, ".git", STATUS_FILE), `{"color":"red","message":"${"x".repeat(100_000)}"}`);
    assert.equal(readStatus(target(box.workspaces, "acme/widgets")), undefined, "cut short, it is not JSON");
  });
});

describe("notes, and the board every agent in a project reads", () => {
  const notes = (cwd: string, text: string) =>
    execFileSync("sh", [HELPER, "note"], { cwd, input: text, encoding: "utf8" });

  test("each target's note beside its status; the board shows them all, and which is yours", () => {
    const box = repository();
    const wip = path.join(box.dir, ".worktrees", "wip");
    helper(box.dir, "set", "blue", "integrating the widget PRs");
    notes(box.dir, "I am carrying issue-12's change to lib.ts.\nissue-14: yours conflicts with it -- see my branch.\n");
    helper(wip, "set", "gray", "withdrawn: carried by main");
    helper(wip, "note", "Agreed; my change is in main's branch now.");
    const board = helper(wip, "board");
    assert.match(board, /^== main \[blue\] integrating the widget PRs  \(.+Z\)$/m);
    assert.match(board, /I am carrying issue-12's change to lib.ts\.\nissue-14: yours conflicts/);
    assert.match(board, /^== wip \[gray\] withdrawn: carried by main  \(.+\)  \(you\)$/m);
    assert.match(board, /Agreed; my change is in main's branch now\./);
    assert.ok(!/\(you\)/.test(board.split("== wip")[0]), "main is not marked as the reader's");
  });

  test("a note is in the git dir, not the repository, and is capped", () => {
    const box = repository();
    const before = box.git("status", "--porcelain");
    notes(box.dir, "x".repeat(20000));
    assert.equal(box.git("status", "--porcelain"), before);
    assert.equal(fs.statSync(path.join(box.dir, ".git", "desolate-note.md")).size, 16384);
    helper(box.dir, "note", "--clear");
    assert.ok(!fs.existsSync(path.join(box.dir, ".git", "desolate-note.md")));
  });

  test("a target with nothing said is on the board too", () => {
    const box = repository();
    assert.match(helper(box.dir, "board"), /^== main \(no status\)  \(you\)$/m);
    assert.match(helper(box.dir, "board"), /^== wip \(no status\)$/m);
  });
});
