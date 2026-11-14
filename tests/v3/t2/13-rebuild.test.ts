// T2 (fake backend). A rebuild of the stack's VMs keeps what is yours: `destroy` without
// --all takes the root's keys, registry, secrets and network rules out of the root VM, the
// next `bootstrap` puts them into the new root (host/carry.ts), and `start` makes a
// workspace whose VM is gone again, on its checkouts, committed work and uncommitted alike.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap, git, newStack } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
const CHECKOUT = "/workspaces/acme/widgets/.worktrees/task-one";
const CLI = path.resolve(import.meta.dirname, "../../../release/cli.sh");
const kept = () => path.join(stack.home, "root-kept", "root-state.tgz");

describe("T2 destroy and bootstrap again: nothing of yours is lost", () => {
  before(() => {
    stack = newStack("rebuild");
    stack.seed("acme/widgets", (dir) => {
      fs.writeFileSync(path.join(dir, "README.md"), "# widgets\n");
      git(dir, "add", "-A");
      git(dir, "commit", "--quiet", "-m", "seed");
    });
    assert.equal(bootstrap(stack).code, 0);
    assert.equal(stack.quiet("clone", "acme/widgets", "--no-domain").code, 0);
    assert.equal(stack.quiet("domain", "create", "dev", "--repo", "acme/widgets").code, 0);
    const secret = spawnSync(CLI, ["domain", "dev", "secret", "set", "REBUILD-TOKEN", "--hosts", "example.com"], { env: stack.env, input: "rebuild-secret-value\n", encoding: "utf8" });
    assert.equal(secret.status, 0, secret.stderr);
    assert.equal(stack.quiet("domain", "dev", "net", "allow", "example.org").code, 0);
    const up = stack.quiet("up", "dev", "--name", "w1", "--branch", "task/one");
    assert.equal(up.code, 0, up.stderr);
    const work = stack.quiet("exec", "dev/w1", "--", "bash", "-c", `cd ${CHECKOUT} && echo done > WORK.md && git add WORK.md && git -c user.name=a -c user.email=a@x commit -qm work && echo wip > WIP.txt`);
    assert.equal(work.code, 0, work.stderr);
  });
  after(() => stack.destroy());

  const state = () => ({
    keys: stack.quiet("keys").stdout,
    repos: JSON.parse(stack.quiet("repos", "--json").stdout).map((r: { repo: string; pushable: boolean }) => [r.repo, r.pushable]),
    secrets: stack.quiet("domain", "dev", "secret", "list").stdout,
    net: stack.quiet("domain", "dev", "net", "show").stdout,
  });

  it("destroy keeps the root's state, the next bootstrap puts it back and removes the copy", () => {
    const before = state();
    assert.match(before.keys, /acme\/widgets {2}write/, "control: the root holds the keys before");
    assert.match(before.secrets, /REBUILD-TOKEN/);
    const destroyed = stack.desolate("destroy");
    assert.equal(destroyed.code, 0, destroyed.stderr);
    assert.match(destroyed.stdout, /kept the root's keys, registry, secrets and network rules/);
    assert.ok(fs.existsSync(kept()), "kept on the host until the next bootstrap");
    assert.equal(fs.statSync(kept()).mode & 0o077, 0, "the copy is the person's alone");
    assert.equal(fs.statSync(path.dirname(kept())).mode & 0o077, 0);
    const again = bootstrap(stack);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /put back the root's keys, registry, secrets and network rules/);
    assert.deepEqual(state(), before, "keys, repositories, secrets and network rules, as they were");
    assert.ok(!fs.existsSync(kept()), "the host's copy is gone once it is back in the root");
  });

  it("the keys put back still work: a fetch with the read key", () => {
    const fetched = stack.desolate("fetch", "acme/widgets");
    assert.equal(fetched.code, 0, fetched.stderr);
  });

  it("a second bootstrap puts back nothing, and a kept copy is never put over a root with keys", () => {
    fs.mkdirSync(path.dirname(kept()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(kept(), "not an archive", { mode: 0o600 });
    const again = bootstrap(stack);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /this root holds keys of its own: left as it is/);
    assert.ok(fs.existsSync(kept()), "left for the person to look at");
    fs.rmSync(kept());
  });

  it("start makes a workspace whose VM is gone again, on its checkouts, with its work", () => {
    const listed = JSON.parse(stack.quiet("list", "--json").stdout) as { workspaces: { workspace: string; status: string }[] }[];
    assert.equal(listed[0]!.workspaces[0]!.status, "missing", "control: its VM went with the destroy");
    const started = stack.desolate("start", "dev/w1");
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, /is gone; making it again, on the same checkouts/);
    const seen = stack.quiet("exec", "dev/w1", "--", "bash", "-c", `cd ${CHECKOUT} && git log --format=%s -1 && cat WIP.txt`);
    assert.equal(seen.code, 0, seen.stderr);
    assert.equal(seen.stdout.trim(), "work\nwip", "the commit and the uncommitted file are both there");
  });
});
