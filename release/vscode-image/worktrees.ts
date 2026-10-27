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
 * The editor container mounts EVERY project read-write and holds the deploy
 * keys' agent socket, and any devcontainer can write its project's `.git` --
 * so git run there against a project obeys attacker-writable config, and
 * follows attacker-placed links. Measured: a plain `worktree add` ran the
 * project's post-checkout hook, smudge filter and fsmonitor in the editor
 * (E17); and with the project's `.git`, `.worktrees` or `.git/info/exclude`
 * made a link into another project, the editor's `add` created a branch in
 * THAT project's repository, a directory in its tree, or appended to its
 * config, which broke it. So:
 *
 *   - Creating and removing a worktree is not done in the editor at all. The
 *     editor asks the broker; the orchestrator runs `createScript` and
 *     `removeScript` in the worktree's sandbox, which mounts the project's
 *     root and nothing else, so every link resolves inside it -- where no
 *     other project is. `add` is `--no-checkout`; the checkout, which runs the
 *     repository's hooks and filters, happens in the same sandbox at first
 *     start. Whether a removal would lose anything is asked there too.
 *   - `list`, the one git the editor still runs, is `hardenedGit`: hooks,
 *     fsmonitor, the pager and auto-gc switched off on the COMMAND LINE, which
 *     outranks every config file and needs no read of the repository's config
 *     to apply -- reading it first would race a devcontainer rewriting it. It
 *     reads; it writes nothing.
 *
 * The orchestrator holds the inner Docker socket, so it reads lock and index
 * FILES rather than asking git anything.
 */
/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ask } from "./broker-client.ts";
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
 * The bundle's sandbox (desolate.ts bundleTarget): the PROJECT ROOT,
 * read-only, and an output directory of this target's own -- and nothing else
 * of /workspaces. The root, not `.git`: a project cannot replace its own root
 * the way it can swap `.git` for a link, so whatever its repository points at
 * outside itself resolves inside the sandbox, where no other project is. For
 * `docker run --mount` (which accepts `readonly`), as checkoutMounts is.
 */
