/**
 * worktrees.ts -- running one project on several branches at once.
 *
 * Two verified facts about git shape everything here.
 *
 * A worktree cannot be mounted on its own. Its `.git` is not a directory but a
 * FILE holding an absolute path into the project's `.git/worktrees/<name>`,
 * and that directory's `commondir` points back at the project's real `.git`.
 * Hide the project and git stops dead. So a worktree's container gets the
 * project's `.git` bound at the path it had when the worktree was created --
 * and nothing else from the project, because git never reads another
 * worktree's checkout on a linked worktree's behalf.
 *
 * Worktrees share `.git/config` and `.git/hooks`. `git config --local` run
 * inside a worktree writes the PROJECT's config, and both of those are
 * executable configuration. So worktrees are PARALLELISM, not a boundary:
 *
 *   - worktree vs another project        -- isolated, exactly as before.
 *   - worktree vs a sibling worktree     -- NOT isolated, by git's design.
 *
 * Two branches that must not reach each other need two clones.
 *
 * Everything below the divider RUNS `git`, which obeys the project's own config
 * and hooks -- `worktree add` alone fires `post-checkout`. So it may be called
 * from the editor container, which already executes project content, and
 * nowhere else. The orchestrator holds the inner Docker socket, so it reads
 * lock FILES rather than asking git anything.
 */
/// <reference types="node" />
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  WORKTREES_DIRECTORY,
  target as resolveTarget,
  validName,
  validWorktree,
  worktreesOf,
  type Target,
} from "./projects.ts";
import { isEntryPoint, run } from "./utils.ts";

/** Overridable so the whole tool can be pointed at a throwaway workspace, the
 *  same way the broker's paths are. Nothing sets it in production. */
const WORKSPACES = process.env.DESOLATE_WORKSPACES ?? "/workspaces";

/** Visible in `git worktree list`, so someone who meets it outside desolate can
 *  tell why it is there and what removes it. */
export const LOCK_REASON =
  "desolate: hidden from the main tree's container; remove with 'cli.sh worktree remove'";

const gitDirectory = ({ projectDir }: Target) => join(projectDir, ".git");

/**
 * The admin directory git keeps this worktree's HEAD, index and lock in.
 *
 * Taken from the worktree's own `.git` FILE, which names it outright, rather
 * than rebuilt from the worktree's directory name -- git does not promise the
 * two match. Two worktrees whose directories share a basename get `<name>` and
 * `<name>1`, and which gets which depends on the order they were created:
 *
 *   .worktrees/wip   -> .git/worktrees/wip1     (this one, created second)
 *   elsewhere/wip    -> .git/worktrees/wip      (made outside desolate)
 *
 * Rebuilding the path there reads a STRANGER's lock, and in one direction that
 * is not fail-safe: a locked foreign `wip` would report an unlocked
 * `.worktrees/wip` as locked, the mask would go on, and the prune the lock
 * exists to prevent would take it.
 *
 * "" when there is no readable `.git` file -- a root target, or a worktree that
 * is not one. Every caller treats that as NOT locked.
 */
const adminDirectory = (worktree: Target) => {
  let pointer: string;
  try {
    pointer = readFileSync(join(worktree.dir, ".git"), "utf8");
  } catch {
    return "";
  }
  const named = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
  // git writes it absolute; resolving against the worktree covers a hand-edited
  // relative one without letting it land wherever the cwd happens to be.
  return named ? resolve(worktree.dir, named) : "";
};

/** Is this worktree exempt from pruning?
 *
 *  Asked of the filesystem rather than of git, because the orchestrator needs
 *  the answer and running git there would execute the project's own config and
 *  hooks. */
export const isLocked = (worktree: Target) => {
  const admin = adminDirectory(worktree);
  return admin !== "" && existsSync(join(admin, "locked"));
};

/**
 * A worktree's container has to see the project's `.git` at one absolute path,
 * inside and out, and writable: commits write objects, refs and the index.
 */
const sharedGitDirectory = (target: Target) => {
  const git = gitDirectory(target);
  return `type=bind,source=${git},target=${git}`;
};

/**
 * What this target's container needs beyond its own workspace folder.
 *
 * Handed to `devcontainer up` as `--mount`, never written into a spec. A
 * project must not be able to declare this itself -- that is how
 * `/workspaces/other/.git` would get mounted -- and policy.ts refuses every
 * bind a project writes, which is exactly the rule that keeps that true.
 *
 * The CLI parses `--mount` with a strict
 * `type=<bind|volume>,source=,target=` regex and REFUSES anything else, which
 * is why the mask below is a runArg rather than a fourth mount.
 */
export const mounts = (target: Target): string[] =>
  target.worktree ? [sharedGitDirectory(target)] : [];

/**
 * An empty tmpfs over `.worktrees`, so the main tree's editor holds one copy of
 * every filename rather than one per branch.
 *
 * Only when every worktree is LOCKED, and that condition is the whole safety
 * argument. A worktree whose directory is missing counts as `prunable`, and
 * pruning deletes the admin directory a running worktree container is using --
 * unrecoverably, since what it holds is that worktree's HEAD, index and refs.
 * `git worktree prune` does it at once; `gc` (and so `gc.auto`, on ordinary
 * commands) does it once `gc.worktreePruneExpire` has passed, three months by
 * default. Locking exempts it from both. Measured on git 2.51.
 */
