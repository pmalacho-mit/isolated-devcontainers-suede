// Offers (section 6.4): a branch a workspace marked ready. Taking one brings the branch into
// the root clone (through the domain's remote), verifies and imports the LFS objects its
// commits reference, and records it under "Needs you". Offering is not pushing.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { refuse } from "../shared/exit.ts";
import { readJson, writeJson } from "../shared/json.ts";
import { isBranch, isCommit, isLfsOid, parseRepo } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { domain as domainOf, domains } from "./domains.ts";
import { git, gitOk, ownedByRoot, safeIn } from "./git.ts";
import { clonePath, domainPath, GITCONFIG, mirrorPath, ROOT } from "./layout.ts";
import { dropLfs, refusalsOf, takeLfs } from "./outbox.ts";
import { recordOf } from "./repos.ts";

export type Offer = { domain: string; repo: string; branch: string; commit: string; workspace: string; lfs: number; at: string };
const file = (domain: string) => path.join(domainPath(domain), "offers.json");
export const offersOf = (domain: string): Offer[] => readJson<Offer[]>(file(domain), []);
export const allOffers = (only?: string): Offer[] => domains().filter((d) => !only || d.slug === only).flatMap((d) => offersOf(d.slug));

const lfsStore = (dir: string, oid: string) => path.join(dir, oid.slice(0, 2), oid.slice(2, 4), oid);

/** Bring a domain's branches into the root clone: `git fetch <domain>`, by the helper. */
export const fetchDomain = async (domain: string, repo: Repo) => {
  const result = await git(clonePath(repo), ["fetch", "--quiet", "--prune", domain], { timeoutMs: 600_000 });
  if (result.code !== 0) throw new Error(`could not bring ${domain}'s branches of ${repo.owner}/${repo.name} into the root clone: ${result.stderr.trim().slice(-400)}`);
};

export const take = async (domain: string, request: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const d = domainOf(domain);
  const repo = parseRepo(request.repo);
  if (!repo || !d.repos.includes(String(request.repo))) return { ok: false, error: "that repository is not in this domain" };
  if (!isBranch(request.branch) || !isCommit(request.commit)) return { ok: false, error: "an offer names a branch and a commit" };
  const id = String(request.repo);
  const clone = clonePath(repo);
  // Two VMs see a share each through its own cache, and nothing makes them agree at once:
  // on vz an entry a workspace has just replaced (a link turned back into a directory, a
  // refs list renamed over) can look as it was to the root for about a second (measured).
  // So what the workspace says it sent is looked for again, briefly, before it is refused.
  let have = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 700));
    await fetchDomain(domain, repo);
    have = (await git(clone, ["rev-parse", "--verify", "--quiet", `refs/remotes/${domain}/${request.branch}`])).stdout.trim();
    if (have === request.commit || refusalsOf(domain).some((r) => r.repo === id)) break;
  }
  if (have !== request.commit) {
    const refusal = refusalsOf(domain).find((r) => r.repo === id);
    if (refusal) return { ok: false, error: `the root refused this domain's bundle of ${id}: ${refusal.why}`, fix: "a branch in this domain holds an object git calls dangerous (a .git inside a tree, a .gitmodules that is a symlink or names an option, a malformed object). Nothing new is taken until that branch is deleted here; then offer again" };
    return { ok: false, error: `the root received ${have ? have.slice(0, 12) : "nothing"} for ${request.branch}, not ${request.commit.slice(0, 12)}`, fix: "run `desolate sync`, then offer again" };
  }

  // LFS: every object the offer names is verified against its id and its pointer's size
  // before it is the root's. Then every pointer in the offered commits must resolve.
  const staged = Array.isArray(request.lfs) ? request.lfs.slice(0, 2000) : [];
  for (const item of staged as { oid?: unknown; size?: unknown }[]) {
    if (!isLfsOid(item.oid) || !Number.isInteger(item.size)) return { ok: false, error: "an LFS object is named by its sha256 and its size" };
    const target = lfsStore(path.join(clone, ".git", "lfs", "objects"), item.oid);
    if (!fs.existsSync(target)) {
      const taken = takeLfs(domain, id, item.oid, item.size as number, target);
      if ("error" in taken) return { ok: false, error: taken.error, fix: "offer again" };
    }
    else dropLfs(domain, id, item.oid);
  }
  const missing = await missingLfs(repo, request.commit);
  if (missing.length > 0) return { ok: false, error: `the offered commits reference ${missing.length} LFS object(s) the root does not have (${missing[0]!.slice(0, 12)}...)`, fix: "offer again from the workspace that made them" };

  const offers = offersOf(domain).filter((o) => !(o.repo === id && o.branch === request.branch));
  offers.push({ domain, repo: id, branch: request.branch, commit: request.commit, workspace: String(request.workspace ?? "").slice(0, 40), lfs: staged.length, at: new Date().toISOString() });
  writeJson(file(domain), offers);
  return { ok: true };
};

export const withdraw = (domain: string, repo: string, branch: string) => {
  writeJson(file(domain), offersOf(domain).filter((o) => !(o.repo === repo && o.branch === branch)));
};

const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/;

/** LFS objects referenced by commits reachable from `commit` and not from origin. */
export const lfsOf = async (repo: Repo, commit: string): Promise<string[]> => {
  const clone = clonePath(repo);
  const listed = await gitOk(clone, ["rev-list", "--objects", commit, "--not", "--remotes=origin"]);
  const ids = listed.split("\n").map((line) => line.split(" ")[0]!).filter((id) => /^[0-9a-f]{40,64}$/.test(id));
  if (ids.length === 0) return [];
  const sizes = await gitOk(clone, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { input: ids.join("\n") + "\n" });
  const oids: string[] = [];
  for (const line of sizes.split("\n")) {
    const [id, type, size] = line.split(" ");
    if (type !== "blob" || Number(size) >= 400) continue;
    const match = POINTER.exec(await gitOk(clone, ["cat-file", "blob", id!]));
    if (match && !oids.includes(match[1]!)) oids.push(match[1]!);
  }
  return oids;
};

