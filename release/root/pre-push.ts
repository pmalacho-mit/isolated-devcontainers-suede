// The root clones' pre-push hook (see hooks/pre-push). git gives it the remote's name and
// URL as arguments and one line per ref on stdin: <local ref> <local sha> <remote ref> <remote sha>.
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { isBranch, isCommit, parseRepo } from "../shared/names.ts";
import { registry } from "./repos.ts";

const [, , remote, url] = process.argv;
// A push to a domain is a delivery through desolate's helper: a local transfer, not a push
// to any remote (section 6.4).
if ((url ?? "").startsWith("desolate::")) process.exit(0);
const fail = (message: string, fix: string): never => {
  process.stderr.write(`desolate: ${message}\n  fix: ${fix}\n`);
  process.exit(1);
};
const repoName = spawnSync("git", ["config", "--get", "desolate.repo"], { encoding: "utf8" }).stdout.trim();
const repo = parseRepo(repoName) ?? fail("this is not one of the root's clones", "push from a clone under /desolate/root");
if (remote !== "origin") fail(`'${remote}' is not a remote desolate pushes to`, "push to origin (the remote) or to a domain");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const HERE = path.dirname(new URL(import.meta.url).pathname);
for (const line of input.split("\n").filter(Boolean)) {
  const [, local, target] = line.split(" ");
  const branch = (target ?? "").replace(/^refs\/heads\//, "");
  if (!target?.startsWith("refs/heads/") || !isBranch(branch)) fail(`desolate pushes branches, not ${target}`, "push a branch");
  if (!isCommit(local) || /^0+$/.test(local!)) fail(`deleting ${branch} on the remote is not something desolate does`, "delete it on the forge");
  // `desolate push` already asked, for exactly this commit.
  if (process.env.DESOLATE_PUSH_APPROVED === local) continue;
  if (registry().repos[repoName]?.defaultBranch === branch) fail(`${branch} is ${repoName}'s default branch`, `push a branch; or use: desolate push <domain> ${repoName} ${branch} --expect ${local} --allow-default`);
  const asked = spawnSync("sudo", ["-n", "-u", "desolate-keyring", "/usr/local/bin/node", "--disable-warning=ExperimentalWarning", `${HERE}/keyring-confirm.ts`, `${repo!.owner}/${repo!.name}`, branch, local!, "a raw git push from the root's terminal"], { stdio: ["inherit", "ignore", "inherit"] });
  if (asked.status !== 0) process.exit(1);
}