export const runArgs = (target: Target): string[] => {
  if (target.worktree) return [];
  const worktrees = join(target.projectDir, WORKTREES_DIRECTORY);
  if (!existsSync(worktrees)) return [];
  if (unlocked(target).length) return [];
  return ["--tmpfs", worktrees];
};

/** Worktrees this project holds that masking would put at risk. */
export const unlocked = (target: Target) =>
  worktreesOf(target).filter((worktree) => !isLocked(worktree));

// ---------------------------------------------------------------------------
// Below here, git runs. Editor container only -- see the header.

/** Refuse, with the message reflowed onto one line so it can be written across
 *  several here and still read as one sentence in a terminal. */
const die = (message: string): never => {
  console.error(`worktree: ${message.replace(/\s*\n\s*/g, " ")}`);
  process.exit(1);
};

const git = (target: Target, ...args: string[]) =>
  run.status("git", ["-C", target.projectDir, ...args]);

const branchExists = ({ projectDir }: Target, branch: string) =>
  run.status.ok(
    "git",
    ["-C", projectDir, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { quiet: true },
  );

/** Check out an existing branch, or start a new one -- the two spellings git
 *  has for `worktree add`, chosen by whether the ref is already there. */
const addArguments = (target: Target, branch: string) =>
  branchExists(target, branch)
    ? ["worktree", "add", target.dir, branch]
    : ["worktree", "add", "-b", branch, target.dir];

/** `.git/info/exclude`, not `.gitignore`: `.gitignore` is tracked, and this
 *  tool's layout has no business in the user's next commit. */
const excludeFromTheRepository = (target: Target) => {
  const file = join(gitDirectory(target), "info", "exclude");
  const entry = `${WORKTREES_DIRECTORY}/`;
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } /* not written yet */ catch {}
  if (existing.split("\n").includes(entry)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${entry}\n`);
};

const add = (target: Target, branch: string) => {
  if (existsSync(target.dir)) return die(`${target.dir} already exists`);

  // git's own refusals here are better than anything worth wrapping them in --
  // "fatal: 'main' is already used by worktree at ..." says precisely why the
  // main tree may not be checked out twice.
  if (git(target, ...addArguments(target, branch)) !== 0)
    return die(`git could not create the worktree (see its message above)`);

  if (git(target, "worktree", "lock", "--reason", LOCK_REASON, target.dir) !== 0)
    return die(
      `the worktree was created but could not be LOCKED. Unlocked, a prune in
       a container that cannot see it destroys it, and no part of that is
       recoverable. Remove it with
       'git -C ${target.projectDir} worktree remove ${target.dir}' and report
       this.`,
    );

  excludeFromTheRepository(target);
  console.log(`worktree: ${target.name} is at ${target.dir}`);
};

const remove = (target: Target) => {
  if (!existsSync(target.dir)) return die(`no such worktree: ${target.dir}`);

  // `worktree remove` refuses a locked worktree, and every desolate worktree is
  // locked, so unlocking is a step rather than a repair.
  git(target, "worktree", "unlock", target.dir);

  if (git(target, "worktree", "remove", target.dir) !== 0)
    return die(
      `git could not remove the worktree (uncommitted changes? see its message above)`,
    );
  console.log(`worktree: removed ${target.name}`);
};

const USAGE = [
  "usage: worktree list   <project>",
  "       worktree add    <project> <name> [<branch>]   (<branch> defaults to <name>)",
  "       worktree remove <project> <name>",
].join("\n");

const targetFrom = (project: string, worktree?: string) => {
  if (!validName(project))
    return die(`'${project}' is not a usable project name`);
  if (worktree !== undefined && !validWorktree(worktree))
    return die(
      `'${worktree}' is not a usable worktree name -- ONE path segment starting
       with a letter or digit. A worktree names a DIRECTORY; use <branch> for a
       ref with slashes in it.`,
    );

  const target = resolveTarget(WORKSPACES, project, worktree);
  if (!existsSync(gitDirectory(target)))
    return die(`${target.projectDir} is not a git repository`);
  return target;
};

/** Create this worktree unless it is already there.
 *
 *  What `desolate <project> --worktree <name>` calls from the editor, so a
 *  branch can be opened in one command. `<branch>` defaults to `<name>`. */
export const ensure = (project: string, worktree: string, branch?: string) => {
  const target = targetFrom(project, worktree);
  if (existsSync(target.dir)) return;
  add(target, branch || worktree);
};

const main = ([command, project, name, branch]: string[]) => {
  if (!project) return die(`no project given\n${USAGE}`);

  switch (command) {
    case "list":
      return void git(targetFrom(project), "worktree", "list");
    case "add": {
      if (!name) return die(`'add' needs a worktree name\n${USAGE}`);
      add(targetFrom(project, name), branch || name);
      return console.log(
        `          start it with:  desolate ${project} --worktree ${name}`,
      );
    }
    case "remove":
      if (!name) return die(`'remove' needs a worktree name\n${USAGE}`);
      return remove(targetFrom(project, name));
    default:
      return die(`unknown command '${command}'\n${USAGE}`);
  }
};

if (isEntryPoint(import.meta.url)) main(process.argv.slice(2));
