/**
 * projects.ts -- what counts as a target, and who can claim a volume namespace.
 *
 * A TARGET is one directory desolate can start: a project, or one of that
 * project's worktrees. It is the currency the rest of the stack deals in,
 * because every docker object and state file is named from its namespace and
 * nothing else may be.
 *
 * Implications for naming projects:
 * - Only two levels supported:
 *  - projects in the root of /workspaces
 *  - projects nested under a parent (matching the owner/repo layout)
 * - Projects cannot start with a `.`
 * - `__` and `--wt--` are forbidden within a project or worktree name: they are
 *   how `/` and `@` are encoded, so `parent/child` vs `parent__child` (and
 *   `repo@wt` vs `repo--wt--wt`) would claim the same volume namespace.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hasConfig as hasDevcontainerConfig } from "./devcontainer.ts";
import type { ReplaceAll } from "./utils.ts";

export const SLASH_REPLACEMENT = "__";
/** How a worktree is written on a command line and printed back. */
export const WORKTREE_MARKER = "@";
/** How a worktree is spelled inside a docker object name. */
export const WORKTREE_REPLACEMENT = "--wt--";
/** Where a project's worktrees live, relative to the project.
 *
 *  Dot-prefixed on purpose: `list` skips dot-prefixed names at every level it
 *  enumerates, so this directory can never be mistaken for a project or an
 *  owner directory. */
export const WORKTREES_DIRECTORY = ".worktrees";

const RESERVED = [SLASH_REPLACEMENT, WORKTREE_REPLACEMENT] as const;

/** Whether `volumeNamespace` can encode this name without risking a collision. */
const namespaceable = (name: string) =>
  !RESERVED.some((sequence) => name.includes(sequence));

type Namespace<T extends string> = ReplaceAll<
  ReplaceAll<T, "/", typeof SLASH_REPLACEMENT>,
  typeof WORKTREE_MARKER,
  typeof WORKTREE_REPLACEMENT
>;

/** A name usable as a docker object name.
 *
 *  Projects may be nested one level -- `owner/repo` -- so that repositories from
 *  different owners can share a repo name, and each may carry worktrees --
 *  `owner/repo@feature`. Docker volume and container names can contain neither
 *  `/` nor `@`, so both must be replaced.
 *
 * @throws If the remapping could result in a collision. Callers that hold a
 * name they did not validate should ask `supports` first -- `list` omits such
 * names, so reaching the throw means an unvalidated name got this far.
 */
export const volumeNamespace = Object.assign(
  <T extends string>(name: T) => {
    if (!namespaceable(name))
      throw new Error(
        [
          `'${name}' cannot contain a "${SLASH_REPLACEMENT}" (double underscore)`,
          `or a "${WORKTREE_REPLACEMENT}": those are reserved for replacing "/"s`,
          `(slashes) and "${WORKTREE_MARKER}"s (worktrees) within volume names`,
        ].join(" "),
      );

    return name
      .replaceAll("/", SLASH_REPLACEMENT)
      .replaceAll(WORKTREE_MARKER, WORKTREE_REPLACEMENT) as Namespace<T>;
  },
  { supports: namespaceable },
);

/** One startable directory, with every name derived from it computed once. */
export interface Target {
  /** How it is written on a command line and printed back: `owner/repo`, or
   *  `owner/repo@feature` for a worktree. Never a docker object name. */
  name: string;
  project: string;
  /** Absent for the branch checked out at the project root. */
  worktree?: string;
  workspaces: string;
  /** The project's own checkout -- where `.git` and `.worktrees` live. */
  projectDir: string;
  /** This target's own tree: its workspace folder, and where its spec is read
   *  from. The project itself, unless this is a worktree. */
  dir: string;
  /** The prefix of every docker object and state file this target owns.
   *
   *  The ternary below is the entire cost of keeping a worktree-less target
   *  byte-identical to what it has always been named. Encoding the worktree
   *  unconditionally would re-provision every existing stack, silently. */
  namespace: string;
}

/** @throws if the name cannot be encoded into a docker object name. */
export const target = (
  workspaces: string,
  project: string,
  worktree?: string,
): Target => {
  const name = worktree ? `${project}${WORKTREE_MARKER}${worktree}` : project;
  const projectDir = join(workspaces, project);
  return {
    name,
    project,
    worktree,
    workspaces,
    projectDir,
    dir: worktree ? join(projectDir, WORKTREES_DIRECTORY, worktree) : projectDir,
    namespace: volumeNamespace(name),
  };
};

/** Directories under `dir` that could claim a namespace of their own.
 *
 *  Dotfiles are infrastructure, not projects: `.desolate` alongside them holds
 *  this stack's own per-target spec fingerprints, and `.worktrees` is reached
 *  deliberately rather than enumerated as a sibling.
 *
 *  @throws if `dir` is unreadable. */
