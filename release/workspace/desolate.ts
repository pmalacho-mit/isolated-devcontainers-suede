// `desolate`, inside a workspace: the two things a workspace may ask of the root, and both
// only ask. Nothing here pushes: offering is not pushing (P2).
//
//   desolate fetch [<owner/repo>]          ask the root to refresh the mirror, then git fetch
//   desolate offer [<owner/repo>] [<branch>]  bundle a branch for the root; a person pushes it
//   desolate sync                          write this domain's branches out for the root now
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isBranch, parseRepo, repoId } from "../shared/names.ts";
import { run } from "../shared/run.ts";
import { branches, domainRepos, importDeliveries, request, stageLfs, syncRepo } from "./sync.ts";

const fail = (message: string, fix: string): never => {
  process.stderr.write(`desolate: ${message}\n  fix: ${fix}\n`);
  process.exit(1);
};
const workspace = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".desolate", "workspace.json"), "utf8")) as { workspace: string; domain: string };
  } catch {
    return { workspace: "unknown", domain: "unknown" };
  }
})();

/** The repository the current directory is a checkout of, or the one named. */
const repoOf = async (named: string | undefined): Promise<string> => {
  if (named) {
    const repo = parseRepo(named) ?? fail(`'${named}' is not a repository`, "name it as <owner>/<repo>");
    if (!domainRepos().includes(repoId(repo))) fail(`${named} is not in this domain`, `this domain has: ${domainRepos().join(", ") || "no repositories"}`);
    return repoId(repo);
  }
  const top = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const match = /^\/workspaces\/([^/]+\/[^/]+)\/\.git$/.exec(top.stdout.trim());
  if (!match) fail("this directory is not a checkout of one of the domain's repositories", "cd into one under /workspaces, or name the repository: desolate offer <owner>/<repo>");
  return match![1]!;
};

const [, , verb, ...args] = process.argv;
if (verb === "fetch") {
  const repos = args[0] ? [await repoOf(args[0])] : domainRepos();
  for (const repo of repos) {
    const reply = await request({ op: "fetch", repo, workspace: workspace.workspace });
    if (reply.ok !== true) fail(`the root could not refresh ${repo}: ${String(reply.error)}`, "on the host: desolate fetch " + repo);
    const fetched = await run("git", ["-C", `/workspaces/${repo}`, "fetch", "--prune", "origin"]);
    if (fetched.code !== 0) fail(`git fetch failed in ${repo}: ${fetched.stderr.trim()}`, "git -C /workspaces/" + repo + " fetch origin");
    const delivered = await importDeliveries(repo);
    process.stdout.write(`${repo}: the mirror is refreshed and origin/* is up to date${delivered.length ? `; delivered from the root: ${delivered.map((b) => `root/${b}`).join(", ")}` : ""}.\n`);
  }
} else if (verb === "offer") {
  const repo = await repoOf(args[0] && args[0].includes("/") && parseRepo(args[0]) ? args[0] : undefined);
  const named = args[0] && !(args[0].includes("/") && parseRepo(args[0])) ? args[0] : args[1];
  const current = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const branch = named ?? current;
  if (!isBranch(branch)) fail(`'${branch}' is not a branch desolate will carry`, "check out the branch to offer, or name it: desolate offer <owner>/<repo> <branch>");
  const commit = (await branches(repo))[branch] ?? fail(`${repo} has no branch '${branch}' in this domain`, "git branch --list");
  const dirty = await run("git", ["-C", `/workspaces/${repo}`, "status", "--porcelain", "--untracked-files=no"]);
  const lfs = await stageLfs(repo, branch).catch((error: Error) => fail(error.message, "git lfs fsck"));
  await syncRepo(repo);
  const reply = await request({ op: "offer", repo, branch, commit, workspace: workspace.workspace, lfs });
  if (reply.ok !== true) fail(`the root did not take the offer: ${String(reply.error)}`, String(reply.fix ?? "on the host: desolate doctor"));
  process.stdout.write(`offered ${repo} ${branch} at ${commit.slice(0, 12)}${lfs.length ? `, with ${lfs.length} LFS object(s)` : ""}.\n`);
  process.stdout.write("It is now under \"Needs you\" in the root. Offering is not pushing: a person reviews it there and pushes.\n");
  if (dirty.stdout.trim()) process.stdout.write("note: the main checkout has uncommitted changes; only commits are offered.\n");
} else if (verb === "sync") {
  for (const repo of domainRepos()) {
    const result = await syncRepo(repo);
    await importDeliveries(repo);
    process.stdout.write(`${repo}: ${result.branches} branch(es) written for the root${result.bundled ? "" : " (nothing new to bundle)"}.\n`);
  }
} else {
  process.stdout.write("desolate, inside a workspace:\n  desolate fetch [<owner/repo>]             ask the root to refresh the mirror, then git fetch\n  desolate offer [<owner/repo>] [<branch>]  offer a branch to the root; a person reviews and pushes it\n  desolate sync                             write this domain's branches out for the root now\n  /desolate/status set <colour> \"<message>\"  say how the work is going\n");
  process.exit(verb && verb !== "help" ? 64 : 0);
}
