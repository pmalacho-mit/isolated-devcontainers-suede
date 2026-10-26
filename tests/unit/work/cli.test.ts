/// <reference types="node" />
// `work`: the human's side of a factory, run against a real repository.
// `verify` is the one that matters most and is run against forgeries: a
// message rewritten in place, and one appended under someone else's name.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RELEASE = path.resolve(import.meta.dirname, "../../../release");
const HELPER = path.join(RELEASE, "proxy/container/desolate-work");
const WORK = path.join(RELEASE, "vscode-image/work.ts");

let tmp = "", workspaces = "", repo = "";
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const work = (...args: string[]) => {
  const run = spawnSync("node", [WORK, ...args], {
    encoding: "utf8",
    env: { ...process.env, DESOLATE_WORKSPACES: workspaces, PATH: `${path.join(tmp, "bin")}:${process.env.PATH}`,
      DESOLATE_WORK_WORKTREE_CMD: path.join(tmp, "bin/worktree"), DESOLATE_WORK_DESOLATE_CMD: path.join(tmp, "bin/desolate") },
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
};
const agent = (target: string, ...args: string[]) =>
  execFileSync("sh", [HELPER, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, DESOLATE_TARGET: target } }).trim();

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "work-cli-"));
  workspaces = path.join(tmp, "workspaces");
  repo = path.join(workspaces, "acme");
  fs.mkdirSync(workspaces, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const remote = path.join(tmp, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git("remote", "add", "origin", `git@localhost:${remote}`);
  fs.mkdirSync(path.join(tmp, "bin"));
  fs.writeFileSync(path.join(tmp, "bin/ssh"), `#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, "bin/desolate"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, "bin/worktree"),
    `#!/bin/sh\n[ "$1" = remove ] && git -C ${repo} worktree remove --force ${repo}/.worktrees/"$3"\nexit 0\n`, { mode: 0o755 });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("enabling a factory is a human act, outside the repository", () => {
  test("init writes the policy under /workspaces/.desolate and says so on the human's outbox", () => {
    const { status, out } = work("init", "acme", "--max", "3", "--prefix", "issue/");
    assert.equal(status, 0, out);
    const policy = JSON.parse(fs.readFileSync(path.join(workspaces, ".desolate/factory/acme.json"), "utf8"));
    assert.equal(policy.max_open_worktrees, 3);
    assert.equal(policy.branch_prefix, "issue/");
    assert.equal(policy.on_done, "hold", "pushes are held unless a human says otherwise");
    assert.match(git("log", "-1", "--format=%an %s", "refs/desolate/agents/@human/outbox"), /^desolate\/@human status: factory enabled/);
  });

  test("a second init is refused without --force, and a bad value always", () => {
    assert.equal(work("init", "acme").status, 2);
    assert.equal(work("init", "acme", "--force", "--on-done", "sometimes").status, 1);
    assert.equal(work("init", "../etc").status, 2);
  });

  test("policy shows it with the live count", () => {
    const { out } = work("policy", "acme");
    assert.match(out, /open worktrees: 0 of 3/);
  });
});

describe("verify: every ref an append by its named writer", () => {
  test("a conversation the protocol wrote passes", () => {
    agent("main", "say", "status", "starting");
    agent("main", "ask", "issue-1", "ready?");
    agent("main", "request", "open", "issue-1", "--branch", "issue/1");
    const { status, out } = work("verify", "acme");
    assert.equal(status, 0, out);
    assert.match(out, /every one an append by its writer/);
  });

  test("a message rewritten in place fails it -- the reflog saw the move", () => {
    const ref = "refs/desolate/agents/main/outbox";
    const head = git("rev-parse", ref);
    const parent = git("rev-parse", `${head}^`);
    const blob = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], {
      input: JSON.stringify({ v: 1, from: "main", to: ["*"], type: "ask", body: "something I never asked", item: null, commit: null, reply_to: null }),
      encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", repo, "mktree"], { input: `100644 blob ${blob}\tmessage.json\n`, encoding: "utf8" }).trim();
    const forged = execFileSync("git", ["-C", repo, "commit-tree", tree, "-p", parent, "-m", "ask: something I never asked"], {
      encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "desolate/main", GIT_AUTHOR_EMAIL: "main@desolate.invalid",
        GIT_COMMITTER_NAME: "desolate/main", GIT_COMMITTER_EMAIL: "main@desolate.invalid" } }).trim();
    git("update-ref", ref, forged, head);
    const { status, out } = work("verify", "acme");
    assert.equal(status, 1, out);
    assert.match(out, /not an append/);
    git("update-ref", ref, head, forged);   // put it back for the next test
  });

  test("a message appended under someone else's name fails it", () => {
    const ref = "refs/desolate/agents/issue-1/outbox";
    const blob = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], {
      input: JSON.stringify({ v: 1, from: "issue-1", to: ["*"], type: "done", body: "x", item: null, commit: null, reply_to: null }),
      encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", repo, "mktree"], { input: `100644 blob ${blob}\tmessage.json\n`, encoding: "utf8" }).trim();
    const commit = execFileSync("git", ["-C", repo, "commit-tree", tree, "-m", "done: x"], {
      encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "desolate/main", GIT_AUTHOR_EMAIL: "main@desolate.invalid",
        GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).trim();
    git("update-ref", ref, commit);
    const { status, out } = work("verify", "acme");
    assert.equal(status, 1);
    assert.match(out, /authored as 'desolate\/main', not desolate\/issue-1/);
    git("update-ref", "-d", ref);
  });
});

describe("the rest of the verbs", () => {
  test("requests lists each request and its outcome; approve records a human's yes", () => {
    const { out } = work("requests", "acme");
    const id = /^([0-9A-Z]{26})  open issue-1 \(issue\/1\) from main  -- pending$/m.exec(out)?.[1];
    assert.ok(id, out);
    assert.equal(work("approve", "acme", id!).status, 0);
    assert.match(work("requests", "acme").out, /-- pending \(approved\)/);
    assert.equal(work("approve", "acme", "01ARZ3NDEKTSV4RRFFQ69G5FAV").status, 2, "an id that is no request");
    assert.match(fs.readFileSync(path.join(workspaces, ".desolate/factory/acme.approved"), "utf8"), new RegExp(id!));
  });

  test("log filters by writer and type", () => {
    const asks = work("log", "acme", "--type", "ask").out.trim().split("\n");
    assert.equal(asks.length, 1);
    assert.match(asks[0], /main\s+ask: ready\?/);
    assert.ok(work("log", "acme", "--target", "@human").out.split("\n").every((line) => !line || / @human /.test(line)));
  });

  test("say writes as @human, to whom it names", () => {
    work("say", "acme", "answer", "go ahead", "--to", "issue-1");
    const message = JSON.parse(git("cat-file", "-p", "refs/desolate/agents/@human/outbox:message.json"));
    assert.deepEqual([message.from, message.type, message.to], ["@human", "answer", ["issue-1"]]);
    assert.equal(work("say", "acme", "gossip", "x").status, 2);
  });

  test("push pushes a worktree's branch on hold, because a human asked -- and close closes it", () => {
    const wt = path.join(repo, ".worktrees", "issue-1");
    git("worktree", "add", "-q", "-b", "issue/1", wt);
    execFileSync("git", ["-C", wt, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "--allow-empty", "-m", "work"]);
    const pushed = work("push", "acme", "issue-1");
    assert.equal(pushed.status, 0, pushed.out);
    assert.equal(execFileSync("git", ["-C", path.join(tmp, "remote.git"), "rev-parse", "refs/heads/issue/1"], { encoding: "utf8" }).trim(),
      execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    const closed = work("close", "acme", "issue-1");
    assert.equal(closed.status, 0, closed.out);
    assert.ok(!fs.existsSync(wt));
    // What the human did verifies; the only problems left are the rewrite the
    // test above made and undid -- which the reflog keeps, as it should.
    const problems = work("verify", "acme").out.split("\n").filter((line) => line.startsWith("  refs/"));
    assert.ok(problems.length > 0 && problems.every((line) => line.startsWith("  refs/desolate/agents/main/outbox:")), problems.join("\n"));
  });
});
