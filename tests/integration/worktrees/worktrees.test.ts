/// <reference types="node" />
// The `worktree` command against a real git repository.
//
// The unit tests read the state `git worktree` leaves behind; this one makes
// git leave it. Everything here is a claim about git's behaviour that the rest
// of the design rests on -- that `lock` writes the file the orchestrator reads,
// that a locked worktree survives a `gc` which cannot see it, and that removal
// needs the unlock. Any of those changing is a silent data-loss bug, so they
// are measured rather than assumed.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { target } from "../../../release/vscode-image/projects.ts";
import {
  isLocked,
  isPopulated,
  unlocked,
} from "../../../release/vscode-image/worktrees.ts";

const COMMAND = fileURLToPath(
  new URL("../../../release/vscode-image/worktrees.ts", import.meta.url),
);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

/** Run the CLI as the editor container would, against a throwaway workspace. */
const worktree = (workspaces: string, ...args: string[]) => {
  try {
    return {
      ok: true,
      output: execFileSync(process.execPath, [COMMAND, ...args], {
        encoding: "utf8",
        env: { ...process.env, DESOLATE_WORKSPACES: workspaces },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (err: any) {
    return { ok: false, output: String(err?.stderr ?? err?.stdout ?? err) };
  }
};

const repository = () => {
  const workspaces = fs.mkdtempSync(join(tmpdir(), "desolate-wt-live-"));
  const dir = join(workspaces, "acme", "widgets");
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main", ".");
  git(dir, "config", "user.email", "tester@example.com");
  git(dir, "config", "user.name", "tester");
  fs.writeFileSync(join(dir, "which-tree.txt"), "main\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return { workspaces, dir };
};

describe("worktree add", () => {
  let box: ReturnType<typeof repository>;
  before(() => {
    box = repository();
  });

  test("creates the directory and a branch named after it", () => {
    const { ok, output } = worktree(box.workspaces, "add", "acme/widgets", "alpha");
    assert.ok(ok, output);
    assert.ok(fs.existsSync(join(box.dir, ".worktrees", "alpha")));
    assert.match(git(box.dir, "branch", "--list", "alpha"), /alpha/);
  });

  test("locks it, in the file the orchestrator reads", () => {
    // The orchestrator must never run git against project content, so it looks
    // for this path. If git ever stops writing it, the mask silently becomes
    // unsafe -- which is what this pins.
    const locked = join(box.dir, ".git", "worktrees", "alpha", "locked");
    assert.ok(fs.existsSync(locked), `${locked} was not written`);
    assert.match(fs.readFileSync(locked, "utf8"), /desolate/);
  });

  test("excludes the layout without touching a tracked file", () => {
    const exclude = join(box.dir, ".git", "info", "exclude");
    assert.match(fs.readFileSync(exclude, "utf8"), /^\.worktrees\/$/m);
    assert.equal(fs.existsSync(join(box.dir, ".gitignore")), false);
  });

  test("adding it twice is refused, not silently repeated", () => {
    const { ok, output } = worktree(box.workspaces, "add", "acme/widgets", "alpha");
    assert.equal(ok, false);
    assert.match(output, /already exists/);
  });

  test("a branch that already exists is checked out rather than recreated", () => {
    git(box.dir, "branch", "existing");
    const { ok, output } = worktree(
      box.workspaces, "add", "acme/widgets", "wt", "existing",
    );
    assert.ok(ok, output);
    assert.match(
      git(join(box.dir, ".worktrees", "wt"), "rev-parse", "--abbrev-ref", "HEAD"),
      /^existing/,
    );
  });

  test("git's own refusal to check out one branch twice is surfaced", () => {
    // "fatal: 'main' is already used by worktree at ..." says precisely why the
    // main tree may not be checked out twice; nothing here improves on it.
    const { ok, output } = worktree(
      box.workspaces, "add", "acme/widgets", "second-main", "main",
    );
    assert.equal(ok, false);
    assert.match(output, /already used by worktree/);
  });

  test("a name that is not one path segment never reaches git", () => {
    for (const name of ["../escape", "a/b", ".hidden", "a--wt--b"]) {
      const { ok, output } = worktree(box.workspaces, "add", "acme/widgets", name);
      assert.equal(ok, false, name);
      assert.match(output, /not a usable worktree name/, name);
    }
  });
});

describe("the lock is what survives a prune", () => {
  /** The exact state the main tree's tmpfs mask produces: the directory is gone
   *  as far as this repository can tell. Run the prunes, then put it back. */
  const pruneWhileHidden = (box: ReturnType<typeof repository>) => {
    const hidden = join(box.workspaces, "hidden");
    fs.renameSync(join(box.dir, ".worktrees"), hidden);
    // Both spellings, because they expire differently: `worktree prune` acts at
    // once, while `gc` waits for gc.worktreePruneExpire (three months by
    // default) -- so a mask left in place is a slow version of the same loss.
    git(box.dir, "worktree", "prune");
    git(box.dir, "-c", "gc.worktreePruneExpire=now", "gc", "--prune=now");
    fs.renameSync(hidden, join(box.dir, ".worktrees"));
  };

  test("a prune that cannot see the worktree leaves it registered and usable", () => {
    const box = repository();
    assert.ok(worktree(box.workspaces, "add", "acme/widgets", "alpha").ok);

    pruneWhileHidden(box);

    assert.match(git(box.dir, "worktree", "list"), /alpha/);
    assert.doesNotThrow(() =>
      git(join(box.dir, ".worktrees", "alpha"), "status", "--porcelain"),
    );
  });

  test("without the lock, the same prune destroys it", () => {
    // Not a hypothetical -- this is why every desolate worktree is locked, and
    // why the mask is skipped when any of them is not. The directory comes back
    // and git still cannot open it: what was deleted was its HEAD and index.
    const box = repository();
    git(box.dir, "worktree", "add", "-b", "loose", ".worktrees/loose");

    pruneWhileHidden(box);

    assert.doesNotMatch(git(box.dir, "worktree", "list"), /loose/);
    assert.throws(() =>
      git(join(box.dir, ".worktrees", "loose"), "status", "--porcelain"),
    );
  });
});

describe("which admin directory belongs to which worktree", () => {
  test("git disambiguates colliding basenames, and isLocked follows it", () => {
    // The layout the orchestrator's mask decision rests on. Rebuilding the
    // admin path from the worktree's NAME reads a stranger's lock here, and in
    // this direction it is not fail-safe: the foreign `wip` is locked, ours is
    // not, and a `true` would turn the mask on over a prunable worktree.
    const box = repository();
    git(box.dir, "worktree", "add", "-q", "-b", "other", "elsewhere/wip");
    git(box.dir, "worktree", "add", "-q", "-b", "ours", ".worktrees/wip");
    git(box.dir, "worktree", "lock", "--reason", "by hand", "elsewhere/wip");

    // Not an assumption -- read back what git actually did.
    assert.match(
      fs.readFileSync(join(box.dir, ".worktrees", "wip", ".git"), "utf8"),
      /worktrees\/wip1$/m,
      "git stopped disambiguating; the rest of this test proves nothing",
    );
    assert.ok(fs.existsSync(join(box.dir, ".git/worktrees/wip/locked")));

    assert.equal(isLocked(target(box.workspaces, "acme/widgets", "wip")), false);
    assert.deepEqual(
      unlocked(target(box.workspaces, "acme/widgets")).map(({ name }) => name),
      ["acme/widgets@wip"],
    );
  });

  test("and reports OUR lock as ours, under the suffixed directory", () => {
    const box = repository();
    git(box.dir, "worktree", "add", "-q", "-b", "other", "elsewhere/wip");
    assert.ok(worktree(box.workspaces, "add", "acme/widgets", "wip").ok);

    assert.equal(isLocked(target(box.workspaces, "acme/widgets", "wip")), true);
    assert.deepEqual(unlocked(target(box.workspaces, "acme/widgets")), []);
  });
});

describe("worktree remove", () => {
  test("unlocks first, because `git worktree remove` refuses a locked one", () => {
    const box = repository();
    assert.ok(worktree(box.workspaces, "add", "acme/widgets", "alpha").ok);

    const { ok, output } = worktree(box.workspaces, "remove", "acme/widgets", "alpha");
    assert.ok(ok, output);
    assert.equal(fs.existsSync(join(box.dir, ".worktrees", "alpha")), false);
    assert.doesNotMatch(git(box.dir, "worktree", "list"), /alpha/);
    assert.equal(
      fs.existsSync(join(box.dir, ".git", "worktrees", "alpha")),
      false,
      "the admin directory was left behind",
    );
  });

  test("one that was never started still keeps a file put there by hand", () => {
    // Never checked out means no index, which is why remove forces it -- but
    // only while `.git` is all the directory holds.
    const box = repository();
    assert.ok(worktree(box.workspaces, "add", "acme/widgets", "draft").ok);
    fs.writeFileSync(join(box.dir, ".worktrees", "draft", "scratch.txt"), "keep me\n");

    const { ok } = worktree(box.workspaces, "remove", "acme/widgets", "draft");
    assert.equal(ok, false);
    assert.ok(fs.existsSync(join(box.dir, ".worktrees", "draft", "scratch.txt")));
  });

  test("a worktree that is not there is a refusal, not a no-op", () => {
    const box = repository();
    const { ok, output } = worktree(box.workspaces, "remove", "acme/widgets", "ghost");
    assert.equal(ok, false);
    assert.match(output, /no such worktree/);
  });
});

describe("worktree list", () => {
  test("reports the main tree and every worktree", () => {
    const box = repository();
    assert.ok(worktree(box.workspaces, "add", "acme/widgets", "alpha").ok);

    const { ok, output } = worktree(box.workspaces, "list", "acme/widgets");
    assert.ok(ok, output);
    assert.match(output, /alpha/);
    assert.match(output, /\[main\]/);
  });

  test("a directory that is not a repository is refused clearly", () => {
    const box = repository();
    fs.mkdirSync(join(box.workspaces, "acme", "plain"), { recursive: true });
    const { ok, output } = worktree(box.workspaces, "list", "acme/plain");
    assert.equal(ok, false);
    assert.match(output, /not a git repository/);
  });
});

// E17. A devcontainer can write its project's `.git`, and the editor -- which
// mounts every project and holds the deploy keys -- runs git against it. Each
// trap below is a command the repository's own config names, armed to leave a
// marker OUTSIDE the repository when it runs. Measured on git 2.51 before the
// fix: a plain `worktree add` fired the hook, the smudge filter and fsmonitor;
// a TTY'd `worktree list` fired `pager.worktree`; removing a racily clean
// worktree fired the clean filter.
describe("E17: nothing the repository configured runs in the editor", () => {
  const armed = () => {
    const box = repository();
    const markers = fs.mkdtempSync(join(tmpdir(), "desolate-wt-markers-"));
    const trap = (name: string) => `sh -c 'touch ${markers}/${name}; cat'`;

    fs.writeFileSync(join(box.dir, ".gitattributes"), "*.txt filter=evil\n*.md filter=wtonly\n");
    fs.writeFileSync(join(box.dir, "notes.md"), "notes\n");
    git(box.dir, "add", "-A");
    git(box.dir, "commit", "-qm", "attributes");

    for (const hook of ["post-checkout", "reference-transaction", "post-index-change"]) {
      const file = join(box.dir, ".git", "hooks", hook);
      fs.writeFileSync(file, `#!/bin/sh\ntouch ${markers}/hook-${hook}\n`);
      fs.chmodSync(file, 0o755);
    }
    const fsmonitor = join(markers, "..", `${markers.split("/").pop()}-fsmonitor.sh`);
    fs.writeFileSync(fsmonitor, `#!/bin/sh\ntouch ${markers}/fsmonitor\n`);
    fs.chmodSync(fsmonitor, 0o755);

    git(box.dir, "config", "filter.evil.smudge", trap("smudge"));
    git(box.dir, "config", "filter.evil.clean", trap("clean"));
    git(box.dir, "config", "core.fsmonitor", fsmonitor);
    git(box.dir, "config", "core.pager", trap("core-pager"));
    git(box.dir, "config", "pager.worktree", trap("pager-worktree"));
    // A driver only a WORKTREE's own config defines, for `remove`, which runs
    // its cleanliness check inside the worktree.
    git(box.dir, "config", "extensions.worktreeConfig", "true");

    const fired = () => fs.readdirSync(markers).sort();
    const clear = () => {
      for (const marker of fs.readdirSync(markers)) fs.rmSync(join(markers, marker));
    };
    return { ...box, markers, trap, fired, clear };
  };

  /** What `populateWorktree` runs in its sandbox, run here instead: the
   *  traps' own control, since a test that never saw them fire proves nothing. */
  const sandboxCheckout = (dir: string) => git(dir, "checkout", "--force");

  test("the traps are live: a plain checkout fires every one", () => {
    const box = armed();
    git(box.dir, "worktree", "add", "-q", "--no-checkout", "-b", "control", ".worktrees/control");
    box.clear();
    sandboxCheckout(join(box.dir, ".worktrees", "control"));
    for (const marker of ["fsmonitor", "hook-post-checkout", "smudge"])
      assert.ok(box.fired().includes(marker), `${marker} did not fire: ${box.fired()}`);
  });

  test("add runs none of them, and leaves the worktree for the sandbox", () => {
    const box = armed();
    const { ok, output } = worktree(box.workspaces, "add", "acme/widgets", "alpha");
    assert.ok(ok, output);
    assert.deepEqual(box.fired(), []);

    const alpha = target(box.workspaces, "acme/widgets", "alpha");
    assert.deepEqual(fs.readdirSync(alpha.dir), [".git"]);
    assert.equal(isPopulated(alpha), false);
    assert.ok(isLocked(alpha), "the unpopulated worktree must still be locked");

    sandboxCheckout(alpha.dir);
    assert.equal(isPopulated(alpha), true);
    assert.equal(fs.readFileSync(join(alpha.dir, "which-tree.txt"), "utf8"), "main\n");
  });

  test("list runs no pager, even on a terminal", (t) => {
    // The pager only engages on a TTY, so the attack needs one: util-linux
    // `script` gives the command a pseudo-terminal.
    try {
      execFileSync("script", ["--version"], { stdio: "ignore" });
    } catch {
      return t.skip("needs util-linux `script` for a pseudo-terminal");
    }
    const box = armed();
    const command = [process.execPath, COMMAND, "list", "acme/widgets"]
      .map((word) => `'${word}'`)
      .join(" ");
    execFileSync("script", ["-qec", command, "/dev/null"], {
      env: { ...process.env, DESOLATE_WORKSPACES: box.workspaces },
      stdio: "ignore",
    });
    assert.deepEqual(box.fired(), []);
  });

  test("remove refuses a racily-clean edit without running a filter", () => {
    const box = armed();
    assert.ok(worktree(box.workspaces, "add", "acme/widgets", "racy").ok);
    const racy = target(box.workspaces, "acme/widgets", "racy");
    sandboxCheckout(racy.dir);
    fs.writeFileSync(
      join(box.dir, ".git", "worktrees", "racy", "config.worktree"),
      `[filter "wtonly"]\n\tclean = ${box.trap("wtonly-clean")}\n`,
    );

    // Same size, and the index's own mtime: git cannot tell from stat alone,
    // so it re-reads both files through their clean filters to compare.
    const index = join(box.dir, ".git", "worktrees", "racy", "index");
    for (const [file, content] of [["which-tree.txt", "MAIN\n"], ["notes.md", "NOTES\n"]]) {
      fs.writeFileSync(join(racy.dir, file), content);
      const { atime, mtime } = fs.statSync(index);
      fs.utimesSync(join(racy.dir, file), atime, mtime);
    }
    box.clear();

    const { ok, output } = worktree(box.workspaces, "remove", "acme/widgets", "racy");
    assert.equal(ok, false, "the edit was lost: remove did not see it");
    assert.match(output, /could not remove/);
    assert.deepEqual(box.fired(), []);
  });

  test("remove of a clean worktree runs none of them either", () => {
    const box = armed();
    assert.ok(worktree(box.workspaces, "add", "acme/widgets", "tidy").ok);
    sandboxCheckout(target(box.workspaces, "acme/widgets", "tidy").dir);
    box.clear();

    const { ok, output } = worktree(box.workspaces, "remove", "acme/widgets", "tidy");
    assert.ok(ok, output);
    assert.deepEqual(box.fired(), []);
  });

  test("a filter driver that cannot be switched off is a refusal", () => {
    // `-c` splits at the first '=', so `-c filter.a=b.clean=` would set some
    // other key and leave this driver live.
    const box = armed();
    git(box.dir, "config", "filter.a=b.clean", box.trap("equals"));
    const { ok, output } = worktree(box.workspaces, "add", "acme/widgets", "beta");
    assert.equal(ok, false);
    assert.match(output, /cannot be switched off/);
    assert.deepEqual(box.fired(), []);
  });
});
