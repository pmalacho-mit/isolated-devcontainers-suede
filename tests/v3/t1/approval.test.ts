// T1. The text a person approves (shared/approval.ts) and the editor gate's decision
// (workspace/editor-gate.ts): pure functions, no stack.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatApproval, parseApproval } from "../../../release/shared/approval.ts";
import { openedWithToken, refusal, sandboxes } from "../../../release/workspace/editor-gate.ts";
import { hold, HELD } from "../../../release/workspace/editor-settings.ts";

const good = { repo: "acme/widgets", branch: "issue/12", commit: "a".repeat(40), nonce: "0123456789abcdef".repeat(2) };

describe("T1 the approval message", () => {
  it("round-trips, and says exactly what is approved", () => {
    const text = formatApproval(good);
    assert.equal(text, `desolate push approval v1\nrepo: acme/widgets\nbranch: issue/12\ncommit: ${"a".repeat(40)}\nnonce: ${good.nonce}\n`);
    assert.deepEqual(parseApproval(text), good);
  });
  it("anything that is not that exact text is not an approval", () => {
    const text = formatApproval(good);
    for (const [name, bad] of [
      ["not a string", 7], ["empty", ""], ["a trailing line", text + "extra: 1\n"], ["no final newline", text.slice(0, -1)],
      ["another version", text.replace("v1", "v2")], ["a short commit", text.replace("a".repeat(40), "a".repeat(39))],
      ["a branch that climbs", text.replace("issue/12", "../../etc")], ["a branch with an escape", text.replace("issue/12", "x\x1b[2J")],
      ["a repository that is a path", text.replace("acme/widgets", "acme/widgets/extra")], ["an uppercase nonce", text.replace(good.nonce, good.nonce.toUpperCase())],
      ["a second branch line", text.replace("branch: issue/12\n", "branch: issue/12\nbranch: main\n")], ["CRLF", text.replace(/\n/g, "\r\n")],
      ["fields in another order", text.replace(`repo: acme/widgets\nbranch: issue/12`, `branch: issue/12\nrepo: acme/widgets`)], ["too long", text + " ".repeat(2000)],
    ] as [string, unknown][])
      assert.equal(parseApproval(bad), null, name);
  });
});

describe("T1 the editor gate", () => {
  const host = "web-one-editor-abc123.localhost";
  const ok = { host: `${host}:31581` };
  it("passes what the editor's own page sends", () => {
    assert.equal(refusal(host, ok), undefined);
    assert.equal(refusal(host, { ...ok, "sec-fetch-site": "same-origin", origin: `http://${host}:31581` }), undefined);
    assert.equal(refusal(host, { ...ok, "sec-fetch-site": "none" }), undefined);
    assert.equal(refusal(host, { host: host.toUpperCase() }), undefined);
  });
  it("refuses another name, another site, another origin", () => {
    assert.equal(refusal(host, { host: "web-one-abc123.localhost:31581" })?.status, 421);
    assert.equal(refusal(host, { host: "127.0.0.1:31581" })?.status, 421);
    assert.equal(refusal(host, {})?.status, 421);
    assert.equal(refusal(host, { host: `${host}.evil.example` })?.status, 421);
    assert.equal(refusal(host, { host: `evil.example/${host}` })?.status, 421);
    for (const site of ["cross-site", "same-site", "anything-else"]) assert.equal(refusal(host, { ...ok, "sec-fetch-site": site })?.status, 403, site);
    assert.equal(refusal(host, { ...ok, origin: "http://web-one-abc123.localhost:3000" })?.status, 403);
    assert.equal(refusal(host, { ...ok, origin: "null" })?.status, 403);
  });
  it("lets in one kind of request another site started: a navigation to the page that carries the editor's token", () => {
    const token = "a".repeat(48);
    const nav = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    const opened = (url: string, headers: Record<string, string> = nav, method = "GET") => openedWithToken({ method, url, headers }, token);
    // The dashboard's "Open editor", followed in a real browser: another site, with the token.
    assert.equal(opened(`/?tkn=${token}&folder=%2Fworkspaces%2Fa`), true);
    assert.equal(refusal(host, { ...ok, ...nav }, true), undefined);
    // Without the token, with another, elsewhere than the page, not a navigation, not a GET.
    assert.equal(opened("/?folder=%2Fworkspaces%2Fa"), false);
    assert.equal(opened(`/?tkn=${"b".repeat(48)}`), false);
    assert.equal(opened(`/?tkn=${token.slice(1)}`), false);
    assert.equal(opened(`/stable-x/vscode-remote-resource?path=/etc/passwd&tkn=${token}`), false);
    assert.equal(opened(`/?tkn=${token}`, { ...nav, "sec-fetch-dest": "iframe" }), false);
    assert.equal(opened(`/?tkn=${token}`, { ...nav, "sec-fetch-mode": "cors" }), false);
    assert.equal(opened(`/?tkn=${token}`, nav, "POST"), false);
    assert.equal(openedWithToken({ method: "GET", url: `/?tkn=${token}`, headers: nav }, null), false, "an editor whose token cannot be read lets nothing in this way");
    // The exception is for the site check only: the name and the origin still hold.
    assert.equal(refusal("other-editor-abc123.localhost", { ...ok, ...nav }, true)?.status, 421);
    assert.equal(refusal(host, { ...ok, ...nav, origin: "http://evil.example" }, true)?.status, 403);
    assert.equal(refusal(host, { ...ok, ...nav })?.status, 403, "control: the same request, not opened with the token, is refused");
  });
  it("sandboxes a remote resource opened as a document, and only that", () => {
    assert.equal(sandboxes("/stable-x/vscode-remote-resource?path=/workspaces/a/x.html", { "sec-fetch-dest": "document" }), true);
    assert.equal(sandboxes("/stable-x/vscode-remote-resource?path=/workspaces/a/x.html", { "sec-fetch-dest": "iframe" }), true);
    assert.equal(sandboxes("/stable-x/vscode-remote-resource?path=/workspaces/a/x.png", { "sec-fetch-dest": "image" }), false);
    assert.equal(sandboxes("/?path=/vscode-remote-resource", { "sec-fetch-dest": "document" }), false);
  });
  it("held settings are put back, and the rest is kept", () => {
    const kept = JSON.parse(hold(JSON.stringify({ "editor.fontSize": 15, "extensions.autoUpdate": true }))) as Record<string, unknown>;
    assert.equal(kept["editor.fontSize"], 15);
    for (const [key, value] of Object.entries(HELD)) assert.deepEqual(kept[key], value, key);
    assert.deepEqual(JSON.parse(hold("this is not json")), HELD);
    assert.deepEqual(JSON.parse(hold(undefined)), HELD);
  });
});
