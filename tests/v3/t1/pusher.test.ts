// T1. The pusher's half of git's push protocol (root/pusher.ts), against a real
// `git receive-pack` on a local repository: no VM, no ssh, the same code. It parses nothing
// the root's user sends: the forge's ref list and report are all it reads, and the one ref
// update it asks for is the approval's.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { advertised, pkt, reported, Uncertain, updateRef } from "../../../release/root/pusher.ts";

const ZERO = "0".repeat(40);
let dir = "";
let remote = "";
let work = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const commit = (message: string) => {
  fs.writeFileSync(path.join(work, "file.txt"), `${message}\n`);
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", message);
  return git(work, "rev-parse", "HEAD");
};
const pack = (tip: string, ...have: string[]) => execFileSync("git", ["pack-objects", "--stdout", "--revs", "--delta-base-offset", "--quiet"], { cwd: work, input: [tip, ...have.map((h) => `^${h}`), ""].join("\n") });
const tipOf = (branch: string) => {
  try {
    return git(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    return ZERO;
  }
};

/** One push, as the pusher makes it, to the local remote. `after`: what goes wrong once the
 *  pack is on the wire. */
const push = async (branch: string, onto: string | null, target: string, bytes: Buffer, after?: () => Promise<void>) => {
  const forge = spawn("git", ["receive-pack", remote], { stdio: ["pipe", "pipe", "pipe"] });
  forge.stdin.on("error", () => {});
  const closed = new Promise((resolve) => forge.on("close", resolve));
  try {
    return await updateRef(forge, branch, onto, target, async (sink: Writable) => {
      sink.write(bytes);
      if (after) await after();
    });
  } finally {
    forge.stdin.end();
    await closed;
  }
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-pusher-"));
  remote = path.join(dir, "remote.git");
  work = path.join(dir, "work");
  git(dir, "init", "--bare", "--quiet", remote);
  git(dir, "init", "--quiet", "-b", "main", work);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("T1 the pusher speaks receive-pack, and asks for one ref update", () => {
  it("pkt-lines and the forge's two kinds of answer are read strictly", () => {
    assert.equal(pkt("abc\n").toString(), "0008abc\n");
    const list = [`${"1".repeat(40)} refs/heads/main\0report-status delete-refs\n`, `${"2".repeat(40)} refs/heads/x\n`];
    assert.equal(advertised(list, "main"), "1".repeat(40));
    assert.equal(advertised(list, "x"), "2".repeat(40));
    assert.equal(advertised(list, "y"), ZERO);
    assert.equal(advertised([`${ZERO} capabilities^{}\0report-status\n`], "main"), ZERO, "an empty repository's list");
    assert.throws(() => advertised(["not a ref line\n"], "main"));
    assert.throws(() => advertised([`${"1".repeat(40)} refs/heads/main extra\n`], "main"));
    assert.deepEqual(reported(["unpack ok\n", "ok refs/heads/main\n"], "refs/heads/main"), { ok: true });
    assert.equal(reported(["unpack ok\n", "ok refs/heads/other\n"], "refs/heads/main").ok, false, "an ok for another ref is not this one's");
    assert.equal(reported(["ok refs/heads/main\n"], "refs/heads/main").ok, false, "no unpack line");
    assert.match(String((reported(["unpack ok\n", "ng refs/heads/main hook declined\n"], "refs/heads/main") as { error: string }).error), /hook declined/);
  });

  it("control: a new branch, then a fast-forward of it, land as asked", async () => {
    const first = commit("one");
    assert.deepEqual(await push("main", null, first, pack(first)), { ok: true });
    assert.equal(tipOf("main"), first);
    const second = commit("two");
    assert.deepEqual(await push("main", first, second, pack(second, first)), { ok: true });
    assert.equal(tipOf("main"), second);
  });

  it("the branch moves only from the commit the approval names: a stale onto, or none for a branch that exists, pushes nothing", async () => {
    const before = tipOf("main");
    const third = commit("three");
    const stale = await push("main", "f".repeat(40), third, pack(third));
    assert.equal(stale.ok, false);
    assert.equal((stale as { moved: boolean }).moved, true);
    const absent = await push("main", null, third, pack(third));
    assert.equal(absent.ok, false, "an approval for a new branch does not move an existing one");
    assert.equal(tipOf("main"), before);
  });

  it("a pack without the approved commit cannot make the branch point at it", async () => {
    const before = tipOf("main");
    const wanted = commit("wanted");
    git(work, "reset", "--quiet", "--hard", before);
    const other = commit("other");
    // The root's user sends the pack of another commit; the update asked for is the approved one.
    const result = await push("main", before, wanted, pack(other, before));
    assert.equal(result.ok, false);
    assert.equal(tipOf("main"), before, "the branch did not move");
    assert.equal(tipOf("other"), ZERO, "and no other ref appeared");
  });

  it("bytes that are not a pack are refused by the forge, and nothing moves", async () => {
    const before = tipOf("main");
    const result = await push("main", before, commit("junk"), Buffer.from("PACK this is not a pack at all, only bytes"));
    assert.equal(result.ok, false);
    assert.equal(tipOf("main"), before);
  });

  it("a replacement is a compare-and-swap too: from the approved onto, to a commit that does not build on it", async () => {
    const before = tipOf("main");
    git(work, "checkout", "--quiet", "--orphan", "rewrite");
    const rewritten = commit("rewritten");
    assert.deepEqual(await push("main", before, rewritten, pack(rewritten)), { ok: true });
    assert.equal(tipOf("main"), rewritten);
  });

  it("asked again for a push that landed, it is done, not refused as moved", async () => {
    const tip = tipOf("main");
    const again = await push("main", "f".repeat(40), tip, pack(tip));
    assert.deepEqual(again, { ok: true });
  });

  it("a failure after the whole pack went out is not 'nothing was pushed': the forge's report decides, or it is uncertain", async () => {
    const before = tipOf("main");
    git(work, "checkout", "--quiet", "-B", "main", before);
    const landed = commit("landed");
    // The sender fails after the last byte (U declared more than it sent, say): the forge
    // took the update anyway, and its report is what is answered.
    const result = await push("main", before, landed, pack(landed, before), async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      throw new Error("nothing arrived for a minute");
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(tipOf("main"), landed);
    // Half a pack, then the failure: the forge cannot have taken it, and the pusher does not
    // claim to know: it says the push is uncertain.
    const half = commit("half");
    const bytes = pack(half, landed);
    await assert.rejects(push("main", landed, half, bytes.subarray(0, Math.floor(bytes.length / 2)), async () => {
      throw new Error("the connection ended before everything arrived");
    }), (error: Error) => error instanceof Uncertain);
    assert.equal(tipOf("main"), landed);
  });
});
