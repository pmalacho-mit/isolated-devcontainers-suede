/// <reference types="node" />
// What the editor's panel reads of each target as files (panel.ts): the
// branch and commit checked out, GitHub's as the editor's cache last saw it,
// the repository a project pushes to, the note, and its ports' labels --
// against a real repository with a worktree, and a cache as push leaves one.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "desolate-panel-"));
process.env.DESOLATE_REMOTE_CACHE = join(root, "cache");
const { factsOf, githubRepoOf, githubTipOf, packedRef, parseHead, plausibleBranch, portLabels } =
  await import("../../../release/vscode-image/panel.ts");
const { list } = await import("../../../release/vscode-image/projects.ts");
const { readNote } = await import("../../../release/vscode-image/status.ts");

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" }).trim();

const workspaces = join(root, "workspaces");
const project = join(workspaces, "acme", "widgets");
let main = "", wip = "";
before(() => {
  mkdirSync(join(project, ".devcontainer"), { recursive: true });
  git(root, "init", "--quiet", project);
  writeFileSync(join(project, ".devcontainer", "devcontainer.json"),
    '{\n  // the app\n  "image": "alpine:3",\n  "portsAttributes": { "5173": { "label": "vite" }, "9000-9002": { "label": "workers" }, "80": { "label": "\\u0007x" } },\n}\n');
  git(project, "add", ".");
  git(project, "commit", "--quiet", "-m", "one");
  main = git(project, "rev-parse", "HEAD");
  git(project, "worktree", "add", "--quiet", "-b", "wip", join(project, ".worktrees", "wip"));
  writeFileSync(join(project, ".worktrees", "wip", "x.txt"), "x\n");
  git(join(project, ".worktrees", "wip"), "add", ".");
  git(join(project, ".worktrees", "wip"), "commit", "--quiet", "-m", "two");
  wip = git(project, "rev-parse", "wip");
  // GitHub, as the editor's cache last saw it: main pushed, wip never.
  const cache = join(root, "cache", "acme__widgets.git");
  git(root, "init", "--quiet", "--bare", cache);
  git(project, "push", "--quiet", cache, "main");
});
after(() => rmSync(root, { recursive: true, force: true }));

const targets = () => list(workspaces);
const target = (worktree?: string) => targets().find((t) => t.project === "acme/widgets" && t.worktree === worktree)!;

describe("what is checked out", () => {
  test("a project's branch and commit, and a worktree's, read as files", () => {
    assert.deepEqual(factsOf(target()).head, { branch: "main", commit: main });
    assert.deepEqual(factsOf(target("wip")).head, { branch: "wip", commit: wip });
  });

  test("a packed ref is found as well as a loose one", () => {
    git(project, "pack-refs", "--all");
    assert.deepEqual(factsOf(target("wip")).head, { branch: "wip", commit: wip });
    assert.equal(packedRef(`# pack-refs\n${wip} refs/heads/wip\n`, "wip"), wip);
    assert.equal(packedRef(`${wip} refs/heads/wip-other\n`, "wip"), undefined);
  });

  test("HEAD is held to its shape: a branch that would leave refs/heads is no branch", () => {
    assert.deepEqual(parseHead("ref: refs/heads/feature/x\n"), { branch: "feature/x" });
    assert.deepEqual(parseHead(`${main}\n`), { detached: main });
    for (const bad of ["../../../etc/passwd", "a/../../b", "/abs", "-x", "a b", "x.lock"])
      assert.equal(plausibleBranch(bad), false, bad);
    assert.deepEqual(parseHead("ref: refs/heads/../../../../etc/passwd\n"), {});
  });
});

describe("whether GitHub has it, as the editor's cache last saw it", () => {
  test("main is there at the same commit; wip is not there at all", () => {
    assert.equal(factsOf(target()).github, "same");
    assert.equal(factsOf(target("wip")).github, "new");
  });

  test("a commit GitHub does not have yet: differs", () => {
    writeFileSync(join(project, "y.txt"), "y\n");
    git(project, "add", ".");
    git(project, "commit", "--quiet", "-m", "three");
    assert.equal(factsOf(target()).github, "differs");
  });

  test("a project never pushed or pulled through the editor is not known", () => {
    assert.deepEqual(githubTipOf("acme/other", "main"), { state: "unknown" });
    assert.deepEqual(githubTipOf("not a project", "main"), { state: "unknown" });
  });
});

describe("the repository a project pushes to", () => {
  test("the one its registration names, which can differ from its name", () => {
    const config = join(root, "gitconfig");
    writeFileSync(config, '[user]\n\tname = x\n[url "git@github.com-acme__widgets:acme/widgets-renamed"]\n\tinsteadOf = git@github.com:acme/widgets-renamed\n');
    assert.equal(githubRepoOf("acme/widgets", [config]), "acme/widgets-renamed");
    assert.equal(githubRepoOf("acme/gadgets", [config]), "acme/gadgets", "unregistered: its name");
    assert.equal(githubRepoOf("solo", [config]), undefined);
  });
});

describe("its ports' labels, and its note", () => {
  test("from portsAttributes, by port or range, as short printable text", () => {
    const label = factsOf(target()).portLabel;
    assert.equal(label(5173), "vite");
    assert.equal(label(9001), "workers");
    assert.equal(label(80), "x");
    assert.equal(label(3000), undefined);
    assert.equal(portLabels({ portsAttributes: [1, 2] })(1), undefined);
  });

  test("the note beside the status: its lines kept, control characters gone", () => {
    writeFileSync(join(project, ".git", "desolate-note.md"), "doing the parser\r\nthen \u001b[31mtests\n");
    assert.equal(readNote(target()), "doing the parser\nthen  [31mtests");
    assert.equal(factsOf(target()).note, "doing the parser\nthen  [31mtests");
  });

  test("a note that is a link out of the project is not read", () => {
    const outside = join(root, "secret.txt");
    writeFileSync(outside, "not yours\n");
    const gitDir = join(project, ".git", "worktrees", "wip");
    symlinkSync(outside, join(gitDir, "desolate-note.md"));
    assert.equal(readNote(target("wip")), undefined);
  });
});
