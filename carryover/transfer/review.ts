/**
 * review.ts -- `desolate --review`: what a push would send, read before it is.
 *
 * The project's half runs in its sandbox (docker.ts `reviewScript`), read-only,
 * as the push's own half does: the branch checked out, what it is compared
 * with, its commits and files, and each changed file's two sides. This reads
 * what it said and keeps those sides in the EDITOR's own cache -- never in the
 * project -- under names of its own, where the desolate extension opens them
 * side by side. No git runs here, and nothing a project wrote becomes a path:
 * a file's path is shown, and its sides are kept as `<n>.a` and `<n>.b`.
 *
 * Every line came from the project's repository, so it is read strictly: a
 * field that is not what it should be drops the line, and text is shown as
 * one printable line.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheRoot } from "./caches.ts";

/** Each line the sandbox says for a review begins with this and a tab. */
export const REVIEWED = "desolate-review";

/** How much of a review's content crosses: past these, a file is listed but
 *  its content is not sent (`large`), or not listed (`more`). */
export const REVIEW_LIMITS = { blobBytes: 512 * 1024, totalBytes: 8 * 1024 * 1024, files: 300, commits: 200 } as const;

export interface ReviewCommit {
  commit: string;
  /** Author time, epoch seconds. */
  time: number;
  author: string;
  subject: string;
}

/** text: both sides were sent; binary, large: listed only; module: a submodule. */
export type ReviewKind = "text" | "binary" | "large" | "module";

export interface ReviewFile {
  index: number;
  /** git's: A, M, D, T, or R/C with a similarity (R087). */
  status: string;
  path: string;
  /** A rename's or copy's old path. */
  from?: string;
  kind: ReviewKind;
  sizes: [number, number];
  /** Which sides there are: an added file has no `a`, a deleted one no `b`. */
  sides: { a: boolean; b: boolean };
}

export interface Review {
  /** The branch checked out; absent when HEAD is detached. */
  branch?: string;
  head: string;
  /** What it is compared with -- origin/<branch>, or for a branch GitHub does
   *  not have yet, the origin branch it started from -- and where they meet. */
  base?: { ref: string; commit: string; from?: string };
  ahead: number;
  behind: number;
  /** `git status --porcelain` entries: work a push does not send. */
  uncommitted: number;
  commits: ReviewCommit[];
  files: ReviewFile[];
  /** More files differ than were listed. */
  more: boolean;
  /** Where each listed text file's sides are kept: `<n>.a`, `<n>.b`. */
  dir?: string;
}

const SHA = /^[0-9a-f]{40,64}$/;
const COUNT = /^\d{1,9}$/;
const TIME = /^\d{1,12}$/;
const ZERO = /^0+$/;
const MODE = /^[0-7]{6}$/;
const KINDS: readonly string[] = ["text", "binary", "large", "module"];

/** One printable line: what a commit or a path says, shown and never obeyed. */
export const printable = (text: string, max = 300) =>
  text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * A path as git prints it: as itself, or -- when it holds a tab, a newline, a
 * quote or a backslash -- in double quotes with C escapes, octal for bytes.
 */
export const unquoteGitPath = (raw: string) => {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  const inner = raw.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const next = inner[i + 1] ?? "";
    if (/[0-7]{3}/.test(inner.slice(i + 1, i + 4))) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (next in simple) {
      bytes.push(simple[next]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString("utf8");
};

/** What the sandbox said, read: the review, each text file's sides as base64
 *  lines, and whether it got to the end. */
export const parseReview = (lines: string[]) => {
  const review: Review = { head: "", ahead: 0, behind: 0, uncommitted: 0, commits: [], files: [], more: false };
  const blobs = new Map<string, string[]>();
  let ended = false;
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields[0] !== REVIEWED) continue;
    const [, kind, ...rest] = fields;
    if (kind === "BRANCH" && rest.length === 2 && SHA.test(rest[1])) {
      if (rest[0] !== "-") review.branch = printable(rest[0], 250);
      review.head = rest[1];
    } else if (kind === "BASE" && rest.length === 3 && rest[0] !== "-" && SHA.test(rest[1])) {
      review.base = { ref: printable(rest[0], 250), commit: rest[1], ...(SHA.test(rest[2]) ? { from: rest[2] } : {}) };
    } else if (kind === "COUNTS" && rest.length === 3 && rest.every((n) => COUNT.test(n))) {
      [review.ahead, review.behind, review.uncommitted] = rest.map(Number);
    } else if (kind === "COMMIT" && rest.length >= 4 && SHA.test(rest[0]) && TIME.test(rest[1])) {
      if (review.commits.length < REVIEW_LIMITS.commits)
        review.commits.push({ commit: rest[0], time: Number(rest[1]), author: printable(rest[2], 100), subject: printable(rest.slice(3).join(" ")) });
    } else if (kind === "FILE" && (rest.length === 10 || rest.length === 11)) {
      const [index, status, modeA, modeB, blobA, blobB, sizeA, sizeB, what, ...paths] = rest;
      if (!COUNT.test(index) || !/^[ACDMRTUX]\d{0,3}$/.test(status) || !MODE.test(modeA) || !MODE.test(modeB) ||
          !SHA.test(blobA) || !SHA.test(blobB) || !COUNT.test(sizeA) || !COUNT.test(sizeB) || !KINDS.includes(what)) continue;
      if (review.files.length >= REVIEW_LIMITS.files) continue;
      const path = printable(unquoteGitPath(paths[paths.length - 1]), 1000);
      review.files.push({
        index: Number(index),
        status,
        path,
        ...(paths.length === 2 ? { from: printable(unquoteGitPath(paths[0]), 1000) } : {}),
        kind: what as ReviewKind,
        sizes: [Number(sizeA), Number(sizeB)],
        sides: { a: !ZERO.test(blobA), b: !ZERO.test(blobB) },
      });
    } else if (kind === "BLOB" && rest.length === 3 && COUNT.test(rest[0]) && (rest[1] === "a" || rest[1] === "b") && /^[A-Za-z0-9+/=]*$/.test(rest[2])) {
      const key = `${rest[0]}.${rest[1]}`;
      const kept = blobs.get(key) ?? [];
      kept.push(rest[2]);
      blobs.set(key, kept);
    } else if (kind === "MORE" && rest.length === 0) {
      review.more = true;
    } else if (kind === "END" && rest.length === 0) {
      ended = true;
    }
  }
  return { review, blobs, ended: ended && SHA.test(review.head) };
};

