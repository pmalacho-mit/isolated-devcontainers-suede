// How each checkout says its work is going (section 5.1): a small JSON file in the domain
// clone's git directory, written from inside a workspace by /desolate/status. The host and
// the root both read those files AS DATA and never run git there (P4). What they say is
// shown, never acted on.
import * as fs from "node:fs";
import * as path from "node:path";
import { isBranch, isCommit } from "./names.ts";
import type { WorkspacePlan } from "./plan.ts";

export type Status = { color: string; message: string; updated: string };
export const COLORS = ["gray", "blue", "green", "yellow", "orange", "red"];

/** The first `most` bytes of a plain file under `base`, or null. `base` is not the
 *  workspace's to change; everything below it is (it is the domain's clone). So:
 *
 *    - the file is opened without following a link at its own name, and what is checked
 *      (a regular file, its size) is checked on the open descriptor, not on the name;
 *    - the file that was opened must be the one that was meant: a directory on the way
 *      that is a link elsewhere is refused. On Linux (the root VM) that is asked of the
 *      kernel about the open descriptor, so there is no moment to swap anything. macOS (the
 *      host) has no such question to ask from node: there the path is resolved again and
 *      must name the same file, same device and inode, as the one that is open.
 *
 *  What is read is shown and never acted on, so the worst a domain can do with the gap that
 *  is left on macOS (a link swapped in and out within one read) is put text from a file
 *  the person can already read in front of that same person. */
export const readPlain = (base: string, file: string, most: number, refuseLarger: boolean): string | null => {
  let fd: number | null = null;
  try {
    const wanted = path.join(fs.realpathSync(base), path.relative(base, file));
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (refuseLarger && stat.size > most)) return null;
    if (process.platform === "linux") {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`) !== wanted) return null;
    } else {
      const named = fs.lstatSync(wanted);
      if (fs.realpathSync(file) !== wanted || named.dev !== stat.dev || named.ino !== stat.ino) return null;
    }
    const buffer = Buffer.alloc(Math.min(stat.size, most));
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
};

/** A status file is written by a workspace, which may be hostile: a known colour, one line
 *  of printable text, a bounded size. */
export const readStatus = (base: string, file: string): Status | null => {
  try {
    const text = readPlain(base, file, 8192, true);
    if (text === null) return null;
    const data = JSON.parse(text) as Partial<Status>;
    if (!COLORS.includes(String(data.color))) return null;
    return { color: String(data.color), message: String(data.message ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 200), updated: String(data.updated ?? "").slice(0, 40) };
  } catch {
    return null;
  }
};
export const readNote = (base: string, file: string): string =>
  (readPlain(base, file, 16384, false) ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ").trimEnd();
/** Where a checkout's status lives, under a domain's `repos` directory. */
export const statusDir = (reposDir: string, c: { repo: string; kind: string; name: string }) =>
  c.kind === "main" ? path.join(reposDir, c.repo, ".git") : path.join(reposDir, c.repo, ".git", "worktrees", c.name);

/** What a checkout has checked out NOW (the plan says only what it started on): read from
 *  its HEAD as data, like its status. `branch` is a name desolate would carry, or null (a
 *  detached HEAD, a rebase under way, or a name it would not carry); `commit` is what that
 *  branch names when its ref is a loose file or in packed-refs, or the detached commit. */
export type Head = { branch: string | null; commit: string | null };
const COMMIT_LINE = /^([0-9a-f]{40})\n$/;
/** A clone's packed-refs, at most 256 KiB (a domain's file: a larger one is not read), and
 *  read again only when it changed (its identity, size and time): the state service looks
 *  at every checkout every second, and an agent could make this file large. */
const PACKED_MOST = 256 * 1024;
const packedCache = new Map<string, { key: string; text: string }>();
const packedRefs = (reposDir: string, file: string): string => {
  let key = "";
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > PACKED_MOST) return "";
    key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "";
  }
  const known = packedCache.get(file);
  if (known && known.key === key) return known.text;
  const text = readPlain(reposDir, file, PACKED_MOST, true) ?? "";
  if (packedCache.size > 500) packedCache.clear();
  packedCache.set(file, { key, text });
  return text;
};
const refCommit = (reposDir: string, common: string, branch: string): string | null => {
  const loose = readPlain(reposDir, path.join(common, "refs", "heads", branch), 128, true);
  if (loose !== null) return COMMIT_LINE.exec(loose)?.[1] ?? null;
  const packed = packedRefs(reposDir, path.join(common, "packed-refs"));
  for (const line of packed.split("\n")) {
    const [commit, ref] = line.split(" ");
    if (ref === `refs/heads/${branch}` && isCommit(commit)) return commit;
  }
  return null;
};
export const readHead = (reposDir: string, c: { repo: string; kind: string; name: string }): Head | null => {
  const text = readPlain(reposDir, path.join(statusDir(reposDir, c), "HEAD"), 512, true);
  // Git ends what it writes there with a newline. Without one, this read caught it half
  // written (a share's file, read from another VM while it is written): unsettled, so
  // null, and the reader keeps what it saw before.
  if (text === null || !text.endsWith("\n")) return null;
  const detached = COMMIT_LINE.exec(text);
  if (detached) return { branch: null, commit: detached[1]! };
  const named = /^ref: refs\/heads\/(\S+)\n$/.exec(text)?.[1];
  if (!isBranch(named)) return { branch: null, commit: null };
  return { branch: named, commit: refCommit(reposDir, path.join(reposDir, c.repo, ".git"), named) };
};

export type StatusView = { workspace: string; checkouts: { repo: string; branch: string; head: Head | null; status: Status | null; note: string }[]; status: Status | null };
export const statusView = (reposDir: string, w: WorkspacePlan): StatusView => {
  const checkouts = w.checkouts.map((c) => ({ repo: c.repo, branch: c.branch, head: readHead(reposDir, c), status: readStatus(reposDir, path.join(statusDir(reposDir, c), "desolate-status.json")), note: readNote(reposDir, path.join(statusDir(reposDir, c), "desolate-note.md")) }));
  // A workspace's status is its most recently set one.
  const latest = checkouts.map((c) => c.status).filter((s): s is Status => s !== null).sort((a, b) => b.updated.localeCompare(a.updated))[0] ?? null;
  return { workspace: `${w.domain}/${w.workspace}`, checkouts, status: latest };
};
