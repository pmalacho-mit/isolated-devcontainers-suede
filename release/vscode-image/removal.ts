/**
 * removal.ts -- what removing a project (`cli.sh repo rm`, desolate.ts
 * removeProject) takes with it, decided from NAMES: which worktrees it had,
 * which containers, volumes and images are its, and what in it would be lost.
 *
 * Pure, so each choice that could reach a sibling's data is tested on its own.
 * Every rule here has to hold with the project's directory already gone --
 * deleted by hand, which is how the issue this exists for (#63) began -- so
 * none of them reads the filesystem: a worktree is found by what desolate
 * keeps about it, a container by the folder the CLI stamped on it.
 */
import { createHash } from "node:crypto";
import { LOSSES_DONE, STATUS_RAN } from "./docker.ts";
import { WORKTREE_REPLACEMENT, WORKTREES_DIRECTORY, validWorktree } from "./projects.ts";

/** The state kinds state.ts keeps, one file each: `<namespace>.<kind>`. */
const STATE_FILE = /^(.+)\.(ports|spec|token|daemon)$/;

/** Worktrees desolate has kept state for: `<project ns>--wt--<name>.<kind>` in
 *  the state directory's `entries`. A name that is not a worktree's is not
 *  one, however it begins. */
export const worktreesInState = (entries: string[], projectNamespace: string): string[] => {
  const prefix = `${projectNamespace}${WORKTREE_REPLACEMENT}`;
  const names = new Set<string>();
  for (const entry of entries) {
    const namespace = STATE_FILE.exec(entry)?.[1];
    if (!namespace?.startsWith(prefix)) continue;
    const name = namespace.slice(prefix.length);
    if (validWorktree(name)) names.add(name);
  }
  return [...names].sort();
};

/** Worktrees a container was started for: its workspace folder, as the CLI
 *  stamped it, is `<projectDir>/.worktrees/<name>`. */
export const worktreesInFolders = (folders: string[], projectDir: string): string[] => {
  const prefix = `${projectDir}/${WORKTREES_DIRECTORY}/`;
  const names = new Set<string>();
  for (const folder of folders) {
    if (!folder.startsWith(prefix)) continue;
    const name = folder.slice(prefix.length);
    if (validWorktree(name)) names.add(name);
  }
  return [...names].sort();
};

/** One container claiming a workspace folder: `docker ps` with its two
 *  identity labels (docker.ts IDENTITY_LABELS). */
export interface WorkspaceContainer {
  id: string;
  folder: string;
  configFile: string;
}

/** `{{.ID}}\t<folder label>\t<config label>` per line. */
export const parseWorkspaceContainers = (text: string): WorkspaceContainer[] =>
  text.split("\n").flatMap((line) => {
    const [id = "", folder = "", configFile = ""] = line.split("\t");
    return id.trim() && folder.trim() ? [{ id: id.trim(), folder: folder.trim(), configFile: configFile.trim() }] : [];
  });

/**
 * The containers desolate started for `dir`: the folder label says `dir`, and
 * the config label names a file INSIDE it -- or nothing, for one made before
 * the CLI wrote that label.
 *
 * The same two halves docker.ts selectWorkspaceContainer pairs, for the same
 * reason: the folder label alone was once forgeable by a sibling. That one
 * compares against the spec on disk, which is gone when the directory is; a
 * file inside the directory is what any spec of its would have been.
 */
export const containersOf = (containers: WorkspaceContainer[], dir: string): string[] =>
  containers
    .filter(({ folder, configFile }) => folder === dir && (configFile === "" || configFile.startsWith(`${dir}/`)))
    .map(({ id }) => id);

/**
 * Which of `volumes` belong to the namespaces being removed.
 *
 * The rule policy.ts mount.owner applies when a project mounts one: a volume
 * is `<namespace>` or `<namespace>-*`, and the LONGEST claim wins -- so
 * removing `acme/widgets` (`acme__widgets`) does not take `acme__widgets-ui-db`
 * while `acme/widgets-ui` is there to claim it. `others` is every namespace
 * that could contest one (projects.list); it may include the ones being
 * removed.
 */
export const volumesOf = (volumes: string[], removing: string[], others: string[]): string[] => {
  const claimants = [...new Set([...removing, ...others])];
  return volumes.filter((volume) => {
    const longest = claimants
      .filter((namespace) => volume === namespace || volume.startsWith(`${namespace}-`))
      .sort((a, b) => b.length - a.length)[0];
    return longest !== undefined && removing.includes(longest);
  });
};

/** The devcontainer CLI's name for the images it builds for a workspace
 *  folder: `vsc-<basename>-<sha256 of the folder>`, then `-features` and
 *  `-uid` for the layers it adds (measured: @devcontainers/cli 0.88.0, Yo and
 *  F9 in its bundle). The digest is of the whole path, so it is that folder's
 *  and no other's. */
const folderDigest = (dir: string) => createHash("sha256").update(dir).digest("hex");

/**
 * Which `repo:tag` references are images built for these targets: the CLI's
 * per-folder images, and desolate's own builds of a Dockerfile project
 * (`desolate-built/<namespace>`, desolate.ts buildBeforeJudging). Base images
 * and desolate's CA-trusting derivatives are shared by every project that
 * names the same base, so they are never among them.
 */
