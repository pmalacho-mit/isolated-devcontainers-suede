/// <reference types="node" />
// The factory's watcher: what it decides about a request, and what it does --
// run for one tick (`--once`) against a real repository, with the commands a
// person would type (`worktree`, `desolate`) replaced by a recorder that does
// what they would to the directory tree.
//
// Two attacks are run, not read: a request whose author does not match its
// claim, and a repository whose config tells `git push` to run a command.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { decide, isSafeRemote, pushArguments } from "../../../release/vscode-image/work-watcher.ts";
import { DEFAULT_POLICY, parsePolicy, PolicyFileError, type Policy } from "../../../release/vscode-image/work-policy.ts";
import { author, parseRequest, type Request } from "../../../release/vscode-image/work-protocol.ts";

const RELEASE = path.resolve(import.meta.dirname, "../../../release");
const HELPER = path.join(RELEASE, "proxy/container/desolate-work");
const WATCHER = path.join(RELEASE, "vscode-image/work-watcher.ts");

// ------------------------------------------------------------- deciding --

const request = (over: Partial<Request> = {}): Request => parseRequest(JSON.stringify({
  v: 1, from: "main", to: ["*"], type: "request", body: "open w", item: null, commit: null, reply_to: null,
  action: "open", worktree: "w", branch: "factory/w", from_ref: null, title: null, brief: null, ...over,
}));
const policy = (over: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, ...over });
const world = (worktrees: string[] = [], hooks = false) => ({ worktrees, hooks });
const by = (from: string) => author(from).name;

describe("what the watcher decides", () => {
  test("an open from a requester, under the cap, opens", () =>
    assert.deepEqual(decide(request(), by("main"), policy(), world(), false), { kind: "open" }));

  test("a request whose author is not who it claims to be is refused", () =>
    assert.equal(decide(request({ from: "forge/github" }), by("issue-7"), policy({ requesters: ["forge/github"] }), world(), false).kind, "refuse"));

  test("an open from outside the requesters is refused -- unless a human approved it", () => {
    assert.equal(decide(request({ from: "issue-7" }), by("issue-7"), policy(), world(), false).kind, "refuse");
    assert.equal(decide(request({ from: "issue-7" }), by("issue-7"), policy(), world(), true).kind, "open");
  });

  test("a branch outside the prefix, an existing worktree, and hooks the policy does not allow are refused", () => {
    assert.equal(decide(request({ branch: "main-ish" }), by("main"), policy(), world(), false).kind, "refuse");
    assert.equal(decide(request(), by("main"), policy(), world(["w"]), false).kind, "refuse");
    assert.equal(decide(request(), by("main"), policy(), world([], true), false).kind, "refuse");
    assert.equal(decide(request(), by("main"), policy({ allow_hooks: true }), world([], true), false).kind, "open");
    assert.equal(decide(request(), by("main"), policy(), world([], true), true).kind, "open", "a human may approve one");
  });

  test("at the cap, an open waits rather than being refused", () =>
    assert.equal(decide(request(), by("main"), policy({ max_open_worktrees: 2 }), world(["a", "b"]), false).kind, "wait"));

  test("the overseer may open worktrees, never close them", () => {
    const close = request({ action: "close", branch: null });
    assert.equal(decide(close, by("main"), policy(), world(["w"]), false).kind, "refuse");
    assert.equal(decide({ ...close, from: "forge/file" }, by("forge/file"), policy({ requesters: ["main", "forge/file"] }), world(["w"]), false).kind, "close");
    assert.equal(decide(close, by("main"), policy(), world(["w"]), true).kind, "close", "a human may approve it");
  });

  test("a push waits for a human unless the policy pushes on its own", () => {
    const pushRequest = request({ action: "push", branch: null });
    assert.equal(decide(pushRequest, by("main"), policy(), world(["w"]), false).kind, "refuse");
    assert.equal(decide(pushRequest, by("main"), policy({ on_done: "push" }), world(["w"]), false).kind, "push");
  });

  test("the push it makes is exact, unforced, and runs no hook", () => {
    const argv = pushArguments("git@github.com:acme/widgets.git", "factory/w");
    assert.equal(argv.at(-1), "refs/heads/factory/w:refs/heads/factory/w");
    assert.ok(argv.includes("--no-verify"));
    assert.ok(!argv.some((arg) => arg.startsWith("+") || arg === "--force" || arg === "-f"));
  });

  test("it pushes only to a plain ssh or https remote", () => {
    for (const url of ["git@github.com:acme/widgets.git", "git@github.com-acme__widgets:acme/widgets.git",
      "ssh://git@github.com/acme/widgets", "https://github.com/acme/widgets.git"])
      assert.ok(isSafeRemote(url), url);
    for (const url of ["/workspaces/acme/hooked.git", "file:///tmp/x", "ext::sh -c touch% /tmp/pwned", "-oProxyCommand=x",
      "git@github.com:../../etc", "https://github.com/a/b c", "fd::17"])
      assert.ok(!isSafeRemote(url), url);
  });
});

