// T1. Names: what desolate accepts as a slug, a repository, a branch, and the names it
// derives. Every name here ends up in a path, a refspec, a VM name or a hostname.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { devHostname, editorHostname, isBranch, isCommit, isSlug, parseRepo, rootVmName, workspaceVmName } from "../../../release/shared/names.ts";

describe("T1 names", () => {
  it("a slug has one spelling", () => {
    for (const good of ["a", "nests-dev", "issue-12", "w1", "0day", "a".repeat(40)]) assert.equal(isSlug(good), true, good);
    for (const bad of ["", "-a", "a-", "a--b", "A", "a_b", "a.b", "a/b", "a b", "a".repeat(41), "../x", "a\n", 12, null, undefined]) assert.equal(isSlug(bad), false, String(bad));
  });

  it("a repository is owner/name, and nothing that could leave its directory", () => {
    assert.deepEqual(parseRepo("pmalacho-mit/suede.nests"), { owner: "pmalacho-mit", name: "suede.nests" });
    for (const bad of ["", "owner", "a/b/c", "../etc", "a/..", "a/b.git", "a/.hidden", "-a/b", "a/b ", "a//b", "a/b\n", "a/b.", "a/b..c", "/b", "a/", 5]) assert.equal(parseRepo(bad), null, String(bad));
  });

  it("a branch is safe as an argument and inside a refspec", () => {
    for (const good of ["main", "issue/12", "suede/nests-changes", "v1.2.3", "a_b", "downstream/owner/repo-abc123"]) assert.equal(isBranch(good), true, good);
    for (const bad of ["", "-oProxyCommand=x", "--upload-pack=x", "a..b", "a//b", "a/", "/a", "a.lock", "a.", "a@{1}", "a b", "a:b", "a~1", "a^", "a?", "a*", "a[", "a\\b", "refs/heads/x\n", "+main", "a".repeat(201), "é"]) assert.equal(isBranch(bad), false, bad);
  });

  it("a commit is forty hex digits", () => {
    assert.equal(isCommit("a".repeat(40)), true);
    for (const bad of ["a".repeat(39), "A".repeat(40), "g".repeat(40), "HEAD", `${"a".repeat(40)}\n`, ""]) assert.equal(isCommit(bad), false, bad);
  });

  it("VM names are short and opaque; hostnames are one per surface", () => {
    const vm = workspaceVmName("main", "a".repeat(40), "b".repeat(40));
    assert.match(vm, /^dsl-main-[0-9a-f]{10}$/);
    assert.equal(rootVmName("main"), "dsl-main-root");
    assert.notEqual(workspaceVmName("main", "a", "b-c"), workspaceVmName("main", "a-b", "c"), "the pair is hashed with a separator, not joined");
    const dev = devHostname("main", "web", "one");
    const editor = editorHostname("main", "web", "one");
    assert.match(dev, /^web-one-[0-9a-f]{6}\.localhost$/);
    assert.match(editor, /^web-one-editor-[0-9a-f]{6}\.localhost$/);
    assert.notEqual(dev, editor, "the editor and the dev servers are two sites: two cookie jars");
    assert.notEqual(devHostname("main", "web", "one"), devHostname("other", "web", "one"), "two stacks do not share a name");
  });
});
