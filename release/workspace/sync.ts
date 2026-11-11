// A domain's branches, written out as data for the root (sections 6.4, 6.5). This runs in the
// domain's own VM, with the domain's trust: it is the domain running git on the domain's
// repository. What it writes to the outbox is a bundle (objects, no config, no hooks), a list
// of refs, and LFS object files. The root reads those as data and never comes here (P4).
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, writeJson } from "../shared/json.ts";
import { isBranch, isCommit, parseRepo } from "../shared/names.ts";
import { run } from "../shared/run.ts";

export const OUTBOX = "/desolate/outbox";
export const INBOX = "/desolate/inbox";
const clone = (repo: string) => `/workspaces/${repo}`;
const syncDir = (repo: string) => path.join(OUTBOX, "sync", repo);

const git = async (repo: string, args: string[], input?: string) => {
  const result = await run("git", ["-C", clone(repo), ...args], { input, timeoutMs: 300_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { ok: result.code === 0, out: result.stdout.trim(), err: result.stderr.trim() };
};

export const domainRepos = (): string[] => {
  const out: string[] = [];
  try {
    for (const owner of fs.readdirSync("/workspaces", { withFileTypes: true })) {
      if (!owner.isDirectory() || owner.name.startsWith(".")) continue;
      for (const name of fs.readdirSync(path.join("/workspaces", owner.name), { withFileTypes: true }))
        if (name.isDirectory() && parseRepo(`${owner.name}/${name.name}`) && fs.existsSync(path.join("/workspaces", owner.name, name.name, ".git"))) out.push(`${owner.name}/${name.name}`);
    }
  } catch {
    /* no clones yet */
  }
  return out.sort();
};

export const branches = async (repo: string): Promise<Record<string, string>> => {
  const listed = await git(repo, ["for-each-ref", "--format=%(objectname) %(refname:strip=2)", "refs/heads"]);
  const out: Record<string, string> = {};
  for (const line of listed.out.split("\n")) {
    const [commit, ...rest] = line.split(" ");
    const branch = rest.join(" ");
    if (isCommit(commit) && isBranch(branch)) out[branch] = commit;
  }
  return out;
};

/** Write the domain's branches of one repository to the outbox: an incremental bundle, less
 *  what the mirror has and what the root has said it holds, and the list of refs. */
export const syncRepo = async (repo: string): Promise<{ branches: number; bundled: boolean }> => {
  const dir = syncDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  const refs = await branches(repo);
  const haves = readJson<string[]>(path.join(INBOX, "haves", `${repo}.json`), []).filter(isCommit);
  // Only haves this clone actually has can be named as exclusions.
  const known: string[] = [];
  for (const commit of haves.slice(0, 500)) if ((await git(repo, ["cat-file", "-e", `${commit}^{commit}`])).ok) known.push(commit);
  const names = Object.keys(refs);
  let bundled = false;
  if (names.length > 0) {
    const file = path.join(dir, `${Date.now().toString(36)}-${process.pid}.bundle`);
    const made = await git(repo, ["bundle", "create", "--quiet", `${file}.tmp`, ...names.map((name) => `refs/heads/${name}`), "--not", "--remotes=origin", ...known]);
    if (made.ok) {
      fs.renameSync(`${file}.tmp`, file);
      bundled = true;
    } else {
      fs.rmSync(`${file}.tmp`, { force: true });
      if (!/empty bundle/i.test(made.err)) throw new Error(`could not bundle ${repo}: ${made.err.slice(-300)}`);
    }
  }
  writeJson(path.join(dir, "refs.json"), { refs, at: new Date().toISOString() });
  return { branches: names.length, bundled };
};

const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/;

/** The LFS objects that `branch`'s commits reference and the mirror does not hold, copied to
 *  the outbox by oid. Pointers are found in every new commit, not only at the tip: the
 *  remote refuses a push that references an object it was never sent. */
export const stageLfs = async (repo: string, branch: string): Promise<{ oid: string; size: number }[]> => {
  const listed = await git(repo, ["rev-list", "--objects", `refs/heads/${branch}`, "--not", "--remotes=origin"]);
  const ids = listed.out.split("\n").map((line) => line.split(" ")[0]!).filter((id) => /^[0-9a-f]{40,64}$/.test(id));
  if (ids.length === 0) return [];
  const sizes = await git(repo, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], ids.join("\n") + "\n");
  const small = sizes.out.split("\n").map((line) => line.split(" ")).filter(([, type, size]) => type === "blob" && Number(size) < 400).map(([id]) => id!);
  const staged: { oid: string; size: number }[] = [];
  const mirror = `/desolate/mirrors/${repo}.git/lfs/objects`;
  for (const id of small) {
    const blob = await git(repo, ["cat-file", "blob", id]);
    const match = POINTER.exec(blob.out + "\n");
    if (!match) continue;
    const [, oid, size] = match as unknown as [string, string, string];
    const where = path.join(oid.slice(0, 2), oid.slice(2, 4), oid);
    if (fs.existsSync(path.join(mirror, where)) || staged.some((s) => s.oid === oid)) continue;
    const local = path.join(clone(repo), ".git", "lfs", "objects", where);
    if (!fs.existsSync(local)) throw new Error(`${branch} references the LFS object ${oid.slice(0, 12)}, which is neither in this clone nor in the mirror`);
    const target = path.join(OUTBOX, "lfs", repo, oid);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(local, target);
    staged.push({ oid, size: Number(size) });
  }
  return staged;
};

/** Deliveries from the root (section 6.4): bundles in the inbox, imported as `root/<branch>`,
 *  never over a branch of the domain's own. */
export const importDeliveries = async (repo: string): Promise<string[]> => {
  const dir = path.join(INBOX, "deliveries", repo);
  const done = readJson<string[]>(path.join(clone(repo), ".git", "desolate-delivered.json"), []);
  const imported: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  for (const name of names) {
    const id = name.slice(0, -5);
    if (done.includes(id)) continue;
    const meta = readJson<{ branch?: string; commit?: string; bundle?: boolean } | null>(path.join(dir, name), null);
    if (!meta || !isBranch(meta.branch) || !isCommit(meta.commit)) continue;
    if (meta.bundle !== false) {
      await git(repo, ["fetch", "--quiet", "--no-tags", path.join(dir, `${id}.bundle`), "+refs/heads/*:refs/desolate/delivery/*"]);
      const scratch = await git(repo, ["for-each-ref", "--format=%(refname)", "refs/desolate/delivery/"]);
      for (const ref of scratch.out.split("\n").filter(Boolean)) await git(repo, ["update-ref", "-d", ref]);
    }
    // As root/<branch>: never over a branch of the domain's own.
    if ((await git(repo, ["cat-file", "-e", `${meta.commit}^{commit}`])).ok && (await git(repo, ["update-ref", `refs/remotes/root/${meta.branch}`, meta.commit])).ok) imported.push(meta.branch);
    done.push(id);
  }
  if (imported.length > 0 || names.length > 0) writeJson(path.join(clone(repo), ".git", "desolate-delivered.json"), done.slice(-500));
  return imported;
};

/** The request channel (section 6.4): a fixed vocabulary, written to the outbox; the root
 *  answers in the inbox, which the domain cannot write. */
export const request = async (body: Record<string, unknown>, timeoutMs = 120_000): Promise<Record<string, unknown>> => {
  const id = `${Date.now().toString(36)}-${createHash("sha256").update(`${process.pid}${Math.random()}`).digest("hex").slice(0, 10)}`;
  const dir = path.join(OUTBOX, "requests");
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, `${id}.json`), body);
  const reply = path.join(INBOX, "replies", `${id}.json`);
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    const value = readJson<Record<string, unknown> | null>(reply, null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  fs.rmSync(path.join(dir, `${id}.json`), { force: true });
  return { ok: false, error: "the root did not answer. Is it running? On the host: desolate doctor" };
};
