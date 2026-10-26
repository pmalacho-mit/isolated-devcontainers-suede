/**
 * args.ts -- the desolate command line.
 *
 * Parsing throws rather than exiting, so the grammar can be exercised without a
 * subprocess. Turning a UsageError into an exit code is the entry point's job.
 */

/**
 * What the invocation asks for. Each one acts on exactly one target.
 *
 * The pair worth reading together is `stop` and `purge`: what `stop`
 * deliberately KEEPS is exactly what `purge` removes.
 */
export type Command =
  /** Start it -- or restart what is already there -- and print its URLs. */
  | "run"
  /** Stop the container and remove the relays, keeping the container itself
   *  and everything saved about the target, so restarting is fast. */
  | "stop"
  /** Print the saved host-port map. Reads state; changes none. */
  | "ports"
  /** Undo `run`: the container, the relays, the volumes desolate built for it,
   *  and its saved ports, token and spec fingerprint. Volumes the PROJECT
   *  declared are left alone -- a target going away is not a reason to delete
   *  a database. */
  | "purge"
  /** What is UP right now, across every project and worktree. Names no target:
   *  the question is about all of them. Reads state; changes none. */
  | "list"
  /** Whether a worktree holds anything a removal would lose, asked in its
   *  sandbox. What `cli.sh worktree remove` runs before deleting one; the
   *  editor cannot ask git that itself (worktrees.ts). */
  | "uncommitted"
  /** Check a never-started worktree out in its sandbox, and nothing else.
   *  What the broker asks for BEFORE it reads the spec: a worktree the editor
   *  created holds no `.devcontainer/` until this has run (worktrees.ts). */
  | "populate"
  /** Create a worktree, with nothing checked out, in its sandbox: the broker's
   *  answer to the editor's `worktree add`, which must not run git itself
   *  (worktrees.ts). The one command whose target must NOT exist yet. */
  | "create-worktree"
  /** Remove a worktree -- once nothing would be lost, or `--force` -- in its
   *  sandbox, after purging what desolate made for it. What `worktree remove`
   *  asks for, from the editor or the Mac. */
  | "remove-worktree"
  /** Give the editor's uid back everything under the target -- or under
   *  `path` inside it -- that a container left owned by someone else (#15).
   *  What `cli.sh reclaim` and `cli.sh worktree remove` run. */
  | "reclaim";

export type Args = {
  command: Command;
  /** `name` or `owner/name`, relative to /workspaces. Reduced to that form
   *  here, so the absolute path tab-completion produces denotes the same
   *  project as the bare name.
   *
   *  Absent exactly when the command names no target -- `list`, and `stop`
   *  widened by `--all`. */
  project?: string;
  /** One of that project's worktrees, rather than the branch checked out at its
   *  root. Names a DIRECTORY under `.worktrees`, never a branch: branches may
   *  contain `/`, and this ends up inside docker object names. Absent is the
   *  project itself. */
  worktree?: string;
  /** A devcontainer.json to read INSTEAD of the one in the target's directory.
   *  Always a frozen copy, so the spec that was validated is the spec that
   *  starts. Absent means desolate makes that copy itself. */
  config?: string;
  /** Recreate the container from the current spec. `run` alone reuses an
   *  existing container WITHOUT re-reading devcontainer.json, so an edited spec
   *  takes effect only with this -- at the cost of anything written inside the
   *  container outside /workspaces. Only `run` reads it. */
  rebuild: boolean;
  /** Rebuild the IMAGE as well as the container. For when the Dockerfile is
   *  unchanged but its inputs are not (apt/npm indexes). Implies `rebuild`. */
  noCache: boolean;
  /** `--all`: widen `stop` from one target to every running one. The spelling
   *  that cannot be mistaken for a project called `all`. */
  all: boolean;
  /** The branch `create-worktree` checks out, made if it is not there. Absent
   *  is the worktree's own name. */
  branch?: string;
  /** Where `create-worktree` starts a branch it makes: a commit, or a ref to
   *  one. Absent is the project's HEAD. */
  from?: string;
  /** `remove-worktree` without asking whether anything would be lost. */
  force: boolean;
  /** `--ports <p> --move <label> <port>`: give one label a different host
   *  port -- for when the Mac already holds it, which Lima never forwards. */
  move?: { label: string; port: number };
  /** `--reclaim --path <relative>`: where under the target to reclaim. Relative
   *  to the target's directory, and refused if it leaves it. */
  path?: string;
  /** `--json`: `list` and `ports` print one JSON document instead of prose,
   *  for programs -- the factory's watcher, the editor extension. */
  json: boolean;
};

/** The wire form the broker spawns desolate with. */
export type Flags =
  | "--stop"
  | "--ports"
  | "--populate"
  | "--create-worktree"
  | ["--branch", string]
  | "--remove-worktree"
  | "--force"
  | ["--from", string]
  | "--purge"
  | "--reclaim"
  | "--uncommitted"
  | "--json"
  | ["--config", string]
  | ["--worktree", string]
  | ["--move", string, string]
  | "--rebuild"
  | [
      "--rebuild",
      /** A fresh image as well as a fresh container. Only useful when the
       *  Dockerfile is unchanged but its inputs are not (apt/npm indexes). */
      "--no-cache",
    ];

export const USAGE =
  `usage: desolate [--config <path>] [--worktree <name>] [--rebuild [--no-cache]]
                [--stop|--ports [--move <label> <port>]|--purge] <project>
       desolate --list                    what is running right now
       desolate --stop all|--stop --all   stop every running target
       <project> is 'name' or 'owner/name', relative to /workspaces
       <name> is a directory under <project>/.worktrees` as const;

