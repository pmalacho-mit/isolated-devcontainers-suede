// T1. Pushes waiting for a person (root/approvals.ts): each file read on its own, so one bad
// one hides none of the others; old ones expire.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { pendingIn } from "../../../release/root/approvals.ts";
import { formatApproval } from "../../../release/shared/approval.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-approvals-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const NOW = Date.parse("2026-11-13T12:00:00Z");
const message = (n: number) => formatApproval({ repo: "acme/app", branch: `b${n}`, commit: String(n).repeat(40).slice(0, 40), onto: null, nonce: String(n).repeat(32).slice(0, 32) });
const put = (name: string, content: string) => fs.writeFileSync(path.join(dir, name), content);

describe("T1 pushes waiting for a person", () => {
  it("one malformed, oversized, expired or foreign file hides none of the others", () => {
    put("1.json", JSON.stringify({ message: message(1), summary: "two files", at: new Date(NOW - 1000).toISOString() }));
    put("2.json", "{not json");
    put("3.json", JSON.stringify({ message: "desolate push approval v2\nrepo: ../x\n", at: new Date(NOW).toISOString() }));
    put("4.json", JSON.stringify({ message: message(4), at: new Date(NOW - 200_000).toISOString() }));
    put("5.json", JSON.stringify({ message: message(5), summary: "x".repeat(20_000), at: new Date(NOW).toISOString() }));
    put("6.json", JSON.stringify({ message: message(6), summary: "s".repeat(500), at: new Date(NOW).toISOString() }));
    fs.mkdirSync(path.join(dir, "7.json"));
    put("8.txt", JSON.stringify({ message: message(8), at: new Date(NOW).toISOString() }));
    const listed = pendingIn(dir, NOW);
    assert.deepEqual(listed.map((p) => p.approval.branch), ["b1", "b6"]);
    assert.equal(listed[1]!.summary.length, 200);
  });
  it("pruning removes what is not a waiting approval, and keeps the rest", () => {
    pendingIn(dir, NOW, true);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["1.json", "6.json", "7.json", "8.txt"]);
  });
});
