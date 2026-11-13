// offers, review, push, approve, and the root's shell: the host's part.
//
// A push is three steps, and the middle one happens here, outside every VM (P2):
//   1. the root checks the push and its keyring issues a challenge naming it;
//   2. the approver on this host shows the challenge to the person and signs it
//      (approver.ts: on your terminal, or Touch ID if chosen);
//   3. the root hands the signature to its keyring, which lets the write key sign for
//      that one push.
// Nothing in a VM can do step 2, so nothing in a VM can push.
import { printable, printableLines } from "../shared/text.ts";
import { EXIT, refuse } from "../shared/exit.ts";
import { editorHostPort, ROOT_HOSTNAME } from "../shared/names.ts";
import { sign } from "./approver.ts";
import { parseApproval } from "../shared/approval.ts";
import { guest } from "./paths.ts";
import { backend, ROOT_VM, rootctl } from "./stack.ts";

type Out = (line: string) => void;
type Offer = { domain: string; repo: string; branch: string; commit: string; workspace: string; lfs: number; at: string };
type Review = { repo: string; branch: string; commit: string; pushable: boolean; isDefault: boolean; commits: { commit: string; subject: string }[]; files: string[]; stat: string; lfsObjects: number; warnings: string[] };

/** Text from a repository (a branch name, a commit subject) is shown as text: control
 *  characters that could repaint a terminal are replaced. */
const plain = (text: string) => printable(text, Infinity);

export const offers = async (domain: string | undefined, out: Out, json: boolean) => {
  const list = await rootctl<Offer[]>("offers.list", { domain }, { quiet: true });
  if (json) return out(JSON.stringify(list));
  const refused = await rootctl<{ domain: string; repo: string; at: string; why: string }[]>("offers.refused", { domain }, { quiet: true }).catch(() => []);
  for (const r of refused) out(`Refused from ${r.domain} (${r.repo}, ${r.at}): ${plain(r.why)}\n  Nothing new from ${r.domain} is taken while one of its branches holds what git refused. Delete that branch in the workspace, then \`desolate sync\` there.`);
  if (list.length === 0) return out("no offers. In a workspace, `desolate offer` marks a branch ready for you.");
  out("Needs you:");
  for (const o of list) out(`  ${o.domain}  ${o.repo}  ${plain(o.branch)}  ${o.commit.slice(0, 12)}  from ${o.workspace}${o.lfs ? `  ${o.lfs} LFS object(s)` : ""}\n    review: desolate review ${o.domain} ${o.repo} ${o.branch}`);
};

/** `desolate branches [<domain>]`: every branch each domain has, not only what was offered.
 *  The list is each domain's own word; `desolate review` reads the branch in the root. */
export const branches = async (domain: string | undefined, out: Out, json: boolean) => {
  const list = await rootctl<{ domain: string; repo: string; branch: string; commit: string; offered: boolean; checkedOutIn: string[] }[]>("branches.list", domain ? { domain } : {}, { quiet: true });
  if (json) return out(JSON.stringify(list));
  if (list.length === 0) return out(domain ? `${domain} has no branches the root has heard of yet` : "no domain has any branch the root has heard of yet");
  for (const b of list)
    out(`  ${b.domain}  ${b.repo}  ${plain(b.branch)}  ${b.commit.slice(0, 12)}${b.offered ? "  offered" : ""}${b.checkedOutIn.length ? `  checked out in ${b.checkedOutIn.join(", ")}` : ""}\n    review: desolate review ${b.domain} ${b.repo} ${plain(b.branch)}`);
};

