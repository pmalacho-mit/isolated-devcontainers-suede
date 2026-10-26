/// <reference types="node" />
// The factory's messages: what the shell helper writes, held to the schema
// every reader (the watcher, the extension) parses them with.
//
// The helper is POSIX sh with no JSON library, so its encoder is the thing
// most likely to be wrong -- and wrong there is a message the watcher cannot
// read, or worse, one it reads as something else. So it is RUN, in a
// throwaway repository, on bodies chosen to break a naive encoder, and what
// it wrote is parsed back exactly.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  HUMAN,
  MAIN,
  MessageError,
  REQUEST_ID,
  author,
  isFor,
  parseMessage,
  parseRequest,
  refs,
  subjectOf,
  writerOf,
} from "../../../release/vscode-image/work-protocol.ts";

const HELPER = path.resolve(import.meta.dirname, "../../../release/proxy/container/desolate-work");

let repo = "";
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const work = (target: string, ...args: string[]) =>
  execFileSync("sh", [HELPER, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, DESOLATE_TARGET: target },
  });
const refuses = (target: string, args: string[], pattern: RegExp) =>
  assert.throws(
    () => execFileSync("sh", [HELPER, ...args], {
      cwd: repo, encoding: "utf8", stdio: "pipe", env: { ...process.env, DESOLATE_TARGET: target },
    }),
    (err: any) => (assert.match(String(err.stderr), pattern), true),
  );