export const imagesOf = (references: string[], dirs: string[], namespaces: string[]): string[] => {
  const digests = dirs.map(folderDigest);
  const built = new Set(namespaces.map((namespace) => `desolate-built/${namespace}`));
  return references.filter((reference) => {
    const at = reference.lastIndexOf(":");
    const repository = at > 0 ? reference.slice(0, at) : reference;
    if (built.has(repository)) return true;
    const cli = /^vsc-[a-z0-9._-]*-([0-9a-f]{64})(?:-features)?(?:-uid)?$/.exec(repository);
    return cli !== null && digests.includes(cli[1]!);
  });
};

/** What a project's root holds that removing it would lose. */
export interface Losses {
  /** `git status --porcelain` lines: uncommitted and untracked. */
  changes: string[];
  /** Local branches with commits on no remote-tracking branch, and how many. */
  branches: { name: string; commits: number }[];
  /** Entries in `git stash list`. */
  stashes: number;
  /** Commits a detached HEAD has that no branch, local or origin's, does. */
  detached: number;
}

/**
 * The root's loss check, as `projectLosses` printed it, or null when it did
 * not run to the end -- which every caller must treat as "not known to be
 * safe", never as clean.
 *
 * `.worktrees/` itself is not a change of the root: each worktree is checked
 * on its own (worktreeChanges), and createWorktree excludes the directory, so
 * this only shows where that exclusion was not written.
 */
export const parseLosses = (text: string): Losses | null => {
  const lines = text.split("\n");
  const ran = lines.indexOf(STATUS_RAN);
  const done = lines.lastIndexOf(LOSSES_DONE);
  if (ran < 0 || done < ran) return null;
  const losses: Losses = { changes: [], branches: [], stashes: 0, detached: 0 };
  for (const line of lines.slice(ran + 1, done)) {
    if (line.trim() === "") continue;
    const branch = /^BRANCH (\S+) ([0-9]+)$/.exec(line);
    const count = /^(STASH|DETACHED) ([0-9]+)$/.exec(line);
    if (branch) {
      if (Number(branch[2]) > 0) losses.branches.push({ name: branch[1]!, commits: Number(branch[2]) });
    } else if (count?.[1] === "STASH") losses.stashes = Number(count[2]);
    else if (count?.[1] === "DETACHED") losses.detached = Number(count[2]);
    else if (/^CHANGE /.test(line)) {
      const change = line.slice("CHANGE ".length);
      if (change !== `?? ${WORKTREES_DIRECTORY}/`) losses.changes.push(change);
    } else return null; // a line nobody printed on purpose: not a check to trust
  }
  return losses;
};

/** Nothing in `losses` would be lost. */
export const nothingLost = ({ changes, branches, stashes, detached }: Losses) =>
  changes.length === 0 && branches.length === 0 && stashes === 0 && detached === 0;

/** `losses`, as lines a person reads before deciding. */
export const describeLosses = ({ changes, branches, stashes, detached }: Losses): string[] => [
  ...(changes.length ? [`uncommitted or untracked:`, ...changes.slice(0, 20).map((c) => `  ${c}`)] : []),
  ...(changes.length > 20 ? [`  ... and ${changes.length - 20} more`] : []),
  ...branches.map(({ name, commits }) => `branch ${name}: ${commits} commit${commits === 1 ? "" : "s"} on no remote branch`),
  ...(stashes ? [`${stashes} stash entr${stashes === 1 ? "y" : "ies"}`] : []),
  ...(detached ? [`a detached HEAD with ${detached} commit${detached === 1 ? "" : "s"} on no branch`] : []),
];

// ------------------------------------------------------------ the editor's --
//
// newrepo.ts `rm`: what `repo add` wrote in the editor, taken back. Here
// rather than there because newrepo.ts runs on import.

/**
 * `config` -- an ssh config -- without the `Host <hostAlias>` block
 * newrepo.ts ensureKey appended: that exact line, and the indented (or blank)
 * lines after it, to the next line that is neither. Nothing else moves: a
 * block for `github.com-acme__widgets-ui` is another line entirely.
 */
export const withoutHostBlock = (config: string, hostAlias: string): string => {
  const out: string[] = [];
  let inBlock = false;
  for (const line of config.split("\n")) {
    if (line === `Host ${hostAlias}`) {
      inBlock = true;
      continue;
    }
    if (inBlock && (line === "" || /^\s/.test(line))) continue;
    inBlock = false;
    out.push(line);
  }
  const text = out.join("\n");
  return config.endsWith("\n") && text !== "" && !text.endsWith("\n") ? `${text}\n` : text;
};

/**
 * The `url.<base>` sections that route a repository through `tag`'s host
 * alias (newrepo.ts ensureUrlRewrites wrote two: the scp-like spelling and
 * the ssh:// one), from `git config --get-regexp '^url\.'`. Whatever
 * repository they name, since the key is the tag's; `:` and `/` end the alias,
 * so `acme__widgets-ui`'s are not among `acme__widgets`'s.
 */
export const urlSectionsOf = (config: string, tag: string): string[] => {
  const aliases = [`url.git@github.com-${tag}:`, `url.ssh://git@github.com-${tag}/`];
  const sections = new Set<string>();
  for (const line of config.split("\n")) {
    const key = line.trim().split(/\s+/)[0] ?? "";
    if (key.endsWith(".insteadof") && aliases.some((alias) => key.startsWith(alias)))
      sections.add(key.slice(0, -".insteadof".length));
  }
  return [...sections].sort();
};

/** The review cache's entries for a project and its worktrees (review.ts
 *  names them `<owner>__<repo>` and `<owner>__<repo>@<worktree>`). */
export const reviewsOf = (entries: string[], namespace: string): string[] =>
  entries.filter((entry) => entry === namespace || entry.startsWith(`${namespace}@`)).sort();
