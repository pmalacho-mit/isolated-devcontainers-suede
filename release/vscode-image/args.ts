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
  | "purge";

export type Args = {
  command: Command;
  /** `name` or `owner/name`, relative to /workspaces. Reduced to that form
   *  here, so the absolute path tab-completion produces denotes the same
   *  project as the bare name. */
  project: string;
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
};

/** The wire form the broker spawns desolate with. */
export type Flags =
  | "--stop"
  | "--ports"
  | ["--config", string]
  | ["--worktree", string]
  | "--rebuild"
  | [
      "--rebuild",
      /** A fresh image as well as a fresh container. Only useful when the
       *  Dockerfile is unchanged but its inputs are not (apt/npm indexes). */
      "--no-cache",
    ];

export const USAGE =
  `usage: desolate [--config <path>] [--worktree <name>] [--rebuild [--no-cache]]
                [--stop|--ports|--purge] <project>
       <project> is 'name' or 'owner/name', relative to /workspaces
       <name> is a directory under <project>/.worktrees` as const;

export class UsageError extends Error {
  constructor(preamble?: string) {
    super(preamble ? `${preamble}\n${USAGE}` : USAGE);
  }
}

/** A project argument may be written as a bare name, an `owner/name`, or the
 *  absolute path the shell's tab-completion produces. All three denote the same
 *  project, so they are reduced to the one form the rest of the code uses. */
const projectName = (raw: string, workspaces: string) =>
  raw.replace(/\/+$/, "").replace(new RegExp(`^${workspaces}/`), "");

/** Order-independent; unknown `--flags` are refused rather than ignored.
 *
 *  @throws UsageError on an unknown flag, a missing project, or more than one.
 */
export const parseArgs = (argv: string[], workspaces = "/workspaces"): Args => {
  let command: Command = "run";
  let config: string | undefined;
  let worktree: string | undefined;
  let rebuild = false;
  let noCache = false;
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

  if (positional.length > 1)
    throw new UsageError(
      `Only one positional argument expected, received ${positional.length}`,
    );

  const raw = positional[0];
  if (!raw) throw new UsageError();

  return {
    command,
    project: projectName(raw, workspaces),
    worktree,
    config,
    rebuild,
    noCache,
  };
};
