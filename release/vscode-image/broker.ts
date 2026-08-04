/* 
The ONLY path from the vscode editor to the inner Docker daemon.

Runs in the orchestrator container (which holds /run/inner/docker.sock).
Listens on a unix socket shared with the vscode container and accepts a
FIXED vocabulary of requests (see `Request` type below). Enforces our
policy on a snapshotted ("frozen") devcontainer config.
*/
/// <reference types="node" />
import { spawn } from "node:child_process";
import {
  chmodSync,
  realpathSync,
  statSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { resolveSpec } from "./devcontainer.ts";
import {
  snapshot,
  initDirectory as initSnapshotDirectory,
} from "./snapshot.ts";
import {
  list as listProjects,
  validName,
  volumeNamespace,
} from "./projects.ts";
import { enforcePolicy, PolicyError } from "./policy.ts";
import type { Flags } from "./args.ts";
import { identity, noop } from "./utils.ts";

type Config = {
  workspaces: string;
  /** Only its DIRECTORY is shared with the vscode container; nothing else is. */
  broker: string;
  /** desolate.ts (typically) -- the only program this file ever spawns. */
  runner: string;
  /**
   * Where devcontainer.json snapshots ("specs") are stored.
   *
   * These must live on the orchestrator's OWN filesystem.
   * Deliberately not under /workspaces and not in any volume shared with vscode.
   * The whole point is that the editor cannot reach the copy we validated.
   */
  specs: string;
};

type EnvironmentVariable = `DESOLATE_${Uppercase<keyof Config>}`;

const environment = {
  key: <T extends keyof Config>(key: T): EnvironmentVariable =>
    `DESOLATE_${key.toUpperCase() as Uppercase<T>}`,
  variable: (key: keyof Config) => process.env[environment.key(key)],
  tryOverride: (config: Config): Readonly<Config> => {
    let key: keyof Config;
    for (key in config) config[key] = environment.variable(key) ?? config[key];
    return config;
  },
};

/** Every path is overridable, so the whole broker can be pointed at a
 *  throwaway workspace and a stub runner. Nothing sets these in production. */
const config = environment.tryOverride({
  workspaces: "/workspaces",
  broker: "/run/broker/desolate.sock",
  runner: "/usr/local/lib/desolate/desolate.ts",
  specs: "/tmp/desolate-specs",
});

const operations = ["start", "rebuild", "stop", "ports", "list"] as const;
type Operation = (typeof operations)[number];

type Request = {
  [op in Operation]: op extends "list"
    ? { op: op }
    : { op: op; project: string };
}[Operation];

const request = {
  max: {
    /**
     * ~20x the largest well-formed request. Checked BOTH while buffering and on
     * the extracted line, and neither subsumes the other: without the first, a
     * client that never sends a newline exhausts the ORCHESTRATOR's memory;
     * without the second, one chunk can arrive with its newline already past the
     * limit. */
    bytes: 4096,
    /** Each start spawns a devcontainer CLI; the editor can call as fast as it likes. */
    concurrent: 4,
  } as const,
  inflight: 0,
  is: (query: unknown): query is Request =>
    query !== null &&
    typeof query === "object" &&
    "op" in query &&
    typeof query.op === "string" &&
    operations.includes(query["op"] as Operation) &&
    (query.op === "list" ||
      ("project" in query && typeof query.project === "string")),
};

/**
 * Project must be a plain name (one or two segments) AND resolve to exactly
 * that path under /workspaces -- the realpath comparison is what stops a
 * legally-named symlink pointing anywhere it likes.
 */
const validate = (project: string): string => {
  if (!validName(project)) throw new Error("invalid project name");

  if (!volumeNamespace.supports(project))
    throw new Error(
      `project name cannot contain "__" (double underscore): it is how ` +
        `"/" is encoded into docker object names, so 'a/b' and 'a__b' ` +
        `would claim the same volume namespace`,
    );

  let real: string;

  try {
    real = realpathSync(join(config.workspaces, project));
  } catch {
    throw new Error("project is missing");
  }

  if (real !== join(realpathSync(config.workspaces), project))
    throw new Error(
      "project must resolve to that exact path under /workspaces",
    );

  if (!statSync(real).isDirectory())
    throw new Error("project is not a directory");
  return project;
};

type Send = (payload: string | Record<string, any>) => void;

const desolate = (validated: string, flags: Flags[], send: Send) =>
  new Promise<number>((resolve) => {
    const { env } = process;
    const child = spawn(
      "tsx",
      [config.runner, ...flags.flatMap(identity), validated],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const relay = (buf: Buffer) => {
      for (const line of buf.toString().split("\n")) {
        if (line.trim()) send(JSON.stringify({ log: line }));
      }
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    child.on("close", (code) => resolve(code ?? 1));
  });

async function handle(req: unknown, send: Send) {
  if (!request.is(req))
    throw new Error(`cannot process request: unknown shape`);

  if (request.inflight >= request.max.concurrent)
    throw new Error(
      `too many operations in flight (max ${request.max.concurrent}); retry shortly`,
    );

  request.inflight++;
  try {
    if (req.op === "list")
      return send({ ok: true, projects: listProjects(config.workspaces) });

    const validated = validate(req.project);
    let flags: Flags[];
    switch (req.op) {
      case "start":
      case "rebuild": {
        const configPath = snapshot(validated, config);
        const workspace = join(config.workspaces, validated);
        const resolved = resolveSpec(workspace, configPath);
        const projects = listProjects(config.workspaces);
        enforcePolicy(validated, resolved, config.workspaces, projects);
        flags = [["--config", configPath]];
        if (req.op === "rebuild") flags.push("--rebuild");
        break;
      }
      case "stop":
      case "ports":
        flags = [`--${req.op}`];
        break;
    }

    const code = await desolate(validated, flags, send);
    send({ ok: code === 0, exit: code });
  } finally {
    request.inflight--;
  }
}

mkdirSync(dirname(config.broker), { recursive: true });
initSnapshotDirectory(config.specs);

try {
  unlinkSync(config.broker);
} /* no stale socket */ catch {}

createServer((connection) => {
  let buffer = "";
  let handled = false;

  const send = Object.assign(
    ((payload) => {
      const line =
        typeof payload === "string" ? payload : JSON.stringify(payload);
      if (connection.writable) connection.write(line + "\n");
    }) satisfies Send,
    {
      error: (error: string, kind?: "policy" | "error") =>
        send({ ok: false, error, ...(kind ? { kind } : {}) }),
    },
  ) satisfies Send;

  const error = (...params: Parameters<(typeof send)["error"]>) => {
    send.error(...params);
    connection.end();
  };

  connection.on("data", async (chunk) => {
    if (handled) return; // one request per connection
    buffer += chunk.toString();
    const index = buffer.indexOf("\n");
    if (index < 0) {
      if (buffer.length > request.max.bytes) error("request too large");
      return;
    }
    const line = buffer.slice(0, index).trim();
    handled = true;

    if (!line) return connection.end();
    if (line.length > request.max.bytes) return error("request too large");

    try {
      await handle(JSON.parse(line), send);
    } catch (err: any) {
      const kind = err instanceof PolicyError ? "policy" : "error";
      send.error(String(err?.message ?? err), kind);
    }
    connection.end();
  });
  connection.on("error", noop /* client vanished */);
}).listen(config.broker, () => {
  /** Neither half is the default -- node builds the socket from the umask.
   *  GROUP WRITE is what lets the editor connect at all (connecting to a unix
   *  socket needs write permission, and 0755 grants the group only r-x); no
   *  WORLD so a umask of 0 cannot silently open it to every uid. */
  const socketPermissions = 0o660;
  chmodSync(config.broker, socketPermissions);
  const log = (msg: string) => console.log(`broker: ${msg}`);
  log(`listening on ${config.broker}`);
  log(`ops = ${operations.join("|")} (policy enforced on start+rebuild)`);
  log(`spec snapshots in ${config.specs} (orchestrator-private)`);
});
