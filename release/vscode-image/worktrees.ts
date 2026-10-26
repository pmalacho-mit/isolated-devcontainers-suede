/**
 * worktrees.ts -- running one project on several branches at once.
 *
 * Two verified facts about git shape everything here.
 *
 * A worktree cannot be mounted on its own. Its `.git` is not a directory but a
 * FILE holding an absolute path into the project's `.git/worktrees/<name>`,
 * and that directory's `commondir` points back at the project's real `.git`.
 * Hide the project and git stops dead. So a worktree's container gets the
 * project's ROOT, at the path it had when the worktree was created, with the
 * worktree as its folder -- never `.git` on its own, which its project can
 * make a link (projectRoot, below).
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
 * Everything below the divider RUNS `git`, from the editor container -- which
 * mounts EVERY project read-write and holds the deploy keys' agent socket. Any
 * devcontainer can write its project's `.git`, so what that git obeys is
 * attacker-writable: a plain `worktree add` ran the project's post-checkout
 * hook, smudge filter and fsmonitor in the editor, and a TTY'd `worktree list`
 * ran its `pager.worktree`, and removing a racily-clean worktree ran its clean
 * filter. Two rules close that, and both are measured in E17:
 *
 *   - Every git here is `hardenedGit`: hooks, fsmonitor, the pager and auto-gc
 *     switched off on the COMMAND LINE, which outranks every config file and
 *     needs no read of the repository's config to apply -- reading it first
 *     would race a devcontainer rewriting it.
 *   - No git here converts file content, so no filter driver is ever consulted
 *     and none has to be switched off. `add` is `--no-checkout`; `remove` is
 *     `--force`, after the uncommitted-changes check that DOES read content has
 *     run in a sandbox. Both sandboxed steps live in desolate.ts and have this
 *     worktree's own reach. A command that would convert content is refused
 *     rather than hardened: git has no switch for every filter.
 *
 * The orchestrator holds the inner Docker socket, so it reads lock and index
 * FILES rather than asking git anything.
 */
/// <reference types="node" />
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
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
import { hint } from "./hints.ts";
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

/** Has this worktree been checked out yet?
 *
 *  `add` creates it with `--no-checkout`, which leaves the admin directory
 *  without an index; the sandboxed checkout writes one. Asked of the filesystem
 *  for the same reason `isLocked` is. A root target is always populated. */
export const isPopulated = (worktree: Target) => {
  if (!worktree.worktree) return true;
  const admin = adminDirectory(worktree);
  return admin !== "" && existsSync(join(admin, "index"));
};

/** The image a worktree is checked out in. Pinned by digest: it runs with the
 *  worktree's own reach, and a moved tag would be someone else's code there.
 *  git 2.54.0 with git-lfs, whose global config makes the lfs filter
 *  `required` -- which is why the sandbox is handed the proxy CA.
 *  Tag f4166bc, published 2026-09-27. */
export const CHECKOUT_IMAGE =
  "alpine/git@sha256:832b1cd1a271509f3d5272a1a62d4cb2ab1a53426ebde1f6c2cb7349f907dc6f";

/** Stamped on a worktree's sandbox with the TARGET's name, so the next run
 *  for that worktree removes one a crash left before starting its own. */
export const SANDBOX_LABEL = "desolate.worktree-sandbox";

/** How long a sandboxed step may run. A checkout runs the repository's
 *  post-checkout hook, which may fetch, install or simply hang. */
export const SANDBOX_SECONDS = 600;

/** Is this a git worktree that was created and never checked out -- the state
 *  `add` leaves it in, and the only one a sandbox should populate?
 *
 *  Narrower than `!isPopulated`: a directory with no `.git` file, or one
 *  naming an admin directory that is not there, is not a worktree waiting for
 *  files, and checking it out would fail rather than help. */
