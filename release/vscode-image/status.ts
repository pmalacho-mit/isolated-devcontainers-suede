/**
 * status.ts -- each target's status: a colour and a message, through `.git`.
 *
 * An agent, or anything else in a project, says how its work is going by
 * writing `<git-dir>/desolate-status.json` -- `/desolate/status`
 * does it from inside a devcontainer -- and desolate SHOWS it: in the editor's
 * panel, in `desolate --status`, and to the Mac's harness through
 * `./cli.sh desolate --status --json` (docs/agents.md). It never acts on one.
 *
 * `<git-dir>` is what `git rev-parse --git-dir` prints in the target: `.git`
 * for a project's own tree, the admin directory `.git/worktrees/<id>` for a
 * worktree. So each target has its own, outside the repository's content --
 * never committed, never in `git status` -- and visible to exactly the
 * containers of its project, which all mount that `.git`.
 *
 * Read here, in the editor, which reaches every project: so read as a file
 * (no git runs) and read strictly. Every byte was written by the project. A
 * link out of the project is not followed, a FIFO does not block, at most
 * STATUS_MAX_BYTES are read, the message becomes one printable line, and a
 * colour this does not know is shown as gray.
 */
import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync, realpathSync, lstatSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { list as listTargets, type Target } from "./projects.ts";

export const STATUS_FILE = "desolate-status.json";
export const COLORS = ["gray", "blue", "green", "yellow", "orange", "red"] as const;
export type Color = (typeof COLORS)[number];
export const STATUS_MAX_BYTES = 4096;
export const MESSAGE_MAX = 200;

export interface Status {
  color: Color;
  message: string;
  /** When it was written: the writer's word, or the file's mtime. ISO 8601. */
  updated: string;
}

/** A status file's content, held to its shape -- or undefined, for one that
 *  says nothing usable. `mtime` stands in for an `updated` it lacks. */
export const parseStatus = (text: string, mtime?: Date): Status | undefined => {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const color: Color = (COLORS as readonly string[]).includes(value.color) ? value.color : "gray";
  const message = typeof value.message === "string"
    ? value.message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX)
    : "";
  const written = typeof value.updated === "string" && !Number.isNaN(Date.parse(value.updated))
    ? new Date(value.updated) : mtime;
  return { color, message, updated: written ? written.toISOString().replace(".000Z", "Z") : "" };
};

/** The target's git dir, relative to its project -- undefined when it has
 *  none, or names one outside the project (a worktree's `.git` file can say
 *  anything). */
export const gitDirectoryOf = (target: Target): string | undefined => {
  let dir: string;
  if (target.worktree) {
    // The worktree's `.git` FILE names its admin directory. Read like the
    // status itself -- a FIFO there must not hang the editor's extension host.
    const pointer = readContained(target.projectDir, relative(target.projectDir, join(target.dir, ".git")));
    const named = pointer && /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
    if (!named) return undefined;
    dir = resolve(target.dir, named);
  } else {
    dir = join(target.projectDir, ".git");
    try {
      if (!lstatSync(dir).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
  }
  const inside = relative(target.projectDir, dir);
  return inside && !inside.startsWith("..") && !inside.startsWith("/") ? inside : undefined;
};

/**
 * A file of the project's, opened only if it IS one: a final symlink is not
 * followed, a FIFO does not block (and is refused), and where the open
 * actually landed -- /proc/self/fd, the kernel's answer, not a path checked
 * beforehand -- must be inside the project. The editor reaches every project,
 * so a `.git` that is a link must not make it read another's.
 */
export const openContained = (projectDir: string, inside: string, flags: number) => {
  let fd: number;
  try {
    fd = openSync(join(projectDir, inside), flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const root = `${realpathSync(projectDir)}/`;
    if (fstatSync(fd).isFile() && readlinkSync(`/proc/self/fd/${fd}`).startsWith(root)) return fd;
  } catch { /* fall through */ }
  closeSync(fd);
  return undefined;
};

/** At most `max` bytes of a contained file, and its mtime; undefined when it
 *  is not one. */
export const readContainedWithTime = (projectDir: string, inside: string, max = STATUS_MAX_BYTES) => {
  const fd = openContained(projectDir, inside, constants.O_RDONLY);
  if (fd === undefined) return undefined;
  try {
    const buffer = Buffer.alloc(Math.min(max, Math.max(1, fstatSync(fd).size)));
    let length = 0;
    while (length < buffer.length) {
      const got = readSync(fd, buffer, length, buffer.length - length, length);
      if (got === 0) break;
      length += got;
    }
    return { text: buffer.subarray(0, length).toString("utf8"), mtime: fstatSync(fd).mtime };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
};
export const readContained = (projectDir: string, inside: string, max = STATUS_MAX_BYTES) =>
  readContainedWithTime(projectDir, inside, max)?.text;

/** This target's status, or undefined when it has none worth showing. */
export const readStatus = (target: Target): Status | undefined => {
  const gitDir = gitDirectoryOf(target);
  if (gitDir === undefined) return undefined;
  const read = readContainedWithTime(target.projectDir, join(gitDir, STATUS_FILE));
  return read && parseStatus(read.text, read.mtime);
};

/** The note beside a status (`/desolate/status note`): prose for the other
 *  agents in this repository, shown to the person too. At most NOTE_MAX_BYTES,
 *  its lines kept and anything else unprintable a space. */
export const NOTE_FILE = "desolate-note.md";
export const NOTE_MAX_BYTES = 16384;
export const readNote = (target: Target): string | undefined => {
  const gitDir = gitDirectoryOf(target);
  if (gitDir === undefined) return undefined;
  const text = readContained(target.projectDir, join(gitDir, NOTE_FILE), NOTE_MAX_BYTES)
    ?.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
  return text || undefined;
};

/** Every target worth showing: each project that can be started -- not an
 *  owner directory, which `list` keeps for namespace claims -- and all of its
 *  worktrees, spec or not (a new one has none until its first checkout). */
export const shownTargets = (workspaces: string): Target[] => {
  const projects = new Set(listTargets.startable(workspaces).filter((t) => !t.worktree).map((t) => t.project));
  return listTargets(workspaces).filter(({ project }) => projects.has(project));
};

/** `desolate --status`'s rows: each target, with its status or null. */
export const statusRows = (workspaces: string, project?: string) =>
  shownTargets(workspaces)
    .filter((target) => project === undefined || target.project === project)
    .map((target) => ({
      target: target.name,
      project: target.project,
      worktree: target.worktree ?? null,
      status: readStatus(target) ?? null,
    }));
