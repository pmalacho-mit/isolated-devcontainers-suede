// T1. Taking in a file another side wrote (shared/copy.ts): the host from the git VM, the root
// from the host. Each hostile shape is refused, and nothing half-copied is left behind.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { takeHashed } from "../../../release/shared/copy.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-copy-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const content = Buffer.from("an LFS object\n");
const oid = createHash("sha256").update(content).digest("hex");
const leftovers = () => fs.readdirSync(dir).filter((name) => name.includes(".part"));
let n = 0;
const target = () => path.join(dir, `to-${n++}`);

describe("T1 taking in a file another side wrote", () => {
  it("a plain file that hashes to its name is taken, as a copy", () => {
    const from = path.join(dir, "good");
    fs.writeFileSync(from, content);
    const to = target();
    assert.equal(takeHashed(from, to, oid, 1024), null);
    assert.deepEqual(fs.readFileSync(to), content);
    assert.notEqual(fs.statSync(to).ino, fs.statSync(from).ino);
    assert.deepEqual(leftovers(), []);
  });
  it("a wrong hash is refused, and nothing is left", () => {
    const from = path.join(dir, "liar");
    fs.writeFileSync(from, "something else\n");
    const to = target();
    assert.equal(takeHashed(from, to, oid, 1024), "it does not hash to its name");
    assert.equal(fs.existsSync(to), false);
    assert.deepEqual(leftovers(), []);
  });
  it("a link, even to a good file, is not followed", () => {
    const link = path.join(dir, "link");
    fs.symlinkSync(path.join(dir, "good"), link);
    assert.equal(takeHashed(link, target(), oid, 1024), "not a plain file of a size desolate takes");
  });
  it("a FIFO is refused at once: the reader does not block on it", () => {
    const fifo = path.join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    assert.equal(takeHashed(fifo, target(), oid, 1024), "not a plain file of a size desolate takes");
    assert.ok(Date.now() - started < 1000);
  });
  it("a file over the size is refused before a byte is copied", () => {
    const big = path.join(dir, "big");
    fs.writeFileSync(big, Buffer.alloc(4096));
    const to = target();
    assert.equal(takeHashed(big, to, oid, 1024), "not a plain file of a size desolate takes");
    assert.equal(fs.existsSync(to), false);
    assert.deepEqual(leftovers(), []);
  });
  it("what is there already is kept, and not written through", () => {
    const to = target();
    fs.writeFileSync(to, content);
    assert.equal(takeHashed(path.join(dir, "liar"), to, oid, 1024), null);
    assert.deepEqual(fs.readFileSync(to), content);
  });
});
