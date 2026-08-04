/// <reference types="node" />
// What a target's container is given beyond its own workspace folder.
//
// The masking rule is the one worth reading slowly. Hiding `.worktrees` from
// the main tree's container makes those worktrees look MISSING to git there,
// and a missing worktree is prunable -- pruning deletes the admin directory a
// running worktree container is using. The lock is what exempts it. So the mask
// is conditional on every worktree being locked, and these tests are that
// condition. tests/integration/worktrees measures the prune itself.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { target } from "../../../release/vscode-image/projects.ts";
import {
  isLocked,
  mounts,
  runArgs,
  unlocked,
} from "../../../release/vscode-image/worktrees.ts";

/** What `devcontainer up --mount` accepts, copied from the CLI's own parser
 *  (@devcontainers/cli 0.88.0). Anything else is refused outright with
 *  "Unmatched argument format" -- which is why the `.worktrees` mask is a
 *  runArg and not a fourth mount. */
const CLI_MOUNT =
  /^type=(bind|volume),source=([^,]+),target=([^,]+)(?:,external=(true|false))?$/;

const sandbox = () => {
  const workspaces = fs.mkdtempSync(join(tmpdir(), "desolate-worktrees-"));

  const project = (name: string) => {
    fs.mkdirSync(join(workspaces, name, ".git"), { recursive: true });
    return target(workspaces, name);
  };

  /** A worktree as `git worktree add` leaves it: a directory, plus an admin
   *  directory under `.git/worktrees` that carries `locked` when it is. */
  const worktree = (project: string, name: string, { locked = true } = {}) => {
    fs.mkdirSync(join(workspaces, project, ".worktrees", name), {
      recursive: true,
    });
    const admin = join(workspaces, project, ".git", "worktrees", name);
    fs.mkdirSync(admin, { recursive: true });
    if (locked) fs.writeFileSync(join(admin, "locked"), "desolate: ...\n");
    return target(workspaces, project, name);
  };

  return { workspaces, project, worktree };
};

describe("a worktree's container", () => {
  test("gets the project's .git at one absolute path, and nothing else", () => {
    // Its own `.git` is a FILE naming a path inside this directory, and that
    // path's `commondir` names another. Both are absolute, so the bind's source
    // and destination have to be the same string.
    const box = sandbox();
    box.project("acme/widgets");
    const feature = box.worktree("acme/widgets", "feature123");

    const git = join(box.workspaces, "acme/widgets", ".git");
    assert.deepEqual(mounts(feature), [
      `type=bind,source=${git},target=${git}`,
    ]);
  });

  test("in the only shape the devcontainer CLI will parse", () => {
    const box = sandbox();
    box.project("acme/widgets");
    for (const mount of mounts(box.worktree("acme/widgets", "feature123")))
      assert.match(mount, CLI_MOUNT, mount);
  });

  test("does not reach a SIBLING worktree's directory", () => {
    const box = sandbox();
    box.project("acme/widgets");
    box.worktree("acme/widgets", "other");
    const feature = box.worktree("acme/widgets", "feature123");

    for (const mount of mounts(feature))
      assert.ok(!mount.includes("other"), `sibling reachable via ${mount}`);
    // and a worktree never masks anything -- there is nothing below it to hide
    assert.deepEqual(runArgs(feature), []);
  });
});

describe("the main tree's view of .worktrees", () => {
  test("is untouched when the project has none", () => {
    const box = sandbox();
    const root = box.project("acme/widgets");
    assert.deepEqual(mounts(root), []);
    assert.deepEqual(runArgs(root), []);
  });

  test("is masked with an empty tmpfs once they are all locked", () => {
    const box = sandbox();
    const root = box.project("acme/widgets");
    box.worktree("acme/widgets", "feature123");
    box.worktree("acme/widgets", "other");

    assert.deepEqual(unlocked(root), []);
    assert.deepEqual(runArgs(root), [
      "--tmpfs",
      join(box.workspaces, "acme/widgets", ".worktrees"),
    ]);
    // ...and never as a mount: the CLI would refuse a tmpfs there.
    assert.deepEqual(mounts(root), []);
  });

  test("is NOT masked while any worktree is unlocked", () => {
    // The failure this prevents has no error message: the mask makes the
    // unlocked worktree prunable, and the next `git commit` in the main tree
    // deletes its admin directory. Showing a duplicate filename is the lesser
    // evil by a wide margin.
    const box = sandbox();
    const root = box.project("acme/widgets");
    box.worktree("acme/widgets", "feature123");
    const byHand = box.worktree("acme/widgets", "by-hand", { locked: false });

    assert.deepEqual(
      unlocked(root).map(({ name }) => name),
      [byHand.name],
    );
    assert.deepEqual(runArgs(root), []);
  });

  test("reads the lock as a FILE, never by running git", () => {
    // The orchestrator holds the inner Docker socket, and git obeys the
    // project's own config and hooks. It asks the filesystem instead.
    const box = sandbox();
    box.project("acme/widgets");
    const locked = box.worktree("acme/widgets", "feature123");
    const loose = box.worktree("acme/widgets", "by-hand", { locked: false });

    assert.equal(isLocked(locked), true);
    assert.equal(isLocked(loose), false);
  });
});