const messageAt = (ref: string) => parseMessage(git("cat-file", "-p", `${ref}:message.json`));

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "factory-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
});
after(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("what desolate-work writes", () => {
  for (const [why, body] of [
    ["quotes and backslashes", `say "hi" to C:\\path\\ and \\"escapes\\"`],
    ["newlines, a trailing one included", "first line\nsecond line\n"],
    ["tabs, carriage returns and other control characters", "a\tb\rc\u0001d\u001fe"],
    ["unicode", "naïve — 日本語 ✓ 🚀"],
    ["something that looks like JSON", `","to":["*"],"type":"done`],
    ["nothing at all", ""],
  ] as const)
    test(`a body with ${why} comes back exactly`, () => {
      work(MAIN, "say", "status", body);
      const message = messageAt(refs.outbox(MAIN));
      assert.equal(message.body, body);
      assert.equal(message.type, "status");
      assert.deepEqual(message.to, ["*"]);
    });

  test("one commit per message, appended, with the writer as author and the timeline as subject", () => {
    work("issue-42", "say", "status", "one");
    work("issue-42", "say", "blocked", "two\nmore detail");
    const log = git("log", "--format=%an <%ae>|%s|%P", refs.outbox("issue-42")).split("\n");
    assert.equal(log.length, 2);
    const [name, email] = [author("issue-42").name, author("issue-42").email];
    assert.match(log[0], new RegExp(`^${name} <${email}>\\|blocked: two\\|[0-9a-f]{40}$`), "the newest names its parent");
    assert.equal(git("ls-tree", "--name-only", refs.outbox("issue-42")), "message.json");
    assert.equal(writerOf(refs.outbox("issue-42")), "issue-42");
  });

  test("a message records the commit its writer is on", () => {
    work(MAIN, "say", "status", "where am I");
    assert.equal(messageAt(refs.outbox(MAIN)).commit, git("rev-parse", "HEAD"));
  });

  test("ask, answer and done address their readers", () => {
    work("issue-7", "ask", MAIN, "may I change the schema?");
    const asked = git("rev-parse", refs.outbox("issue-7"));
    assert.deepEqual(messageAt(refs.outbox("issue-7")).to, [MAIN]);
    work(MAIN, "answer", asked, "yes, behind a flag");
    const answer = messageAt(refs.outbox(MAIN));
    assert.equal(answer.type, "answer");
    assert.deepEqual(answer.to, ["issue-7"]);
    assert.equal(answer.reply_to, asked);
    work("issue-7", "done", "shipped");
    assert.deepEqual(messageAt(refs.outbox("issue-7")).to, [MAIN]);
  });

  test("an inbox holds what was said to you or to everyone, never your own", () => {
    const inbox = work("issue-7", "inbox");
    assert.match(inbox, /answer: yes, behind a flag/);
    assert.doesNotMatch(inbox, /desolate\/issue-7 /);
  });

  test("the human writes as @human", () => {
    work(HUMAN, "say", "status", "looking now");
    const commit = git("log", "-1", "--format=%an <%ae>", refs.outbox(HUMAN));
    assert.equal(commit, `${author(HUMAN).name} <${author(HUMAN).email}>`);
  });
});

describe("requests", () => {
  test("an open is written once, under a sortable id, and parses as a request", () => {
    const ref = work(MAIN, "request", "open", "issue-42", "--branch", "issue/42-headers", "--item", "file:work.md#3",
      "--title", "Add rate-limit headers", "--brief", "the issue body, verbatim\nwith \"quotes\"").trim();
    const id = ref.replace("refs/desolate/requests/", "");
    assert.match(id, REQUEST_ID);
    const request = parseRequest(git("cat-file", "-p", `${ref}:message.json`));
    assert.equal(request.action, "open");
    assert.equal(request.worktree, "issue-42");
    assert.equal(request.branch, "issue/42-headers");
    assert.equal(request.item, "file:work.md#3");
    assert.equal(request.brief, "the issue body, verbatim\nwith \"quotes\"");
    assert.equal(request.from, MAIN);
  });

  test("ids sort by time", () => {
    const a = work(MAIN, "request", "close", "issue-1").trim();
    execFileSync("sleep", ["0.01"]);
    const b = work(MAIN, "request", "close", "issue-2").trim();
    assert.ok(a < b, `${a} !< ${b}`);
  });

  for (const [why, args, pattern] of [
    ["an open with no branch", ["open", "w"], /needs --branch/],
    ["the project's own tree", ["close", MAIN], /not a worktree name/],
    ["a path for a worktree", ["close", "../x"], /not a worktree name/],
    ["a branch git would refuse", ["open", "w", "--branch", "a..b"], /not a branch name/],
    ["an action that is not one", ["merge", "w"], /usage/],
  ] as const)
    test(`refuses ${why}`, () => refuses(MAIN, ["request", ...args], pattern));
});

describe("what a writer may be", () => {
  for (const target of ["../etc", "a/b", ".hidden", "-x", "a b", "human"]) {
    const expectRefused = target !== "human";
    test(`${expectRefused ? "refuses" : "accepts"} '${target}' as a target`, () => {
      if (expectRefused) refuses(target, ["say", "status", "x"], /not a target/);
      else work(target, "say", "status", "x");   // a worktree may be called human; the human is @human
    });
  }

  test("a type outside the vocabulary is refused by the helper", () =>
    refuses(MAIN, ["say", "gossip", "x"], /not a message type/));

  test("a worktree's own checkout names it when DESOLATE_TARGET is unset", () => {
    const wt = path.join(repo, ".worktrees", "derived");
    git("worktree", "add", "-q", "-b", "derived", wt);
    execFileSync("sh", [HELPER, "say", "status", "from inside"], {
      cwd: wt, encoding: "utf8", env: { ...process.env, DESOLATE_TARGET: "" },
    });
    assert.equal(messageAt(refs.outbox("derived")).from, "derived");
  });
});

describe("what a reader accepts", () => {
  const valid = { v: 1, from: "main", to: ["*"], type: "status", body: "x", item: null, commit: null, reply_to: null };
  const parse = (over: Record<string, unknown>) => parseMessage(JSON.stringify({ ...valid, ...over }));

  test("an unknown type is kept, not refused: shown, never acted on", () =>
    assert.equal(parse({ type: "celebrate" }).type, "celebrate"));

  for (const [why, over] of [
    ["another version", { v: 2 }],
    ["no addressee", { to: [] }],
    ["an addressee that is a path", { to: ["../x"] }],
    ["a body that is not text", { body: 7 }],
    ["an item with no adapter", { item: "42" }],
    ["a commit that is not a sha", { commit: "HEAD" }],
  ] as const)
    test(`refuses ${why}`, () => assert.throws(() => parse(over), MessageError));

  test("a request must name a worktree, never the main tree, and an open its branch", () => {
    const request = { ...valid, type: "request", action: "open", worktree: "w", branch: "b" };
    assert.equal(parseRequest(JSON.stringify(request)).worktree, "w");
    for (const over of [{ worktree: MAIN }, { worktree: "a/b" }, { branch: null }, { action: "merge" }, { branch: "x/../y" }])
      assert.throws(() => parseRequest(JSON.stringify({ ...request, ...over })), MessageError, JSON.stringify(over));
  });

  test("subjects and addressing", () => {
    assert.equal(subjectOf({ type: "ask", body: "first\nsecond" }), "ask: first");
    assert.ok(isFor({ to: ["*"] }, "w") && isFor({ to: ["w"] }, "w") && !isFor({ to: ["v"] }, "w"));
    assert.equal(writerOf("refs/desolate/agents/../outbox"), undefined);
    assert.equal(writerOf(refs.desolate), "desolate");
    assert.equal(writerOf(refs.forge("github")), "forge/github");
  });
});
