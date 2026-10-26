/**
 * work-forge.ts -- where work items come from, and where their outcomes go.
 *
 * The core speaks git; a forge is an adapter at the edge. Each adapter POLLS
 * (an inbound webhook would be the first inbound path into the VM), turns new
 * work items into `open` requests written as `forge/<adapter>`, and on what
 * desolate reports, says so where the item lives and asks for the close.
 *
 *   poll(project)        the open work items, each with a stable id
 *   complete(project, i) the item's branch was pushed: mark it done there
 *
 * An item is requested once: what was requested is on the adapter's own
 * outbox (`item` messages), which is also how a person reads its history.
 *
 * `file` is the reference adapter -- the acceptance harness, and the proof
 * that nothing in the core knows GitHub: unchecked lines in the project's
 * `.desolate/work.md`, read from its working copy (openContained).
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, openSync, readFileSync, readlinkSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";
import { target as resolveTarget, validWorktree } from "./projects.ts";
import * as workGit from "./work-git.ts";
import type { Policy } from "./work-policy.ts";
import { parseMessage, refs, subjectOf, MAIN, type Message } from "./work-protocol.ts";

export interface WorkItem {
  /** `<adapter>:<id>`, opaque past the colon. */
  item: string;
  title: string;
  worktree: string;
}

export interface Adapter {
  name: string;
  poll: (projectDir: string) => WorkItem[];
  /** Mark the item done where it lives. */
  complete: (projectDir: string, item: WorkItem) => void;
}

// ------------------------------------------------------------------- file --

export const WORK_FILE = ".desolate/work.md";
const LINE = /^(\s*[-*] \[)([ xX])(\]\s+)(.+?)\s*$/;

/** A worktree name from a title: a slug, and enough of the id to keep two
 *  items with the same words apart. Always a valid worktree name. */
export const worktreeName = (title: string, id: string) => {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  const name = `${slug || "item"}-${id.slice(0, 6)}`;
  if (!validWorktree(name) || name === MAIN) throw new Error(`cannot name a worktree for '${title}'`);
  return name;
};

export const fileItems = (text: string): (WorkItem & { done: boolean })[] =>
  text.split("\n").flatMap((line) => {
    const match = LINE.exec(line);
    if (!match) return [];
    const title = match[4];
    const id = createHash("sha256").update(title).digest("hex").slice(0, 12);
    return [{ item: `file:${id}`, title, worktree: worktreeName(title, id), done: match[2] !== " " }];
  });

/**
 * A file of the project's, opened only if it IS one: a final symlink is not
 * followed, a FIFO does not block (and is refused), and where the open
 * actually landed -- /proc/self/fd, the kernel's answer, not a path checked
 * beforehand -- must be inside the project. The editor reaches every project,
 * so a `.desolate` that is a link must not make it read or tick another's.
 */
