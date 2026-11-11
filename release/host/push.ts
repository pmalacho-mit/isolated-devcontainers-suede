// offers, review, push, and the root's shell: the host's part. The push itself runs in the
// root VM, attached to this terminal if there is one. With no terminal nobody can be asked,
// and the push is refused there (P2): this file cannot make it happen.
import { EXIT, refuse } from "../shared/exit.ts";
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

export const push = (args: string[]): Promise<number> =>
  backend().attach(ROOT_VM, ["node", "--disable-warning=ExperimentalWarning", `${guest.release}/root/push.ts`, ...args], { cwd: guest.rootClones });

export const rootShell = (): Promise<number> => backend().attach(ROOT_VM, ["bash", "-l"], { cwd: guest.rootClones });
