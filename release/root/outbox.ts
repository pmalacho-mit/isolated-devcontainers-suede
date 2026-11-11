// Reading a domain's outbox, as data (P4). Everything in an outbox was written by a domain,
// which may be hostile: names are validated, files must be regular files directly where they
// are expected (no symlink is followed), and sizes are bounded. No function here runs git in
// a domain's repository; the only git they feed is `git fetch <bundle file>` in a ROOT clone,
// and a bundle is objects with no config and no hooks.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isBranch, isCommit, isLfsOid, parseRepo } from "../shared/names.ts";
import { domainPath } from "./layout.ts";

export const outbox = (domain: string) => path.join(domainPath(domain), "outbox");
export const inbox = (domain: string) => path.join(domainPath(domain), "inbox");

const LIMIT = { json: 1024 * 1024, bundle: 2 * 1024 ** 3, lfs: 5 * 1024 ** 3 } as const;

/** A regular file, not a symlink, no bigger than `max`; else null. */
export const regular = (file: string, max: number): fs.Stats | null => {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size <= max ? stat : null;
  } catch {
    return null;
  }
};

/** Open without following a symlink at the last component, and read. */
const readPlain = (file: string, max: number): Buffer | null => {
  if (!regular(file, max)) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    return fs.readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
};

export const readData = <T>(file: string): T | null => {
  const data = readPlain(file, LIMIT.json);
  if (!data) return null;
  try {
    return JSON.parse(data.toString("utf8")) as T;
  } catch {
    return null;
  }
};

const syncDir = (domain: string, repo: string) => path.join(outbox(domain), "sync", repo);

/** The domain's branches, as it listed them: only well-formed names and commits survive. */
export const listedRefs = (domain: string, repo: string): Record<string, string> => {
  if (!parseRepo(repo)) return {};
  const data = readData<{ refs?: unknown }>(path.join(syncDir(domain, repo), "refs.json"));
  const out: Record<string, string> = {};
  if (data && typeof data.refs === "object" && data.refs !== null)
    for (const [branch, commit] of Object.entries(data.refs as Record<string, unknown>).slice(0, 5000))
      if (isBranch(branch) && isCommit(commit)) out[branch] = commit;
  return out;
};

/** Bundle files waiting in the outbox, oldest first. */
export const pendingBundles = (domain: string, repo: string): string[] => {
  const dir = syncDir(domain, repo);
  try {
    return fs.readdirSync(dir).filter((name) => /^[0-9a-z-]{1,60}\.bundle$/.test(name)).sort()
      .map((name) => path.join(dir, name)).filter((file) => regular(file, LIMIT.bundle) !== null);
  } catch {
    return [];
  }
};

/** An LFS object the domain staged: taken only if its content hashes to its name and its
 *  size is what the pointer said (section 6.3). Returns the verified bytes' path, or why not. */
export const verifiedLfs = (domain: string, repo: string, oid: string, size: number): { file: string } | { error: string } => {
  if (!isLfsOid(oid)) return { error: "not an LFS object id" };
  const file = path.join(outbox(domain), "lfs", repo, oid);
  const stat = regular(file, LIMIT.lfs);
  if (!stat) return { error: `the LFS object ${oid.slice(0, 12)} is not in the outbox` };
  if (stat.size !== size) return { error: `the LFS object ${oid.slice(0, 12)} is ${stat.size} bytes; its pointer says ${size}` };
  const hash = createHash("sha256");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (let read = fs.readSync(fd, buffer); read > 0; read = fs.readSync(fd, buffer)) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  if (hash.digest("hex") !== oid) return { error: `the LFS object ${oid.slice(0, 12)} does not hash to its id` };
  return { file };
};
