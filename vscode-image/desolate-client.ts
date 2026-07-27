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

function usage(): never {
  console.log("usage: desolate [--stop|--ports|--rebuild] <project>");
  console.log("       desolate --list");
  console.log("");
  console.log("  --rebuild  recreate the container from the current devcontainer.json.");
  console.log("             Plain start REUSES an existing container and does not");
  console.log("             re-read the spec, so edits need this to take effect.");
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") usage();

let request: Record<string, unknown>;
if (argv[0] === "--list") {
  request = { op: "list" };
} else if (argv[0] === "--stop" || argv[0] === "--ports" || argv[0] === "--rebuild") {
  const project = argv[1];
  if (!project) usage();
  const op = { "--stop": "stop", "--ports": "ports", "--rebuild": "rebuild" }[argv[0]]!;
  request = { op, project };
} else {
  request = { op: "start", project: argv[0] };
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
