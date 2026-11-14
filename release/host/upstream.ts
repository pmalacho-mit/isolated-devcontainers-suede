// `desolate upstream` on the Mac: the same command the git VM has (git/upstream.ts), run there
// on your clone of the consumer, then (unless --no-wait) a wait for the pull request the
// dependency's Action opens, through GitHub's API, which only the Mac can reach.
//
//   desolate upstream <consumer> <dependency-dir> <owner/repo> [--from <domain>/<branch> | <ref>]
//                     [--no-wait] [--remote <url>]
//
// The host runs no git on desolate's repositories: the split, the checks and the push are
// the git VM's, and the push waits for your approval on the approval page like any other.
import { EXIT, refuse } from "../shared/exit.ts";
import { isCommit, parseRepo, repoId } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { downstreamBranch } from "../shared/suede.ts";
import { printable } from "../shared/text.ts";
import { ensureGitClone, ensureGitVm, GIT_VM } from "./git-vm.ts";
import { guest } from "./paths.ts";
import { backend, config, rootctl } from "./stack.ts";

type Out = (line: string) => void;
const USAGE = "desolate upstream <consumer> <dependency-dir> <owner/repo> [--from <domain>/<branch>] [--no-wait] [--remote <url>]";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The pull request suede's Action opens for `branch`, as suede's own upstream waits for it.
 *  0: open (or nothing new to propose); 1: the Action failed; 2: none within the wait. */
export const waitForPull = async (dependency: Repo, branch: string, out: Out): Promise<number> => {
  const api = process.env.SUEDE_GITHUB_API ?? "https://api.github.com";
  const waitS = Number(process.env.SUEDE_UPSTREAM_WAIT) || 180;
  const everyS = Number(process.env.SUEDE_UPSTREAM_INTERVAL) || 5;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const ask = async (route: string): Promise<unknown> => {
    try {
      const answer = await fetch(`${api}/${route}`, { headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(20_000) });
      return answer.ok ? await answer.json() : null;
    } catch {
      return null;
    }
  };
  const slug = repoId(dependency);
  const head = encodeURIComponent(`${dependency.owner}:${branch}`);
  out(`waiting for the pull request (up to ${waitS} s; --no-wait skips this) ...`);
  for (const until = Date.now() + waitS * 1000; ; ) {
    const pulls = await ask(`repos/${slug}/pulls?head=${head}&state=all&per_page=1`);
    const pr = Array.isArray(pulls) ? (pulls[0] as { html_url?: unknown; draft?: unknown } | undefined) : undefined;
    if (pr && typeof pr.html_url === "string") {
      out(pr.draft === true ? "pull request opened as a draft: replaying the change onto the current release hit conflicts, left as markers for the maintainers:" : "pull request opened:");
      out(`  ${printable(pr.html_url, 300)}`);
      return EXIT.ok;
    }
    const runs = (await ask(`repos/${slug}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`)) as { workflow_runs?: { status?: unknown; conclusion?: unknown; html_url?: unknown }[] } | null;
    const run = runs?.workflow_runs?.[0];
    if (run && run.status === "completed") {
      if (run.conclusion !== "success") {
        out(`the Action that opens the pull request ended: ${printable(run.conclusion, 40)}`);
        out(`  ${printable(run.html_url, 300)}`);
        return EXIT.failed;
      }
      const branchThere = await ask(`repos/${slug}/branches/${encodeURIComponent(branch)}`);
      if (!branchThere) {
        out("nothing new to propose: the dependency's main already has this change, so its Action removed the branch and opened no pull request.");
        return EXIT.ok;
      }
    }
    if (Date.now() >= until) break;
    await sleep(everyS * 1000);
  }
  out(`no pull request after ${waitS} s. Follow the Action at https://github.com/${slug}/actions (branch: ${branch}).`);
  return 2;
};

export const upstreamCommand = async (positionals: string[], values: Record<string, unknown>, out: Out): Promise<number> => {
  if (positionals.length !== 3) refuse("upstream what?", USAGE, EXIT.usage);
  const [consumerName, dir, dependencyName] = positionals as [string, string, string];
  const consumer = parseRepo(consumerName) ?? refuse(`'${printable(consumerName, 100)}' is not a repository`, USAGE, EXIT.usage);
  const dependency = parseRepo(dependencyName) ?? refuse(`'${printable(dependencyName, 100)}' is not a repository`, USAGE, EXIT.usage);
  const from = typeof values.from === "string" ? values.from : null;
  if (from !== null && (!/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(from) || from.includes("..") || from.includes("@{"))) refuse(`'${printable(from, 100)}' is not a branch or a commit`, USAGE, EXIT.usage);
  const remote = typeof values.remote === "string" ? values.remote : null;
  // Which repositories desolate holds, and which it may push: the root's word.
  const held = await rootctl<{ repo: string; pushable: boolean }[]>("repo.list", {}, { quiet: true });
  const find = (repo: Repo) => held.find((r) => r.repo.toLowerCase() === repoId(repo).toLowerCase());
  if (!find(consumer)) refuse(`desolate does not hold ${repoId(consumer)}`, `desolate clone ${repoId(consumer)} --no-push`);
  const dep = find(dependency);
  if (!dep) refuse(`desolate does not hold ${repoId(dependency)}`, `desolate clone ${repoId(dependency)}`);
  if (!dep!.pushable) refuse(`${repoId(dependency)} is not pushable: the root holds no write key for it, so nothing can be proposed to it`, `it was cloned --no-push. To make it pushable: desolate clone ${repoId(dependency)}`);

  await ensureGitVm((line) => process.stderr.write(`${line}\n`));
  const clone = await ensureGitClone(consumer);
  // The consumer commit, so the branch can be waited on: what the git VM's command will take.
  const resolved = await backend().exec(GIT_VM, ["bash", "-c", 'cd "$1" || exit 1; case "$2" in */*) r=${2%%/*}; git remote | grep -qx -- "$r" && git fetch --quiet -- "$r";; esac; git rev-parse --verify --quiet "$2^{commit}"', "_", clone, from ?? "HEAD"], { timeoutMs: 600_000 });
  const commit = resolved.stdout.trim();
  if (!isCommit(commit)) refuse(`${repoId(consumer)} has no ${printable(from ?? "HEAD", 100)} in your git VM clone`, `desolate git ${repoId(consumer)}, then git fetch <domain>`);

  const args = [repoId(consumer), dir, repoId(dependency), ...(from ? ["--from", commit] : []), ...(remote ? ["--remote", remote] : [])];
  const code = await backend().attach(GIT_VM, ["bash", "-lc", 'cd "$1" && shift && exec desolate upstream "$@"', "_", clone, ...args], { cwd: guest.git });
  if (code !== 0) return code;
  const branch = downstreamBranch(consumer, commit);
  if (values["no-wait"] === true) return EXIT.ok;
  if (config()?.forge.kind !== "github") {
    out(`(the remote is not GitHub, so there is no pull request to wait for: the branch is ${branch})`);
    return EXIT.ok;
  }
  return waitForPull(dependency, branch, out);
};
