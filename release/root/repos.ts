// Repositories in the root: keys, the mirror (what the remote published, LFS included) and
// the root clone (the person's own). Sections 5.3, 6.1-6.3.
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, writeJson } from "../shared/json.ts";
import { repoId } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { refuse } from "../shared/exit.ts";
import { forge, git, gitBare, gitOk, remoteUrl, sshCommand } from "./git.ts";
import { ask } from "./keyring-client.ts";
import { clonePath, HOOKS, KEYRING, MIRROR_HOOKS, mirrorPath, REGISTRY } from "./layout.ts";

export type RepoRecord = {
  /** The root holds a write key for it. A domain has no access level: every domain reads,
   *  only the root writes. */
  pushable: boolean;
  /** No key could be added (someone else's public repository): fetched without one. */
  anonymous: boolean;
  defaultBranch: string | null;
  fetchedAt: string | null;
};
type Registry = { repos: Record<string, RepoRecord> };

export const registry = (): Registry => readJson<Registry>(REGISTRY, { repos: {} });
const save = (value: Registry) => writeJson(REGISTRY, value);
export const recordOf = (repo: Repo): RepoRecord =>
  registry().repos[repoId(repo)] ?? refuse(`${repoId(repo)} is not cloned into the root`, `desolate clone ${repoId(repo)}`);

const NOWHERE = "/dev/null/desolate/this-repository-is-not-pushable";

const keyring = async (request: Record<string, unknown>) => {
  const reply = await ask(KEYRING.control, request);
  if (reply.ok !== true) throw new Error(`keyring: ${String(reply.error)}`);
  return reply;
};

/** Step 1 of `desolate clone`: make the keys and say which public halves the forge needs.
 *  The host registers them (it has the person's `gh`; the root has no forge credentials). */
export const prepare = async (repo: Repo, options: { push: boolean; anonymous: boolean }) => {
  const all = registry();
  const existing = all.repos[repoId(repo)];
  const record: RepoRecord = existing ?? { pushable: false, anonymous: options.anonymous, defaultBranch: null, fetchedAt: null };
  const keys: { role: "read" | "write"; pubkey: string }[] = [];
  if (!options.anonymous) {
    record.anonymous = false;
    keys.push({ role: "read", pubkey: String((await keyring({ op: "create", repo: repoId(repo), role: "read" })).pubkey) });
  }
  if (options.push) {
    if (options.anonymous) refuse("a repository fetched anonymously cannot be pushable: a push needs a write key", "drop --anonymous, or add --no-push");
    record.pushable = true;
    keys.push({ role: "write", pubkey: String((await keyring({ op: "create", repo: repoId(repo), role: "write" })).pubkey) });
  }
  all.repos[repoId(repo)] = record;
  save(all);
  return { repo: repoId(repo), pushable: record.pushable, anonymous: record.anonymous, keys };
};

const fetchUrl = (repo: Repo, record: RepoRecord) => {
  const f = forge();
  if (!record.anonymous) return remoteUrl(repo, f);
  if (f.kind !== "github") refuse("anonymous fetches are for public GitHub repositories", "clone it with a read key instead (drop --anonymous)");
  return `https://github.com/${repo.owner}/${repo.name}.git`;
};

const config = async (dir: string, pairs: Record<string, string>) => {
  for (const [key, value] of Object.entries(pairs)) await gitOk(dir, ["config", key, value]);
};

