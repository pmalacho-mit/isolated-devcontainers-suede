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
  CHECKOUT_IMAGE,
  awaitsCheckout,
  checkoutMounts,
  createArguments,
  createScript,
  hardenedGit,
  removal,
  removeScript,
  validBranch,
  projectRoot,
  sandboxMounts,
  isLocked,
  isPopulated,
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
  test("is given no bind beyond its workspace mount -- never the project's .git", () => {
    // A bind's source is resolved on the daemon, following symlinks, and the
    // project's own agent can make its `.git` a link to another project's.
    // The worktree's `.git` arrives inside the project root instead, which is
    // its workspace mount (projectRoot, below).
    const box = sandbox();
    box.project("acme/widgets");
    const feature = box.worktree("acme/widgets", "feature123");
    assert.deepEqual(mounts(feature), []);
  });

  test("is mounted as its project's root, at that root's own path", () => {
    // Its own `.git` is a FILE naming an absolute path inside the project's
    // `.git`, so the root has to sit at the same path inside and out.
    const box = sandbox();
    box.project("acme/widgets");
    const feature = box.worktree("acme/widgets", "feature123");
    const project = join(box.workspaces, "acme/widgets");
    assert.equal(projectRoot(feature), `type=bind,source=${project},target=${project}`);
    assert.ok(feature.dir.startsWith(`${project}/`), feature.dir);
  });

  test("in the only shape the devcontainer CLI will parse", () => {
    const box = sandbox();
    box.project("acme/widgets");
    const feature = box.worktree("acme/widgets", "feature123");
    for (const mount of [...mounts(feature), projectRoot(feature)])
      assert.match(mount, CLI_MOUNT, mount);
  });

  test("masks nothing", () => {
    // Its siblings and main tree are in its project root, and so in reach:
    // they share its `.git`, and so its trust, already (the header).
    const box = sandbox();
    box.project("acme/widgets");
    box.worktree("acme/widgets", "other");
    assert.deepEqual(runArgs(box.worktree("acme/widgets", "feature123")), []);
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

describe("git in the editor executes nothing the repository configured", () => {
  test("the hardening is a fixed command line that reads nothing first", () => {
    // Reading the repository's config to decide what to switch off was a race
    // a devcontainer rewriting it could win, and a lookup that could fail
    // open. So the argv cannot depend on the repository at all: a project
    // directory that does not exist yields the same one.
    const box = sandbox();
    const real = hardenedGit(box.project("acme/widgets"));
    const absent = hardenedGit(target(box.workspaces, "acme/nowhere"));
    assert.deepEqual(real.slice(2), absent.slice(2));
    const settings = real.filter((_, i) => real[i - 1] === "-c");
    assert.deepEqual(settings, [
      "core.hooksPath=/dev/null",
      "core.fsmonitor=false",
      "gc.auto=0",
      "maintenance.auto=false",
    ]);
    assert.ok(real.includes("--no-pager"));
  });

  test("add never checks out", () => {
    const adds = createScript.split("\n").filter((line) => line.includes("worktree add"));
    assert.equal(adds.length, 2, createScript);
    for (const line of adds) assert.match(line, /--no-checkout/);
  });

  test("the sandbox image is pinned by digest", () => {
    assert.match(CHECKOUT_IMAGE, /@sha256:[0-9a-f]{64}$/);
  });
});

describe("whether a worktree has been checked out", () => {
  test("not until its admin directory holds an index", () => {
    const box = sandbox();
    const feature = box.worktree("acme/widgets", "feature123");
    assert.equal(isPopulated(feature), false);
    fs.writeFileSync(join(box.workspaces, "acme/widgets/.git/worktrees/feature123/index"), "");
    assert.equal(isPopulated(feature), true);
  });

  test("a root target always is", () => {
    assert.equal(isPopulated(sandbox().project("acme/widgets")), true);
  });
});

describe("the checkout sandbox's reach", () => {
  test("is its devcontainer's: the project root, and the CA read-only", () => {
    const box = sandbox();
    const feature = box.worktree("acme/widgets", "feature123");
    const project = join(box.workspaces, "acme/widgets");
    assert.deepEqual(sandboxMounts(feature), [projectRoot(feature)]);
    assert.deepEqual(checkoutMounts(feature, "acme__widgets--wt--feature123-desolate-ca", "/desolate-ca"), [
      `type=bind,source=${project},target=${project}`,
      "type=volume,source=acme__widgets--wt--feature123-desolate-ca,target=/desolate-ca,readonly",
    ]);
  });

  test("binds no path below the project root, which its project could make a link", () => {
    // The attack, measured on the shared daemon: `/workspaces/p/.git` made a
    // link to `/workspaces/victim/.git`, and a bind of it mounted the
    // victim's. Every bind source here must be the root, which the project
    // works inside and so cannot replace.
    const box = sandbox();
    box.worktree("acme/widgets", "other");
    const feature = box.worktree("acme/widgets", "feature123");
    const project = join(box.workspaces, "acme/widgets");
    const binds = checkoutMounts(feature, "ca", "/desolate-ca").filter((m) => m.startsWith("type=bind,"));
    assert.deepEqual(binds.map((mount) => /source=([^,]+)/.exec(mount)![1]), [project]);
  });
});

describe("which worktrees a sandbox should check out", () => {
  test("one that git registered and never checked out", () => {
    const box = sandbox();
    box.project("acme/widgets");
    assert.equal(awaitsCheckout(box.worktree("acme/widgets", "fresh")), true);
  });

  test("not one already checked out", () => {
    const box = sandbox();
    box.project("acme/widgets");
    const done = box.worktree("acme/widgets", "done");
    fs.writeFileSync(join(box.workspaces, "acme/widgets/.git/worktrees/done/index"), "");
    assert.equal(awaitsCheckout(done), false);
  });

  test("not a directory that is no worktree at all", () => {
    // No .git file, or one naming an admin directory that is gone: checking
    // it out would fail, so it is started -- or refused -- as it always was.
    const box = sandbox();
    box.project("acme/widgets");
    fs.mkdirSync(join(box.workspaces, "acme/widgets/.worktrees/handmade"), { recursive: true });
    assert.equal(awaitsCheckout(target(box.workspaces, "acme/widgets", "handmade")), false);
    const orphan = box.worktree("acme/widgets", "orphan");
    fs.rmSync(join(box.workspaces, "acme/widgets/.git/worktrees/orphan"), { recursive: true });
    assert.equal(awaitsCheckout(orphan), false);
  });

  test("never a root target", () => {
    assert.equal(awaitsCheckout(sandbox().project("acme/widgets")), false);
  });
});

describe("creating and removing one, in its sandbox", () => {
  test("the scripts take every path and name as an argument, never as text", () => {
    // A name spliced into a script is a name that can end the quote it sits
    // in. These are fixed strings; what varies arrives as $1, $2, ...
    const box = sandbox();
    const alpha = target(box.workspaces, "acme/widgets", "alpha");
    for (const script of [createScript, removeScript])
      for (const word of [box.workspaces, "acme", "alpha"])
        assert.ok(!script.includes(word), `'${word}' is in the script`);
    assert.deepEqual(createArguments(alpha, "feature/1").slice(0, 3), [
      alpha.projectDir,
      alpha.dir,
      "feature/1",
    ]);
  });

  test("a branch that git would read as something else never reaches it", () => {
    for (const branch of ["-b", "--orphan", "a b", "a\nb", "", "x".repeat(256), 7])
      assert.equal(validBranch(branch), false, JSON.stringify(branch));
    for (const branch of ["main", "feature/123", "hotfix-1.2"])
      assert.equal(validBranch(branch), true, branch);
  });

  test("removal asks git only of a worktree that was checked out", () => {
    const box = sandbox();
    box.project("acme/widgets");
    const fresh = box.worktree("acme/widgets", "fresh");
    assert.deepEqual(removal(fresh, false), { kind: "nothing" });
    assert.deepEqual(removal(fresh, true), { kind: "force" });

    const started = box.worktree("acme/widgets", "started");
    fs.writeFileSync(join(started.projectDir, ".git", "worktrees", "started", "index"), "");
    assert.deepEqual(removal(started, false), { kind: "check" });
  });

  test("one never checked out still keeps a file put there by hand", () => {
    // Never checked out means no index, so git has nothing to compare -- but
    // anything beside `.git` was put there by someone, and is theirs.
    const box = sandbox();
    box.project("acme/widgets");
    const draft = box.worktree("acme/widgets", "draft");
    fs.writeFileSync(join(draft.dir, "scratch.txt"), "keep me\n");
    assert.deepEqual(removal(draft, false), { kind: "refuse", stray: ["scratch.txt"] });
  });
});
