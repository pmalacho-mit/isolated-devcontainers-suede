// desolate-client.ts -- the `desolate` command inside the EDITOR container.
//
// The editor has no Docker access by design. This client sends a request to
// the orchestrator's broker over a unix socket and streams back its output, so
// the workflow feels identical:
//
//   desolate myproject          start it, print URLs
//   desolate myproject --worktree wip [--branch feature/123]
//   desolate --stop myproject
//   desolate --stop all             (or --stop --all)
//   desolate --ports myproject
//   desolate --list                 what is running right now
//   desolate --purge --worktree wip myproject   what a worktree's removal runs here
//   desolate --list --json | desolate --ports myproject --json   for programs
//
// The broker validates both the project name and the project's
// devcontainer.json spec before acting -- see broker.ts.
//
// A worktree that is not there yet is created first, by asking the broker:
// the orchestrator runs git for it in the worktree's sandbox, never here
// (worktrees.ts).

import { ask } from "./broker-client.ts";
import { ensure as ensureWorktree } from "./worktrees.ts";
import { EVERY_TARGET, meansEveryTarget } from "./projects.ts";

const WORKSPACES = process.env.DESOLATE_WORKSPACES ?? "/workspaces";

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

/** `code` 0 when the user ASKED for help, 1 when we are rejecting a command
 *  line. Shells and scripts distinguish those; `desolate` used to exit 0 for
 *  both, so a malformed invocation looked like it worked. */
function usage(code = 0): never {
  const out = code === 0 ? console.log : console.error;
  out("usage: desolate [--stop|--ports|--rebuild] [--worktree <name>] <project>");
  out("       desolate --list                    what is running right now");
  out("       desolate --dinds                   every project dind and the VM's headroom, as JSON");
  out("       desolate --stop all|--stop --all   stop every running target");
  out("");
  out("  --rebuild  recreate the container from the current devcontainer.json.");
  out("             Plain start REUSES an existing container and does not");
  out("             re-read the spec, so edits need this to take effect.");
  out("");
  out("  --all      with --stop, every running target rather than one. The");
  out(`             bare word '${EVERY_TARGET}' means the same, unless a project of`);
  out("             that name is really there -- then it names that project.");
  out("");
  out("  --worktree open one of <project>/.worktrees/<name> instead of the");
  out("             branch checked out at the project root. Created on first");
  out("             use, with a branch of the same name unless --branch says");
  out("             otherwise. Worktrees run in parallel; they are NOT isolated");
  out("             from each other (they share .git, config and hooks).");
  out("  --branch   the git ref --worktree checks out. Defaults to <name>.");
  out("");
  out("  Flags may come before or after <project>; unknown flags are refused.");
  process.exit(code);
}

/** Every line prefixed, and the exit status the shell reads. Nothing here is
 *  recoverable: a command line we cannot read is one we must not guess at. */
