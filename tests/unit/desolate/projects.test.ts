/// <reference types="node" />
// Which directories are targets, and which names may never be one.
//
// The `--wt--` case is the same class of bug as encoding structure into a name
// and reading it back: `acme/widgets@feature` becomes
// `acme__widgets--wt--feature`, so a project LITERALLY called
// `acme__widgets--wt--feature` would claim the identical namespace. Both halves
// of the defence are here -- the name is refused, and it is left out of the
// list that decides who owns a volume.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EVERY_TARGET,
  list,
  meansEveryTarget,
  target,
  validName,
  validWorktree,
  volumeNamespace,
  worktreesOf,
} from "../../../release/vscode-image/projects.ts";

const sandbox = () => {
  const workspaces = fs.mkdtempSync(join(tmpdir(), "desolate-targets-"));
  const directory = (...segments: string[]) => {
    const path = join(workspaces, ...segments);
    fs.mkdirSync(path, { recursive: true });
    return path;
  };
  return {
    workspaces,
    directory,
    /** A directory that can be started, i.e. one carrying a spec. */
    startable: (...segments: string[]) => {
      fs.writeFileSync(
        join(directory(...segments, ".devcontainer"), "devcontainer.json"),
        "{}",
      );
    },
  };
};

const names = (workspaces: string) =>
  list(workspaces)
    .map(({ name }) => name)
    .sort();

describe("the list of everything that could claim a namespace", () => {
  test("carries a project's worktrees alongside the project", () => {
    const box = sandbox();
    box.startable("acme", "widgets");
    box.directory("acme", "widgets", ".worktrees", "feature123");
    box.directory("acme", "widgets", ".worktrees", "other");

    assert.deepEqual(names(box.workspaces), [
      "acme",
      "acme/widgets",
      "acme/widgets@feature123",
      "acme/widgets@other",
    ]);
  });

  test("`.worktrees` is never itself mistaken for a project", () => {
    // It is dot-prefixed for exactly this reason: `list` skips dot-prefixed
    // names at every level, so it is reached deliberately or not at all.
    const box = sandbox();
    box.startable("widgets");
    box.directory("widgets", ".worktrees", "feature123");

    assert.deepEqual(names(box.workspaces), [
      "widgets",
      "widgets@feature123",
    ]);
  });

  test("a worktree is startable only once it carries its own spec", () => {
    // A branch is developed with the devcontainer.json on that branch, so the
    // spec is read from the worktree, not from the project root.
    const box = sandbox();
    box.startable("acme", "widgets");
    box.directory("acme", "widgets", ".worktrees", "bare");
    box.startable("acme", "widgets", ".worktrees", "feature123");

    assert.deepEqual(
      list.startable(box.workspaces)
        .map(({ name }) => name)
        .sort(),
      ["acme/widgets", "acme/widgets@feature123"],
    );
  });

  test("each worktree's directory is under its project's .worktrees", () => {
    const box = sandbox();
    box.startable("acme", "widgets");
    box.directory("acme", "widgets", ".worktrees", "feature123");

    assert.deepEqual(
      worktreesOf(target(box.workspaces, "acme/widgets")).map(
        ({ dir }) => dir,
      ),
      [join(box.workspaces, "acme/widgets/.worktrees/feature123")],
    );
  });
});

describe("the '--wt--' reservation", () => {
  test("a project cannot be named the encoding of somebody's worktree", () => {
    // Without this, `acme__widgets--wt--feature` as a project name and
    // `feature` as a worktree of `acme/widgets` produce one namespace, and the
    // volume-ownership check approves whichever asks first.
    const collision = "acme__widgets--wt--feature";
    assert.equal(validName(collision), false);
    assert.equal(validWorktree("a--wt--b"), false);
    assert.throws(() => volumeNamespace(collision), /double underscore/);
  });

  test("a directory spelling that collision is left out of the list", () => {
    // Refusing the name is right; refusing it from inside `list` is not -- the
    // list is what every OTHER project is measured against, and a throw there
    // would take the whole workspace down. It is omitted instead.
    const box = sandbox();
    box.startable("acme", "widgets");
    box.startable("acme__widgets--wt--feature");
    box.directory("acme", "widgets", ".worktrees", "feature");

    const listed = names(box.workspaces);
    assert.ok(!listed.includes("acme__widgets--wt--feature"), `${listed}`);
    assert.ok(listed.includes("acme/widgets@feature"));
  });

  test("the encoded forms of a project and its worktree stay distinct", () => {
    const project = target("/workspaces", "acme/widgets");
    const worktree = target("/workspaces", "acme/widgets", "feature");
    assert.notEqual(project.namespace, worktree.namespace);
    assert.equal(worktree.namespace, "acme__widgets--wt--feature");
  });
});

describe("the word that means every target", () => {
  test("'all' widens when no project is there to be meant instead", () => {
    const box = sandbox();
    box.startable("myapp");
    assert.equal(meansEveryTarget(box.workspaces, EVERY_TARGET), true);
  });

  test("a project really called 'all' takes the word back", () => {
    // Widening here would stop the whole stack for someone who named ONE
    // project, which is the expensive direction to be wrong in. `--all` is the
    // spelling that cannot be shadowed, and the runner points at it.
    const box = sandbox();
    box.startable(EVERY_TARGET);
    assert.equal(meansEveryTarget(box.workspaces, EVERY_TARGET), false);
  });

  test("a directory called 'all' counts even without a spec", () => {
    // The question is "did the user mean a thing on disk", not "could it
    // start". A half-set-up project is still the likelier referent.
    const box = sandbox();
    box.directory(EVERY_TARGET);
    assert.equal(meansEveryTarget(box.workspaces, EVERY_TARGET), false);
  });

  test("no other name widens, including an absent project", () => {
    const box = sandbox();
    for (const name of ["myapp", "ALL", "all/", "", undefined])
      assert.equal(meansEveryTarget(box.workspaces, name), false, `${name}`);
  });
});

describe("a worktree name is ONE path segment", () => {
  test("accepts what a directory may be called", () => {
    for (const name of ["feature123", "wip", "a.b_c-d", "9lives"])
      assert.ok(validWorktree(name), name);
  });

  test("refuses anything that would leave its own directory", () => {
    // Nesting (`.worktrees/a/b`), traversal and hidden names all die on the
    // single-segment rule, which is why there is no second check for them.
    for (const name of ["a/b", "..", ".", ".hidden", "-dash", "", "a b", "a\\b"])
      assert.equal(validWorktree(name), false, name);
  });

  test("refuses one longer than a path segment may be", () => {
    assert.ok(validWorktree("a".repeat(64)));
    assert.equal(validWorktree("a".repeat(65)), false);
  });
});