export const bundleMounts = (target: Target, out: string): string[] => [
  `type=bind,source=${target.projectDir},target=${target.projectDir},readonly`,
  `type=bind,source=${out},target=/out`,
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
// Creating and removing one: scripts the ORCHESTRATOR runs in the worktree's
// sandbox (desolate.ts), never git in the editor. See the header.

/** git that executes nothing the repository configured: hooks, fsmonitor,
 *  the pager and auto-gc switched off on the COMMAND LINE, which outranks
 *  every config file. In a sandbox this is hygiene -- it has the project's own
 *  reach -- and in the editor, where `list` still runs it, the boundary.
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

/** `g`, in a sandbox script: that git, against the project in `$p`. */
const SANDBOX_GIT = `g() { git -C "$p" ${NO_COMMANDS.join(" ")} "$@"; }`;

/** Is this a ref `add` may hand git? git has the last word on what a branch
 *  may be called; this refuses only what would reach it as something else --
 *  an option, or a word split in two. */
export const validBranch = (branch: unknown): branch is string =>
  typeof branch === "string" &&
  branch.length > 0 &&
  branch.length <= 255 &&
  !branch.startsWith("-") &&
  !/[\s\x00-\x1f\x7f]/.test(branch);

/** What `createScript` exits with, beyond git's own failures. */
export const CREATE_EXIT = { exists: 3, git: 4, lock: 5, exclude: 6, start: 7 } as const;

/**
 * Create a worktree with nothing checked out, lock it, and keep `.worktrees`
 * out of the repository's status -- run in its sandbox, with its arguments as
 * positional parameters rather than spliced into the script.
 *
 * A branch that is not there yet starts at `$5` when it is given -- checked
 * to be a commit first, so it reaches `worktree add` as nothing else -- and
 * at the project's HEAD when it is empty. An existing branch ignores it.
 *
 * `--no-checkout`, because a checkout runs the repository's hooks, filters and
 * fsmonitor, and does so at first start instead (desolate.ts populateWorktree).
 * `.git/info/exclude`, not `.gitignore`: `.gitignore` is tracked, and this
 * tool's layout has no business in the user's next commit.
 */
export const createScript = [
  'p=$1 dir=$2 branch=$3 reason=$4 from=$5',
  SANDBOX_GIT,
  `if [ -e "$dir" ] || [ -L "$dir" ]; then echo "worktree: $dir already exists" >&2; exit ${CREATE_EXIT.exists}; fi`,
  `if [ -n "$from" ] && ! g rev-parse --verify --quiet "$from^{commit}" >/dev/null; then echo "worktree: '$from' is not a commit in $p" >&2; exit ${CREATE_EXIT.start}; fi`,
  // git's own refusals here are better than anything worth wrapping them in --
  // "fatal: 'main' is already used by worktree at ..." says precisely why.
  'if g show-ref --verify --quiet "refs/heads/$branch"',
  `then g worktree add --no-checkout "$dir" "$branch" || exit ${CREATE_EXIT.git}`,
  `else g worktree add --no-checkout -b "$branch" "$dir" \${from:+"$from"} || exit ${CREATE_EXIT.git}`,
  'fi',
  `g worktree lock --reason "$reason" "$dir" || exit ${CREATE_EXIT.lock}`,
  `exclude="$p/.git/info/exclude"`,
  `mkdir -p "$p/.git/info" || exit ${CREATE_EXIT.exclude}`,
  `grep -qxF '${WORKTREES_DIRECTORY}/' "$exclude" 2>/dev/null || printf '%s\\n' '${WORKTREES_DIRECTORY}/' >> "$exclude" || exit ${CREATE_EXIT.exclude}`,
].join("\n");

/** `createScript`'s positional parameters, for this worktree on `branch`,
 *  started at `from` if that branch is new. */
export const createArguments = (target: Target, branch: string, from = "") => [
  target.projectDir,
  target.dir,
  branch,
  LOCK_REASON,
  from,
];

/** What `removeScript` exits with when git did not remove it. */
export const REMOVE_EXIT = { relocked: 4, partial: 5 } as const;

/**
 * Remove a worktree -- run in its sandbox, once desolate.ts has decided
 * nothing will be lost (`removal`). Never git's own cleanliness check: that
 * reads content, which runs the repository's filters, so it is `--force`.
 *
 * `worktree remove` refuses a locked worktree, and every desolate worktree is
 * locked, so unlocking is a step rather than a repair -- and one to undo if
 * git refuses, or a main tree started with the mask up would see a prunable
 * worktree. Measured on git 2.51, a failure has two shapes: git refuses
 * before touching anything (still registered, so lock it again), or it
 * deletes the registration and then fails on a file (nothing left to lock).
 */
export const removeScript = [
  'p=$1 dir=$2 reason=$3',
  SANDBOX_GIT,
  'g worktree unlock "$dir" 2>/dev/null',
  'g worktree remove --force "$dir" && exit 0',
  'if g worktree list --porcelain | grep -qxF "worktree $dir"',
  `then g worktree lock --reason "$reason" "$dir"; exit ${REMOVE_EXIT.relocked}`,
  'fi',
  `exit ${REMOVE_EXIT.partial}`,
].join("\n");

/** `removeScript`'s positional parameters, for this worktree. */
export const removeArguments = (target: Target) => [target.projectDir, target.dir, LOCK_REASON];

/** What sits in a worktree beside its `.git` file. */
export const strayEntries = (target: Target) =>
  readdirSync(target.dir).filter((entry) => entry !== ".git");

/**
 * What has to be true before this worktree may be removed.
 *
 *   force     the person typing said to discard whatever is in it.
 *   nothing   never checked out, and nothing put there by hand: only `.git`,
 *             and no index. There is nothing in it to lose.
 *   check     checked out: ask git, in its sandbox, what is uncommitted.
 *   refuse    never checked out, yet holding files someone put there.
 */
export const removal = (target: Target, force: boolean) => {
  if (force) return { kind: "force" } as const;
  if (isPopulated(target)) return { kind: "check" } as const;
  const stray = strayEntries(target);
  return stray.length
    ? ({ kind: "refuse", stray } as const)
    : ({ kind: "nothing" } as const);
};

// ---------------------------------------------------------------------------
// The editor's `worktree` command. Only `list` runs git here.

/** Refuse, with the message reflowed onto one line so it can be written across
 *  several here and still read as one sentence in a terminal. */
const die = (message: string): never => {
  console.error(`worktree: ${message.replace(/\s*\n\s*/g, " ")}`);
  process.exit(1);
};

/** git that executes nothing the repository configured. See the header. */
export const hardenedGit = ({ projectDir }: Target) => [
  "-C",
  projectDir,
  ...NO_COMMANDS,
];

const git = (target: Target, ...args: string[]) =>
  run.status("git", [...hardenedGit(target), ...args]);

const USAGE = [
  "usage: worktree list   <project>",
  "       worktree add    <project> <name> [<branch> [<start>]]   (<branch> defaults to <name>; a new one starts at <start>)",
  "       worktree remove <project> <name> [--force]   (checked for uncommitted work first)",
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

/** Ask the orchestrator to create this worktree, in its sandbox. The exit
 *  status the broker relayed: 0 when it was made. */
const add = (target: Target, branch: string, from?: string) => {
  if (!validBranch(branch)) return die(`'${branch}' is not a usable branch name`);
  if (from !== undefined && !validBranch(from)) return die(`'${from}' is not a usable start point`);
  return ask({
    op: "worktree-add", project: target.project, worktree: target.worktree, branch,
    ...(from !== undefined ? { from } : {}),
  });
};

/** Create this worktree unless it is already there.
 *
 *  What `desolate <project> --worktree <name>` calls from the editor, so a
 *  branch can be opened in one command. `<branch>` defaults to `<name>`. */
export const ensure = async (project: string, worktree: string, branch?: string) => {
  const target = targetFrom(project, worktree);
  if (existsSync(target.dir)) return 0;
  return add(target, branch || worktree);
};

/** `--force` is the person at the keyboard. `--checked-clean`, which cli.sh
 *  used to pass once it had checked, still means "check": the orchestrator
 *  checks itself now. Anything else after the name is a third positional,
 *  which only `add` has. */
const forcedBy = (flag: string | undefined): boolean => {
  if (flag === undefined || flag === "--checked-clean") return false;
  if (flag === "--force") return true;
  return die(`unknown option '${flag}' for remove\n${USAGE}`);
};

const main = async ([command, project, name, branch, start]: string[]): Promise<number> => {
  if (!project) return die(`no project given\n${USAGE}`);

  switch (command) {
    case "list":
      return git(targetFrom(project), "worktree", "list");
    case "add": {
      if (!name) return die(`'add' needs a worktree name\n${USAGE}`);
      const code = await add(targetFrom(project, name), branch || name, start);
      if (code === 0)
        console.log(
          `          start it with:  ${hint.desolate(`${project} --worktree ${name}`)}`,
        );
      return code;
    }
    case "remove": {
      if (!name) return die(`'remove' needs a worktree name\n${USAGE}`);
      const target = targetFrom(project, name);
      if (!existsSync(target.dir)) return die(`no such worktree: ${target.dir}`);
      return ask({ op: "worktree-remove", project, worktree: name, force: forcedBy(branch) });
    }
    default:
      return die(`unknown command '${command}'\n${USAGE}`);
  }
};

if (isEntryPoint(import.meta.url))
  main(process.argv.slice(2)).then((code) => process.exit(code));
