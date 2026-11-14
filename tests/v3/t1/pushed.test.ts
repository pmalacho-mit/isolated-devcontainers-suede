// T1. What was pushed, and whether it has landed (root/pushed.ts): a pushed branch is "merged
// into <base>" when the base has all its changes, however the pull request was merged (a
// merge commit, a squash, a rebase), and not when anything of it is still missing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { run } from "../../../release/shared/run.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-pushed-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
process.env.DESOLATE_ROOT_STATE = path.join(dir, "state");
const { landedIn, landedFor, pushedList, recordPushed, settle, waiting } = await import("../../../release/root/pushed.ts");

const repo = path.join(dir, "repo");
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const sh = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env }).trim();
const write = (file: string, text: string) => fs.writeFileSync(path.join(repo, file), text);
const commit = (message: string) => {
  sh("add", "-A");
  sh("commit", "-q", "-m", message);
  return sh("rev-parse", "HEAD");
};
const gitIn = (args: string[]) => run("git", ["-C", repo, ...args], { env });

fs.mkdirSync(repo);
execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
write("a.txt", "a\n");
write("b.txt", "b\n");
commit("start");
/** A branch off main with one change to `file`; back on main after. */
const branch = (name: string, file: string, text: string) => {
  sh("switch", "-q", "-c", name, "main");
  write(file, text);
  const tip = commit(`${name}: ${file}`);
  sh("switch", "-q", "main");
  return tip;
};

describe("T1 what was pushed, and whether it landed", () => {
  it("a merge, a squash and a rebase all count; work still missing does not", async () => {
    const merged = branch("merged", "a.txt", "merged\n");
    const squashed = branch("squashed", "b.txt", "squashed\n");
    const rebased = branch("rebased", "c.txt", "rebased\n");
    const open = branch("open", "d.txt", "not merged\n");
    const halfway = branch("halfway", "e.txt", "one\n");
    sh("switch", "-q", "halfway");
    write("f.txt", "two\n");
    const halfwayTip = commit("halfway: f.txt");
    sh("switch", "-q", "main");
    // CONTROL: before anything is merged, nothing has landed.
    for (const tip of [merged, squashed, rebased, open, halfwayTip]) assert.equal(await landedIn(gitIn, tip, "main"), false, tip);

    sh("merge", "-q", "--no-ff", "-m", "merge", "merged");
    sh("merge", "-q", "--squash", "squashed");
    commit("squashed (#2)");
    sh("cherry-pick", rebased); // a rebase merge: the same change, another commit id
    sh("cherry-pick", halfway); // only the first of halfway's two commits
    assert.equal(await landedIn(gitIn, merged, "main"), true, "a merge commit");
    assert.equal(await landedIn(gitIn, squashed, "main"), true, "a squash");
    assert.equal(await landedIn(gitIn, rebased, "main"), true, "a rebase");
    assert.equal(await landedIn(gitIn, open, "main"), false, "not merged");
    assert.equal(await landedIn(gitIn, halfwayTip, "main"), false, "half of it merged");
    assert.equal(await landedIn(gitIn, merged, "no-such-branch"), false, "no such base");
    assert.equal(await landedIn(gitIn, "0".repeat(40), "main"), false, "no such commit");
  });

  it("a base that changed a merged file again is not recognised: the branch is just not marked", async () => {
    const tip = branch("later", "g.txt", "first\n");
    sh("merge", "-q", "--squash", "later");
    commit("later (#3)");
    assert.equal(await landedIn(gitIn, tip, "main"), true);
    write("g.txt", "changed since\n");
    commit("g changed again");
    assert.equal(await landedIn(gitIn, tip, "main"), false);
  });

  it("the record: the newest push of a branch replaces the last; settle marks what landed; a newer commit is not marked", async () => {
    const tip = branch("feature", "h.txt", "h\n");
    recordPushed({ repo: "acme/app", branch: "feature", commit: "1".repeat(40), base: "main" });
    recordPushed({ repo: "acme/app", branch: "feature", commit: tip, base: "main" });
    recordPushed({ repo: "acme/app", branch: "solo", commit: tip, base: "solo" }); // a branch into itself: no base
    recordPushed({ repo: "acme/app", branch: "--evil", commit: tip, base: "main" }); // not a branch: not recorded
    assert.deepEqual(pushedList().map((p) => [p.branch, p.commit, p.base]), [["feature", tip, "main"], ["solo", tip, null]]);
    assert.deepEqual(waiting(), ["acme/app"]);
    assert.equal(await settle("acme/app", gitIn), 0, "not merged yet");
    sh("merge", "-q", "--squash", "feature");
    commit("feature (#4)");
    assert.equal(await settle("other/repo", gitIn), 0, "another repository's fetch looks at nothing of this one");
    assert.equal(await settle("acme/app", gitIn), 1);
    assert.equal(landedFor(pushedList(), "acme/app", "feature", tip), "main");
    assert.equal(landedFor(pushedList(), "acme/app", "feature", "2".repeat(40)), null, "the branch moved on since: not marked");
    assert.equal(landedFor(pushedList(), "acme/app", "solo", tip), null);
    assert.deepEqual(waiting(), [], "nothing left to wait for");
  });
});