describe("what a policy may say", () => {
  test("the defaults hold pushes, allow no hooks, and let only main ask", () =>
    assert.deepEqual(parsePolicy("{}"), DEFAULT_POLICY));

  for (const [why, text] of [
    ["a key it does not know (a typo)", `{"on_dnoe":"push"}`],
    ["a cap of zero", `{"max_open_worktrees":0}`],
    ["a requester that is a path", `{"requesters":["../x"]}`],
    ["a prefix that is not segments", `{"branch_prefix":"a..b"}`],
    ["on_done that is neither", `{"on_done":"sometimes"}`],
    ["not JSON", `{`],
  ] as const)
    test(`refuses ${why}`, () => assert.throws(() => parsePolicy(text), PolicyFileError));
});

// --------------------------------------------------------------- one tick --

let tmp = "", workspaces = "", repo = "", remote = "", calls = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const work = (target: string, ...args: string[]) =>
  execFileSync("sh", [HELPER, ...args], { cwd: target === "main" ? repo : path.join(repo, ".worktrees", target), encoding: "utf8",
    env: { ...process.env, DESOLATE_TARGET: target } }).trim();
const writePolicy = (over: Record<string, unknown>) =>
  fs.writeFileSync(path.join(workspaces, ".desolate/factory/acme.json"), JSON.stringify(over));
