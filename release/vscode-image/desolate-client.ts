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
//   desolate --status [--json] [project]     each target's status (status.ts)
//   desolate --push [--worktree w] [--allow-default] project   its branch to GitHub (transfer.ts)
//   desolate --pull [--worktree w] project   GitHub's branches in, fast-forwarded
//   desolate --review [--worktree w] [--json] project   what a push would send (review.ts)
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
import { statusRows } from "./status.ts";
import { pull, push, TransferError } from "./transfer.ts";
import { describeReview, keepReview, parseReview, REVIEWED, reviewDirectory } from "./review.ts";

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
  out("       desolate --status [--json] [<project>]   each target's status (desolate-status, inside)");
  out("       desolate --stop all|--stop --all   stop every running target");
  out("       desolate --push [--worktree <name>] [--allow-default] <project>");
  out("                                          push its checked-out branch to its GitHub repository");
  out("       desolate --pull [--worktree <name>] [--fetch-only] <project>");
  out("                                          fetch that repository into origin/*, and fast-forward");
  out("       desolate --review [--worktree <name>] [--json] <project>");
  out("                                          what a push would send: its commits and files");
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

// Each target's status, read here: a file in its git dir the editor already
// sees (status.ts), so no broker, and nothing runs.
if (argv[0] === "--status") {
  const rest = argv.slice(1);
  const json = rest.includes("--json");
  const words = rest.filter((word) => word !== "--json");
  if (words.some((word) => word.startsWith("-")) || words.length > 1) refuse("usage: desolate --status [--json] [project]");
  const only = words[0]?.replace(/\/+$/, "").replace(new RegExp(`^${WORKSPACES}/`), "");
  const rows = statusRows(WORKSPACES, only);
  if (json) {
    console.log(JSON.stringify(rows));
  } else if (!rows.some((row) => row.status)) {
    console.log(only ? `no status for ${only}` : "no target has a status");
  } else {
    const shown = rows.filter((row) => row.status);
    const width = Math.max(...shown.map((row) => row.target.length));
    for (const { target, status } of shown)
      console.log(`  ${target.padEnd(width)}  ${status!.color.padEnd(6)}  ${status!.message}  (${status!.updated})`);
  }
  process.exit(0);
}

// Push and pull run git HERE, in a scratch repository that has nothing of the
// project's (transfer.ts) -- the project's half is asked of the broker. Never
// `git push`/`git pull` in a project from this editor: that is the project's
// own git, hooks and all, with every deploy key in reach.
if (argv[0] === "--push" || argv[0] === "--pull") {
  const which = argv[0];
  const words = argv.slice(1);
  let worktree: string | undefined, allowDefault = false, fetchOnly = false;
  const projects: string[] = [];
  while (words.length) {
    const word = words.shift()!;
    if (word === "--worktree") worktree = words.shift() || refuse("--worktree expects a name");
    else if (word === "--allow-default" && which === "--push") allowDefault = true;
    else if (word === "--fetch-only" && which === "--pull") fetchOnly = true;
    else if (word.startsWith("-")) refuse(`unknown option '${word}' for ${which}`);
    else projects.push(word.replace(/\/+$/, "").replace(new RegExp(`^${WORKSPACES}/`), ""));
  }
  if (projects.length !== 1) refuse(`usage: desolate ${which} [--worktree <name>]${which === "--push" ? " [--allow-default]" : ""} <project>`);
  (which === "--push" ? push(projects[0], { worktree, allowDefault }) : pull(projects[0], { worktree, fetchOnly }))
    .then((said) => { console.log(`desolate: ${said}`); process.exit(0); })
    .catch((err) => {
      if (!(err instanceof TransferError)) throw err;
      refuse(err.message);
    });
} else if (argv[0] === "--review") {
  // What a push would send, said by the target's sandbox (docker.ts
  // reviewScript) and read here: its records are kept from the terminal, and
  // each changed file's two sides are kept in this editor's cache for the
  // extension's diff view -- never written into the project.
  const words = argv.slice(1);
  let worktree: string | undefined, json = false;
  const projects: string[] = [];
  while (words.length) {
    const word = words.shift()!;
    if (word === "--worktree") worktree = words.shift() || refuse("--worktree expects a name");
    else if (word === "--json") json = true;
    else if (word.startsWith("-")) refuse(`unknown option '${word}' for --review`);
    else projects.push(word.replace(/\/+$/, "").replace(new RegExp(`^${WORKSPACES}/`), ""));
  }
  if (projects.length !== 1) refuse("usage: desolate --review [--worktree <name>] [--json] <project>");
  const said: string[] = [];
  ask({ op: "review", project: projects[0], ...(worktree ? { worktree } : {}) }, (line) => {
    if (line.startsWith(`${REVIEWED}\t`)) { said.push(line); return false; }
    if (json) console.error(line);
    return !json;
  }).then((code) => {
    const { review, blobs, ended } = parseReview(said);
    if (code !== 0 || !ended) refuse(`the review of ${projects[0]}${worktree ? `@${worktree}` : ""} did not finish (exit ${code})`);
    const kept = keepReview(review, blobs, reviewDirectory(projects[0], worktree));
    console.log(json ? JSON.stringify(kept) : describeReview(kept));
    process.exit(0);
  });
} else {

// Order-independent, and an unrecognised --flag is REFUSED rather than dropped.
// The old parsing only ever looked at argv[0], so `desolate myproj --rebuild`
// (or a typo like --build) silently became a plain start: you were told the
// project was ready, having asked for a rebuild that never happened. desolate.ts
// already refuses unknown options; this side has to agree, or the two disagree
// about what the same command line means.
const OPS: Record<string, string> = {
  "--list": "list", "--dinds": "dinds", "--stop": "stop", "--ports": "ports", "--rebuild": "rebuild",
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
}
