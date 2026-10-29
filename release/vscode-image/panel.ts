/**
 * panel.ts -- what the editor's desolate panel reads about each target beyond
 * its status: the branch checked out and its commit, whether GitHub has that
 * commit as far as desolate last saw, the note beside the status, and the
 * labels its devcontainer.json gives its ports.
 *
 * All of it as files, the way status.ts reads a status: no git runs (the
 * editor must not run a project's git -- transfer.ts), every read of the
 * project's is contained to it, bounded, and held to the shape it should
 * have. What GitHub has comes from the editor's OWN cache of the remote,
 * which push and pull keep (transfer.ts), never from the network.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { remoteCacheRoot } from "./caches.ts";
import { parse as parseJsonc } from "./jsonc.ts";
import type { Target } from "./projects.ts";
import { gitDirectoryOf, readContained, readNote } from "./status.ts";

const COMMIT = /^[0-9a-f]{40,64}$/;
const PACKED_REFS_MAX = 4 * 1024 * 1024;
const CONFIG_MAX = 256 * 1024;

/** A branch name as HEAD may hold one, kept to what can name a ref file
 *  without leaving refs/heads: no `..`, no control or space, no leading `/`. */
export const plausibleBranch = (name: string) =>
  name.length > 0 && name.length <= 250 && !/[\u0000- \u007f~^:?*[\\]/.test(name) &&
  !name.split("/").some((part) => part === "" || part === "." || part === ".." || part.endsWith(".lock")) &&
  !name.startsWith("-");

/** HEAD's text, read: the branch it names, or the commit it is detached at. */
export const parseHead = (text: string): { branch?: string; detached?: string } => {
  const line = text.split("\n")[0].trim();
  const ref = /^ref: refs\/heads\/(.+)$/.exec(line);
  if (ref) return plausibleBranch(ref[1]) ? { branch: ref[1] } : {};
  return COMMIT.test(line) ? { detached: line } : {};
};

/** `refs/heads/<branch>`'s commit in a packed-refs file, if it is there. */
export const packedRef = (packed: string, branch: string) => {
  for (const line of packed.split("\n")) {
    const [commit, name] = line.trim().split(" ");
    if (name === `refs/heads/${branch}` && COMMIT.test(commit)) return commit;
  }
  return undefined;
};

/** A branch's commit in a repository whose files `read` reads: its loose ref,
 *  or its line in packed-refs. */
const refOf = (read: (inside: string, max: number) => string | undefined, gitDir: string, branch: string) => {
  const loose = read(join(gitDir, "refs", "heads", branch), 200)?.trim();
  if (loose && COMMIT.test(loose)) return loose;
  const packed = read(join(gitDir, "packed-refs"), PACKED_REFS_MAX);
  return packed ? packedRef(packed, branch) : undefined;
};

export interface Head {
  branch?: string;
  /** The commit checked out: the branch's, or the detached HEAD's. */
  commit?: string;
}

/** What the target has checked out. A worktree's HEAD is in its own git dir;
 *  its branches, like every target's, in the project's `.git`. */
export const headOf = (target: Target): Head => {
  const gitDir = gitDirectoryOf(target);
  if (gitDir === undefined) return {};
  const head = parseHead(readContained(target.projectDir, join(gitDir, "HEAD"), 512) ?? "");
  if (head.detached) return { commit: head.detached };
  if (!head.branch) return {};
  const read = (inside: string, max: number) => readContained(target.projectDir, inside, max);
  return { branch: head.branch, commit: refOf(read, ".git", head.branch) };
};

/** GitHub's commit for `branch` as desolate last saw it: `unknown` when there
 *  is no cache yet (never pushed or pulled through the editor), `absent` when
 *  GitHub had no such branch. */
export const githubTipOf = (project: string, branch: string): { state: "unknown" } | { state: "absent" } | { state: "at"; commit: string } => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project) || !plausibleBranch(branch)) return { state: "unknown" };
  const cache = join(remoteCacheRoot(), `${project.replace("/", "__")}.git`);
  const read = (inside: string, max: number) => {
    try {
      const text = readFileSync(join(cache, inside), "utf8");
      return text.length <= max ? text : undefined;
    } catch {
      return undefined;
    }
  };
  if (read("HEAD", 512) === undefined) return { state: "unknown" };
  const commit = refOf(read, "", branch);
  return commit ? { state: "at", commit } : { state: "absent" };
};