function refuse(...lines: string[]): never {
  for (const line of lines) console.error(`desolate: ${line}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") usage();

// Order-independent, and an unrecognised --flag is REFUSED rather than dropped.
// The old parsing only ever looked at argv[0], so `desolate myproj --rebuild`
// (or a typo like --build) silently became a plain start: you were told the
// project was ready, having asked for a rebuild that never happened. desolate.ts
// already refuses unknown options; this side has to agree, or the two disagree
// about what the same command line means.
const OPS: Record<string, string> = {
  "--list": "list", "--dinds": "dinds", "--stop": "stop", "--ports": "ports", "--rebuild": "rebuild", "--purge": "purge", "--bundle": "bundle",
};
/** Flags that consume the next argument. */
const VALUES = ["--worktree", "--branch"] as const;
/** Flags that qualify an op rather than being one. */
const MODIFIERS = ["--all", "--json"] as const;

let op = "start";
let move: { label: string; port: number } | undefined;
const value: Record<string, string | undefined> = {};
const modifier = new Set<string>();
const rest: string[] = [];
const queue = [...argv];
while (queue.length) {
  const a = queue.shift()!;
  if (a in OPS) {
    // Two ops in one command line is a mistake, not a precedence question.
    if (op !== "start") refuse(`'${a}' conflicts with the operation already given`);
    op = OPS[a];
  } else if (a === "--move") {
    const label = queue.shift(), port = queue.shift();
    if (!label || !port || !/^(editor|[1-9][0-9]{0,4})$/.test(label) || !/^[1-9][0-9]{0,4}$/.test(port))
      refuse("--move takes a label (editor, or a container port) and a host port");
    move = { label: label!, port: Number(port) };
  } else if ((MODIFIERS as readonly string[]).includes(a)) {
    modifier.add(a);
  } else if ((VALUES as readonly string[]).includes(a)) {
    const given = queue.shift();
    if (given === undefined || given.startsWith("-")) refuse(`'${a}' expects a value`);
    value[a] = given;
  } else if (a.startsWith("-")) {
    refuse(
      `unknown option '${a}'`,
      `        known: ${[...Object.keys(OPS), ...MODIFIERS, ...VALUES].sort().join(" ")}`,
      "        (to rebuild from an edited devcontainer.json: --rebuild)",
    );
  } else {
    rest.push(a);
  }
}

const worktree = value["--worktree"];
if (value["--branch"] !== undefined && worktree === undefined)
  refuse("--branch only means something with --worktree");

if (modifier.has("--all") && op !== "stop") refuse("--all only means something with --stop");
if (move && op !== "ports") refuse("--move only means something with --ports");
if (modifier.has("--json") && op !== "list" && op !== "ports") refuse("--json only means something with --list or --ports");
if (op === "bundle" && value["--worktree"] === undefined) refuse("--bundle bundles a worktree's branch: name it with --worktree");
if (op === "purge" && value["--worktree"] === undefined)
  refuse("--purge here is a worktree's: name it with --worktree (a project's purge is the Mac's: ./cli.sh desolate --purge <project>)");

// The two spellings of "everything". `--all` says so outright; the bare word
// only widens when no project of that name is there to be meant instead, which
// projects.ts decides for both this client and the runner behind the broker --
// two processes disagreeing about what `--stop all` did is not a thing to risk.
const stopsEverything =
  op === "stop" && (modifier.has("--all") || meansEveryTarget(WORKSPACES, rest[0]));
/** The op as it was spelled, for saying what refused a project. */
const spelling = op === "list" ? "--list" : `--stop ${modifier.has("--all") ? "--all" : EVERY_TARGET}`;
/** Positionals the global op did not account for. The bare word IS the op. */
const unaccountedFor = stopsEverything ? rest.filter((word) => word !== EVERY_TARGET) : rest;

let request: Record<string, unknown>;
if (op === "dinds") {
  if (rest.length || worktree !== undefined) refuse("--dinds acts on every dind, so it takes no project");
  request = { op: "dinds" };
} else if (op === "list" || stopsEverything) {
  if (unaccountedFor.length)
    refuse(`${spelling} acts on every target, so it takes no project`,
           `got '${unaccountedFor.join(" ")}'`);
  if (worktree !== undefined) refuse(`${spelling} takes no worktree`);
  request = { op: op === "list" ? "list" : "stop-all", ...(modifier.has("--json") && op === "list" ? { json: true } : {}) };
} else {
  if (rest.length !== 1) {
    console.error(rest.length === 0
      ? `desolate: '${op}' needs a project name`
      : `desolate: '${op}' takes ONE project, got ${rest.length}: ${rest.join(" ")}`);
    usage(1);
  }
  request = { op, project: rest[0], worktree, ...(move ? { move } : {}), ...(modifier.has("--json") ? { json: true } : {}) };
}

// Created before the broker is asked to start it -- by the broker as well, in
// a request of its own, so a refusal to create says so rather than reading as
// a missing worktree.
const created = worktree !== undefined && (op === "start" || op === "rebuild")
  ? ensureWorktree(String(rest[0]), worktree, value["--branch"])
  : Promise.resolve(0);

created
  .then((code) => (code === 0 ? ask(request) : code))
  .then((code) => process.exit(code));
