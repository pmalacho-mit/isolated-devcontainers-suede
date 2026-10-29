/// <reference types="node" />
// `deps report` and `deps build` (docker.ts depsScript), run as the sandbox
// runs them, against real repositories made with git-subrepo: a consumer that
// is itself a suede dependency, with a release-declared dependency, one that
// holds a nested dependency, a tooling subrepo, and its own release/.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { depsScript, parseDepsReport } from "../../../release/vscode-image/docker.ts";

const root = mkdtempSync(join(tmpdir(), "desolate-deps-"));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" }).trim();
const subrepoAvailable = spawnSync("git", ["subrepo", "--version"], { env }).status === 0;

const remote = (name: string) => join(root, "remotes", "acme", `${name}.git`);
/** A dependency repository with a release branch holding `files`. */
const dependency = (name: string, files: Record<string, string>) => {
  git(root, "init", "--quiet", "--bare", remote(name));
  const work = join(root, "work", name);
  git(root, "init", "--quiet", work);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(work, file, ".."), { recursive: true });
    writeFileSync(join(work, file), text);
  }
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", `${name} v1`);
  git(work, "push", "--quiet", remote(name), "HEAD:refs/heads/release");
  return git(work, "rev-parse", "HEAD");
};
const gitrepo = (url: string, branch: string, commit: string) =>
  `[subrepo]\n\tremote = ${url}\n\tbranch = ${branch}\n\tcommit = ${commit}\n\tparent = \n`;

const consumer = join(root, "consumer");
// Where desolate's editor would find it: a project under /workspaces.
process.env.DESOLATE_WORKSPACES = join(root, "workspaces");
process.env.DESOLATE_REMOTE_CACHE = join(root, "cache");
const clone = join(root, "workspaces", "acme", "consumer");
const { deliver, pushUpstream, downstreamBranch, deliveredBundle, TransferError } = await import("../../../release/vscode-image/transfer.ts");
const run = (cwd: string, ...args: string[]) => spawnSync("sh", ["-c", depsScript, "deps", ...args], { cwd, env, encoding: "utf8" });
const report = (cwd: string) => {
  const result = run(cwd, "report", "HEAD");
  assert.equal(result.status, 0, result.stderr);
  return parseDepsReport(result.stdout)!;
};
const bundleFor = (name: string) =>
  git(root, "--git-dir", remote(name), "bundle", "create", "--quiet", join(clone, ".git", `desolate-dep-acme__${name}.bundle`), "release");

before(() => {
  if (!subrepoAvailable) return;
  const inner = dependency("inner", { "x.txt": "inner v1\n" });
  dependency("widget", { "lib.txt": "widget v1\n", ".gitrepo": gitrepo(remote("widget"), "release", "2".repeat(40)) });
  dependency("outer", { "o.txt": "outer v1\n", "inner/x.txt": "inner v1\n", "inner/.gitrepo": gitrepo(remote("inner"), "release", inner) });

  git(root, "init", "--quiet", consumer);
  mkdirSync(join(consumer, "release"), { recursive: true });
  writeFileSync(join(consumer, "release", "app.txt"), "the consumer's own release\n");
  writeFileSync(join(consumer, "release", ".gitrepo"), gitrepo("https://github.com/acme/consumer", "release", "0".repeat(40)));
  mkdirSync(join(consumer, ".suede", "core"), { recursive: true });
  writeFileSync(join(consumer, ".suede", "core", "tool.sh"), "tooling\n");
  writeFileSync(join(consumer, ".suede", "core", ".gitrepo"), gitrepo("https://github.com/pmalacho-mit/suede.git", "dependency/main/core", "1".repeat(40)));
  git(consumer, "add", ".");
  git(consumer, "commit", "--quiet", "-m", "consumer");
  git(consumer, "subrepo", "clone", "--quiet", remote("widget"), "widget", "-b", "release");
  git(consumer, "subrepo", "clone", "--quiet", remote("outer"), "outer", "-b", "release");
  symlinkSync("widget", join(consumer, "widget.consumer"));
  git(consumer, "add", "widget.consumer");
  git(consumer, "commit", "--quiet", "-m", "declare widget a release dependency");
  // The consumer's own changes: to widget, and to the dependency nested in outer.
  writeFileSync(join(consumer, "widget", "lib.txt"), "widget v1, improved by the consumer\n");
  writeFileSync(join(consumer, "outer", "inner", "x.txt"), "inner v1, improved by the consumer\n");
  writeFileSync(join(consumer, ".suede", "core", "tool.sh"), "tooling, edited\n");
  git(consumer, "commit", "--quiet", "-am", "improve widget and inner");
  // A clone has none of the dependencies' history: subrepo keeps it in refs
  // a clone does not copy. That is what desolate's sandbox starts from.
  git(root, "clone", "--quiet", "--no-local", consumer, clone);
});