const subdirectories = Object.assign(
  (dir: string) =>
    readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          namespaceable(entry.name),
      )
      .map((entry) => entry.name),
  {
    /** [] rather than a throw: an unreadable owner directory means its children
     *  simply do not claim, not that every other project is unmeasurable. */
    orNone: (dir: string) => {
      try {
        return subdirectories(dir);
      } catch {
        return [];
      }
    },
  },
);

/** This project's worktrees, whether or not they carry a devcontainer spec. */
export const worktreesOf = ({ workspaces, project }: Target): Target[] =>
  subdirectories
    .orNone(join(workspaces, project, WORKTREES_DIRECTORY))
    .map((worktree) => target(workspaces, project, worktree));

const withWorktrees = (workspaces: string, project: string): Target[] => {
  const root = target(workspaces, project);
  return [root, ...worktreesOf(root)];
};

/** @throws naming `workspaces`, because an empty list silently WIDENS every
 *  volume-namespace claim rather than narrowing one. */
const topLevel = (workspaces: string) => {
  try {
    return subdirectories(workspaces);
  } catch (err: any) {
    throw new Error(
      [
        `cannot enumerate projects: ${workspaces} is unreadable`,
        `(${err?.code ?? err?.message ?? err}). Refusing to continue, because`,
        `an empty project list silently WIDENS every volume-namespace claim.`,
      ].join(" "),
    );
  }
};

export const list = Object.assign(
  /**
   * Every target under `workspaces` that can claim a volume namespace.
   *
   * Names `volumeNamespace` cannot encode are omitted, so one unsupported
   * directory refuses only itself (at `validate`) rather than every project
   * that has to be measured against the list.
   *
   * Projects can either live in the `workspaces` directory or nest one level
   * (e.g. `owner/repo`, allowing two owners to share a repo name). A top-level
   * directory is therefore one of two things, and its own devcontainer spec is
   * what distinguishes them:
   *
   *   - it HAS a spec       -> it is a project. Its subdirectories are its own
   *                            source tree, not sibling projects.
   *   - it has NO spec      -> it is an owner directory. Its children are the
   *                            projects, and each can claim `<top>__<sub>`.
   *
   * The owner directory is listed either way. It is a real name that a real
   * project could occupy in the future, and reserving it costs nothing.
   *
   * @throws if `workspaces` is unreadable
   */
  (workspaces: string): Target[] => {
    const targets: Target[] = [];

    for (const top of topLevel(workspaces)) {
      targets.push(...withWorktrees(workspaces, top));

      if (hasDevcontainerConfig(join(workspaces, top))) continue;

      for (const sub of subdirectories.orNone(join(workspaces, top)))
        targets.push(...withWorktrees(workspaces, `${top}/${sub}`));
    }

    return targets;
  },
  {
    /**
     * The subset of `list` that can actually be started right now (answering
     * "what can I open?", rather than "who could contest this volume name?").
     */
    startable: (workspaces: string) =>
      list(workspaces).filter(({ dir }) => hasDevcontainerConfig(dir)),
  },
);

/** The word that stands for every target where one target is normally named. */
export const EVERY_TARGET = "all";

/**
 * Does this project argument mean "all of them"?
 *
 * `all` is a legal project name, and a directory really called that is the
 * thing the user is far more likely to have meant -- so the word only widens to
 * everything when there is no such project to be meant instead. The reading is
 * decided HERE, once, because the editor's client and the orchestrator's runner
 * are separate processes that must not disagree about what `--stop all` did.
 *
 * `--all` remains the unambiguous spelling, and is what the reading below tells
 * a user to reach for when their project is the one shadowing the word.
 */
export const meansEveryTarget = (workspaces: string, project?: string) =>
  project === EVERY_TARGET && !existsSync(join(workspaces, EVERY_TARGET));

/** Longest single path segment of a name, in characters. Two of them plus a
 *  slash is the ceiling for a whole project name. */
const MAX_SEGMENT = 64;
/** Must START with alphanumeric, which rules out "..", ".", hidden dirs, and
 *  anything beginning with a dash. */
const SEGMENT = `[a-zA-Z0-9][a-zA-Z0-9._-]{0,${MAX_SEGMENT - 1}}`;

const spelledAs =
  (pattern: RegExp) =>
  (query: unknown): query is string =>
    typeof query === "string" && pattern.test(query) && namespaceable(query);

/**
 * Is this a syntactically valid project name -- one or two plain path segments
 * that can be turned into a volume namespace?
 *
 * A direct child of /workspaces, or one level deeper so a repo can be scoped by
 * its owner.
 */
export const validName = spelledAs(
  new RegExp(`^${SEGMENT}(?:/${SEGMENT})?$`),
);

/**
 * Is this a valid worktree name -- exactly ONE path segment?
 *
 * A worktree names a DIRECTORY, not a branch. Branch names may contain `/`
 * (`feature/123`), which would need an encoding into volume names that has to
 * round-trip and cannot collide with the `/` -> `__` rule already in use. One
 * segment avoids the question, and refuses `.worktrees/a/b` along with it.
 */
export const validWorktree = spelledAs(new RegExp(`^${SEGMENT}$`));
