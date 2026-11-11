// offers, review, push, approve, and the root's shell: the host's part.
//
// A push is three steps, and the middle one happens here, outside every VM (P2):
//   1. the root checks the push and its keyring issues a challenge naming it;
//   2. the approver on this host shows the challenge to the person and signs it
//      (approver.ts: Touch ID on a Mac);
//   3. the root hands the signature to its keyring, which lets the write key sign for
//      that one push.
// Nothing in a VM can do step 2, so nothing in a VM can push.
import { EXIT, refuse } from "../shared/exit.ts";
import { sign } from "./approver.ts";
import { guest } from "./paths.ts";
import { backend, ROOT_VM, rootctl } from "./stack.ts";

type Out = (line: string) => void;
type Offer = { domain: string; repo: string; branch: string; commit: string; workspace: string; lfs: number; at: string };
type Review = { repo: string; branch: string; commit: string; pushable: boolean; isDefault: boolean; commits: { commit: string; subject: string }[]; files: string[]; stat: string; lfsObjects: number; warnings: string[] };

/** Text from a repository (a branch name, a commit subject) is shown as text: control
 *  characters that could repaint a terminal are replaced. */
const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");

export const offers = async (domain: string | undefined, out: Out, json: boolean) => {
  const list = await rootctl<Offer[]>("offers.list", { domain }, { quiet: true });
  if (json) return out(JSON.stringify(list));
  if (list.length === 0) return out("no offers. In a workspace, `desolate offer` marks a branch ready for you.");
  out("Needs you:");
  for (const o of list) out(`  ${o.domain}  ${o.repo}  ${plain(o.branch)}  ${o.commit.slice(0, 12)}  from ${o.workspace}${o.lfs ? `  ${o.lfs} LFS object(s)` : ""}\n    review: desolate review ${o.domain} ${o.repo} ${o.branch}`);
};

export const review = async (args: string[], out: Out, json: boolean) => {
  const [domain, repo, branch] = args;
  if (!domain || !repo || !branch) refuse("review what?", "desolate review <domain> <owner/repo> <branch>   (see `desolate offers`)", EXIT.usage);
  const r = await rootctl<Review>("review", { domain, repo, branch }, { quiet: true });
  if (json) return out(JSON.stringify(r));
  out(`${r.repo}  ${plain(r.branch)}  at ${r.commit}`);
  out(`a push would send ${r.commits.length} commit(s): ${r.stat || "no file changes"}${r.lfsObjects ? `, and ${r.lfsObjects} LFS object(s) first` : ""}`);
  for (const c of r.commits.slice(0, 30)) out(`  ${c.commit.slice(0, 12)}  ${plain(c.subject).slice(0, 100)}`);
  if (r.commits.length > 30) out(`  ... and ${r.commits.length - 30} more`);
  for (const file of r.files.slice(0, 40)) out(`  M ${plain(file)}`);
  if (r.files.length > 40) out(`  ... and ${r.files.length - 40} more files`);
  for (const warning of r.warnings) out(`  WARNING: ${warning}`);
  out(`read the diff in the root: desolate root shell, then: git -C /desolate/root/${r.repo} diff origin/HEAD...${domain}/${plain(r.branch)}`);
  if (!r.pushable) out(`${r.repo} is not pushable (cloned --no-push): there is no write key for it.`);
  else out(`to push exactly this: desolate push ${domain} ${r.repo} ${plain(r.branch)} --expect ${r.commit}${r.isDefault ? " --allow-default" : ""}`);
};

const PUSH = ["node", "--disable-warning=ExperimentalWarning", `${guest.release}/root/push.ts`];

export const push = async (args: string[]): Promise<number> => {
  const prepared = await backend().exec(ROOT_VM, [...PUSH, "prepare", ...args], { cwd: guest.rootClones, inheritStderr: true, timeoutMs: 300_000 });
  if (prepared.code !== 0) return prepared.code;
  let plan: { summary: string; warnings: string[]; message: string };
  try {
    plan = JSON.parse(prepared.stdout.trim().split("\n").pop() ?? "");
  } catch {
    return refuse("the root did not describe the push", "desolate doctor");
  }
  for (const warning of plan.warnings) process.stderr.write(`desolate: WARNING: this push ${plain(warning)}\n`);
  const signature = await sign(plan.message, plan.summary);
  return backend().attach(ROOT_VM, [...PUSH, "run", ...args, "--message", Buffer.from(plan.message).toString("base64"), "--signature", signature], { cwd: guest.rootClones });
};

/** `desolate approve`: answer the raw `git push` that is waiting in the root's terminal. */
export const approve = async (out: Out): Promise<number> => {
  const pending = await rootctl<{ message: string; summary: string }[]>("approvals.pending", {}, { quiet: true });
  if (pending.length === 0) {
    out("nothing is waiting for approval. (`desolate push` asks by itself; this is for a raw `git push` in `desolate root shell`.)");
    return 0;
  }
  for (const request of pending) {
    const signature = await sign(request.message, request.summary);
    await rootctl("approvals.answer", { message: request.message, signature }, { quiet: true });
    out("approved; the push waiting in the root continues.");
  }
  return 0;
};

export const rootShell = (): Promise<number> => backend().attach(ROOT_VM, ["bash", "-l"], { cwd: guest.rootClones });