export const openContained = (projectDir: string, relative: string, flags: number) => {
  let fd: number;
  try {
    fd = openSync(join(projectDir, relative), flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  const inside = `${realpathSync(projectDir)}/`;
  if (fstatSync(fd).isFile() && readlinkSync(`/proc/self/fd/${fd}`).startsWith(inside)) return fd;
  closeSync(fd);
  return undefined;
};

export const fileAdapter: Adapter = {
  name: "file",
  // The working copy, not HEAD: git in the editor would follow a ref the
  // project made a link (work-git.ts containment), and a file read through
  // openContained cannot be anything but the project's own.
  poll: (projectDir) => {
    const fd = openContained(projectDir, WORK_FILE, constants.O_RDONLY);
    if (fd === undefined) return [];
    try {
      return fileItems(readFileSync(fd, "utf8")).filter((item) => !item.done);
    } finally {
      closeSync(fd);
    }
  },
  // The box is ticked in the working copy, as a person would tick it: a
  // write, for them to commit -- never a commit made here.
  complete: (projectDir, item) => {
    const fd = openContained(projectDir, WORK_FILE, constants.O_RDWR);
    if (fd === undefined) return;
    try {
      const lines = readFileSync(fd, "utf8").split("\n");
      const at = lines.findIndex((line) => {
        const match = LINE.exec(line);
        return match !== null && match[2] === " " && match[4] === item.title;
      });
      if (at < 0) return;
      lines[at] = lines[at].replace(LINE, "$1x$3$4");
      const text = Buffer.from(lines.join("\n"));
      ftruncateSync(fd, 0);
      writeSync(fd, text, 0, text.length, 0);
    } finally {
      closeSync(fd);
    }
  },
};

export const ADAPTERS: Record<string, Adapter> = { file: fileAdapter };

// ------------------------------------------------------------------- loop --

type Say = (line: string) => void;

const message = (from: string, type: string, body: string, fields: Record<string, unknown>): Message => ({
  v: 1, from, to: ["*"], type, body, item: null, commit: null, reply_to: null, ...fields,
});

/** What this adapter already said, by item: requested, completed. */
const ledger = (projectDir: string, adapter: string) => {
  const requested = new Map<string, string>();   // item -> worktree
  const completed = new Set<string>();
  for (const commit of workGit.history(projectDir, refs.forge(adapter))) {
    try {
      const said = parseMessage(workGit.readCommit(projectDir, commit).json);
      if (said.item && said.type === "item") requested.set(said.item, String(said.worktree ?? ""));
      if (said.item && said.type === "merged") completed.add(said.item);
    } catch { /* not ours to act on */ }
  }
  return { requested, completed };
};

/** Worktrees desolate reported pushed, from its own outbox. */
const pushedWorktrees = (projectDir: string) => {
  const pushed = new Set<string>();
  for (const commit of workGit.history(projectDir, refs.desolate)) {
    try {
      const said = parseMessage(workGit.readCommit(projectDir, commit).json);
      if (said.state === "pushed" && typeof said.worktree === "string") pushed.add(said.worktree);
    } catch { /* skip */ }
  }
  return pushed;
};

/** Write a request as the adapter would: one commit, created once. */
const request = (projectDir: string, adapter: string, fields: Record<string, unknown>, ulid: () => string) => {
  const writer = `forge/${adapter}`;
  const body = `${fields.action} ${fields.worktree}`;
  const text = message(writer, "request", body, { commit: null, branch: null, from_ref: null, title: null, brief: null, ...fields });
  workGit.append(projectDir, refs.request(ulid()), writer, text, subjectOf({ type: "request", body }), "create");
};

export const tickForge = (project: string, workspaces: string, policy: Policy, say: Say, ulid: () => string) => {
  const projectDir = resolveTarget(workspaces, project).projectDir;
  for (const name of policy.adapters) {
    const adapter = ADAPTERS[name];
    if (!adapter) continue;
    const writer = `forge/${name}`;
    const { requested, completed } = ledger(projectDir, name);

    for (const item of adapter.poll(projectDir)) {
      if (requested.has(item.item)) continue;
      const branch = `${policy.branch_prefix}${item.worktree}`;
      request(projectDir, name, { action: "open", worktree: item.worktree, branch, item: item.item, title: item.title, brief: item.title }, ulid);
      workGit.append(projectDir, refs.forge(name), writer,
        message(writer, "item", item.title, { item: item.item, worktree: item.worktree }), subjectOf({ type: "item", body: item.title }));
      say(`${project}: ${writer} asked to open ${item.worktree} for '${item.title}'`);
    }

    const pushed = pushedWorktrees(projectDir);
    const items = new Map(adapter.poll(projectDir).map((item) => [item.item, item]));
    for (const [item, worktree] of requested) {
      if (completed.has(item) || !pushed.has(worktree)) continue;
      const known = items.get(item);
      if (known) adapter.complete(projectDir, known);
      workGit.append(projectDir, refs.forge(name), writer,
        message(writer, "merged", `done: ${known?.title ?? worktree}`, { item, worktree }), subjectOf({ type: "merged", body: worktree }));
      request(projectDir, name, { action: "close", worktree, item }, ulid);
      say(`${project}: ${writer} marked ${item} done and asked to close ${worktree}`);
    }
  }
};
