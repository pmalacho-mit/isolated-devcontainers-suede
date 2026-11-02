/// <reference types="node" />
// Which projects the runner keeps off the shared daemon (restrictions.ts):
// the ones the proxy holds to what is allowed by name, read as addon.py reads
// them -- what cannot be read restricts.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { restrictionOf } from "../../../release/vscode-image/restrictions.ts";

const NOW = 1_000_000;
const of = (policies: unknown, project = "acme/widgets") => restrictionOf(JSON.stringify(policies), project, NOW);

describe("which projects are restricted", () => {
  test("none, with no file: every project has the default", () => {
    assert.equal(restrictionOf(null, "acme/widgets", NOW), undefined);
  });

  test("deny, and learn while it learns", () => {
    assert.equal(of({ "acme/widgets": { action: "deny" } }), "deny");
    assert.equal(of({ "acme/widgets": { action: "learn", until: NOW + 60, then: "allow" } }), "learn");
  });

  test("a learn window that ended is its then", () => {
    assert.equal(of({ "acme/widgets": { action: "learn", until: NOW, then: "deny" } }), "deny");
    assert.equal(of({ "acme/widgets": { action: "learn", until: NOW, then: "allow" } }), undefined);
  });

  test("allow, or not listed, is the default; another project's entry is not this one's", () => {
    assert.equal(of({ "acme/widgets": { action: "allow" } }), undefined);
    assert.equal(of({ solo: { action: "deny" } }), undefined);
  });

  test("what cannot be read restricts: an entry, or the whole file", () => {
    for (const entry of [{ action: "learn" }, { action: "learn", until: "soon", then: "deny" }, { action: "sometimes" }, "deny", null])
      assert.equal(of({ "acme/widgets": entry }), "deny", JSON.stringify(entry));
    assert.equal(restrictionOf("{not json", "acme/widgets", NOW), "deny");
    assert.equal(restrictionOf("unreadable", "solo", NOW), "deny");
    assert.equal(restrictionOf("[]", "solo", NOW), "deny");
  });
});
