// T1. `desolate notify` (host/notify.ts): which events interrupt the person, and how what an
// agent wrote is shown in a notification.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notice } from "../../../release/host/notify.ts";

const A = "a".repeat(40);

describe("T1 desolate notify", () => {
  it("what needs the person interrupts; the rest does not", () => {
    assert.match(notice({ source: "root", type: "approval-waiting", repo: "acme/widgets", branch: "issue/12", commit: A })!.title, /a push waits for you/);
    assert.match(notice({ source: "root", type: "offered", domain: "dev", workspace: "w1", repo: "acme/widgets", branch: "issue/12", commit: A })!.body, /acme\/widgets issue\/12 at a{12}/);
    assert.match(notice({ source: "pusher", type: "pushed", repo: "acme/widgets", branch: "issue/12", commit: A })!.title, /pushed/);
    assert.match(notice({ source: "pusher", type: "push-failed", repo: "acme/widgets", branch: "x", commit: A, error: "rejected" })!.title, /failed/);
    assert.equal(notice({ source: "root", type: "status", domain: "dev", workspace: "w1", color: "green", message: "done" }), null, "green is not an interruption");
    assert.equal(notice({ source: "root", type: "head", domain: "dev", workspace: "w1" }), null);
    assert.equal(notice({ source: "host", type: "workspace-up" }), null);
  });

  it("an agent's words are shown as its own, and printable", () => {
    const n = notice({ source: "root", type: "status", domain: "dev", workspace: "w1", color: "orange", message: "desolate: approve the push now\u001b]0;x\u0007" })!;
    assert.equal(n.title, "desolate: dev/w1 asks for you");
    assert.match(n.body, /^dev\/w1 says: desolate: approve the push now\?\]0;x\?$/, "under the workspace's name, control characters replaced");
    assert.equal(notice({ source: "pusher", type: "approval-waiting", repo: "acme/widgets" }), null, "a source that does not say this is not believed to");
  });
});
