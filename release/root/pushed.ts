// What was pushed, and whether it has landed: a record of each branch the root pushed for a
// person, and, once the mirror shows the branch's changes in the branch it was for (its pull
// request merged, by a merge, a squash or a rebase), when that was seen. The dashboard and
// `desolate branches` mark such a branch "merged into <base>", so a workspace whose work is
// all in can be stopped or removed.
//
// Read from the mirror with git alone, and only from what the remote published: a domain's
// word decides nothing here but which branch a workspace is on. The check is conservative.
// It says "landed" only when every file the branch changed is, in the base, exactly as the
// branch left it; a base that has since changed one of those files again is not recognised
// (the branch is then just not marked).
import * as path from "node:path";
import { readJson, writeJson } from "../shared/json.ts";
import { isBranch, isCommit, pullRequestUrl } from "../shared/names.ts";
import type { RunResult } from "../shared/run.ts";
import { forge } from "./git.ts";
import { ROOT } from "./layout.ts";

export type Pushed = {
  repo: string; branch: string; commit: string;
  /** The branch a pull request would go into: the offer's `--base`, else the default branch. */
  base: string | null;
  at: string;
  /** When the mirror first showed the commit's changes in `base`. */
  landed?: string;
};

const FILE = () => path.join(ROOT.state, "pushed.json");
const KEEP = 500;
export const pushedList = (): Pushed[] => {
  const list = readJson<unknown>(FILE(), []);
  return Array.isArray(list) ? (list as Pushed[]) : [];
};

/** After a push: the newest push of a branch replaces what was recorded for it. */
export const recordPushed = (entry: { repo: string; branch: string; commit: string; base: string | null }) => {
  if (!isBranch(entry.branch) || !isCommit(entry.commit)) return;
  const base = entry.base && isBranch(entry.base) && entry.base !== entry.branch ? entry.base : null;
  const list = pushedList().filter((p) => !(p.repo === entry.repo && p.branch === entry.branch));
  list.push({ repo: entry.repo, branch: entry.branch, commit: entry.commit, base, at: new Date().toISOString() });
  writeJson(FILE(), list.slice(-KEEP));
};

/** After a push that landed: record it, and return GitHub's page for opening its pull
 *  request (null on another forge, or with no base). Never throws: the push has happened,
 *  and a record that could not be written must not make it look as if it had not. */
export const afterPush = (entry: { repo: string; branch: string; commit: string; base: string | null }, warn: (line: string) => void): string | null => {
  try {
    recordPushed(entry);
  } catch (error) {
    warn(`desolate: pushed, but not recorded, so it will not be marked when merged: ${(error as Error).message}`);
  }
  try {
    return forge().kind === "github" ? pullRequestUrl(entry.repo, entry.branch, entry.base) : null;
  } catch {
    return null;
  }
};

/** The base a branch's commit was pushed for and has landed in, or null. */
export const landedFor = (list: Pushed[], repo: string, branch: string, commit: string): string | null => {
  const p = list.find((e) => e.repo === repo && e.branch === branch && e.commit === commit);
  return p?.landed && p.base ? p.base : null;
};

type Git = (args: string[]) => Promise<RunResult>;

/** Whether `commit`'s changes are all in `base`, as the repository `git` runs in has them:
 *  `base` contains the commit (a merge, or a fast-forward), or every file the commit's branch
 *  changed since it left `base` is, in `base`, exactly as the commit has it (a squash, or a
 *  rebase). Read only: no merge is made, nothing is written. */
export const landedIn = async (git: Git, commit: string, base: string): Promise<boolean> => {
  const tip = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${base}^{commit}`])).stdout.trim();
  if (!tip || (await git(["cat-file", "-e", `${commit}^{commit}`])).code !== 0) return false;
  if ((await git(["merge-base", "--is-ancestor", commit, tip])).code === 0) return true;
  const fork = (await git(["merge-base", commit, tip])).stdout.trim();
  if (!fork) return false;
  const names = async (from: string, to: string) => {
    const out = await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", from, to]);
    return out.code === 0 ? out.stdout.split("\0").filter(Boolean) : null;
  };
  const changed = await names(fork, commit);
  const differs = await names(tip, commit);
  if (!changed || !differs || changed.length === 0) return false;
  const different = new Set(differs);
  return changed.every((file) => !different.has(file));
};

/** After the mirror of `repo` was fetched: each push of it not yet seen landed is looked for
 *  in its base. `git` runs in the mirror, whose refs/heads/* are the remote's branches. */
export const settle = async (repo: string, git: Git): Promise<number> => {
  const list = pushedList();
  let found = 0;
  for (const p of list) {
    if (p.repo !== repo || p.landed || !p.base) continue;
    if (await landedIn(git, p.commit, p.base)) {
      p.landed = new Date().toISOString();
      found++;
    }
  }
  if (found > 0) {
    // Written over what is there now, so a push recorded meanwhile is kept.
    const now = pushedList();
    for (const p of list) if (p.landed) {
      const same = now.find((e) => e.repo === p.repo && e.branch === p.branch && e.commit === p.commit);
      if (same && !same.landed) same.landed = p.landed;
    }
    writeJson(FILE(), now);
  }
  return found;
};

/** Repositories with a push still waiting to land, pushed in the last 30 days: the root
 *  fetches these now and then, so a pull request merged on the forge shows without anyone
 *  asking. */
export const waiting = (): string[] => {
  const since = Date.now() - 30 * 24 * 3600_000;
  return [...new Set(pushedList().filter((p) => !p.landed && p.base && Date.parse(p.at) > since).map((p) => p.repo))];
};