/** Remote -> mirror (section 6.4), with the read key alone. Then the root clone, if new. */
export const fetch = async (repo: Repo, log: (line: string) => void = () => {}) => {
  const record = recordOf(repo);
  const mirror = mirrorPath(repo);
  const url = fetchUrl(repo, record);
  if (!fs.existsSync(path.join(mirror, "HEAD"))) {
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    const made = await gitBare(["init", "--bare", "--quiet", mirror]);
    if (made.code !== 0) throw new Error(`cannot create the mirror: ${made.stderr.trim()}`);
  }
  await config(mirror, {
    "remote.origin.url": url,
    // The mirror is NEVER pruned of objects: clones borrow them (alternates), and an object
    // must not vanish even after a force-push upstream (section 6.2).
    "gc.auto": "0",
    "gc.pruneExpire": "never",
    "maintenance.auto": "false",
    // Pinned here, where repository content cannot reach: a `.lfsconfig` in a commit
    // would otherwise choose where LFS goes, and with which key.
    "lfs.url": url,
    "lfs.locksverify": "false",
    // Nothing is ever pushed INTO the mirror: it holds what the remote published. The hook
    // lives in a directory only root writes.
    "core.hooksPath": `${MIRROR_HOOKS}`,
  });
  if (!record.anonymous) await config(mirror, { "core.sshCommand": sshCommand(repo, "read") });
  await git(mirror, ["config", "--unset-all", "remote.origin.fetch"]);
  await gitOk(mirror, ["config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
  await gitOk(mirror, ["config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]);

  log(`fetching ${repoId(repo)} ${record.anonymous ? "anonymously, over https" : "with the read key"}`);
  const fetched = await git(mirror, ["fetch", "--prune", "--no-auto-gc", "--quiet", "origin"], { timeoutMs: 600_000 });
  if (fetched.code !== 0)
    refuse(`cannot fetch ${repoId(repo)}: ${fetched.stderr.trim().split("\n").slice(-3).join(" | ")}`,
      record.anonymous ? "check the repository is public" : `check its read deploy key is registered: desolate keys ${repoId(repo)}`);

  // The remote's default branch becomes the mirror's HEAD, so clones check it out.
  const head = await git(mirror, ["ls-remote", "--symref", "origin", "HEAD"], { timeoutMs: 60_000 });
  const symref = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head.stdout);
  if (symref) await gitOk(mirror, ["symbolic-ref", "HEAD", `refs/heads/${symref[1]}`]);
  const defaultBranch = symref ? symref[1]! : null;

  // LFS: what the branch tips need (question 8's proposal). Older objects on request.
  const heads = (await gitOk(mirror, ["for-each-ref", "--format=%(refname)", "refs/heads"])).split("\n").filter(Boolean);
  let lfsObjects = 0;
  if (heads.length > 0) {
    const lfs = await git(mirror, ["lfs", "fetch", "origin", ...heads], { timeoutMs: 600_000 });
    if (lfs.code !== 0) refuse(`fetched ${repoId(repo)}, but its LFS objects did not come: ${lfs.stderr.trim().split("\n").slice(-2).join(" | ")}`, `desolate fetch ${repoId(repo)}`);
    try {
      lfsObjects = fs.readdirSync(path.join(mirror, "lfs", "objects"), { recursive: true }).filter((name) => /[0-9a-f]{64}$/.test(String(name))).length;
    } catch {
      /* no LFS objects */
    }
  }

  const all = registry();
  all.repos[repoId(repo)] = { ...record, defaultBranch, fetchedAt: new Date().toISOString() };
  save(all);
  const created = await ensureClone(repo, defaultBranch);
  return { repo: repoId(repo), branches: heads.length, defaultBranch, lfsObjects, rootClone: created ? "created" : "present" };
};

/** The root clone: the person's own, borrowing the mirror's objects. Its config is written
 *  here, before anything from the repository's content is checked out. */
export const ensureClone = async (repo: Repo, defaultBranch: string | null): Promise<boolean> => {
  const clone = clonePath(repo);
  const mirror = mirrorPath(repo);
  const fresh = !fs.existsSync(path.join(clone, ".git"));
  if (fresh) {
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    const made = await gitBare(["clone", "--shared", "--no-checkout", "--quiet", mirror, clone]);
    if (made.code !== 0) throw new Error(`cannot create the root clone: ${made.stderr.trim()}`);
  }
  const record = recordOf(repo);
  await config(clone, {
    "remote.origin.url": mirror,
    // No hook in the content, and none planted in .git/hooks, ever runs: hooks come only
    // from a directory owned by root that holds desolate's own pre-push.
    "core.hooksPath": HOOKS,
    // LFS downloads read the mirror, offline. Set here, it outranks any `.lfsconfig`.
    "lfs.url": `file://${mirror}`,
    "lfs.locksverify": "false",
    "desolate.repo": repoId(repo),
  });
  await git(clone, ["config", "--unset-all", "remote.origin.lfspushurl"]);
  if (record.pushable) {
    const url = remoteUrl(repo);
    await config(clone, {
      // `git push origin <branch>` goes to desolate's helper, which asks the person (on the
      // host) before anything leaves: see git-remote-desolate-push.ts.
      "remote.origin.pushurl": `desolate-push::${repoId(repo)}`,
      // `lfs.pushurl`, not remote.origin.lfspushurl: git-lfs lets `lfs.url` outrank the
      // per-remote setting, and an upload would then go into the mirror (measured).
      "lfs.pushurl": url,
      "core.sshCommand": sshCommand(repo, "write"),
    });
  } else {
    // Not pushable: a push, of commits or of LFS objects, has nowhere to go. Without these
    // it would land in the mirror, which the root can write.
    await config(clone, { "remote.origin.pushurl": NOWHERE, "lfs.pushurl": `file://${NOWHERE}` });
    await git(clone, ["config", "--unset-all", "core.sshCommand"]);
  }
  if (fresh && defaultBranch) {
    const out = await git(clone, ["checkout", "--quiet", defaultBranch], { timeoutMs: 600_000 });
    if (out.code !== 0) throw new Error(`cannot check out ${defaultBranch} in the root clone: ${out.stderr.trim().slice(-500)}`);
  }
  return fresh;
};

export const list = () =>
  Object.entries(registry().repos).map(([name, record]) => ({ repo: name, ...record })).sort((a, b) => a.repo.localeCompare(b.repo));
