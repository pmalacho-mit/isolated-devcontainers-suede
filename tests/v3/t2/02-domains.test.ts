// T2 (fake backend). Phases 2 and 3, the git side: a domain, its clones borrowing from the
// mirror, workspaces and their checkouts, worktrees, checkout locks, two domains with one
// repository. No hypervisor boundary is proved here: the read-only and isolation checks are
// repeated on a real VM in tests/v3/t3.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
const vmOf = (target: string) => {
  const [domain] = target.split("/");
  const list = JSON.parse(stack.quiet("list", domain!, "--json").stdout) as { workspaces: { workspace: string; vm: string }[] }[];
  return list[0]!.workspaces.find((w) => `${domain}/${w.workspace}` === target)!.vm;
};
const inWs = (target: string, script: string, root = false) => stack.inVm(vmOf(target), ["bash", "-c", script], { root });

describe("T2 phases 2-3: domains, workspaces and their checkouts", () => {
  before(() => {
    stack = newStack("domains");
    stack.seed("acme/widgets", (dir) => {
      git(dir, "lfs", "install", "--local");
      git(dir, "lfs", "track", "*.bin");
      fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(200_000, 7));
      fs.writeFileSync(path.join(dir, "README.md"), "# widgets\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    stack.seed("acme/consumer", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# consumer\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    stack.seed("acme/private", (dir) => {
      fs.writeFileSync(path.join(dir, "SECRET.md"), "another domain's repository\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    assert.equal(bootstrap(stack).code, 0);
    for (const repo of ["acme/widgets", "acme/consumer", "acme/private"]) assert.equal(stack.quiet("clone", repo).code, 0);
  });
  after(() => stack.destroy());

  it("a domain, two repositories, and its first workspace", () => {
    stack.step("create a domain and start a workspace");
    assert.equal(stack.desolate("domain", "create", "nests-dev", "--title", "suede.nests agentic development").code, 0);
    assert.equal(stack.desolate("domain", "nests-dev", "add", "--repo", "acme/widgets").code, 0);
    assert.equal(stack.desolate("domain", "nests-dev", "add", "--repo", "acme/consumer").code, 0);
    const up = stack.desolate("up", "nests-dev");
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /workspace nests-dev\/w1 is up {2}\[NOT ISOLATED: fake backend\]/);
    assert.match(up.stdout, /acme\/widgets {2}main checkout \(main\) {2}\/workspaces\/acme\/widgets/);
    assert.match(up.stdout, /the start took [\d.]+ s: planned [\d.]+ s, VM booted [\d.]+ s, services, checkouts, devcontainer and editor [\d.]+ s/);
  });

  it("the domain clone borrows the mirror: nothing of its own until its first commit; LFS checks out", () => {
    const counts = inWs("nests-dev/w1", "cd /workspaces/acme/widgets && git count-objects -v && cat .git/objects/info/alternates && stat -c %s big.bin && git lfs env | grep Endpoint=");
    assert.equal(counts.code, 0, counts.stderr);
    assert.match(counts.stdout, /^count: 0$/m);
    assert.match(counts.stdout, /^in-pack: 0$/m);
    assert.match(counts.stdout, /^\/desolate\/mirrors\/acme\/widgets\.git\/objects$/m);
    assert.match(counts.stdout, /^200000$/m, "the LFS file was smudged from the read-only mirror");
    assert.match(counts.stdout, /Endpoint=file:\/\/\/desolate\/mirrors\/acme\/widgets\.git/);
  });

  it("git fetch works from the mirror, with no key and no network; a commit stays in the domain clone", () => {
    const before = fs.readdirSync(path.join(stack.home, "mirrors/acme/widgets.git/objects"), { recursive: true }).length;
    const work = inWs("nests-dev/w1", "cd /workspaces/acme/widgets && git fetch origin && echo change >> README.md && git commit -qam 'a change in the domain' && git count-objects -v | head -1 && ip -o link | grep -cvE ': (docker0|br-[0-9a-f]+|veth[0-9a-f]+)[@:]'");
    assert.equal(work.code, 0, work.stderr);
    assert.match(work.stdout, /^count: [1-9]/m, "the commit's objects are the domain clone's own");
    assert.match(work.stdout, /^1$/m, "the workspace has one interface that leads anywhere, and it is loopback (the VM's own docker bridge leads only to its containers). Its fetch used no network");
    const after = fs.readdirSync(path.join(stack.home, "mirrors/acme/widgets.git/objects"), { recursive: true }).length;
    assert.equal(after, before, "the mirror did not change");
  });

  it("T2 the mirror and the inbox are read-only in the workspace, to root too", () => {
    // Controls: the same writes succeed where the workspace MAY write.
    assert.equal(inWs("nests-dev/w1", "touch /workspaces/.probe && rm /workspaces/.probe && touch /desolate/outbox/.probe && rm /desolate/outbox/.probe", true).code, 0, "control: /workspaces and the outbox are writable");
    for (const attempt of [
      "touch /desolate/mirrors/acme/widgets.git/planted",
      "echo x >> /desolate/mirrors/acme/widgets.git/HEAD",
      "cd /workspaces/acme/widgets && git push origin HEAD:refs/heads/from-workspace",
      "touch /desolate/inbox/forged-delivery",
      "echo '{}' > /desolate/inbox/workspaces/w1.json",
      "touch /desolate/release/planted",
    ]) assert.notEqual(inWs("nests-dev/w1", attempt, true).code, 0, `root in the workspace must not be able to: ${attempt}`);
    assert.equal(fs.existsSync(path.join(stack.home, "mirrors/acme/widgets.git/planted")), false);
  });

  it("a workspace sees the mirrors of its own domain's repositories, and no others", () => {
    const seen = inWs("nests-dev/w1", "ls /desolate/mirrors/acme/");
    assert.deepEqual(seen.stdout.trim().split("\n").sort(), ["consumer.git", "widgets.git"]);
    assert.ok(fs.existsSync(path.join(stack.home, "mirrors/acme/private.git")), "control: the other mirror exists on the host");
  });

  it("the main checkout is refused to a second workspace, which can take a worktree", () => {
    stack.step("a second workspace in the domain");
    const refused = stack.desolate("up", "nests-dev", "--name", "issue-12", "--checkout", "acme/widgets=main");
    assert.equal(refused.code, 75, "busy");
    assert.match(refused.stderr, /held by the workspace 'nests-dev\/w1'/);
    assert.match(refused.stderr, /fix: take a worktree instead: --checkout acme\/widgets=worktree:<branch>/);
    const up = stack.desolate("up", "nests-dev", "--name", "issue-12", "--checkout", "acme/widgets=worktree:issue/12");
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /acme\/widgets {2}worktree issue\/12 from main {2}\/workspaces\/acme\/widgets\/\.worktrees\/issue-12/);
    // Not named, and its main checkout is held: a fresh worktree named for the workspace.
    assert.match(up.stdout, /acme\/consumer {2}worktree issue-12 from main/);
  });

  it("two workspaces commit to one repository at once, in their own worktrees, without corruption", async () => {
    const worker = (target: string, dir: string, tag: string) => new Promise<number>((resolve) => {
      const child = spawn("docker", ["exec", "-u", "desolate", "-e", "HOME=/home/desolate", vmOf(target), "bash", "-c",
        `cd ${dir} && for i in $(seq 1 60); do echo "${tag} $i" > ${tag}.txt && git add ${tag}.txt && git commit -qm "${tag} $i" || exit 1; done`], { stdio: "ignore" });
      child.on("close", (code) => resolve(code ?? 1));
    });
    const [a, b] = await Promise.all([
      worker("nests-dev/w1", "/workspaces/acme/widgets", "one"),
      worker("nests-dev/issue-12", "/workspaces/acme/widgets/.worktrees/issue-12", "two"),
    ]);
    assert.deepEqual([a, b], [0, 0], "every commit succeeded in both workspaces");
    const check = inWs("nests-dev/issue-12", "cd /workspaces/acme/widgets && git fsck --full --strict 2>&1 | grep -v '^Checking' ; git rev-list --count main && git rev-list --count issue/12");
    const [mainCount, branchCount] = check.stdout.trim().split("\n").slice(-2).map(Number);
    assert.equal(mainCount, 62, "seed + the earlier change + 60");
    assert.equal(branchCount, 62, "it branched from the domain's local main (seed + the earlier change), + 60");
    assert.doesNotMatch(check.stdout, /error|missing|dangling commit|corrupt/i);
  });

  it("--base origin/main --fetch: a worktree from what the remote has now", () => {
    stack.step("fetch, then start from the remote's main");
    const pushed = stack.forge("commit", "acme/widgets", "main", "UPSTREAM.md", "pushed by someone else\n").trim();
    const up = stack.desolate("up", "nests-dev", "--name", "fresh", "--fetch", "--base", "origin/main", "--checkout", "acme/widgets=worktree:issue/13");
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /mirrors refreshed/);
    const head = inWs("nests-dev/fresh", "cd /workspaces/acme/widgets/.worktrees/issue-13 && git rev-parse HEAD && cat UPSTREAM.md");
    assert.equal(head.stdout.split("\n")[0], pushed, "the worktree starts at the commit the remote just published");
  });

  it("two domains, one repository: separate clones, one mirror, neither sees the other's work", () => {
    stack.step("a second domain with the same repository");
    assert.equal(stack.desolate("domain", "create", "other", "--title", "another boundary").code, 0);
    assert.equal(stack.desolate("domain", "other", "add", "--repo", "acme/widgets").code, 0);
    assert.equal(stack.desolate("domain", "other", "add", "--repo", "acme/private").code, 0);
    assert.equal(stack.desolate("up", "other").code, 0);
    const other = inWs("other/w1", "cd /workspaces/acme/widgets && git branch -a --format='%(refname:short)' && cat .git/objects/info/alternates && ls /workspaces/acme && git log --oneline | wc -l");
    const lines = other.stdout.trim().split("\n");
    assert.ok(!lines.includes("issue/12") && !lines.includes("issue/13"), "the other domain's branches are not here");
    assert.ok(lines.includes("/desolate/mirrors/acme/widgets.git/objects"), "it borrows the same mirror");
    assert.ok(lines.includes("private") && !lines.includes("consumer"), "it has its own repositories, not the first domain's");
    // Control: the first domain does have those branches, so their absence above means something.
    assert.match(inWs("nests-dev/w1", "cd /workspaces/acme/widgets && git branch --format='%(refname:short)'").stdout, /issue\/12/);
    assert.notEqual(inWs("nests-dev/w1", "ls /workspaces/acme/private").code, 0);
  });

  it("exec carries stdin, stdout and the exit code; list shows every workspace", () => {
    stack.step("exec and list");
    const echo = stack.desolate("exec", "nests-dev/issue-12", "--checkout", "acme/widgets", "--", "bash", "-c", "pwd; git branch --show-current; exit 7");
    assert.equal(echo.code, 7);
    assert.match(echo.stdout, /\/workspaces\/acme\/widgets\/\.worktrees\/issue-12\nissue\/12/);
    const list = stack.desolate("list");
    assert.match(list.stdout, /nests-dev\/issue-12 {2}running {2}\[not isolated\]/);
    const json = JSON.parse(stack.quiet("list", "--json").stdout) as { domain: string; workspaces: { status: string; isolated: boolean }[] }[];
    assert.deepEqual(json.map((d) => [d.domain, d.workspaces.length]), [["nests-dev", 3], ["other", 1]]);
    assert.ok(json.every((d) => d.workspaces.every((w) => w.isolated === false)), "every workspace on the fake backend is labelled not isolated");
  });

  it("stop keeps a workspace's checkouts held; rm frees them", () => {
    stack.step("stop, start, rm");
    assert.equal(stack.desolate("stop", "nests-dev/w1").code, 0);
    assert.equal(stack.desolate("up", "nests-dev", "--name", "taker", "--checkout", "acme/widgets=main").code, 75, "a stopped workspace still holds its checkout");
    assert.equal(stack.desolate("start", "nests-dev/w1").code, 0);
    assert.match(inWs("nests-dev/w1", "cd /workspaces/acme/widgets && git log -1 --format=%s").stdout, /one 60/, "its work is where it left it");
    assert.equal(stack.desolate("rm", "nests-dev/w1").code, 0);
    const taken = stack.desolate("up", "nests-dev", "--name", "taker", "--checkout", "acme/widgets=main");
    assert.equal(taken.code, 0, taken.stderr);
    assert.match(inWs("nests-dev/taker", "cd /workspaces/acme/widgets && git log -1 --format=%s").stdout, /one 60/, "the main checkout carries on from the domain's clone");
  });

  it("a domain is removed only when no workspace is left in it; the root keeps its own clone", () => {
    stack.step("remove a domain");
    const busy = stack.desolate("rm", "other");
    assert.equal(busy.code, 75);
    assert.match(busy.stderr, /fix: desolate rm other\/w1/);
    assert.equal(stack.desolate("rm", "other/w1").code, 0);
    assert.equal(stack.desolate("rm", "other").code, 0);
    assert.equal(fs.existsSync(path.join(stack.home, "domains/other")), false);
    assert.ok(fs.existsSync(path.join(stack.home, "root/acme/widgets/.git")), "the root clone is untouched");
    assert.ok(fs.existsSync(path.join(stack.home, "mirrors/acme/widgets.git/HEAD")), "the mirror is untouched");
  });

  it("a domain with several repositories names whose devcontainer.json its workspaces run", () => {
    stack.step("the domain's environment");
    assert.match(stack.desolate("domain", "nests-dev", "env").stdout, /its workspaces run the devcontainer\.json of the first checkout that has one\. To choose: desolate domain nests-dev env --from <owner>\/<repo>/);
    const refused = stack.desolate("domain", "nests-dev", "env", "--from", "acme/elsewhere");
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /acme\/elsewhere is not in the domain nests-dev/);
    assert.match(stack.desolate("domain", "nests-dev", "env", "--from", "acme/widgets").stdout, /its workspaces run acme\/widgets's devcontainer\.json/);
    assert.equal(stack.quiet("up", "nests-dev", "--name", "env-check").code, 0);
    const plan = JSON.parse(fs.readFileSync(path.join(stack.home, "domains/nests-dev/inbox/workspaces/env-check.json"), "utf8")) as { env?: string };
    assert.equal(plan.env, "acme/widgets", "the workspace's plan, which the domain cannot write, carries it");
    assert.match(stack.desolate("domain", "nests-dev", "env", "compose").stderr, /composing one environment from several specs is not built yet/);
    assert.equal(stack.quiet("rm", "nests-dev/env-check").code, 0);
  });

  it("the transcript reads as reviewed", () => {
    stack.checkTranscript("t2-02-domains");
  });
});
