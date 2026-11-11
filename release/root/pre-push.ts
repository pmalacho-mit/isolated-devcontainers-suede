// The root clones' pre-push hook (see hooks/pre-push). git gives it the remote's name and
// URL as arguments and one line per ref on stdin: <local ref> <local sha> <remote ref> <remote sha>.
//
// Pushes through desolate's own helpers (to a domain; to `origin`, whose push address is
// git-remote-desolate-push) are gated there. What is left for this hook is a push straight
// to the remote's address: by send.ts, after an approval, or by hand. It lets through only
// the exact commit a person approved on the host, so an approval for one commit cannot
// carry another. (`--no-verify` skips this file; then only a live approval for the
// repository stands between the push and the remote. See docs/v3/decisions.md.)
import { spawnSync } from "node:child_process";
import { isBranch, isCommit, parseRepo } from "../shared/names.ts";
import { ask } from "./keyring-client.ts";
import { KEYRING } from "./layout.ts";

const [, , , url] = process.argv;
if ((url ?? "").startsWith("desolate::") || (url ?? "").startsWith("desolate-push::")) process.exit(0);
const fail = (message: string, fix: string): never => {
  process.stderr.write(`desolate: ${message}\n  fix: ${fix}\n`);
  process.exit(1);
};
const repoName = spawnSync("git", ["config", "--get", "desolate.repo"], { encoding: "utf8" }).stdout.trim();
if (!parseRepo(repoName)) fail("this is not one of the root's clones", "push from a clone under /desolate/root");
let input = "";
for await (const chunk of process.stdin) input += chunk;
for (const line of input.split("\n").filter(Boolean)) {
  const [, local, target] = line.split(" ");
  const branch = (target ?? "").replace(/^refs\/heads\//, "");
  if (!target?.startsWith("refs/heads/") || !isBranch(branch)) fail(`desolate pushes branches, not ${target}`, "push a branch");
  if (!isCommit(local) || /^0+$/.test(local!)) fail(`deleting ${branch} on the remote is not something desolate does`, "delete it on the forge");
  const approved = await ask(KEYRING.control, { op: "approved", repo: repoName, ref: branch, commit: local });
  if (approved.ok !== true) fail(`no person approved pushing ${local!.slice(0, 12)} to ${branch} of ${repoName}`, "git push origin <branch> (it asks, and you approve on the host), or `desolate push` on the host");
}