after(() => process.env.KEEP ? console.log("kept " + root) : rmSync(root, { recursive: true, force: true }));

describe("deps report", { skip: !subrepoAvailable && "git-subrepo is not installed" }, () => {
  test("lists the suede dependencies only: not release/, not tooling", () => {
    const found = report(clone);
    assert.equal(found.suede, true, "the consumer is itself a suede dependency");
    assert.deepEqual(found.dependencies.map((d) => d.dir).sort(), ["outer", "outer/inner", "widget"]);
  });

  test("with no history to compare against, it says so", () => {
    assert.deepEqual(report(clone).dependencies.map((d) => d.state), ["nopin", "nopin", "nopin"]);
  });

  test("once delivered: the change is the innermost dependency's, and kinds are told apart", () => {
    for (const name of ["widget", "outer", "inner"]) bundleFor(name);
    const byDir = Object.fromEntries(report(clone).dependencies.map((d) => [d.dir, d]));
    assert.equal(byDir.widget.state, "diff");
    assert.deepEqual(byDir.widget.files, [{ status: "M", path: "lib.txt" }], "its .gitrepo is not the consumer's change");
    assert.equal(byDir.widget.kind, "release", "declared by widget.consumer -> widget");
    assert.equal(byDir.widget.repo, "acme/widget");
    assert.equal(byDir["outer/inner"].state, "diff");
    assert.equal(byDir["outer/inner"].kind, "development");
    assert.equal(byDir.outer.state, "same", "a change inside a nested dependency is not the outer one's");
    assert.match(byDir.widget.patch!, /^[0-9a-f]{40}$/);
  });

  test("the same change has the same patch id, whatever commit carries it", () => {
    const before = report(clone).dependencies.find((d) => d.dir === "widget")!.patch;
    writeFileSync(join(clone, "unrelated.txt"), "x\n");
    git(clone, "add", "unrelated.txt");
    git(clone, "commit", "--quiet", "-m", "unrelated");
    assert.equal(report(clone).dependencies.find((d) => d.dir === "widget")!.patch, before);
  });

  test("an app that is no suede dependency calls its dependencies `app`", () => {
    const app = join(root, "app");
    git(root, "clone", "--quiet", "--no-local", clone, app);
    git(app, "rm", "--quiet", "-r", "release");
    git(app, "commit", "--quiet", "-m", "no longer a suede dependency");
    for (const name of ["widget"]) git(root, "--git-dir", remote(name), "bundle", "create", "--quiet", join(app, ".git", `desolate-dep-acme__${name}.bundle`), "release");
    const found = report(app);
    assert.equal(found.suede, false);
    assert.equal(found.dependencies.find((d) => d.dir === "widget")!.kind, "app");
  });
});

describe("deps build", { skip: !subrepoAvailable && "git-subrepo is not installed" }, () => {
  test("one commit on the pin, the consumer's folder less its .gitrepo, bundled for the dependency", () => {
    const out = join(clone, ".git", "desolate-transfer-0123456789abcdef.bundle");
    const result = run(clone, "build", "HEAD", "widget", out, "acme/consumer");
    assert.equal(result.status, 0, result.stderr);
    const [, commit, pin, tag, consumerCommit, patch] = result.stdout.trim().split("\t");
    assert.equal(tag, "acme__widget");
    assert.equal(consumerCommit, git(clone, "rev-parse", "HEAD"));
    assert.equal(patch, report(clone).dependencies.find((d) => d.dir === "widget")!.patch);
    // What the dependency receives: verify and fetch it there, as the editor will.
    git(root, "--git-dir", remote("widget"), "bundle", "verify", "--quiet", out);
    git(root, "--git-dir", remote("widget"), "fetch", "--quiet", out, "refs/desolate/upstream/outgoing:refs/heads/proposed");
    assert.equal(git(root, "--git-dir", remote("widget"), "rev-parse", "proposed"), commit);
    assert.equal(git(root, "--git-dir", remote("widget"), "rev-parse", "proposed^"), pin);
    assert.equal(git(root, "--git-dir", remote("widget"), "show", "proposed:lib.txt"), "widget v1, improved by the consumer");
    assert.match(git(root, "--git-dir", remote("widget"), "show", "proposed:.gitrepo"), /commit = 2{40}/, "the dependency's own .gitrepo, not the consumer's");
    assert.match(git(root, "--git-dir", remote("widget"), "log", "-1", "--format=%B", "proposed"), /improve widget and inner/);
    assert.equal(git(clone, "for-each-ref", "refs/desolate/upstream"), "", "its temporary ref is left behind");
  });

  test("a dependency whose only change is nested builds nothing", () => {
    const result = run(clone, "build", "HEAD", "outer", join(clone, ".git", "desolate-transfer-1111111111111111.bundle"), "acme/consumer");
    assert.equal(result.stdout.trim(), "BUILT\tnone");
  });

  test("anything but a suede dependency is refused", () => {
    for (const dir of ["release", ".suede/core", "nope"])
      assert.notEqual(run(clone, "build", "HEAD", dir, join(clone, ".git", "x.bundle"), "c").status, 0, dir);
  });
});

