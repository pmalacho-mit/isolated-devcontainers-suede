// The push (section 6.4): root clone -> remote, by a person, pinned to the commit they
// reviewed. Run in the root VM, on a terminal.
//
//   node push.ts <domain> <owner/repo> <branch> --expect <commit> [--allow-default]
//
// Order: every refusal that needs no person comes first (not pushable, no --expect, the
// commit moved, the default branch), then the person is asked, then LFS objects go up, then
// the commit. The write key signs none of it without the approval the person just gave.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT, Refusal, refuse } from "../shared/exit.ts";
import { isCommit, parseRepo } from "../shared/names.ts";
import { git } from "./git.ts";
import { clonePath, ROOT } from "./layout.ts";
import { lfsOf, review, withdraw } from "./offers.ts";
import * as repos from "./repos.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CONFIRM = ["sudo", "-n", "-u", "desolate-keyring", "/usr/local/bin/node", "--disable-warning=ExperimentalWarning", `${HERE}/keyring-confirm.ts`];

const confirm = (repo: string, branch: string, commit: string, summary: string): Promise<string | null> =>
  new Promise((resolve) => {
    const child = spawn(CONFIRM[0]!, [...CONFIRM.slice(1), repo, branch, commit, summary], { stdio: ["inherit", "pipe", "inherit"] });
    let id = "";
    child.stdout!.on("data", (chunk) => (id += chunk));
    child.on("close", (code) => resolve(code === 0 && id.trim() ? id.trim() : null));
    child.on("error", () => resolve(null));
  });
const revoke = (id: string) => new Promise<void>((resolve) => spawn(CONFIRM[0]!, [...CONFIRM.slice(1), "--revoke", id], { stdio: "ignore" }).on("close", () => resolve()));

const main = async () => {
  const args = process.argv.slice(2);
  const positional = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--expect");
  const [domain, repoArg, branch] = positional;
  const expect = args.includes("--expect") ? args[args.indexOf("--expect") + 1] : undefined;
  const allowDefault = args.includes("--allow-default");
  if (!domain || !repoArg || !branch) refuse("push what?", "desolate push <domain> <owner/repo> <branch> --expect <commit>", EXIT.usage);
  const r = await review(domain!, repoArg, branch);
  const repo = parseRepo(r.repo)!;
  const again = `desolate review ${domain} ${r.repo} ${branch}`;
  if (!r.pushable) refuse(`${r.repo} is not pushable: the root holds no write key for it`, `it was cloned --no-push. To make it pushable: desolate clone ${r.repo}`);
  if (!isCommit(expect)) refuse("a push names the commit you reviewed", `${again}, then: desolate push ${domain} ${r.repo} ${branch} --expect ${r.commit}`, EXIT.usage);
  if (expect !== r.commit) refuse(`${branch} is at ${r.commit.slice(0, 12)}, not the ${expect!.slice(0, 12)} that was reviewed: it moved since`, `review it again (${again}), then push with --expect ${r.commit}`, EXIT.expectMismatch);
  if (r.isDefault && !allowDefault) refuse(`${branch} is ${r.repo}'s default branch`, "push a branch and open a pull request; or, to push the default branch itself, add --allow-default", EXIT.defaultBranch);
  if (r.commits.length === 0) refuse(`${branch} has nothing the remote lacks`, again);

  const lock = path.join(ROOT.state, "push-locks", r.repo.replace("/", "--"));
  try {
    fs.mkdirSync(lock);
  } catch {
    if (Date.now() - fs.statSync(lock).mtimeMs < 300_000) refuse(`another push to ${r.repo} is in progress`, "try again in a moment", EXIT.busy);
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock);
  }
  let approval: string | null = null;
  try {
    for (const warning of r.warnings) process.stderr.write(`desolate: WARNING: this push ${warning}\n`);
    approval = await confirm(r.repo, branch!, r.commit, `${r.commits.length} commit(s), ${r.stat || "no file changes"}${r.lfsObjects ? `, ${r.lfsObjects} LFS object(s)` : ""}`);
    if (!approval) throw new Refusal("no person confirmed the push, so nothing was pushed", "run `desolate push` from a terminal of your own, and type the branch name when it asks", EXIT.unconfirmed);
    const clone = clonePath(repo);
    // LFS objects first: the remote never has a pointer without its object.
    const own = (await lfsOf(repo, r.commit)).filter((oid) => fs.existsSync(path.join(clone, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid)));
    if (own.length > 0) {
      process.stderr.write(`uploading ${own.length} LFS object(s)\n`);
      const lfs = await git(clone, ["lfs", "push", "origin", "--object-id", ...own], { timeoutMs: 1_800_000 });
      if (lfs.code !== 0) throw new Refusal(`the LFS objects did not upload, so the commit was not pushed: ${lfs.stderr.trim().split("\n").slice(-2).join(" | ")}`, "try the push again");
    }
    const pushed = await git(clone, ["push", "--porcelain", "origin", `${r.commit}:refs/heads/${branch}`], { timeoutMs: 1_800_000, env: { DESOLATE_PUSH_APPROVED: r.commit } });
    if (pushed.code !== 0) throw new Refusal(`the remote did not take the push: ${pushed.stderr.trim().split("\n").slice(-3).join(" | ")}`, /non-fast-forward|fetch first/.test(pushed.stderr) ? `the remote's ${branch} has moved: desolate fetch ${r.repo}, then rebase in the workspace and offer again` : "desolate doctor");
  } finally {
    if (approval) await revoke(approval);
    fs.rmSync(lock, { recursive: true, force: true });
  }
  withdraw(domain!, r.repo, branch!);
  // What the remote now has, the mirror has: origin/* in every clone follows.
  await repos.fetch(repo).catch(() => {});
  process.stdout.write(`pushed ${r.repo} ${branch} at ${r.commit} (${r.commits.length} commit(s)${r.lfsObjects ? `, ${r.lfsObjects} LFS object(s) first` : ""}).\n`);
};

try {
  await main();
} catch (error) {
  if (error instanceof Refusal) {
    process.stderr.write(`desolate: ${error.message}\n${error.fix ? `  fix: ${error.fix}\n` : ""}`);
    process.exit(error.code);
  }
  process.stderr.write(`desolate: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
