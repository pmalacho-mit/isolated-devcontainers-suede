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

  /** A worktree as `git worktree add` leaves it: a directory whose `.git` is a
   *  FILE naming an admin directory, and that admin directory.
   *
   *  `admin` is separate from `name` because git does not promise they match --
   *  colliding basenames get `<name>` and `<name>1`. */
  const worktree = (
    project: string,
    name: string,
    { locked = true, admin = name } = {},
  ) => {
    const dir = join(workspaces, project, ".worktrees", name);
    const adminDir = join(workspaces, project, ".git", "worktrees", admin);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(join(dir, ".git"), `gitdir: ${adminDir}\n`);
    if (locked) fs.writeFileSync(join(adminDir, "locked"), "desolate: ...\n");
    return target(workspaces, project, name);
  };

  /** A worktree of the same project living somewhere OTHER than `.worktrees`,
   *  which is where a colliding admin directory comes from. */
  const foreign = (project: string, name: string, { locked = true } = {}) => {
    const dir = join(workspaces, project, "elsewhere", name);
    const adminDir = join(workspaces, project, ".git", "worktrees", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(join(dir, ".git"), `gitdir: ${adminDir}\n`);
    if (locked) fs.writeFileSync(join(adminDir, "locked"), "by hand\n");
  };

  return { workspaces, project, worktree, foreign };
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

  test("a colliding basename does not make a STRANGER's lock ours", () => {
    // git disambiguates admin directories by suffix, so `.worktrees/wip` can
    // sit behind `.git/worktrees/wip1` while `.git/worktrees/wip` belongs to a
    // worktree made by hand somewhere else in the repo. Rebuilding the path
    // from the name reads that one: the unlocked worktree reports locked, the
    // mask goes on, and the prune takes it. Which way round the two were
    // created decides it, so this is a bug you meet once and cannot undo.
    const box = sandbox();
    const root = box.project("acme/widgets");
    box.foreign("acme/widgets", "wip", { locked: true });
    const ours = box.worktree("acme/widgets", "wip", {
      locked: false,
      admin: "wip1",
    });

    assert.equal(isLocked(ours), false);
    assert.deepEqual(unlocked(root).map(({ name }) => name), [ours.name]);
    assert.deepEqual(runArgs(root), []);
  });

  test("a worktree with no readable .git counts as unlocked", () => {
    // Fail-safe by construction: an answer we cannot establish must never turn
    // the mask on. A root target lands here too -- its `.git` is a directory.
    const box = sandbox();
    const root = box.project("acme/widgets");
    const ours = box.worktree("acme/widgets", "wip");
    fs.rmSync(join(ours.dir, ".git"));

    assert.equal(isLocked(ours), false);
    assert.equal(isLocked(root), false);
    assert.deepEqual(runArgs(root), []);
  });
});