export class UsageError extends Error {
  constructor(preamble?: string) {
    super(preamble ? `${preamble}\n${USAGE}` : USAGE);
  }
}

/** A path under a target, as written: relative, no `..` segment, nothing a
 *  shell or a mount option would read twice. Checked again against the real
 *  directory where it is used; this is the grammar's half. */
const relativeWithin = (raw: string) =>
  raw !== "" &&
  !raw.startsWith("/") &&
  !/[\0\n,]/.test(raw) &&
  raw.split("/").every((segment) => segment !== "..");

/** A project argument may be written as a bare name, an `owner/name`, or the
 *  absolute path the shell's tab-completion produces. All three denote the same
 *  project, so they are reduced to the one form the rest of the code uses. */
const projectName = (raw: string, workspaces: string) =>
  raw.replace(/\/+$/, "").replace(new RegExp(`^${workspaces}/`), "");

/** Commands that act on the whole stack, so a project argument has nothing to
 *  mean. `--all` puts `stop` in the same class. */
const namesNoTarget = (command: Command, all: boolean) =>
  command === "list" || all;

/** @throws UsageError unless exactly one project was given. */
const theOneProject = (positional: string[], workspaces: string) => {
  if (positional.length > 1)
    throw new UsageError(
      `Only one positional argument expected, received ${positional.length}`,
    );
  const raw = positional[0];
  if (!raw) throw new UsageError();
  return projectName(raw, workspaces);
};

/** Order-independent; unknown `--flags` are refused rather than ignored.
 *
 *  @throws UsageError on an unknown flag, a missing project, one too many, or a
 *  project given to a command that acts on all of them.
 */
export const parseArgs = (argv: string[], workspaces = "/workspaces"): Args => {
  let command: Command = "run";
  let config: string | undefined;
  let worktree: string | undefined;
  let rebuild = false;
  let noCache = false;
  let all = false;
  let branch: string | undefined;
  let from: string | undefined;
  let force = false;
  let move: Args["move"];
  let reclaimPath: string | undefined;
  let json = false;
  const positional: string[] = [];
  const queue = [...argv];

  while (queue.length) {
    const arg = queue.shift()!;
    switch (arg) {
      case "--config":
        config = queue.shift() ?? "";
        break;
      case "--worktree":
        worktree = queue.shift() ?? "";
        break;
      case "--stop":
        command = "stop";
        break;
      case "--ports":
        command = "ports";
        break;
      case "--purge":
        command = "purge";
        break;
      case "--populate":
        command = "populate";
        break;
      case "--uncommitted":
        command = "uncommitted";
        break;
      case "--create-worktree":
        command = "create-worktree";
        break;
      case "--remove-worktree":
        command = "remove-worktree";
        break;
      case "--branch":
        branch = queue.shift() ?? "";
        break;
      case "--from":
        from = queue.shift() ?? "";
        break;
      case "--force":
        force = true;
        break;
      case "--reclaim":
        command = "reclaim";
        break;
      case "--path":
        reclaimPath = queue.shift() ?? "";
        break;
      case "--list":
        command = "list";
        break;
      case "--all":
        all = true;
        break;
      case "--json":
        json = true;
        break;
      case "--move": {
        const label = queue.shift() ?? "";
        const port = queue.shift() ?? "";
        if (!/^(editor|[1-9][0-9]{0,4})$/.test(label) || !/^[1-9][0-9]{0,4}$/.test(port))
          throw new UsageError(`--move takes a label (editor, or a container port) and a host port`);
        move = { label, port: Number(port) };
        break;
      }
      case "--rebuild":
        rebuild = true;
        break;
      case "--no-cache":
        noCache = true;
        rebuild = true;
        break;
      default:
        if (arg.startsWith("--")) throw new UsageError(`unknown option '${arg}'`);
        positional.push(arg);
    }
  }

  if (all && command !== "stop")
    throw new UsageError("--all only means something with --stop");
  if (branch !== undefined && command !== "create-worktree")
    throw new UsageError("--branch only means something with --create-worktree");
  if (from !== undefined && command !== "create-worktree")
    throw new UsageError("--from only means something with --create-worktree");
  if (force && command !== "remove-worktree")
    throw new UsageError("--force only means something with --remove-worktree");
  if ((command === "create-worktree" || command === "remove-worktree") && worktree === undefined)
    throw new UsageError(`--${command} acts on a worktree; name it with --worktree`);
  if (move && command !== "ports")
    throw new UsageError("--move only means something with --ports");
  if (json && command !== "list" && command !== "ports")
    throw new UsageError("--json only means something with --list or --ports");
  if (reclaimPath !== undefined && command !== "reclaim")
    throw new UsageError("--path only means something with --reclaim");
  if (reclaimPath !== undefined && !relativeWithin(reclaimPath))
    throw new UsageError(`--path '${reclaimPath}' must be relative, and stay inside the target`);

  if (namesNoTarget(command, all)) {
    if (positional.length)
      throw new UsageError(
        `'${all ? "--all" : "--list"}' acts on every target, so it takes no ` +
          `project (got '${positional.join(" ")}')`,
      );
    return { command, worktree, config, rebuild, noCache, all, branch, from, force, json };
  }

  return {
    command,
    project: theOneProject(positional, workspaces),
    worktree,
    config,
    rebuild,
    noCache,
    all,
    branch,
    from,
    force,
    json,
    ...(move ? { move } : {}),
    ...(reclaimPath !== undefined ? { path: reclaimPath } : {}),
  };
};