const missingLfs = async (repo: Repo, commit: string) =>
  (await lfsOf(repo, commit)).filter((oid) => !fs.existsSync(lfsStore(path.join(clonePath(repo), ".git", "lfs", "objects"), oid)) && !fs.existsSync(lfsStore(path.join(mirrorPath(repo), "lfs", "objects"), oid)));

export type Review = {
  domain: string; repo: string; branch: string; commit: string; base: string; defaultBranch: string | null;
  pushable: boolean; isDefault: boolean; commits: { commit: string; subject: string }[]; files: string[];
  stat: string; lfsObjects: number; warnings: string[];
};

/** What a push would send (section 8: `desolate review`). Read from the root clone only. */
export const review = async (domain: string, repoArg: unknown, branch: unknown): Promise<Review> => {
  const d = domainOf(domain);
  const repo = parseRepo(repoArg) ?? refuse(`'${String(repoArg)}' is not a repository`, "name it as <owner>/<repo>");
  const id = `${repo.owner}/${repo.name}`;
  if (!d.repos.includes(id)) refuse(`${id} is not in the domain '${domain}'`, `desolate domain ${domain} show`);
  if (!isBranch(branch)) refuse(`'${String(branch)}' is not a branch`, `desolate offers ${domain}`);
  const record = recordOf(repo);
  await fetchDomain(domain, repo);
  const clone = clonePath(repo);
  const commit = (await git(clone, ["rev-parse", "--verify", "--quiet", `refs/remotes/${domain}/${branch}`])).stdout.trim();
  if (!commit) refuse(`the domain '${domain}' has no branch '${branch}' of ${id}`, `desolate offers ${domain}`);
  const upstream = record.defaultBranch ? `refs/remotes/origin/${record.defaultBranch}` : "";
  const base = upstream ? (await git(clone, ["merge-base", commit, upstream])).stdout.trim() : "";
  const range = base ? `${base}..${commit}` : commit;
  const log = await gitOk(clone, ["log", "--format=%H%x09%s", "--max-count=200", range]);
  const files = (await gitOk(clone, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", base || "4b825dc642cb6eb9a060e54bf8d69288fbee4904", commit])).split("\0").filter(Boolean);
  const stat = (await gitOk(clone, ["diff", "--no-ext-diff", "--no-textconv", "--shortstat", base || "4b825dc642cb6eb9a060e54bf8d69288fbee4904", commit])).trim();
  const warnings: string[] = [];
  if (files.some((f) => f === ".github" || f.startsWith(".github/"))) warnings.push("changes .github/: a pushed branch's own workflows run on the remote, with the repository's secrets");
  if (files.some((f) => /(^|\/)\.suede\/core\//.test(f))) warnings.push("changes a vendored .suede/core/: a proposal that rewrites suede's own machinery is worth a second look");
  if (files.some((f) => f === ".lfsconfig" || f === ".gitattributes" || f === ".gitmodules")) warnings.push("changes .lfsconfig, .gitattributes or .gitmodules: these steer what git does with this repository elsewhere");
  return {
    domain, repo: id, branch, commit, base, defaultBranch: record.defaultBranch, pushable: record.pushable,
    isDefault: branch === record.defaultBranch,
    commits: log.split("\n").filter(Boolean).map((line) => ({ commit: line.slice(0, line.indexOf("\t")), subject: line.slice(line.indexOf("\t") + 1) })),
    files, stat, lfsObjects: (await lfsOf(repo, commit)).length, warnings,
  };
};

/** The diff a push would send, as text, for a person to read before they push it. Made by
 *  git from objects in the root clone, with nothing the content could steer: no external
 *  diff program, no textconv, no colour, no pager, and no checkout (two commits are
 *  compared; no file of the branch is ever written into the root's working tree). The text
 *  is the content's, so whoever shows it shows it as text. Capped: a diff too long to read
 *  is cut, and says so. */
export const DIFF_LIMIT = 1024 * 1024;
export const diff = async (domain: string, repoArg: unknown, branch: unknown): Promise<{ repo: string; branch: string; commit: string; base: string; text: string; truncated: boolean }> => {
  const r = await review(domain, repoArg, branch);
  const clone = clonePath(parseRepo(r.repo)!);
  if (!ownedByRoot(clone)) throw new Error("not a root clone");
  const child = spawn("git", [...safeIn(clone), "-C", clone, "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--unified=3", r.base || "4b825dc642cb6eb9a060e54bf8d69288fbee4904", r.commit, "--"],
    { stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: GITCONFIG, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "" } });
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const timer = setTimeout(() => {
    truncated = true;
    child.kill("SIGKILL");
  }, 60_000);
  child.stdout.on("data", (chunk: Buffer) => {
    if (size + chunk.length > DIFF_LIMIT) {
      chunks.push(chunk.subarray(0, DIFF_LIMIT - size));
      size = DIFF_LIMIT;
      truncated = true;
      child.kill("SIGKILL");
    } else {
      chunks.push(chunk);
      size += chunk.length;
    }
  });
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  clearTimeout(timer);
  return { repo: r.repo, branch: r.branch, commit: r.commit, base: r.base, text: Buffer.concat(chunks).toString("utf8"), truncated };
};
