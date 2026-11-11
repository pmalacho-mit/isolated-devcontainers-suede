// A workspace's first act, as the domain's own user: make this workspace's checkouts. This is
// the domain running git in the domain's repositories (P4): the root never does it for it.
//
//   node init.ts <workspace>     reads /desolate/inbox/workspaces/<workspace>.json
//
// A domain clone borrows the mirror's objects (git clone --shared), so it costs no download
// and almost no disk, and holds only what was made in it (section 6.2).
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson } from "../shared/json.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { run, sleep } from "../shared/run.ts";

const name = process.argv[2] ?? "";
const plan = readJson<WorkspacePlan | null>(`/desolate/inbox/workspaces/${name}.json`, null);
if (!plan) {
  console.error(`init: the root sent no plan for the workspace '${name}'`);
  process.exit(1);
}

const git = async (dir: string | null, args: string[]) => {
  const result = await run("git", dir ? ["-C", dir, ...args] : args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 600_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed${dir ? ` in ${dir}` : ""}: ${(result.stderr || result.stdout).trim().slice(-800)}`);
  return result.stdout.trim();
};

/** The domain's .git is shared by every workspace in it, and two can start at once. A
 *  directory is the lock: mkdir is atomic, on the share too. */
const LOCKS = "/workspaces/.desolate/locks";
const withLock = async <T>(key: string, body: () => Promise<T>): Promise<T> => {
  fs.mkdirSync(LOCKS, { recursive: true });
  const lock = path.join(LOCKS, key);
  for (let waited = 0; ; waited += 200) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      // A lock older than two minutes belongs to a workspace that died mid-init.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        /* released meanwhile */
      }
      if (waited > 180_000) throw new Error(`another workspace has held the init lock on ${key} for three minutes`);
      await sleep(200);
    }
  }
  try {
    return await body();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
};

const made: string[] = [];
for (const checkout of plan.checkouts) {
  const clone = `/workspaces/${checkout.repo}`;
  const mirror = `/desolate/mirrors/${checkout.repo}.git`;
  await withLock(checkout.repo.replace("/", "--"), async () => {
    if (!fs.existsSync(path.join(clone, ".git"))) {
      fs.mkdirSync(path.dirname(clone), { recursive: true });
      await git(null, ["clone", "--shared", "--no-checkout", "--quiet", mirror, clone]);
      // LFS reads the read-only mirror, offline. Set before the first checkout smudges.
      await git(clone, ["config", "lfs.url", `file://${mirror}`]);
      await git(clone, ["config", "lfs.locksverify", "false"]);
      // Several VMs write this .git: git's own housekeeping must not race across them.
      await git(clone, ["config", "gc.auto", "0"]);
      await git(clone, ["config", "maintenance.auto", "false"]);
      fs.appendFileSync(path.join(clone, ".git", "info", "exclude"), "/.worktrees/\n");
      const head = await git(clone, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
      const branch = head.replace(/^origin\//, "") || checkout.base.replace(/^origin\//, "");
      await git(clone, ["checkout", "--quiet", branch]);
      made.push(`domain clone ${checkout.repo}`);
    }
    if (plan.fetch) await git(clone, ["fetch", "--quiet", "--prune", "origin"]);
    if (checkout.kind === "worktree" && !fs.existsSync(path.join(checkout.path, ".git"))) {
      const exists = await run("git", ["-C", clone, "rev-parse", "--verify", "--quiet", `refs/heads/${checkout.branch}`]);
      if (exists.code === 0) await git(clone, ["worktree", "add", "--quiet", checkout.path, checkout.branch]);
      else await git(clone, ["worktree", "add", "--quiet", "-b", checkout.branch, checkout.path, checkout.base]);
      // Locked against pruning by another VM that cannot see this worktree's files as live.
      await git(clone, ["worktree", "lock", "--reason", `workspace ${plan.workspace}`, checkout.path]).catch(() => "");
      made.push(`worktree ${checkout.repo} ${checkout.branch}`);
    }
  });
}

// An identity for commits, if the workspace has none: who worked here is the workspace.
const who = await run("git", ["config", "--global", "user.email"]);
if (who.code !== 0) {
  await git(null, ["config", "--global", "user.name", `${plan.domain}/${plan.workspace}`]);
  await git(null, ["config", "--global", "user.email", `${plan.workspace}@${plan.domain}.desolate.invalid`]);
}
fs.mkdirSync("/home/desolate/.desolate", { recursive: true });
fs.writeFileSync("/home/desolate/.desolate/workspace.json", JSON.stringify(plan, null, 2));
process.stdout.write(JSON.stringify({ ok: true, made, checkouts: plan.checkouts.map((c) => ({ repo: c.repo, branch: c.branch, path: c.path })) }) + "\n");
