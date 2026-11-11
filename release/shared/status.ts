// How each checkout says its work is going (section 5.1): a small JSON file in the domain
// clone's git directory, written from inside a workspace by /desolate/status. The host and
// the root both read those files AS DATA and never run git there (P4). What they say is
// shown, never acted on.
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspacePlan } from "./plan.ts";

export type Status = { color: string; message: string; updated: string };
export const COLORS = ["gray", "blue", "green", "yellow", "orange", "red"];

/** A status file is written by a workspace, which may be hostile: a known colour, one line
 *  of printable text, a bounded size, and no symlink followed. */
export const readStatus = (file: string): Status | null => {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 8192) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Status>;
    if (!COLORS.includes(String(data.color))) return null;
    return { color: String(data.color), message: String(data.message ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 200), updated: String(data.updated ?? "").slice(0, 40) };
  } catch {
    return null;
  }
};
export const readNote = (file: string): string => {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return "";
    return fs.readFileSync(file, "utf8").slice(0, 16384).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ").trimEnd();
  } catch {
    return "";
  }
};
/** Where a checkout's status lives, under a domain's `repos` directory. */
export const statusDir = (reposDir: string, c: { repo: string; kind: string; name: string }) =>
  c.kind === "main" ? path.join(reposDir, c.repo, ".git") : path.join(reposDir, c.repo, ".git", "worktrees", c.name);

export type StatusView = { workspace: string; checkouts: { repo: string; branch: string; status: Status | null; note: string }[]; status: Status | null };
export const statusView = (reposDir: string, w: WorkspacePlan): StatusView => {
  const checkouts = w.checkouts.map((c) => ({ repo: c.repo, branch: c.branch, status: readStatus(path.join(statusDir(reposDir, c), "desolate-status.json")), note: readNote(path.join(statusDir(reposDir, c), "desolate-note.md")) }));
  // A workspace's status is its most recently set one.
  const latest = checkouts.map((c) => c.status).filter((s): s is Status => s !== null).sort((a, b) => b.updated.localeCompare(a.updated))[0] ?? null;
  return { workspace: `${w.domain}/${w.workspace}`, checkouts, status: latest };
};
