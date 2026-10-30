/// <reference types="node" />
// Creating and removing worktrees against a real git repository.
//
// The unit tests read the state `git worktree` leaves behind; this one makes
// git leave it. The scripts the orchestrator runs in a worktree's sandbox
// (worktrees.ts createScript, removeScript) are run HERE, against the same
// paths -- what is measured is what git does with them; the sandbox's own
// reach is the nested and stack tests'. The editor's `worktree` command is
// run as itself for what it still decides alone: names, options, `list`. Everything here is a claim about git's behaviour that the rest
// of the design rests on -- that `lock` writes the file the orchestrator reads,
// that a locked worktree survives a `gc` which cannot see it, and that removal
// needs the unlock. Any of those changing is a silent data-loss bug, so they
// are measured rather than assumed.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { target } from "../../../release/vscode-image/projects.ts";
import {
  CREATE_EXIT,
  REMOVE_EXIT,
  createArguments,
  createScript,
  isLocked,
  isPopulated,
  removal,
  removeArguments,
  removeScript,
  unlocked,
} from "../../../release/vscode-image/worktrees.ts";

const COMMAND = fileURLToPath(
  new URL("../../../release/vscode-image/worktrees.ts", import.meta.url),
);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

/** Run the CLI as the editor container would, against a throwaway workspace
 *  and a broker that is not there: what it refuses, it refuses first. */