describe("deliver and push upstream: the editor's half", { skip: !subrepoAvailable && "git-subrepo is not installed" }, () => {
  const registrations = Object.fromEntries(["widget", "outer", "inner"].map((name) =>
    [`acme/${name}`, { tag: `acme__${name}`, ownerRepo: `acme/${name}`, url: remote(name) }]));

  test("a delivered release branch lets the sandbox compare, and a proposal reaches the dependency as suede's branch", () => {
    const fresh = join(root, "workspaces", "acme", "fresh");
    git(root, "clone", "--quiet", "--no-local", consumer, fresh);
    const project = "acme/fresh";
    assert.equal(parseDepsReport(run(fresh, "report", "HEAD").stdout)!.dependencies.find((d) => d.dir === "widget")!.state, "nopin");
    assert.match(deliver(project, "acme/widget", { registrations }), /^delivered acme\/widget's release/);
    assert.equal(deliveredBundle("acme/widget"), ".git/desolate-dep-acme__widget.bundle");
    assert.equal(parseDepsReport(run(fresh, "report", "HEAD").stdout)!.dependencies.find((d) => d.dir === "widget")!.state, "diff");

    const name = "desolate-transfer-abcdefabcdefabcd.bundle";
    const built = run(fresh, "build", "HEAD", "widget", join(fresh, ".git", name), project);
    assert.equal(built.status, 0, built.stderr);
    const [, commit, pin, , consumerCommit] = built.stdout.trim().split("\t");
    const branch = pushUpstream(project, "acme/widget", { name, commit, pin, consumerCommit }, { registrations });
    assert.equal(branch, `downstream/acme/fresh-${consumerCommit}`);
    assert.equal(git(root, "--git-dir", remote("widget"), "rev-parse", `refs/heads/${branch}`), commit);
    assert.equal(git(root, "--git-dir", remote("widget"), "rev-parse", "release"), pin, "release is not touched");

    // The same proposal again: refused, since suede's branch for it is there.
    const again = run(fresh, "build", "HEAD", "widget", join(fresh, ".git", name), project);
    const [, commit2, pin2, , consumerCommit2] = again.stdout.trim().split("\t");
    assert.throws(() => pushUpstream(project, "acme/widget", { name, commit: commit2, pin: pin2, consumerCommit: consumerCommit2 }, { registrations }),
      (err: Error) => err instanceof TransferError && /already on acme\/widget/.test(err.message));
  });

  test("a bundle that is not what the sandbox said is refused", () => {
    const project = "acme/fresh";
    const fresh = join(root, "workspaces", "acme", "fresh");
    const name = "desolate-transfer-0000000000000001.bundle";
    writeFileSync(join(fresh, "lib-extra.txt"), "x\n");
    git(fresh, "add", "lib-extra.txt");
    git(fresh, "commit", "--quiet", "-m", "another commit");
    const built = run(fresh, "build", "HEAD", "widget", join(fresh, ".git", name), project);
    const [, , pin, , consumerCommit] = built.stdout.trim().split("\t");
    assert.throws(() => pushUpstream(project, "acme/widget", { name, commit: "c".repeat(40), pin, consumerCommit }, { registrations }),
      /not the c{40}/);
  });

  test("a dependency that is not in the stack is named, not guessed at", () => {
    assert.throws(() => deliver("acme/fresh", "acme/nowhere", { registrations }), /acme\/nowhere is not in the stack/);
  });

  test("suede's branch name, spelled as suede spells it", () => {
    assert.equal(downstreamBranch("acme/my app", "a".repeat(40)), `downstream/acme/my-app-${"a".repeat(40)}`);
    assert.equal(downstreamBranch("solo", "b".repeat(40)), `downstream/solo-${"b".repeat(40)}`);
  });
});
