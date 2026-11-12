// T1. The root reads a domain's outbox as data: what a hostile domain can put there, and
// what the root makes of it. (P4. The end-to-end version, with git, is in t2/04-offers.)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

  it("only regular bundle files with plain names are taken; every name that was looked at is removed from the outbox, and nothing else", () => {
    fs.writeFileSync(`${sync}/abc-1.bundle`, "one bundle's bytes");
    fs.writeFileSync(`${sync}/UPPER.bundle`, "x");
    fs.writeFileSync(`${sync}/a b.bundle`, "x");
    fs.symlinkSync("/etc/passwd", `${sync}/zz.bundle`);
    fs.mkdirSync(`${sync}/dir.bundle`);
    const taken = outbox.takeBundles("t1-dom", "acme/widgets");
    assert.equal(taken.copies.length, 1);
    assert.equal(fs.readFileSync(taken.copies[0]!, "utf8"), "one bundle's bytes");
    assert.ok(taken.copies[0]!.startsWith(path.join(work, "state", "incoming")), "the copy is in the root's own directory");
    assert.equal(taken.dropped, 2, "the symlink and the directory were dropped, not followed");
    assert.deepEqual(fs.readdirSync(sync).sort(), ["UPPER.bundle", "a b.bundle", "dir.bundle", "refs.json"], "names that are not a bundle's are left alone; the symlink itself is gone");
    assert.ok(fs.existsSync("/etc/passwd"), "and what it pointed at is not");
  });

  it("an LFS object is taken only if it hashes to its name and has the size its pointer said", () => {
    const data = Buffer.from("large file content");
    const oid = createHash("sha256").update(data).digest("hex");
    const target = (name: string) => path.join(work, "store", name);
    fs.writeFileSync(`${lfs}/${oid}`, data);
    assert.deepEqual(outbox.takeLfs("t1-dom", "acme/widgets", oid, data.length, target(oid)), { ok: true }, "control: an honest object is accepted");
    assert.deepEqual(fs.readFileSync(target(oid)), data, "and what was kept is what was hashed");
    assert.ok(!fs.existsSync(`${lfs}/${oid}`), "once taken, it is removed from the outbox");
    fs.writeFileSync(`${lfs}/${oid}`, data);
    assert.match((outbox.takeLfs("t1-dom", "acme/widgets", oid, data.length + 1, target("size")) as { error: string }).error, /its pointer says/);
    const wrong = "b".repeat(64);
    fs.writeFileSync(`${lfs}/${wrong}`, data);
    assert.match((outbox.takeLfs("t1-dom", "acme/widgets", wrong, data.length, target(wrong)) as { error: string }).error, /does not hash to its id/);
    const linked = "c".repeat(64);
    fs.symlinkSync("/etc/passwd", `${lfs}/${linked}`);
    assert.match((outbox.takeLfs("t1-dom", "acme/widgets", linked, 1, target(linked)) as { error: string }).error, /not in the outbox/);
    assert.match((outbox.takeLfs("t1-dom", "acme/widgets", "../../x", 1, target("x")) as { error: string }).error, /not an LFS object id/);
    assert.deepEqual(fs.readdirSync(path.join(work, "store")), [oid], "nothing that was refused was kept, not even a partial copy");
  });

  it("a symlink anywhere on the way to a file is not followed: not at the end, not at a directory above", () => {
    // What a workspace can do in its outbox: make any component a symlink. In the root VM
    // it would resolve to the root's own files.
    const secret = path.join(work, "roots-own");
    fs.mkdirSync(secret, { recursive: true });
    fs.writeFileSync(path.join(secret, "refs.json"), JSON.stringify({ refs: { stolen: "a".repeat(40) } }));
    fs.writeFileSync(path.join(secret, "zz.bundle"), "the root's own file");
    const honest = `${domains}/t1-dom/outbox/sync/acme/honest`;
    fs.mkdirSync(honest, { recursive: true });
    fs.writeFileSync(`${honest}/refs.json`, JSON.stringify({ refs: { fine: "b".repeat(40) } }));
    fs.writeFileSync(`${honest}/aa.bundle`, "a bundle's bytes");
    assert.deepEqual(outbox.listedRefs("t1-dom", "acme/honest"), { fine: "b".repeat(40) }, "control: a plain file in a plain directory is read");
    const honestTaken = outbox.takeBundles("t1-dom", "acme/honest");
    assert.deepEqual(honestTaken.copies.map((copy) => fs.readFileSync(copy, "utf8")), ["a bundle's bytes"], "control: a plain bundle in a plain directory is taken");
    // The directory itself is a symlink to the root's files.
    fs.symlinkSync(secret, `${domains}/t1-dom/outbox/sync/acme/linked`);
    assert.deepEqual(outbox.listedRefs("t1-dom", "acme/linked"), {}, "a refs list reached through a symlinked directory is not read");
    assert.deepEqual(outbox.takeBundles("t1-dom", "acme/linked"), { copies: [], dropped: 0, more: false }, "nor a bundle");
    assert.equal(fs.readFileSync(path.join(secret, "zz.bundle"), "utf8"), "the root's own file", "and the root's own file was not removed through the domain's path");
    // A directory two levels up is a symlink.
    fs.symlinkSync(path.join(work, "roots-own-tree"), `${domains}/t1-dom/outbox/requests`);
    fs.mkdirSync(path.join(work, "roots-own-tree"), { recursive: true });
    fs.writeFileSync(path.join(work, "roots-own-tree", "r.json"), JSON.stringify({ op: "fetch" }));
    assert.equal(outbox.readData(`${domains}/t1-dom/outbox/requests/r.json`), null);
    assert.deepEqual(outbox.drain(`${domains}/t1-dom/outbox/requests`, /\.json$/, 50), []);
    assert.ok(fs.existsSync(path.join(work, "roots-own-tree", "r.json")), "nothing was drained from, or removed in, the directory the symlink led to");
    // A FIFO where a file should be would hold a reader for ever: it is not opened to be read.
    spawnSync("mkfifo", [`${honest}/pipe.bundle`]);
    assert.deepEqual(outbox.takeBundles("t1-dom", "acme/honest"), { copies: [], dropped: 1, more: false });
    // CONTROL for drain: an honest request is read once and removed.
    fs.rmSync(`${domains}/t1-dom/outbox/requests`);
    fs.mkdirSync(`${domains}/t1-dom/outbox/requests`);
    fs.writeFileSync(`${domains}/t1-dom/outbox/requests/a1.json`, JSON.stringify({ op: "fetch" }));
    assert.deepEqual(outbox.drain(`${domains}/t1-dom/outbox/requests`, /\.json$/, 50), [{ name: "a1.json", data: { op: "fetch" } }]);
    assert.deepEqual(fs.readdirSync(`${domains}/t1-dom/outbox/requests`), []);
  });

  it("size: a JSON file over the limit is not read; bundles are taken one at a time when asked", () => {
    const requests = `${domains}/t1-dom/outbox/requests`;
    const pad = (bytes: number) => JSON.stringify({ op: "fetch", pad: "x".repeat(bytes) });
    fs.writeFileSync(`${requests}/big.json`, pad(1024 * 1024));
    fs.writeFileSync(`${requests}/fits.json`, pad(1024 * 1024 - 100));
    const drained = outbox.drain<{ op: string }>(requests, /\.json$/, 50);
    assert.deepEqual(drained.map((d) => [d.name, d.data?.op ?? null]), [["big.json", null], ["fits.json", "fetch"]], "control: just under the limit is read");
    const many = `${domains}/t1-dom/outbox/sync/acme/many`;
    fs.mkdirSync(many, { recursive: true });
    for (const name of ["a", "b", "c"]) fs.writeFileSync(`${many}/${name}.bundle`, `bundle ${name}`);
    const first = outbox.takeBundles("t1-dom", "acme/many", 1);
    assert.deepEqual([first.copies.length, first.more, fs.readFileSync(first.copies[0]!, "utf8"), fs.readdirSync(many)], [1, true, "bundle a", ["b.bundle", "c.bundle"]]);
    outbox.takeBundles("t1-dom", "acme/many", 1);
    const last = outbox.takeBundles("t1-dom", "acme/many", 1);
    assert.deepEqual([last.copies.length, last.more, fs.readdirSync(many)], [1, false, []]);
  });
});
