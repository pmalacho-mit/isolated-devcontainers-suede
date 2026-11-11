// T1. The root reads a domain's outbox as data: what a hostile domain can put there, and
// what the root makes of it. (P4. The end-to-end version, with git, is in t2/04-offers.)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-outbox-"));
// layout.ts reads these when it is first imported.
process.env.DESOLATE_ROOT_STATE = path.join(work, "state");
process.env.DESOLATE_ROOT_DOMAINS = path.join(work, "domains");
let outbox: typeof import("../../../release/root/outbox.ts");
const domains = process.env.DESOLATE_ROOT_DOMAINS;

describe("T1 outbox", () => {
  const sync = `${domains}/t1-dom/outbox/sync/acme/widgets`;
  const lfs = `${domains}/t1-dom/outbox/lfs/acme/widgets`;
  before(async () => {
    outbox = await import("../../../release/root/outbox.ts");
    fs.mkdirSync(sync, { recursive: true });
    fs.mkdirSync(lfs, { recursive: true });
  });
  after(() => {
    fs.rmSync(`${domains}/t1-dom`, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("only well-formed branches and commits survive a refs list", () => {
    const sha = "a".repeat(40);
    fs.writeFileSync(`${sync}/refs.json`, JSON.stringify({ refs: { main: sha, "issue/12": sha, "../../x": sha, "-oProxyCommand=x": sha, "a b": sha, short: "abc", "refs/heads/main": sha } }));
    assert.deepEqual(Object.keys(outbox.listedRefs("t1-dom", "acme/widgets")).sort(), ["issue/12", "main", "refs/heads/main"]);
    assert.deepEqual(outbox.listedRefs("t1-dom", "../../etc"), {}, "a repository that is not one lists nothing");
  });

  it("a refs list that is a symlink, or not JSON, lists nothing", () => {
    fs.rmSync(`${sync}/refs.json`);
    fs.symlinkSync("/etc/passwd", `${sync}/refs.json`);
    assert.deepEqual(outbox.listedRefs("t1-dom", "acme/widgets"), {});
    fs.rmSync(`${sync}/refs.json`);
    fs.writeFileSync(`${sync}/refs.json`, "not json");
    assert.deepEqual(outbox.listedRefs("t1-dom", "acme/widgets"), {});
  });

  it("only regular bundle files with plain names are pending", () => {
    fs.writeFileSync(`${sync}/abc-1.bundle`, "x");
    fs.writeFileSync(`${sync}/UPPER.bundle`, "x");
    fs.writeFileSync(`${sync}/a b.bundle`, "x");
    fs.symlinkSync("/etc/passwd", `${sync}/zz.bundle`);
    fs.mkdirSync(`${sync}/dir.bundle`);
    assert.deepEqual(outbox.pendingBundles("t1-dom", "acme/widgets").map((file) => path.basename(file)), ["abc-1.bundle"]);
  });

  it("an LFS object is taken only if it hashes to its name and has the size its pointer said", () => {
    const data = Buffer.from("large file content");
    const oid = createHash("sha256").update(data).digest("hex");
    fs.writeFileSync(`${lfs}/${oid}`, data);
    assert.ok("file" in outbox.verifiedLfs("t1-dom", "acme/widgets", oid, data.length), "control: an honest object is accepted");
    assert.match((outbox.verifiedLfs("t1-dom", "acme/widgets", oid, data.length + 1) as { error: string }).error, /its pointer says/);
    const wrong = "b".repeat(64);
    fs.writeFileSync(`${lfs}/${wrong}`, data);
    assert.match((outbox.verifiedLfs("t1-dom", "acme/widgets", wrong, data.length) as { error: string }).error, /does not hash to its id/);
    const linked = "c".repeat(64);
    fs.symlinkSync("/etc/passwd", `${lfs}/${linked}`);
    assert.match((outbox.verifiedLfs("t1-dom", "acme/widgets", linked, 1) as { error: string }).error, /not in the outbox/);
    assert.match((outbox.verifiedLfs("t1-dom", "acme/widgets", "../../x", 1) as { error: string }).error, /not an LFS object id/);
  });
});
