/**
 * work-git.ts -- the factory's refs, read and written from the editor.
 *
 * The watcher reads every participant's refs on a timer, and the repository
 * is the project's: its `.git/config` names commands (`core.fsmonitor`,
 * `core.hooksPath`, `core.pager`, `diff.external` ...). So every git here is
 * PLUMBING -- for-each-ref, cat-file, rev-parse, hash-object, mktree,
 * commit-tree, update-ref -- with the system and global config ignored and
 * every command-naming knob a plumbing command can reach switched off on the
 * command line, which outranks the repository's own. Nothing is checked out,
 * and the index is never read. tests/static/13 asserts the flags.
 */
import { execFileSync } from "node:child_process";
import { author, type Message } from "./work-protocol.ts";

/** Prepended to every git this module runs. */
export const HARDENED = [
  "--no-pager",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.pager=cat",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
] as const;

/** And this, in its environment: no config but the repository's own. */
export const HARDENED_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
} as const;

export class GitError extends Error {}

export const git = (repo: string, args: string[], options: { input?: string; env?: Record<string, string> } = {}) => {
  try {
    return execFileSync("git", ["-C", repo, ...HARDENED, ...args], {
      encoding: "utf8",
      input: options.input,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...HARDENED_ENV, ...options.env },
    }).trimEnd();
  } catch (err: any) {
    throw new GitError(String(err?.stderr || err?.message || err).trim().split("\n").slice(-2).join(" / "));
  }
};

/** The ref's commit, or undefined when there is none. */
export const resolve = (repo: string, ref: string) => {
  try {
    return git(repo, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]) || undefined;
  } catch {
    return undefined;
  }
};

/** Every ref under a prefix, with the commit it points at. */
export const refsUnder = (repo: string, prefix: string): { ref: string; commit: string }[] => {
  const out = git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", prefix]);
  return out ? out.split("\n").map((line) => {
    const [ref, commit] = line.split(" ");
    return { ref, commit };
  }) : [];
};

export interface CommitRead {
  commit: string;
  authorName: string;
  parents: string[];
  json: string;
}

/** A commit is immutable, so a read of one is kept by its sha: the watcher
 *  rereads every outbox each tick, and without this a conversation's length
 *  is the number of git processes it costs every fifteen seconds. */
const reads = new Map<string, CommitRead>();

/** One message: its commit, its author's name, its parents, and its
 *  message.json, raw -- the commit read as an object, not through `log`. */
export const readCommit = (repo: string, commit: string): CommitRead => {
  const key = `${repo}\0${commit}`;
  const known = reads.get(key);
  if (known) return known;
  const header = git(repo, ["cat-file", "commit", commit]).split("\n\n")[0];
  const read = {
    commit,
    authorName: /^author (.*) <[^>]*> \d+ [+-]\d{4}$/m.exec(header)?.[1] ?? "",
    parents: [...header.matchAll(/^parent ([0-9a-f]+)$/gm)].map((match) => match[1]),
    json: git(repo, ["cat-file", "-p", `${commit}:message.json`]),
  };
  reads.set(key, read);
  return read;
};

/** A ref's history, newest first: commit shas. */
export const history = (repo: string, ref: string) => {
  const head = resolve(repo, ref);
  return head ? git(repo, ["rev-list", head]).split("\n").filter(Boolean) : [];
};

const zeroOid = (repo: string) =>
  "0".repeat(git(repo, ["rev-parse", "--show-object-format"]) === "sha256" ? 64 : 40);

/** Append a message to `ref` as `writer`, with compare-and-swap: a writer
 *  that raced this one retries rather than losing either message. `create`
 *  refuses a ref that is already there (a request is written once). */
export const append = (
  repo: string,
  ref: string,
  writer: string,
  message: Message,
  subject: string,
  mode: "append" | "create" = "append",
) => {
  const { name, email } = author(writer);
  const env = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
  const blob = git(repo, ["hash-object", "-w", "--stdin"], { input: JSON.stringify(message) });
  const tree = git(repo, ["mktree"], { input: `100644 blob ${blob}\tmessage.json\n` });
  for (let attempt = 0; attempt < 5; attempt++) {
    const old = resolve(repo, ref);
    if (old && mode === "create") throw new GitError(`${ref} exists already`);
    const commit = git(repo, ["commit-tree", tree, ...(old ? ["-p", old] : [])], { input: `${subject}\n`, env });
    try {
      // --create-reflog: refs outside refs/heads get no reflog by default, and
      // the reflog is how `work verify` sees a ref that was rewritten.
      git(repo, ["update-ref", "--create-reflog", "-m", `desolate ${mode}`, ref, commit, old ?? zeroOid(repo)]);
      return commit;
    } catch {
      /* another writer won the swap: look again */
    }
  }
  throw new GitError(`could not append to ${ref}: another writer kept winning`);
};

/** A file at a ref, read without checking anything out, or undefined. */
export const fileAt = (repo: string, ref: string, path: string) => {
  try {
    return git(repo, ["cat-file", "-p", `${ref}:${path}`]);
  } catch {
    return undefined;
  }
};
