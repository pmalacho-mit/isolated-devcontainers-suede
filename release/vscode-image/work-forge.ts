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
 *   finished(project)    (optional) items the forge itself says are over --
 *                        a merged PR, a closed issue. An adapter that has it
 *                        is closed on that, not on the push.
 *
 * An item is requested once: what was requested is on the adapter's own
 * outbox (`item` messages), which is also how a person reads its history.
 *
 * `file` is the reference adapter -- the acceptance harness, and the proof
 * that nothing in the core knows GitHub: unchecked lines in the project's
 * `.desolate/work.md`, read from its working copy (openContained).
 *
 * `github` never reaches GitHub. The human's Mac does (release/forge.sh), with
 * their own `gh` credentials, and hands the editor what it saw -- the open
 * issues carrying the policy's label, and the items whose PR merged or whose
 * issue closed -- through `work github <project> sync`. So no forge token is in
 * the VM, the proxy or the editor, and a project's daemon can spend none.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { target as resolveTarget, validWorktree } from "./projects.ts";
import * as workGit from "./work-git.ts";
import { factoryFiles, type Policy } from "./work-policy.ts";
import { parseMessage, refs, subjectOf, MAIN, type Message } from "./work-protocol.ts";

export interface WorkItem {
  /** `<adapter>:<id>`, opaque past the colon. */
  item: string;
  title: string;
  worktree: string;
}

/** What an adapter is asked about: one project's factory. */
export interface Context {
  projectDir: string;
  project: string;
  workspaces: string;
  policy: Policy;
}

