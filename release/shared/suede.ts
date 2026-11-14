// suede's names and rules, in one place: what `desolate upstream` (git/upstream.ts, in the
// git VM), the root (a push of a `downstream/...` branch) and the reviewer agree on.
// Nothing here runs a program; the checks that need git take one that the caller runs.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../.suede/nests/dsl.import.meta.vitest.ts";
import { isCommit, parseRepo, repoId } from "./names.ts";
import type { Repo } from "./names.ts";

/** suede's own spelling of a branch segment (upstream.sh, sanitize_seg). */
export const segment = (raw: string) =>
  raw.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").replace(/^[-.]+/, "").replace(/[-.]+$/, "");

declare namespace segment {
  export type Cases = Table<typeof segment, [
    [args: [raw: "acme"], expected: "acme"],
    [args: [raw: "my_app.v2"], expected: "my_app.v2"],
    [args: [raw: "a b//c"], expected: "a-b-c"],
    [args: [raw: "-.x.-"], expected: "x"],
  ]>;
}

/** The branch suede's upstream pushes a consumer's proposal to, and the dependency's
 *  `suede-downstream-to-main` Action fires on: `downstream/<owner>/<repo>-<consumer commit>`. */
export const downstreamBranch = (consumer: Repo, commit: string) =>
  `downstream/${segment(consumer.owner)}/${segment(consumer.name) || "repo"}-${commit}`;

declare namespace downstreamBranch {
  export type Cases = Table<typeof downstreamBranch, [
    [args: [consumer: { owner: "acme"; name: "app" }, commit: "0123456789abcdef0123456789abcdef01234567"], expected: "downstream/acme/app-0123456789abcdef0123456789abcdef01234567"],
  ]>;
}

/** A suede proposal's branch, as the root sees one. */
export const isDownstream = (branch: string) => branch.startsWith("downstream/");

/** The repository a remote's address names (`.gitrepo`'s `remote`, suede's `--remote`), or
 *  null. Any host: desolate pushes to the repository the person named, through its own forge,
 *  so the host is not what is compared. Only addresses git would reach over the network:
 *  never a local path, a `file://`, or a transport helper (`ext::...`). */
export const remoteRepo = (url: unknown): Repo | null => {
  if (typeof url !== "string" || url.length > 500 || /[\s\p{Cc}]/u.test(url) || url.startsWith("-") || url.includes("::")) return null;
  const scheme = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?[A-Za-z0-9._-]+(?::\d+)?\/(.+)$/.exec(url);
  const scp = scheme ? null : /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+:(?!\/)(.+)$/.exec(url);
  const rest = (scheme ?? scp)?.[1];
  return rest ? parseRepo(rest.replace(/\/+$/, "").replace(/\.git$/, "")) : null;
};

declare namespace remoteRepo {
  export type Names = Table<typeof remoteRepo, [
    [args: [url: "https://github.com/acme/lib"], expected: { owner: "acme"; name: "lib" }],
    [args: [url: "https://github.com/acme/lib.git"], expected: { owner: "acme"; name: "lib" }],
    [args: [url: "git@github.com:acme/lib.git"], expected: { owner: "acme"; name: "lib" }],
    [args: [url: "git@github.com-acme__lib:acme/lib.git"], expected: { owner: "acme"; name: "lib" }],
    [args: [url: "ssh://git@10.0.0.2:2222/acme/lib.git"], expected: { owner: "acme"; name: "lib" }],
  ]>;
  export type Refuses = Table<typeof remoteRepo, [
    [args: [url: "/srv/git/acme/lib.git"], expected: null],
    [args: [url: "file:///srv/acme/lib"], expected: null],
    [args: [url: "ext::sh -c touch% /tmp/x"], expected: null],
    [args: [url: "-oProxyCommand=x:acme/lib"], expected: null],
    [args: [url: "https://gitlab.com/group/sub/lib"], expected: null],
    [args: [url: "https://github.com/acme/../lib"], expected: null],
    [args: [url: 42], expected: null],
  ]>;
}

/** GitHub's names are not case-sensitive. */
export const sameRepo = (a: Repo, b: Repo) => repoId(a).toLowerCase() === repoId(b).toLowerCase();

/** What a `.gitrepo` says, as `git config --blob ... --get subrepo.<key>` read it. */
export type Gitrepo = { remote: string | null; branch: string | null; commit: string | null; parent: string | null; method: string | null };

/** Why a `.gitrepo` is not one desolate will hand to git-subrepo, or null. Its `commit` and
 *  `parent` become git arguments there; the rest is replaced (`-r`, `-b`) or unused. */
export const gitrepoProblem = (g: Gitrepo): string | null => {
  if (!isCommit(g.commit)) return "its commit is not a full commit id";
  if (g.parent !== null && !isCommit(g.parent)) return "its parent is not a full commit id";
  if (g.method !== null && g.method !== "merge" && g.method !== "rebase") return "its method is neither merge nor rebase";
  return null;
};

declare namespace gitrepoProblem {
  export type Cases = Table<typeof gitrepoProblem, [
    [args: [g: { remote: "https://github.com/acme/lib"; branch: "release"; commit: "0123456789abcdef0123456789abcdef01234567"; parent: null; method: "merge" }], expected: null],
    [args: [g: { remote: null; branch: null; commit: "0123456789abcdef0123456789abcdef01234567 -F /etc/passwd"; parent: null; method: null }], expected: "its commit is not a full commit id"],
    [args: [g: { remote: null; branch: null; commit: "0123456789abcdef0123456789abcdef01234567"; parent: "HEAD"; method: null }], expected: "its parent is not a full commit id"],
    [args: [g: { remote: null; branch: null; commit: "0123456789abcdef0123456789abcdef01234567"; parent: null; method: "squash" }], expected: "its method is neither merge nor rebase"],
  ]>;
}

/** suede's own machinery, as a dependency vendors it: every consumer runs it. */
export const SUEDE_CORE = /(^|\/)\.suede\/core\//;
/** A dependency's workflows: they run on its remote, with its secrets, when a branch is pushed. */
export const GITHUB_DIR = /^\.github(\/|$)/;

/** git, as the caller runs it (in its own repository). */
export type Git = (args: string[]) => Promise<{ code: number; stdout: string }>;

/** The object a commit has at `.github` (null: none). */
const githubOf = async (git: Git, commit: string) => {
  const found = await git(["rev-parse", "--verify", "--quiet", `${commit}:.github`]);
  return found.code === 0 && /^[0-9a-f]{40}$/.test(found.stdout.trim()) ? found.stdout.trim() : null;
};

/** The root's rule for a push of a `downstream/...` branch, however it was asked for: the
 *  commit's `.github/` is exactly that of a commit the remote already has (one of `tips`) and
 *  that it builds on (a merge base). Returns why not, or null. */
export const downstreamRefusal = async (git: Git, commit: string, tips: string[]): Promise<string | null> => {
  const bases = new Set<string>();
  for (const tip of tips.slice(0, 200)) {
    const found = await git(["merge-base", "--all", commit, tip]);
    if (found.code === 0) for (const id of found.stdout.split("\n")) if (isCommit(id.trim())) bases.add(id.trim());
  }
  if (bases.size === 0) return "it builds on nothing the remote has: a suede proposal builds on the dependency's release";
  const mine = await githubOf(git, commit);
  for (const base of bases) if ((await githubOf(git, base)) === mine) return null;
  return "it changes the dependency's .github/: a pushed branch's own workflows run on the remote, with its secrets, on the push itself. Proposals leave .github/ alone; make that change in the dependency yourself";
};