const tick = () => execFileSync("node", [WATCHER, "--once"], {
  encoding: "utf8",
  env: {
    ...process.env, DESOLATE_WORKSPACES: workspaces, PATH: `${path.join(tmp, "bin")}:${process.env.PATH}`,
    DESOLATE_WORK_WORKTREE_CMD: path.join(tmp, "bin/worktree"), DESOLATE_WORK_DESOLATE_CMD: path.join(tmp, "bin/desolate"),
  },
});
const recorded = () => fs.readFileSync(calls, "utf8").split("\n").filter(Boolean);
const states = () => {
  try {
    return git(repo, "log", "--format=%s", "refs/desolate/desolate/outbox").split("\n").reverse();
  } catch {
    return [];
  }
};

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-"));
  workspaces = path.join(tmp, "workspaces");
  repo = path.join(workspaces, "acme");
  remote = path.join(tmp, "remote.git");
  calls = path.join(tmp, "calls");
  fs.mkdirSync(path.join(workspaces, ".desolate/factory"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  // A plain ssh remote, as the watcher insists -- served by an `ssh` on PATH
  // that runs the remote command here, which is all this test needs of ssh.
  git(repo, "remote", "add", "origin", `git@localhost:${remote}`);
  // The recorders: `worktree add` makes the worktree as worktrees.ts would
  // (real git, so it has a branch); `remove` removes it; `desolate` succeeds.
  fs.mkdirSync(path.join(tmp, "bin"));
  fs.writeFileSync(path.join(tmp, "bin/worktree"), `#!/bin/sh
echo "worktree $*" >> ${calls}
case "$1" in
  add) if [ -n "$5" ]; then git -C ${repo} worktree add -q -b "$4" ${repo}/.worktrees/"$3" "$5"; else git -C ${repo} worktree add -q -b "$4" ${repo}/.worktrees/"$3"; fi ;;
  remove) git -C ${repo} worktree remove --force ${repo}/.worktrees/"$3" ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, "bin/desolate"), `#!/bin/sh\necho "desolate $*" >> ${calls}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, "bin/ssh"), `#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n`, { mode: 0o755 });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => fs.writeFileSync(calls, ""));

describe("one tick of the watcher, on a real repository", () => {
  test("a project without a policy file has no factory: nothing happens", () => {
    work("main", "request", "open", "early", "--branch", "factory/early");
    tick();
    assert.deepEqual(recorded(), []);
    assert.deepEqual(states(), []);
  });

  test("with one, an open request is a worktree add and a start, answered on desolate's outbox", () => {
    writePolicy({ max_open_worktrees: 2 });
    tick();
    assert.deepEqual(recorded(), ["worktree add acme early factory/early", "desolate acme --worktree early"]);
    assert.match(states().at(-1)!, /^state: opened early on factory\/early$/);
  });

  test("a request is handled once", () => {
    tick();
    assert.deepEqual(recorded(), []);
  });

  test("a malformed request is refused, and the loop goes on to the next", () => {
    // Written by hand, as a hostile writer would: not JSON at all.
    const blob = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: "{not json", encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", repo, "mktree"], { input: `100644 blob ${blob}\tmessage.json\n`, encoding: "utf8" }).trim();
    const commit = execFileSync("git", ["-C", repo, "-c", "user.name=x", "-c", "user.email=x@x", "commit-tree", tree, "-m", "junk"], { encoding: "utf8" }).trim();
    git(repo, "update-ref", "refs/desolate/requests/00000000000000000000000000", commit);
    work("main", "request", "open", "second", "--branch", "factory/second");
    tick();
    assert.ok(states().some((s) => /cannot be read: not JSON/.test(s)), states().join("\n"));
    assert.deepEqual(recorded(), ["worktree add acme second factory/second", "desolate acme --worktree second"]);
  });

  test("a forged request -- its author not who it claims -- is refused", () => {
    execFileSync("sh", [HELPER, "request", "open", "forged", "--branch", "factory/forged"], {
      cwd: repo, env: { ...process.env, DESOLATE_TARGET: "main", GIT_AUTHOR_NAME: "x" },
    });
    // The helper sets its own author, so forge it the other way: rewrite the claim.
    const ref = git(repo, "for-each-ref", "--sort=-refname", "--format=%(refname)", "refs/desolate/requests/").split("\n")[0];
    const json = git(repo, "cat-file", "-p", `${ref}:message.json`).replace('"from":"main"', '"from":"forge/github"');
    const blob = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: json, encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", repo, "mktree"], { input: `100644 blob ${blob}\tmessage.json\n`, encoding: "utf8" }).trim();
    const commit = execFileSync("git", ["-C", repo, "commit-tree", tree, "-m", "request: open forged"],
      { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: by("main"), GIT_AUTHOR_EMAIL: "main@desolate.invalid",
        GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).trim();
    git(repo, "update-ref", ref, commit);
    writePolicy({ max_open_worktrees: 4, requesters: ["main", "forge/github"] });
    tick();
    assert.ok(states().some((s) => /claims to be from 'forge\/github'/.test(s)), states().join("\n"));
    assert.ok(!recorded().some((c) => c.includes("forged")));
  });

  test("at the cap, an open waits -- said once -- and opens when a worktree closes", () => {
    writePolicy({ max_open_worktrees: 2, requesters: ["main", "forge/file"] });
    work("main", "request", "open", "third", "--branch", "factory/third");
    tick();
    tick();
    assert.equal(states().filter((s) => /^state: waiting/.test(s)).length, 1, states().join("\n"));
    assert.ok(!recorded().some((c) => c.includes("third")));
    // The forge closes one (a close from main would be refused: overseers do not close).
    execFileSync("sh", [HELPER, "request", "close", "early"], { cwd: repo, env: { ...process.env, DESOLATE_TARGET: "main" } });
    tick();
    assert.ok(states().some((s) => /only a forge adapter/.test(s)), "main's close must be refused");
    fs.writeFileSync(calls, "");
    // Now as the forge would: a writer named forge/file.
    const forge = (args: string[]) => {
      const json = JSON.stringify({ v: 1, from: "forge/file", to: ["*"], type: "request", body: "close early", item: null,
        commit: null, reply_to: null, action: "close", worktree: "early", branch: null, from_ref: null, title: null, brief: null });
      const blob = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: json, encoding: "utf8" }).trim();
      const tree = execFileSync("git", ["-C", repo, "mktree"], { input: `100644 blob ${blob}\tmessage.json\n`, encoding: "utf8" }).trim();
      const commit = execFileSync("git", ["-C", repo, "commit-tree", tree, "-m", "request: close early"],
        { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: by("forge/file"), GIT_AUTHOR_EMAIL: "forge/file@desolate.invalid",
          GIT_COMMITTER_NAME: by("forge/file"), GIT_COMMITTER_EMAIL: "forge/file@desolate.invalid" } }).trim();
      git(repo, "update-ref", `refs/desolate/requests/${args[0]}`, commit);
    };
    forge(["7ZZZZZZZZZZZZZZZZZZZZZZZZZ"]);
    tick();
    assert.deepEqual(recorded().slice(0, 3), [
      "desolate --stop --worktree early acme",
      "desolate --purge --worktree early acme",
      "worktree remove acme early --checked-clean",
    ]);
    tick();
    assert.ok(recorded().includes("worktree add acme third factory/third"), recorded().join("\n"));
  });
});

describe("pushing, on a policy that pushes", () => {
  test("an agent's done pushes its branch -- and a hostile receivepack runs nothing", () => {
    const marker = path.join(tmp, "receivepack-ran");
    git(repo, "config", "remote.origin.receivepack", `touch ${marker}; git-receive-pack`);
    writePolicy({ max_open_worktrees: 4, requesters: ["main", "forge/file"], on_done: "push" });
    const wt = path.join(repo, ".worktrees", "second");
    execFileSync("git", ["-C", wt, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "--allow-empty", "-m", "work"]);
    work("second", "done", "ready");
    tick();
    assert.equal(git(remote, "rev-parse", "refs/heads/factory/second"), git(wt, "rev-parse", "HEAD"));
    assert.ok(!fs.existsSync(marker), "the repository's receivepack ran");
    assert.ok(states().some((s) => /^state: pushed factory\/second/.test(s)), states().join("\n"));
    tick();
    assert.equal(states().filter((s) => /pushed factory\/second/.test(s)).length, 1, "a done is pushed once");
  });
});
