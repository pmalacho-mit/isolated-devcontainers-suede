/// <reference types="node" />
// `desolate --review` (review.ts): reviewScript (docker.ts) run as the sandbox
// runs it, against real repositories -- a branch GitHub does not have yet, and
// one it has that moved on both sides -- then read, kept and said. And what it
// refuses to read: lines that are not what they claim to be.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reviewScript } from "../../../release/vscode-image/docker.ts";
import {
  describeReview, keepReview, parseReview, REVIEW_LIMITS, REVIEWED, unquoteGitPath,
} from "../../../release/vscode-image/review.ts";
import { relayLines } from "../../../release/vscode-image/utils.ts";

const root = mkdtempSync(join(tmpdir(), "desolate-review-"));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "a@a", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "a@a" };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" }).trim();
const write = (dir: string, file: string, text: string | Buffer) => writeFileSync(join(dir, file), text);

/** The script's lines, as the sandbox would print them. */
const said = (dir: string, limits: Partial<Record<keyof typeof REVIEW_LIMITS, number>> = {}) => {
  const l = { ...REVIEW_LIMITS, ...limits };
  const result = spawnSync("sh", ["-c", reviewScript, "review", dir, String(l.blobBytes), String(l.totalBytes), String(l.files), String(l.commits)],
    { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n");
};

const origin = join(root, "origin.git");
const work = join(root, "work");
before(() => {
  git(root, "init", "--quiet", "--bare", origin);
  git(root, "init", "--quiet", work);
  write(work, "keep.txt", "one\ntwo\n");
  write(work, "gone.txt", "bye\n");
  write(work, "old-name.txt", "moving\ncontent here\nsame\n");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "base");
  git(work, "push", "--quiet", origin, "main");
  git(work, "fetch", "--quiet", origin, "+refs/heads/*:refs/remotes/origin/*");
  git(work, "checkout", "--quiet", "-b", "feature");
  write(work, "keep.txt", "one\ntwo changed\n");
  git(work, "rm", "--quiet", "gone.txt");
  git(work, "mv", "old-name.txt", "new-name.txt");
  write(work, "added.txt", "fresh\n");
  write(work, "blob.bin", Buffer.from([0x61, 0, 0x62, 0, 0x63]));
  write(work, "we\tird-ü.txt", "tab\n");
  write(work, "large.txt", "x".repeat(3000));
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "the feature");
  write(work, "added.txt", "fresh\nmore\n");
  git(work, "commit", "--quiet", "-am", "a second step");
  write(work, "keep.txt", "one\ntwo changed\ndirty\n");
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("a branch GitHub does not have yet", () => {
  test("is compared with where it started, and its commits and files are said", () => {
    const { review, ended } = parseReview(said(work, { blobBytes: 1024 }));
    assert.ok(ended);
    assert.equal(review.branch, "feature");
    assert.equal(review.base?.ref, "origin/main");
    assert.deepEqual([review.ahead, review.behind, review.uncommitted], [2, 0, 1]);
    assert.deepEqual(review.commits.map((c) => c.subject), ["a second step", "the feature"]);
    assert.equal(review.commits[0].author, "Ada");
    const byPath = new Map(review.files.map((f) => [f.path, f]));
    assert.equal(byPath.get("added.txt")?.status, "A");
    assert.deepEqual(byPath.get("added.txt")?.sides, { a: false, b: true });
    assert.equal(byPath.get("gone.txt")?.status, "D");
    assert.equal(byPath.get("keep.txt")?.status, "M");
    assert.equal(byPath.get("new-name.txt")?.from, "old-name.txt");
    assert.match(byPath.get("new-name.txt")!.status, /^R\d+$/);
    assert.equal(byPath.get("blob.bin")?.kind, "binary");
    assert.equal(byPath.get("large.txt")?.kind, "large", "over the per-file limit, it is listed and not sent");
    // git quoted it for the tab; it is read back, and shown as one line.
    assert.ok(byPath.has("we ird-ü.txt"), [...byPath.keys()].join(", "));
  });

  test("each text file's two sides are kept in the editor's cache, under names of its own", () => {
    const { review, blobs } = parseReview(said(work, { blobBytes: 1024 }));
    const dir = join(root, "kept");
    writeFileSync(join(root, "stale"), "");
    const kept = keepReview(review, blobs, dir);
    assert.equal(kept.dir, dir);
    const keep = kept.files.find((f) => f.path === "keep.txt")!;
    assert.equal(readFileSync(join(dir, `${keep.index}.a`), "utf8"), "one\ntwo\n");
    assert.equal(readFileSync(join(dir, `${keep.index}.b`), "utf8"), "one\ntwo changed\n", "what is committed, not the worktree's");
    const added = kept.files.find((f) => f.path === "added.txt")!;
    assert.ok(!existsSync(join(dir, `${added.index}.a`)), "an added file has no old side");
    const binary = kept.files.find((f) => f.path === "blob.bin")!;
    assert.ok(!existsSync(join(dir, `${binary.index}.b`)), "nothing of a binary is sent");
  });

  test("past the total, a file is listed and its content not kept", () => {
    const { review, blobs } = parseReview(said(work, { totalBytes: 40 }));
    const kinds = review.files.map((f) => f.kind);
    assert.ok(kinds.includes("large") && kinds.includes("text"), kinds.join(", "));
  });

  test("past the file limit, it says there are more", () => {
    const { review } = parseReview(said(work, { files: 2 }));
    assert.equal(review.files.length, 2);
    assert.equal(review.more, true);
  });

  test("said for a terminal", () => {
    const { review } = parseReview(said(work));
    const text = describeReview(review);
    assert.match(text, /^feature: 2 commits to push, against origin\/main, where it started \(GitHub has no feature yet\)/);
    assert.match(text, /R {2}old-name\.txt → new-name\.txt/);
    assert.match(text, /1 uncommitted change is in the worktree; a push does not send it\./);
  });
});

describe("a branch GitHub has", () => {
  test("is compared with origin/<branch>: ahead, and behind when it moved there too", () => {
    git(work, "push", "--quiet", origin, "feature");
    git(work, "fetch", "--quiet", origin, "+refs/heads/*:refs/remotes/origin/*");
    git(work, "commit", "--quiet", "-am", "local only");
    // Someone else's commit on GitHub's feature, fetched.
    const other = join(root, "other");
    git(root, "clone", "--quiet", "--branch", "feature", origin, other);
    write(other, "theirs.txt", "theirs\n");
    git(other, "add", ".");
    git(other, "commit", "--quiet", "-m", "theirs");
    git(other, "push", "--quiet", origin, "feature");
    git(work, "fetch", "--quiet", origin, "+refs/heads/*:refs/remotes/origin/*");
    const { review } = parseReview(said(work));
    assert.equal(review.base?.ref, "origin/feature");
    assert.deepEqual([review.ahead, review.behind], [1, 1]);
    assert.deepEqual(review.files.map((f) => f.path), ["keep.txt"], "what the branch adds since they met");
    assert.match(describeReview(review), /and 1 on origin\/feature it lacks: pull first/);
  });
});

describe("what it refuses to read", () => {
  test("lines that are not records, or not well-formed ones, are dropped", () => {
    const sha = "a".repeat(40), zero = "0".repeat(40);
    const { review, blobs, ended } = parseReview([
      `${REVIEWED}\tBRANCH\tmain\t${sha}`,
      "desolate: driving acme's daemon",
      `${REVIEWED}\tFILE\t1\tM\t100644\t100644\tnot-a-sha\t${sha}\t1\t1\ttext\tx.txt`,
      `${REVIEWED}\tFILE\t2\tM\t100644\t100644\t${zero}\t${sha}\t1\t1\tscript\tx.txt`,
      `${REVIEWED}\tFILE\t3\tA\t000000\t100644\t${zero}\t${sha}\t0\t4\ttext\tok.txt`,
      `${REVIEWED}\tBLOB\t3\tb\tnot base64!`,
      `${REVIEWED}\tBLOB\t3\tb\tdGFiCg==`,
      `${REVIEWED}\tCOMMIT\t${sha}\t17\tAda\tsubject\twith a tab\u0007bell`,
      `${REVIEWED}\tEND`,
    ]);
    assert.ok(ended);
    assert.deepEqual(review.files.map((f) => f.path), ["ok.txt"]);
    assert.deepEqual(blobs.get("3.b"), ["dGFiCg=="]);
    assert.equal(review.commits[0].subject, "subject with a tab bell", "control characters become spaces");
  });

  test("without its END, a review did not finish", () => {
    assert.equal(parseReview([`${REVIEWED}\tBRANCH\tmain\t${"a".repeat(40)}`]).ended, false);
  });

  test("git's quoting is read back, octal bytes and all", () => {
    assert.equal(unquoteGitPath('"\\303\\274.txt"'), "ü.txt");
    assert.equal(unquoteGitPath('"a\\tb\\"c\\\\d"'), 'a\tb"c\\d');
    assert.equal(unquoteGitPath("plain.txt"), "plain.txt");
  });
});

describe("the broker's relay", () => {
  test("whole lines only: a line or a character split between chunks arrives whole", () => {
    const got: string[] = [];
    const relay = relayLines((payload) => got.push(JSON.parse(payload).log));
    const bytes = Buffer.from("first line\nsecond ü line\nlast without newline", "utf8");
    const cut = bytes.indexOf(0xbc);   // inside ü's two bytes
    relay(bytes.subarray(0, 4));
    relay(bytes.subarray(4, cut));
    relay(bytes.subarray(cut));
    relay.flush();
    assert.deepEqual(got, ["first line", "second ü line", "last without newline"]);
  });
});