export interface Adapter {
  name: string;
  poll: (context: Context) => WorkItem[];
  /** Mark the item done where it lives. */
  complete: (context: Context, item: WorkItem) => void;
  /** The items the forge says are over; with it, the close waits for this. */
  finished?: (context: Context) => Set<string>;
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
  poll: ({ projectDir }) => {
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
  complete: ({ projectDir }, item) => {
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

// ----------------------------------------------------------------- github --

/** What the Mac's agent saw: the open issues with the label, and the issue
 *  numbers whose work is over (PR merged or closed, or the issue closed). */
export interface GithubSnapshot {
  open: { number: number; title: string }[];
  finished: number[];
}

const MAX_ITEMS = 500;
const MAX_TITLE = 200;
const issueNumber = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value < 1e9;

/**
 * `work github <project> sync`'s input, held to its shape. It comes from the
 * Mac, but every title in it was written by whoever can file an issue: kept
 * to one printable line, never used as a name -- a worktree is `issue-<n>`.
 */
export const parseGithubSnapshot = (text: string): GithubSnapshot => {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("not JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  if (Object.keys(value).sort().join() !== "finished,open") throw new Error("it holds exactly 'open' and 'finished'");
  if (!Array.isArray(value.open) || value.open.length > MAX_ITEMS) throw new Error(`'open' is a list of at most ${MAX_ITEMS} issues`);
  if (!Array.isArray(value.finished) || value.finished.length > MAX_ITEMS) throw new Error(`'finished' is a list of at most ${MAX_ITEMS} issue numbers`);
  const open = value.open.map((issue: any) => {
    if (issue === null || typeof issue !== "object" || !issueNumber(issue.number) || typeof issue.title !== "string")
      throw new Error("each open issue is { number, title }");
    const title = issue.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
    return { number: issue.number, title: title || `issue ${issue.number}` };
  });
  if (!value.finished.every(issueNumber)) throw new Error("'finished' holds issue numbers");
  return { open, finished: value.finished };
};

const readSnapshot = ({ workspaces, project }: Context): GithubSnapshot => {
  try {
    return parseGithubSnapshot(readFileSync(factoryFiles(workspaces, project).github, "utf8"));
  } catch {
    return { open: [], finished: [] };
  }
};

/** Written whole and renamed into place: the watcher reads it on its own tick. */
export const writeGithubSnapshot = (workspaces: string, project: string, snapshot: GithubSnapshot) => {
  const file = factoryFiles(workspaces, project).github;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(snapshot)}\n`);
  renameSync(`${file}.tmp`, file);
};

export const githubItem = (repo: string, number: number) => `github:${repo}#${number}`;

export const githubAdapter: Adapter = {
  name: "github",
  poll: (context) => {
    const repo = context.policy.github?.repo;
    if (!repo) return [];
    return readSnapshot(context).open.map(({ number, title }) =>
      ({ item: githubItem(repo, number), title, worktree: `issue-${number}` }));
  },
  // Nothing to mark here: the issue and its PR are GitHub's, and the Mac's
  // agent says so there.
  complete: () => {},
  finished: (context) => {
    const repo = context.policy.github?.repo;
    return new Set(repo ? readSnapshot(context).finished.map((number) => githubItem(repo, number)) : []);
  },
};

export const ADAPTERS: Record<string, Adapter> = { file: fileAdapter, github: githubAdapter };

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

/** The requested items whose worktree desolate reported pushed. */
const pushedWorktreesAsItems = (projectDir: string, requested: Map<string, string>) => {
  const pushed = pushedWorktrees(projectDir);
  return new Set([...requested].filter(([, worktree]) => pushed.has(worktree)).map(([item]) => item));
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
  const context: Context = { projectDir, project, workspaces, policy };
  for (const name of policy.adapters) {
    const adapter = ADAPTERS[name];
    if (!adapter) continue;
    const writer = `forge/${name}`;
    const { requested, completed } = ledger(projectDir, name);

    for (const item of adapter.poll(context)) {
      if (requested.has(item.item)) continue;
      const branch = `${policy.branch_prefix}${item.worktree}`;
      request(projectDir, name, { action: "open", worktree: item.worktree, branch, item: item.item, title: item.title, brief: item.title }, ulid);
      workGit.append(projectDir, refs.forge(name), writer,
        message(writer, "item", item.title, { item: item.item, worktree: item.worktree, branch }), subjectOf({ type: "item", body: item.title }));
      say(`${project}: ${writer} asked to open ${item.worktree} for '${item.title}'`);
    }

    // Done is the forge's word where it has one -- a merged PR, a closed
    // issue -- and a push where it has none.
    const over = adapter.finished?.(context) ?? pushedWorktreesAsItems(projectDir, requested);
    const items = new Map(adapter.poll(context).map((item) => [item.item, item]));
    for (const [item, worktree] of requested) {
      if (completed.has(item) || !over.has(item)) continue;
      const known = items.get(item);
      if (known) adapter.complete(context, known);
      workGit.append(projectDir, refs.forge(name), writer,
        message(writer, "merged", `done: ${known?.title ?? worktree}`, { item, worktree }), subjectOf({ type: "merged", body: worktree }));
      request(projectDir, name, { action: "close", worktree, item }, ulid);
      say(`${project}: ${writer} marked ${item} done and asked to close ${worktree}`);
    }
  }
};

// ----------------------------------------------------------------- status --

/** One requested item, as the Mac's forge agent needs it: where its work is
 *  (desolate's last word on its worktree), and the PR it opened, if any. */
export interface ItemStatus {
  item: string;
  worktree: string;
  branch: string;
  /** requested, then desolate's states (opened, waiting, refused, failed,
   *  pushed), `merged` once the adapter has asked for the close, and `closed`
   *  once it is. */
  state: string;
  pr: string | null;
}

export const GITHUB_PR = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9][0-9]{0,8}$/;

export const forgeStatus = (projectDir: string, adapter: string, branchPrefix: string): ItemStatus[] => {
  const rows = new Map<string, ItemStatus>();
  for (const commit of workGit.history(projectDir, refs.forge(adapter)).reverse()) {
    let said: Message;
    try { said = parseMessage(workGit.readCommit(projectDir, commit).json); } catch { continue; }
    if (!said.item) continue;
    const row = rows.get(said.item);
    if (said.type === "item" && !row && typeof said.worktree === "string" && validWorktree(said.worktree)) {
      const branch = typeof said.branch === "string" ? said.branch : `${branchPrefix}${said.worktree}`;
      rows.set(said.item, { item: said.item, worktree: said.worktree, branch, state: "requested", pr: null });
    } else if (row && said.type === "pr" && typeof said.url === "string" && GITHUB_PR.test(said.url)) row.pr = said.url;
    else if (row && said.type === "merged") row.state = "merged";
  }
  const states = new Map<string, string>();
  for (const commit of workGit.history(projectDir, refs.desolate).reverse()) {
    try {
      const said = parseMessage(workGit.readCommit(projectDir, commit).json);
      if (typeof said.state === "string" && typeof said.worktree === "string") states.set(said.worktree, said.state);
    } catch { /* skip */ }
  }
  // desolate's word on the worktree, except that `merged` -- the close is
  // asked for -- stands until the worktree is in fact `closed`.
  for (const row of rows.values()) {
    const state = states.get(row.worktree);
    if (state !== undefined && (row.state !== "merged" || state === "closed")) row.state = state;
  }
  return [...rows.values()];
};

/** The PR the Mac's agent opened for an item, on the adapter's own outbox. */
export const recordPr = (projectDir: string, adapter: string, item: string, url: string) => {
  if (!GITHUB_PR.test(url)) throw new Error(`'${url}' is not a GitHub pull request URL`);
  const writer = `forge/${adapter}`;
  workGit.append(projectDir, refs.forge(adapter), writer,
    message(writer, "pr", url, { item, url }), subjectOf({ type: "pr", body: url }));
};
