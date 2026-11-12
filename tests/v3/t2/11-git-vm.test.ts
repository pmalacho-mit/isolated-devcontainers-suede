// T2 (fake backend). The git VM: a shell in a browser tab, git in the person's own clones,
// and a push from there that waits for the approval page like any other.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { request as httpRequest } from "node:http";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const forgeRefs = (repo: string) => Object.fromEntries(stack.forge("refs", repo).trim().split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]));

/** HTTP to one of the host daemon's pages, by its name, as the browser would send it. */
const client = (name: string, port: number) => {
  let cookie = "";
  const call = (method: string, url: string, headers: Record<string, string> = {}, body?: string, untilMs?: number): Promise<{ status: number; headers: Record<string, unknown>; body: string }> =>
    new Promise((resolve, reject) => {
      // (A fresh connection each time: the daemon routes a connection by its first request's
      // name, and each page refuses a request for another, which is what a test of one
      // page's answers must not stumble on.)
      const req = httpRequest({ agent: false, host: "127.0.0.1", port, method, path: url, headers: { host: `${name}:${port}`, ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
        if (untilMs) setTimeout(() => (req.destroy(), resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text })), untilMs);
      });
      req.on("error", (error) => (untilMs ? undefined : reject(error)));
      req.end(body);
    });
  return {
    login: async (address: string) => {
      const at = new URL(address);
      const answer = await call("GET", at.pathname + at.search);
      assert.equal(answer.status, 303);
      cookie = String(answer.headers["set-cookie"]).split(";")[0]!;
    },
    get: (url: string, untilMs?: number) => call("GET", url, { "sec-fetch-site": "same-origin" }, undefined, untilMs),
    post: (url: string, body: unknown) => call("POST", url, { "sec-fetch-site": "same-origin", origin: `http://${name}:${port}`, "content-type": "application/json" }, JSON.stringify(body)),
  };
};

