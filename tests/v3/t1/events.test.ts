// T1. `desolate events` (host/events.ts): what each source may say, and what reaches a
// script's terminal of what an agent wrote.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hub, pusherEvent, stateEvents } from "../../../release/host/events.ts";
import { printable } from "../../../release/shared/text.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("T1 desolate events", () => {
  it("the pusher's lines are events only when every field is what a push names", () => {
    const pushed = pusherEvent(`EVENT ${JSON.stringify({ type: "pushed", at: "2026-11-12T00:00:00Z", repo: "acme/widgets", branch: "issue/12", commit: A, onto: null })}`);
    assert.deepEqual({ ...pushed, at: "" }, { v: 1, at: "", type: "pushed", source: "pusher", repo: "acme/widgets", branch: "issue/12", commit: A, onto: null });
    const failed = pusherEvent(`EVENT ${JSON.stringify({ type: "push-failed", repo: "acme/widgets", branch: "x", commit: A, onto: B, error: "the forge refused\u001b]52;c;aGk=\u0007" })}`);
    assert.equal(failed?.type, "push-failed");
    assert.doesNotMatch(String(failed?.error), /[\u001b\u0007]/, "no escape sequence reaches a terminal");
    for (const bad of [
      "2026-11-12 pusher: pushed",
      `EVENT ${JSON.stringify({ type: "deleted", repo: "acme/widgets", branch: "x", commit: A, onto: null })}`,
      `EVENT ${JSON.stringify({ type: "pushed", repo: "../etc", branch: "x", commit: A, onto: null })}`,
      `EVENT ${JSON.stringify({ type: "pushed", repo: "acme/widgets", branch: "a..b", commit: A, onto: null })}`,
      `EVENT ${JSON.stringify({ type: "pushed", repo: "acme/widgets", branch: "x", commit: "abc", onto: null })}`,
      "EVENT {not json",
    ])
      assert.equal(pusherEvent(bad), null, bad);
  });

  it("the root's state, diffed: what is new, as the root's word, made printable", () => {
    const before = { offers: [{ domain: "dev", workspace: "w1", repo: "acme/widgets", branch: "old", commit: A }], approvals: [], domains: [{ slug: "dev", workspaces: [{ workspace: "w1", says: { status: { color: "blue", message: "working", updated: "1" } } }] }] };
    const after = {
      offers: [{ domain: "dev", workspace: "w1", repo: "acme/widgets", branch: "issue/12", commit: B }],
      approvals: [{ repo: "acme/widgets", branch: "issue/12", commit: B }],
      refused: [{ domain: "dev", repo: "acme/widgets", why: "hasDotgit" }],
      domains: [{ slug: "dev", workspaces: [{ workspace: "w1", says: { status: { color: "green", message: "ready ‮dlrow\u001b[2J", updated: "2" } } }] }],
    };
    const events = stateEvents(before, after);
    assert.deepEqual(events.map((e) => e.type).sort(), ["approval-waiting", "bundle-refused", "offer-gone", "offered", "status"]);
    assert.ok(events.every((e) => e.source === "root"), "all of it is the root's word");
    const status = events.find((e) => e.type === "status")!;
    assert.equal(status.message, "ready ?dlrow?[2J", "no bidirectional override, no escape");
    assert.deepEqual(stateEvents(after, after), [], "nothing changed, nothing said");
  });

  it("printable keeps text and drops what a terminal would act on", () => {
    assert.equal(printable("issue/12 ✓ café"), "issue/12 ✓ café");
    assert.equal(printable("a\u0000b\u001bc\u009bd​e⁦f"), "a?b?c?d?e?f");
    assert.equal(printable("x".repeat(500), 10), "x".repeat(10));
  });

  it("the hub replays what it holds, then streams", () => {
    const h = hub(3);
    for (const n of [1, 2, 3, 4]) h.publish(h.host("n", { n }));
    const seen: number[] = [];
    const stop = h.listen(10, (line) => seen.push((JSON.parse(line) as { n: number }).n));
    h.publish(h.host("n", { n: 5 }));
    stop();
    h.publish(h.host("n", { n: 6 }));
    assert.deepEqual(seen, [2, 3, 4, 5]);
    const fresh: number[] = [];
    h.listen(0, (line) => fresh.push((JSON.parse(line) as { n: number }).n))();
    assert.deepEqual(fresh, [], "replay 0 replays nothing (a restarted script does not act on old pushes again)");
    assert.equal((h.host("x", { source: "pusher", type: "pushed" }) as { source: string; type: string }).source, "host", "a field cannot stand in for the source");
  });

  it("a name the root's user reports is one desolate would make, or null: a script may pass it on", () => {
    const [offered] = stateEvents({ offers: [] }, { offers: [{ domain: "dev", workspace: "w1", repo: "acme/widgets", branch: "--upload-pack=touch x", commit: "nope" }] });
    assert.equal(offered!.branch, null);
    assert.equal(offered!.commit, null);
    assert.equal(offered!.repo, "acme/widgets");
    const [status] = stateEvents({ domains: [] }, { domains: [{ slug: "dev", workspaces: [{ workspace: "w1", says: { status: { color: "blink", message: "hi", updated: "1" } } }] }] });
    assert.equal(status!.color, null);
  });

  it("a checkout's HEAD moving is an event, its names checked", () => {
    const at = (branch: unknown, commit: unknown) => ({ domains: [{ slug: "dev", workspaces: [{ workspace: "w1", checkouts: [{ repo: "acme/widgets", head: { branch, commit } }] }] }] });
    assert.deepEqual(stateEvents(at("main", A), at("main", A)), []);
    const [moved] = stateEvents(at("main", A), at("issue/12", B));
    assert.deepEqual({ ...moved, at: "" }, { at: "", v: 1, type: "head", source: "root", domain: "dev", workspace: "w1", repo: "acme/widgets", branch: "issue/12", commit: B, was: { branch: "main", commit: A } });
    const [odd] = stateEvents(at("main", A), at("--upload-pack=x", "nope"));
    assert.equal(odd!.branch, null);
    assert.equal(odd!.commit, null);
  });
});
