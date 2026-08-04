/// <reference types="node" />
// The two string predicates every containment rule in this repo reduces to.
//
// `isWithin` decides whether a build context, a config directory or a resolved
// symlink is still inside the project. `validName` decides whether a string is
// a project at all, before the broker touches the filesystem with it. Both were
// exercised only through the rules built on top of them, which means a change
// to either would have surfaced as a policy test failing for reasons that do
// not name the predicate.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isWithin } from "../../../release/vscode-image/utils.ts";
import { validName } from "../../../release/vscode-image/projects.ts";

describe("isWithin", () => {
  const ROOT = "/workspaces/web";

  test("a path is inside itself", () => {
    assert.equal(isWithin(ROOT, ROOT), true);
  });

  test("descendants at any depth are inside", () => {
    for (const sub of ["/src", "/.devcontainer/devcontainer.json", "/a/b/c/d"])
      assert.equal(
        isWithin(ROOT, ROOT + sub),
        true,
        `${ROOT + sub} should be inside`,
      );
  });

  test("a project whose name this one PREFIXES is not inside it", () => {
    // The reason this is a function rather than a `startsWith` at each call
    // site. `web` and `web-api` are an ordinary way to name two services, and
    // a bare prefix test puts the second one inside the first -- which is a
    // build context reaching a sibling's source, and a snapshot following a
    // symlink into another trust domain.
    for (const other of [
      "/workspaces/web-api",
      "/workspaces/web-api/secrets.env",
      "/workspaces/webapi",
      "/workspaces/web.old",
    ])
      assert.equal(isWithin(ROOT, other), false, `${other} escaped`);
  });

  test("an unrelated path is outside", () => {
    for (const other of ["/etc/passwd", "/workspaces", "/", "/workspaces/api"])
      assert.equal(isWithin(ROOT, other), false, `${other} escaped`);
  });

  test("a root that already ends in a separator gains no second one", () => {
    assert.equal(isWithin("/", "/anything"), true);
    assert.equal(isWithin("/workspaces/web/", "/workspaces/web/src"), true);
    assert.equal(isWithin("/workspaces/web/", "/workspaces/web-api"), false);
  });

  test("it is a STRING comparison, so callers must resolve first", () => {
    // Stated as an assertion because it is the one way to misuse this. An
    // unresolved '..' walks straight out and this still answers "inside", so
    // policy.ts resolves with posix.resolve and snapshot.ts with realpathSync
    // BEFORE asking. A future caller that forgets has no error to go on.
    assert.equal(isWithin(ROOT, `${ROOT}/../../etc/passwd`), true);
  });
});

describe("validName", () => {
  const accepts = (name: unknown) =>
    assert.equal(validName(name), true, `${JSON.stringify(name)} was refused`);
  const refuses = (name: unknown) =>
    assert.equal(validName(name), false, `${JSON.stringify(name)} was accepted`);

  test("a flat project, and an owner-scoped repo", () => {
    for (const name of ["a", "9", "myapp", "my.app", "my-app", "my_app"])
      accepts(name);
    for (const name of ["owner/repo", "pmalacho-mit/suede", "a/b"])
      accepts(name);
  });

  test("exactly one level of nesting", () => {
    // `cli.sh repo add` clones to /workspaces/<owner>/<repo>, and nothing
    // deeper is a project. Anything else and the broker's realpath comparison
    // would be measuring against a path it did not build.
    refuses("a/b/c");
    refuses("owner/repo/sub/deep");
  });

  test("nothing that could climb, hide, or be read as a flag", () => {
    for (const name of [
      "..",
      ".",
      "../etc",
      "a/../b",
      ".hidden",
      "-flag",
      "--config",
      "_leading",
      "/absolute",
      "/workspaces/myapp",
      "a/",
      "/a",
      "a//b",
      "",
      "a b",
      "a\nb",
      "a\0b",
    ])
      refuses(name);
  });

  test("'__' is refused, because it is how '/' is encoded", () => {
    // 'a/b' and 'a__b' would otherwise claim the same docker volume namespace.
    refuses("a__b");
    refuses("owner/re__po");
    refuses("__leading");
  });

  test("a segment has a length ceiling", () => {
    accepts("a".repeat(64));
    refuses("a".repeat(65));
    accepts(`${"a".repeat(64)}/${"b".repeat(64)}`);
    refuses(`${"a".repeat(65)}/b`);
  });

  test("a non-string from the wire is refused, not coerced", () => {
    // The broker hands this whatever JSON.parse produced, so the type guard is
    // load-bearing rather than decorative.
    for (const value of [null, undefined, 42, {}, ["myapp"], true])
      refuses(value);
  });
});