describe("T2 the git VM: git in a browser tab, pushes through the approval page", () => {
  before(() => {
    stack = newStack("gitvm");
    stack.seed("acme/widgets", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# widgets\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/widgets").code, 0);
  });
  after(() => stack.destroy());

  const gitVm = () => `dsl-${stack.instance}-git`;

  it("desolate git makes the VM and the person's clone, with no network and the root's clones read-only", () => {
    const made = stack.desolate("git", "acme/widgets");
    assert.equal(made.code, 0, made.stderr);
    assert.match(made.stdout, /^git {10}http:\/\/desolate-git\.localhost:\d+\/\?tkn=[0-9a-f]{48}&repo=acme%2Fwidgets\n$/);
    const inside = stack.inVm(gitVm(), ["bash", "-lc", "cd /git/acme/widgets && git log --oneline -1 && git config remote.origin.pushurl && git config --get-all remote.root.fetch"]);
    assert.equal(inside.code, 0, inside.stderr);
    assert.match(inside.stdout, /seed\ndesolate-out::acme\/widgets\n\+refs\/remotes\/\*:refs\/remotes\/root\/\*\n/);
    // No way out, and nothing of the root's to change.
    const closed = stack.inVm(gitVm(), ["bash", "-c", "curl -sS -m 5 https://example.com >/dev/null 2>&1 && echo NET; touch /desolate/root/x 2>/dev/null && echo ROOT-WRITABLE; touch /desolate/mirrors/x 2>/dev/null && echo MIRRORS-WRITABLE; echo done"]);
    assert.equal(closed.stdout.trim(), "done", "no network; the root's clones and the mirrors are read-only");
    // git runs no hook in a clone's own hooks directory: only the git VM's (empty) one.
    const trap = stack.inVm(gitVm(), ["bash", "-lc", "cd /git/acme/widgets && mkdir -p .git/hooks && printf '#!/bin/sh\\ntouch /tmp/PWNED-hook\\n' > .git/hooks/post-checkout && chmod +x .git/hooks/post-checkout && git checkout -q -b probe && git checkout -q main && git branch -q -D probe; rm .git/hooks/post-checkout; ls /tmp/PWNED-hook 2>/dev/null; true"]);
    assert.equal(trap.stdout.trim(), "", "a clone's own hook does not run");
  });

  it("a shell in the browser tab, and a push from it that lands only after the approval page", async () => {
    const port = Number(stack.env.DESOLATE_EDITOR_PORT);
    const terminal = client("desolate-git.localhost", port);
    await terminal.login(/(http:\S+)/.exec(stack.desolate("git", "acme/widgets").stdout)![1]!);
    const opened = await terminal.post("/session", { repo: "acme/widgets" });
    assert.equal(opened.status, 200, opened.body);
    const { id, token } = JSON.parse(opened.body) as { id: string; token: string };
    const type = (text: string) => terminal.post(`/session/${id}/input`, { token, data: Buffer.from(text).toString("base64") });
    const screen = async (pattern: RegExp, ms = 20_000) => {
      let said = "";
      for (const until = Date.now() + ms; Date.now() < until; ) {
        const stream = await terminal.get(`/session/${id}/stream?token=${token}`, 700);
        said = stream.body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => Buffer.from(line.slice(6), "base64").toString()).join("")
          // eslint-disable-next-line no-control-regex
          .replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");
        if (pattern.test(said)) return said;
      }
      assert.fail(`the terminal never showed ${pattern}: ${said.slice(-800)}`);
    };
    assert.equal((await type("pwd; git status --short --branch\n")).status, 200);
    await screen(/\/git\/acme\/widgets[\s\S]*## main\.\.\.origin\/main/);
    // A commit, and a push of it, typed as anyone would.
    await type("echo from-the-git-vm > note.txt && git add note.txt && git -c user.name=person -c user.email=p@example.invalid commit -qm 'from the git VM' && git push origin HEAD:refs/heads/from-git\n");
    await screen(/handed to the root\. Approve it on the approval page/);
    const commit = stack.inVm(gitVm(), ["git", "-C", "/git/acme/widgets", "rev-parse", "HEAD"]).stdout.trim();
    assert.equal(forgeRefs("acme/widgets")["from-git"], undefined, "nothing reached the remote before the approval");

    const approvals = client("desolate-approve.localhost", port);
    await approvals.login(/approvals {4}(http:\S+)/.exec(stack.desolate("approve", "--web").stdout)![1]!);
    type Waiting = { nonce: string; token: string; branch: string; commit: string; summary: { waiting?: boolean; ok: boolean; commits?: { subject: string }[] } };
    let push: Waiting | undefined;
    for (let i = 0; i < 120 && !push; i++) {
      push = (JSON.parse((await approvals.get("/pending")).body) as { pending: Waiting[] }).pending.find((p) => p.branch === "from-git" && !p.summary.waiting);
      if (!push) await sleep(250);
    }
    assert.ok(push, "the push waits on the approval page");
    assert.equal(push!.commit, commit);
    assert.equal(push!.summary.ok, true, JSON.stringify(push!.summary));
    assert.deepEqual(push!.summary.commits!.map((c) => c.subject), ["from the git VM"], "the reviewer says what it is");
    assert.equal((await approvals.post("/approve", { nonce: push!.nonce, token: push!.token, commit })).status, 200);
    await screen(/\* \[new branch\]\s+HEAD -> from-git/, 60_000);
    assert.equal(forgeRefs("acme/widgets")["from-git"], commit, "the remote has exactly that commit");
  });

  it("the terminal answers nothing to another origin, or without its cookie", async () => {
    const port = Number(stack.env.DESOLATE_EDITOR_PORT);
    const stranger = client("desolate-git.localhost", port);
    const none = await stranger.post("/session", {});
    assert.equal(none.status, 401, `no cookie: ${none.body}`);
    const other = client("dev-w1-abc123.localhost", port);
    assert.notEqual((await other.post("/session", {})).status, 200, "another name");
  });

  it("a link in the out-box is not followed: the host neither reads, moves nor writes what it names", async () => {
    // A file of the person's on the Mac, and a request whose bundle is a link to it.
    const canary = path.join(stack.work, "canary.txt");
    fs.writeFileSync(canary, "the person's file\n");
    const id = "aaaaaaaaaaaaaaaa";
    const request = JSON.stringify({ repo: "acme/widgets", branch: "linked", commit: "b".repeat(40), forced: false, lfs: ["c".repeat(64)] });
    const planted = stack.inVm(gitVm(), ["bash", "-c", `cd /desolate/out && ln -s ${canary} ${id}.bundle && ln -s ${canary} ${id}.${"c".repeat(64)}.lfs && printf '%s' '${request}' > ${id}.json && ln -s ${canary} /desolate/answers/${id}.json 2>/dev/null; echo planted`]);
    assert.match(planted.stdout, /planted/);
    let answer = "";
    for (let i = 0; i < 40 && !answer; i++) {
      answer = stack.inVm(gitVm(), ["bash", "-c", `cat /desolate/answers/${id}.json 2>/dev/null; true`]).stdout;
      if (!answer) await sleep(250);
    }
    assert.match(answer, /not a plain file/, "refused, and said so where the git VM reads it");
    assert.equal(fs.readFileSync(canary, "utf8"), "the person's file\n", "the file the links named is as it was, and where it was");
    assert.ok(!fs.lstatSync(path.join(stack.home, "git-answers", `${id}.json`)).isSymbolicLink(), "the answers are the host's: the git VM could not leave a link there");
  });
});
