// desolate-client.ts -- the `desolate` command inside the EDITOR container.
//
// The editor has no Docker access by design. This client sends a request to
// the orchestrator's broker over a unix socket and streams back its output, so
// the workflow feels identical:
//
//   desolate myproject          start it, print URLs
//   desolate --stop myproject
//   desolate --ports myproject
//   desolate --list
//
// The broker validates both the project name and the project's
// devcontainer.json spec before acting -- see broker.ts.

import * as net from "node:net";

const SOCKET = process.env.DESOLATE_BROKER ?? "/run/broker/desolate.sock";

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

/** `code` 0 when the user ASKED for help, 1 when we are rejecting a command
 *  line. Shells and scripts distinguish those; `desolate` used to exit 0 for
 *  both, so a malformed invocation looked like it worked. */
function usage(code = 0): never {
  const out = code === 0 ? console.log : console.error;
  out("usage: desolate [--stop|--ports|--rebuild] <project>");
  out("       desolate --list");
  out("");
  out("  --rebuild  recreate the container from the current devcontainer.json.");
  out("             Plain start REUSES an existing container and does not");
  out("             re-read the spec, so edits need this to take effect.");
  out("");
  out("  Flags may come before or after <project>; unknown flags are refused.");
  process.exit(code);
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
  "--list": "list", "--stop": "stop", "--ports": "ports", "--rebuild": "rebuild",
};

let op = "start";
const rest: string[] = [];
for (const a of argv) {
  if (a in OPS) {
    // Two ops in one command line is a mistake, not a precedence question.
    if (op !== "start") {
      console.error(`desolate: '${a}' conflicts with the operation already given`);
      process.exit(1);
    }
    op = OPS[a];
  } else if (a.startsWith("-")) {
    console.error(`desolate: unknown option '${a}'`);
    console.error(`         known: ${Object.keys(OPS).sort().join(" ")}`);
    console.error("         (to rebuild from an edited devcontainer.json: --rebuild)");
    process.exit(1);
  } else {
    rest.push(a);
  }
}

let request: Record<string, unknown>;
if (op === "list") {
  if (rest.length) { console.error("desolate: --list takes no project"); process.exit(1); }
  request = { op };
} else {
  if (rest.length !== 1) {
    console.error(rest.length === 0
      ? `desolate: '${op}' needs a project name`
      : `desolate: '${op}' takes ONE project, got ${rest.length}: ${rest.join(" ")}`);
    usage(1);
  }
  request = { op, project: rest[0] };
}

const conn = net.createConnection(SOCKET);
let exitCode = 0;
let buffer = "";

conn.on("connect", () => conn.write(JSON.stringify(request) + "\n"));

conn.on("data", chunk => {
  buffer += chunk.toString();
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { console.log(line); continue; }
    if (msg.log !== undefined) { console.log(msg.log); continue; }
    if (msg.projects !== undefined) { for (const p of msg.projects) console.log(`  ${p}`); }
    if (msg.error) { console.error(`desolate: ${msg.error}`); }
    if (msg.ok === false) exitCode = typeof msg.exit === "number" ? msg.exit : 1;
  }
});

conn.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
    console.error("desolate: cannot reach the orchestrator broker.");
    console.error(`         socket: ${SOCKET}`);
    console.error("         Is the stack up?  (on your Mac: ./cli.sh ps)");
  } else {
    console.error(`desolate: ${err.message}`);
  }
  process.exit(1);
});

conn.on("close", () => process.exit(exitCode));