export const awaitsCheckout = (worktree: Target) => {
  if (!worktree.worktree) return false;
  const admin = adminDirectory(worktree);
  return admin !== "" && existsSync(admin) && !existsSync(join(admin, "index"));
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
 * What a worktree's container is given, and its sandboxes: the PROJECT ROOT,
 * at its own path -- which holds the worktree and the project's `.git` both.
 *
 * Not the worktree and `.git` as two binds, which is what it was. A bind's
 * source is resolved on the daemon, following symlinks, and the project's own
 * agent can replace its `.git` (or a worktree's directory) with a link to
 * another project's: on the shared daemon, which sees all of /workspaces, the
 * next worktree start then mounted THAT project's `.git`, writable (measured
 * in the nested stack). A project cannot replace its own root -- it is the
 * mount point it works in -- so binding the root and nothing below it leaves
 * every link inside to resolve within the container, where no other project
 * is. The cost: a worktree's container sees its project's other worktrees and
 * main tree, which share its `.git`, and so its trust, already.
 */
export const projectRoot = (target: Target) =>
  `type=bind,source=${target.projectDir},target=${target.projectDir}`;

/**
 * What this target's container needs beyond its workspace mount: nothing.
 * A worktree's workspace mount IS the project root (desolate.ts), so its
 * `.git` comes with it. Kept as the one place a future injected mount goes:
 * handed to `devcontainer up` as `--mount`, never written into a spec.
 */
export const mounts = (_target: Target): string[] => [];

/** What a worktree's sandbox is given: exactly what its devcontainer gets. */
export const sandboxMounts = (target: Target): string[] => [projectRoot(target)];

/**
 * The checkout's sandbox, which also gets the proxy CA, read-only, for
 * git-lfs. For `docker run --mount`, NOT `devcontainer up --mount`: the CLI's
 * grammar refuses `readonly` (tests/static/01-syntax.sh), docker's accepts it.
 */
export const checkoutMounts = (
  target: Target,
  caVolume: string,
  caDirectory: string,
): string[] => [
  ...sandboxMounts(target),
  `type=volume,source=${caVolume},target=${caDirectory},readonly`,
];

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

/** The knobs in a repository's config that name a command and that the
 *  commands below can reach, and the value that switches each off.
 *  `--no-pager` covers `core.pager` and every `pager.<cmd>`; auto-gc and
 *  maintenance are commands git may spawn on its own after a write. */
const NO_COMMANDS = [
  "--no-pager",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];

/** git that executes nothing the repository configured. See the header. */
export const hardenedGit = ({ projectDir }: Target) => [
  "-C",
  projectDir,
  ...NO_COMMANDS,
];

const git = (target: Target, ...args: string[]) =>
  run.status("git", [...hardenedGit(target), ...args]);

const branchExists = (target: Target, branch: string) =>
  run.status.ok(
    "git",
    [...hardenedGit(target), "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { quiet: true },
  );

/** Check out an existing branch, or start a new one -- the two spellings git
 *  has for `worktree add`, chosen by whether the ref is already there. Never
 *  checked out HERE: `--no-checkout` was measured to run no hook, filter or
 *  fsmonitor, and a checkout runs all three. */
export const addArguments = (target: Target, branch: string, exists: boolean) =>
  exists
    ? ["worktree", "add", "--no-checkout", target.dir, branch]
    : ["worktree", "add", "--no-checkout", "-b", branch, target.dir];

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
  if (git(target, ...addArguments(target, branch, branchExists(target, branch))) !== 0)
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
  console.log(
    `          its files are checked out in a sandbox when it first starts`,
  );
};

/** Why a worktree may be removed without git checking it first: git's own
 *  check reads content, which runs the repository's filters, so it never runs
 *  here (see the header).
 *
 *   checked  `cli.sh worktree remove` had the orchestrator check it for
 *            uncommitted changes in a sandbox, and it was clean.
 *   force    the person typing said to discard whatever is in it. */
export type RemovalWarrant = "checked" | "force";

/** Never started, so never checked out, and nothing put there by hand: only
 *  `.git`, and no index. There is nothing in it to lose. */
const holdsNothing = (target: Target) =>
  !isPopulated(target) && readdirSync(target.dir).every((entry) => entry === ".git");

const remove = (target: Target, warrant?: RemovalWarrant) => {
  if (!existsSync(target.dir)) return die(`no such worktree: ${target.dir}`);
  if (!warrant && !holdsNothing(target))
    return die(
      `refusing to remove ${target.name} unchecked. Checking it for uncommitted
       changes runs the repository's own filters, which must not run in the
       editor. Remove it with ${hint.mac(`worktree remove ${target.project} ${target.worktree}`)},
       which checks it in a sandbox first -- or add --force here to discard
       anything uncommitted in it.`,
    );

  // `worktree remove` refuses a locked worktree, and every desolate worktree is
  // locked, so unlocking is a step rather than a repair -- and one to undo if
  // git refuses, or a main tree started with the mask up would see a
  // prunable worktree. Measured on git 2.51, a failure has two shapes: git
  // refuses before touching anything (the registration is still there, so
  // lock it again), or it deletes the registration and then fails on a file
  // (nothing is left to lock: the directory is no longer a worktree).
  const admin = adminDirectory(target);
  git(target, "worktree", "unlock", target.dir);
  if (git(target, "worktree", "remove", "--force", target.dir) !== 0) {
    if (admin !== "" && existsSync(admin)) {
      git(target, "worktree", "lock", "--reason", LOCK_REASON, target.dir);
      return die(`git could not remove the worktree (see its message above); it is locked again`);
    }
    return die(
      `git unregistered the worktree but could not delete all of ${target.dir}
       (see its message above) -- files a container wrote as root, most likely.
       What is left there is no longer a worktree.`,
    );
  }
  console.log(`worktree: removed ${target.name}`);
};

const USAGE = [
  "usage: worktree list   <project>",
  "       worktree add    <project> <name> [<branch>]   (<branch> defaults to <name>)",
  "       worktree remove <project> <name> [--force]   (cli.sh checks it first)",
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

/** `--checked-clean` is how cli.sh says the sandbox found no uncommitted
 *  changes; `--force` is the person at the keyboard. Anything else after the
 *  name is a third positional, which only `add` has. */
const warrantFrom = (flag: string | undefined): RemovalWarrant | undefined => {
  if (flag === undefined) return undefined;
  if (flag === "--checked-clean") return "checked";
  if (flag === "--force") return "force";
  return die(`unknown option '${flag}' for remove\n${USAGE}`);
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
        `          start it with:  ${hint.desolate(`${project} --worktree ${name}`)}`,
      );
    }
    case "remove":
      if (!name) return die(`'remove' needs a worktree name\n${USAGE}`);
      return remove(targetFrom(project, name), warrantFrom(branch));
    default:
      return die(`unknown command '${command}'\n${USAGE}`);
  }
};

if (isEntryPoint(import.meta.url)) main(process.argv.slice(2));