const worktree = (workspaces: string, ...args: string[]) => {
  try {
    return {
      ok: true,
      output: execFileSync(process.execPath, [COMMAND, ...args], {
        encoding: "utf8",
        env: { ...process.env, DESOLATE_WORKSPACES: workspaces, DESOLATE_BROKER: join(workspaces, "no-broker.sock") },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (err: any) {
    return { ok: false, output: String(err?.stderr ?? err?.stdout ?? err) };
  }
};

/** A sandbox script, run here with its positional parameters. */
const sandboxed = (script: string, args: string[]) => {
  const result = spawnSync("sh", ["-c", script, "desolate-worktree", ...args], { encoding: "utf8" });
  return { ok: result.status === 0, code: result.status, output: `${result.stdout}${result.stderr}` };
};
/** What the orchestrator runs for `worktree add acme/widgets <name> [<branch>]`. */
const add = (workspaces: string, name: string, branch = name) =>
  sandboxed(createScript, createArguments(target(workspaces, "acme/widgets", name), branch));
/** What it runs to remove one, once `removal` has allowed it. */
const remove = (workspaces: string, name: string) =>
  sandboxed(removeScript, removeArguments(target(workspaces, "acme/widgets", name)));

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
    const { ok, output } = add(box.workspaces, "alpha");
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
    const { code, output } = add(box.workspaces, "alpha");
    assert.equal(code, CREATE_EXIT.exists);
    assert.match(output, /already exists/);
  });

  test("a branch that already exists is checked out rather than recreated", () => {
    git(box.dir, "branch", "existing");
    const { ok, output } = add(box.workspaces, "wt", "existing",
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
    const { ok, output } = add(box.workspaces, "second-main", "main",
    );
    assert.equal(ok, false);
    assert.match(output, /already used by worktree/);
  });

  test("a name that is not one path segment never reaches git", () => {
    for (const name of ["../escape", "a/b", ".hidden", "a--wt--b"]) {
      const { ok, output } = worktree(box.workspaces, "add", "acme/widgets", name);
      assert.equal(ok, false, name);
      assert.doesNotMatch(output, /cannot reach the orchestrator broker/, name);
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
    assert.ok(add(box.workspaces, "alpha").ok);

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
    assert.ok(add(box.workspaces, "wip").ok);

    assert.equal(isLocked(target(box.workspaces, "acme/widgets", "wip")), true);
    assert.deepEqual(unlocked(target(box.workspaces, "acme/widgets")), []);
  });
});

describe("worktree remove", () => {
  test("unlocks first, because `git worktree remove` refuses a locked one", () => {
    const box = repository();
    assert.ok(add(box.workspaces, "alpha").ok);

    const { ok, output } = remove(box.workspaces, "alpha");
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
    // Never checked out means no index, so git has nothing to compare -- but
    // anything beside `.git` was put there by someone.
    const box = repository();
    assert.ok(add(box.workspaces, "draft").ok);
    fs.writeFileSync(join(box.dir, ".worktrees", "draft", "scratch.txt"), "keep me\n");
    const draft = target(box.workspaces, "acme/widgets", "draft");
    assert.deepEqual(removal(draft, false), { kind: "refuse", stray: ["scratch.txt"] });
    fs.rmSync(join(draft.dir, "scratch.txt"));
    assert.deepEqual(removal(draft, false), { kind: "nothing" });
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
    assert.ok(add(box.workspaces, "alpha").ok);

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
describe("E17: nothing the repository configured runs where desolate runs git", () => {
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
    const { ok, output } = add(box.workspaces, "alpha");
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

  /** A populated worktree with a same-size, same-mtime edit in every filtered
   *  file -- the state in which git's own cleanliness check re-reads content
   *  through the clean filters, which is what ran them in the editor before. */
  const racilyEdited = (box: ReturnType<typeof armed>, name: string) => {
    assert.ok(add(box.workspaces, name).ok);
    const wt = target(box.workspaces, "acme/widgets", name);
    sandboxCheckout(wt.dir);
    fs.writeFileSync(
      join(box.dir, ".git", "worktrees", name, "config.worktree"),
      `[filter "wtonly"]\n\tclean = ${box.trap("wtonly-clean")}\n`,
    );
    const index = join(box.dir, ".git", "worktrees", name, "index");
    for (const [file, content] of [["which-tree.txt", "MAIN\n"], ["notes.md", "NOTES\n"]]) {
      fs.writeFileSync(join(wt.dir, file), content);
      const { atime, mtime } = fs.statSync(index);
      fs.utimesSync(join(wt.dir, file), atime, mtime);
    }
    box.clear();
    return wt;
  };

  test("whether a checked-out tree may be removed is git's question, asked in its sandbox", () => {
    // Checking for uncommitted changes is the content read that ran the clean
    // filter. Deciding to ask runs nothing; the asking is `--uncommitted`,
    // in the sandbox.
    const box = armed();
    const wt = racilyEdited(box, "racy");
    assert.deepEqual(removal(wt, false), { kind: "check" });
    assert.deepEqual(box.fired(), []);
  });

  test("remove on a racily-edited tree runs no filter", () => {
    // The strong version: every filter is armed AND git would have had to
    // read content to decide -- so a filter firing here means the removal
    // asked git about content.
    const box = armed();
    const wt = racilyEdited(box, "gone");
    const { ok, output } = remove(box.workspaces, "gone");
    assert.ok(ok, output);
    assert.equal(fs.existsSync(wt.dir), false);
    assert.deepEqual(box.fired(), []);
  });

  test("a config too large to enumerate changes nothing", () => {
    // The first version of this fix listed filter drivers and switched each
    // off by name; past node's 1 MiB output buffer the listing came back
    // empty and every filter ran. Nothing here reads the config any more, so
    // its size is irrelevant -- which is the property pinned.
    const box = armed();
    const padding = Array.from({ length: 50_000 }, (_, i) => `[filter "pad${i}"]\n\tclean = x\n`).join("");
    fs.appendFileSync(join(box.dir, ".git", "config"), padding);
    const wt = racilyEdited(box, "big");
    const { ok, output } = remove(box.workspaces, "big");
    assert.ok(ok, output);
    assert.equal(fs.existsSync(wt.dir), false);
    assert.deepEqual(box.fired(), []);
  });

  test("a config rewritten while git runs changes nothing", async () => {
    // The same version read the config in one process and obeyed it in the
    // next; a devcontainer flipping benign and evil configs won that gap in
    // one try out of ten. Flip harder than that, across ten removals.
    const box = armed();
    const config = join(box.dir, ".git", "config");
    const evil = fs.readFileSync(config, "utf8");
    const benign = evil.replace(/\[filter "evil"\][^[]*/, "");
    const child = spawn(process.execPath, [
      "-e",
      `const fs=require("fs");let i=0;` +
        `for(;;){fs.writeFileSync(process.argv[1]+".tmp",(i++%2)?process.argv[2]:process.argv[3]);` +
        `fs.renameSync(process.argv[1]+".tmp",process.argv[1]);}`,
      config,
      benign,
      evil,
    ]);
    try {
      for (let round = 0; round < 10; round++) {
        const wt = racilyEdited(box, `flip${round}`);
        remove(box.workspaces, `flip${round}`);
        assert.equal(fs.existsSync(wt.dir), false, `round ${round} did not remove it`);
      }
    } finally {
      child.kill("SIGKILL");
    }
    assert.deepEqual(box.fired(), []);
  });

  test("a removal git refuses leaves the worktree locked again", () => {
    // unlock is a step of removal, so a refusal after it has to undo it: an
    // unlocked worktree hidden by the main tree's mask is a prunable one. A
    // lock file that cannot be deleted makes the unlock fail and git refuse a
    // still-locked worktree, with its registration intact.
    const box = armed();
    assert.ok(add(box.workspaces, "stuck").ok);
    const wt = target(box.workspaces, "acme/widgets", "stuck");
    const admin = join(box.dir, ".git", "worktrees", "stuck");
    fs.chmodSync(admin, 0o555);
    try {
      const { code, output } = remove(box.workspaces, "stuck");
      assert.equal(code, REMOVE_EXIT.relocked, output);
      assert.ok(isLocked(wt), "the worktree was left unlocked");
    } finally {
      fs.chmodSync(admin, 0o755);
    }
  });

  test("a removal that fails half way says the directory is no longer a worktree", () => {
    // The other shape, measured: git drops the registration, then cannot
    // delete a file -- the root-owned files compose services leave (#15).
    const box = armed();
    assert.ok(add(box.workspaces, "half").ok);
    const wt = target(box.workspaces, "acme/widgets", "half");
    sandboxCheckout(wt.dir);
    const pinned = join(wt.dir, "pinned");
    fs.mkdirSync(pinned);
    fs.writeFileSync(join(pinned, "file"), "x");
    fs.chmodSync(pinned, 0o555);
    try {
      const { code, output } = remove(box.workspaces, "half");
      assert.equal(code, REMOVE_EXIT.partial, output);
      assert.doesNotMatch(git(box.dir, "worktree", "list"), /half/);
    } finally {
      fs.chmodSync(pinned, 0o755);
    }
  });

  test("an unknown option to remove is a refusal, not a positional", () => {
    const box = repository();
    assert.ok(add(box.workspaces, "alpha").ok);
    const { ok, output } = worktree(box.workspaces, "remove", "acme/widgets", "alpha", "--yes");
    assert.equal(ok, false);
    assert.match(output, /unknown option '--yes'/);
  });
});