export const review = async (args: string[], out: Out, json: boolean, against: "origin" | "domain" = "origin") => {
  const diff = args.includes("--diff");
  const [domain, repo, branch] = args.filter((arg) => arg !== "--diff");
  if (!domain || !repo || !branch) refuse("review what?", "desolate review <domain> <owner/repo> <branch> [--against origin|domain]   (see `desolate branches` and `desolate offers`)", EXIT.usage);
  const r = await rootctl<Review & { againstLabel?: string; pushCommits?: number }>("review", { domain, repo, branch, against }, { quiet: true });
  if (json) return out(JSON.stringify(r));
  out(`${r.repo}  ${plain(r.branch)}  at ${r.commit}, against ${r.againstLabel ?? "origin"}`);
  out(against === "domain"
    ? `beyond ${r.againstLabel ?? "the domain's default branch"}: ${r.commits.length} commit(s), ${r.stat || "no file changes"}. A push would send ${r.pushCommits} commit(s) (against origin).`
    : `a push would send ${r.commits.length} commit(s): ${r.stat || "no file changes"}${r.lfsObjects ? `, and ${r.lfsObjects} LFS object(s) first` : ""}`);
  for (const c of r.commits.slice(0, 30)) out(`  ${c.commit.slice(0, 12)}  ${plain(c.subject).slice(0, 100)}`);
  if (r.commits.length > 30) out(`  ... and ${r.commits.length - 30} more`);
  for (const file of r.files.slice(0, 40)) out(`  ${plain(file)}`);
  if (r.files.length > 40) out(`  ... and ${r.files.length - 40} more files`);
  for (const warning of r.warnings) out(`  WARNING: ${warning}`);
  if (diff) {
    // The diff is the content's own text, made in the root by git alone. Shown as text:
    // anything that could repaint a terminal is replaced.
    const d = await rootctl<{ text: string; truncated: boolean }>("review.diff", { domain, repo, branch, against }, { quiet: true });
    out("");
    out(printableLines(d.text).trimEnd());
    if (d.truncated) out("... the diff is longer than is shown here. The whole of it: desolate root shell, then git diff.");
  } else {
    out(`read the diff: desolate review ${domain} ${r.repo} ${plain(r.branch)} --diff${against === "domain" ? " --against domain" : ""}`);
    out(`  or in the dashboard: http://${ROOT_HOSTNAME}:${editorHostPort()}/?review&domain=${encodeURIComponent(domain)}&repo=${encodeURIComponent(r.repo)}&branch=${encodeURIComponent(r.branch)}`);
    out("  or with git, in `desolate root shell`");
  }
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
  const signature = await sign(plan.message, await reviewed(plan.message));
  void (await import("./daemon.ts")).announceApproved(plan.message);
  return backend().attach(ROOT_VM, [...PUSH, "run", ...args, "--message", Buffer.from(plan.message).toString("base64"), "--signature", signature], { cwd: guest.rootClones });
};

/** `desolate approve`: answer the raw `git push` that is waiting in the root's terminal. */
/** The reviewer's account of a push, in one line for the terminal's prompt: what the
 *  approval page shows, from the root's reviewer, not the root's ordinary user (which reads
 *  what domains write). */
const reviewed = async (message: string): Promise<string> => {
  const push = parseApproval(message);
  if (!push) return "";
  const { reviewerSummary } = await import("./daemon.ts");
  const s = await reviewerSummary(push);
  if (!s.ok) return `desolate's reviewer could not say what this push would send (${s.error ?? "no answer"}): approve only if you know`;
  const commits = (s.commits?.length ?? 0) + (s.more ?? 0);
  const files = (s.files?.length ?? 0) + (s.moreFiles ?? 0);
  return [
    s.fastForward === false ? "REPLACES the remote's branch (commits only the remote has are dropped);" : "",
    `${commits} commit(s) the remote does not have, ${files} file(s)${s.lfs ? `, ${s.lfs} of them LFS` : ""}`,
    ...(s.warnings ?? []).map((w) => `; warning: ${w}`),
    s.files?.some((f) => f.sensitive) ? "; changes what runs on the forge" : "",
  ].join(" ").trim();
};

export const approve = async (out: Out): Promise<number> => {
  const pending = await rootctl<{ message: string; summary: string }[]>("approvals.pending", {}, { quiet: true });
  if (pending.length === 0) {
    out("nothing is waiting for approval. (`desolate push` asks by itself; this is for a raw `git push` in `desolate root shell`.)");
    return 0;
  }
  for (const request of pending) {
    const signature = await sign(request.message, await reviewed(request.message));
    void (await import("./daemon.ts")).announceApproved(request.message);
    await rootctl("approvals.answer", { message: request.message, signature }, { quiet: true });
    out("approved; the push waiting in the root continues.");
  }
  return 0;
};

export const rootShell = (): Promise<number> => backend().attach(ROOT_VM, ["bash", "-l"], { cwd: guest.rootClones });