/** Where a target's last review is kept: the editor's cache, named by the
 *  target -- whose names the broker already holds to plain segments. */
export const reviewDirectory = (project: string, worktree?: string) =>
  join(cacheRoot(), "reviews", `${project.replace(/\//g, "__")}${worktree ? `@${worktree}` : ""}`);

/** Each text file's sides, kept in `dir` as `<n>.a` and `<n>.b` -- what was
 *  there before is gone first, so a review never shows another's content.
 *  Past the limits, a side is not kept, and its file becomes `large`. */
export const keepReview = (review: Review, blobs: Map<string, string[]>, dir: string): Review => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let total = 0;
  const files = review.files.map((file) => {
    if (file.kind !== "text") return file;
    const sides = (["a", "b"] as const).filter((side) => file.sides[side]);
    const decoded = sides.map((side) => [side, Buffer.from((blobs.get(`${file.index}.${side}`) ?? []).join(""), "base64")] as const);
    const size = decoded.reduce((sum, [, bytes]) => sum + bytes.length, 0);
    if (decoded.some(([, bytes]) => bytes.length > REVIEW_LIMITS.blobBytes) || total + size > REVIEW_LIMITS.totalBytes)
      return { ...file, kind: "large" as const };
    total += size;
    for (const [side, bytes] of decoded) writeFileSync(join(dir, `${file.index}.${side}`), bytes, { mode: 0o600 });
    return file;
  });
  return { ...review, files, dir };
};

const ago = (seconds: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - seconds * 1000) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
};

/** The review, said for a person at a terminal. */
export const describeReview = (review: Review, now = Date.now()) => {
  const lines: string[] = [];
  const branch = review.branch ?? `(detached at ${review.head.slice(0, 12)})`;
  const against = !review.base ? "GitHub has none of it"
    : review.base.ref === `origin/${review.branch}` ? `against ${review.base.ref}`
    : `against ${review.base.ref}, where it started (GitHub has no ${branch} yet)`;
  lines.push(`${branch}: ${review.ahead} commit${review.ahead === 1 ? "" : "s"} to push, ${against}`);
  if (review.behind) lines.push(`  and ${review.behind} on ${review.base?.ref} it lacks: pull first, or the push is refused`);
  for (const commit of review.commits)
    lines.push(`  ${commit.commit.slice(0, 12)}  ${commit.subject}  (${commit.author}, ${ago(commit.time, now)})`);
  if (review.ahead > review.commits.length) lines.push(`  … and ${review.ahead - review.commits.length} more`);
  lines.push(`${review.files.length}${review.more ? "+" : ""} file${review.files.length === 1 ? "" : "s"} changed:`);
  for (const file of review.files) {
    const name = file.from ? `${file.from} → ${file.path}` : file.path;
    lines.push(`  ${file.status[0]}  ${name}${file.kind === "text" ? "" : `  (${file.kind})`}`);
  }
  if (review.uncommitted) lines.push(`${review.uncommitted} uncommitted change${review.uncommitted === 1 ? " is" : "s are"} in the worktree; a push does not send ${review.uncommitted === 1 ? "it" : "them"}.`);
  if (review.dir) lines.push(`each file's two sides: ${review.dir}/<n>.a and <n>.b`);
  return lines.join("\n");
};
