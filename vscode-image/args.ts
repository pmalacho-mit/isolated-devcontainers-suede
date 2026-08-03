/**
 * args.ts -- the desolate command line.
 *
 * Parsing throws rather than exiting, so the grammar can be exercised without a
 * subprocess. Turning a UsageError into an exit code is the entry point's job.
 */

export type Command = "run" | "stop" | "ports";

export type Args = {
  command: Command;
  project: string;
  config?: string;
  rebuild: boolean;
  noCache: boolean;
};

/** The wire form the broker spawns desolate with. */
export type Flags =
  | "--stop"
  | "--ports"
  | ["--config", string]
  | "--rebuild"
  | [
      "--rebuild",
      /** A fresh image as well as a fresh container. Only useful when the
       *  Dockerfile is unchanged but its inputs are not (apt/npm indexes). */
      "--no-cache",
    ];

export const USAGE =
  `usage: desolate [--config <path>] [--rebuild [--no-cache]] [--stop|--ports] <project>
       <project> is 'name' or 'owner/name', relative to /workspaces` as const;

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
      case "--stop":
        command = "stop";
        break;
      case "--ports":
        command = "ports";
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
    config,
    rebuild,
    noCache,
  };
};