/** A port's label, if its devcontainer.json gives it one. */
export type PortLabel = (port: number) => string | undefined;

/** Each port's label from `portsAttributes` in a devcontainer.json -- keyed by
 *  a port, or a range `a-b` -- as one short printable line. */
export const portLabels = (config: unknown): PortLabel => {
  const labels = new Map<number, string>();
  const ranges: [number, number, string][] = [];
  const attributes = (config as { portsAttributes?: unknown } | null)?.portsAttributes;
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return () => undefined;
  for (const [key, value] of Object.entries(attributes as Record<string, unknown>)) {
    const label = (value as { label?: unknown } | null)?.label;
    if (typeof label !== "string") continue;
    const text = label.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!text) continue;
    const single = /^(\d{1,5})$/.exec(key), range = /^(\d{1,5})-(\d{1,5})$/.exec(key);
    if (single) labels.set(Number(single[1]), text);
    else if (range) ranges.push([Number(range[1]), Number(range[2]), text]);
  }
  return (port) => labels.get(port) ?? ranges.find(([low, high]) => port >= low && port <= high)?.[2];
};

/** The labels of a target's ports, from its devcontainer.json; empty when it
 *  has none, or none that parses. */
export const portLabelsOf = (target: Target) => {
  for (const config of [join(target.dir, ".devcontainer", "devcontainer.json"), join(target.dir, ".devcontainer.json")]) {
    const text = readContained(target.projectDir, relative(target.projectDir, config), CONFIG_MAX);
    if (text === undefined) continue;
    try {
      return portLabels(parseJsonc(text));
    } catch {
      return portLabels(undefined);
    }
  }
  return portLabels(undefined);
};

/**
 * The GitHub repository a project pushes to: the one `repo add` (newrepo.ts)
 * registered, as the section it writes in the editor's own git config --
 * `[url "git@github.com-<owner>__<alias>:<owner/repo>"]` -- read as a file,
 * the way transfer.ts's registrationOf reads it through git. A project
 * cloned under another name pushes to its repository, not to its name; one
 * never registered falls back to its name when that is an owner/repo.
 */
export const githubRepoOf = (project: string, configs = [join(homedir(), ".gitconfig"), join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git", "config")]) => {
  const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(project);
  if (!name) return undefined;
  const tag = `${name[1]}__${name[2]}`.replace(/\./g, "\\.");
  const section = new RegExp(`^\\s*\\[url "git@github\\.com-${tag}:([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)"\\]`, "m");
  for (const config of configs) {
    try {
      const found = section.exec(readFileSync(config, "utf8"))?.[1];
      if (found) return found;
    } catch { /* not there */ }
  }
  return project;
};

/** Everything the panel shows of one target that it reads itself. */
export interface Facts {
  head: Head;
  /** Whether GitHub has the commit checked out: `same` it does, `differs` its
   *  branch is elsewhere, `new` it has no such branch, `unknown` desolate has
   *  not seen GitHub for this project yet (or HEAD is detached). */
  github: "same" | "differs" | "new" | "unknown";
  note?: string;
  portLabel: PortLabel;
  /** Its GitHub repository, for links (githubRepoOf). */
  repo?: string;
}

export const factsOf = (target: Target): Facts => {
  const head = headOf(target);
  let github: Facts["github"] = "unknown";
  if (head.branch && head.commit) {
    const tip = githubTipOf(target.project, head.branch);
    github = tip.state === "unknown" ? "unknown" : tip.state === "absent" ? "new" : tip.commit === head.commit ? "same" : "differs";
  }
  return { head, github, note: readNote(target), portLabel: portLabelsOf(target), repo: githubRepoOf(target.project) };
};
