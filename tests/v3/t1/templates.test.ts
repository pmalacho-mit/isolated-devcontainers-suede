// T1. A domain's template (section 4.7, C3): what it is keyed by, and what it is called.
// (Building one needs a registry the tests do not have; the M1's numbers are in
// docs/v3/decisions.md, "A domain's template".)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { workspaceVmName } from "../../../release/shared/names.ts";
import { keyOf, templateVm } from "../../../release/host/templates.ts";

describe("T1 a domain's template", () => {
  const env = { repo: "acme/widgets", spec: ".devcontainer", id: "a".repeat(40) };
  it("is keyed by the spec as published: another tree, another file, another repository is another template", () => {
    assert.equal(keyOf(env), keyOf({ ...env }), "the same spec, the same key");
    assert.notEqual(keyOf(env), keyOf({ ...env, id: "b".repeat(40) }));
    assert.notEqual(keyOf(env), keyOf({ ...env, spec: ".devcontainer.json" }));
    assert.notEqual(keyOf(env), keyOf({ ...env, repo: "acme/other" }));
    assert.match(keyOf(env), /^[0-9a-f]{16}$/);
  });
  it("is named for its domain and key, never like a workspace's VM, and as long as one", () => {
    const name = templateVm("web", keyOf(env));
    assert.match(name, /^dsl-[a-z0-9]+-t[0-9a-f]{9}$/);
    assert.notEqual(name, templateVm("api", keyOf(env)), "one domain's template is never another's");
    const workspace = workspaceVmName("main", "web", "w1");
    assert.equal(name.replace(/^dsl-main-/, "").length, workspace.replace(/^dsl-main-/, "").length);
    assert.doesNotMatch(name, /^dsl-[a-z0-9]+-[0-9a-f]{10}$/, "a workspace VM's name is ten hex digits; a template's starts with t");
  });
});
