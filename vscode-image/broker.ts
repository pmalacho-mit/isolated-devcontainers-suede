/* 
broker.ts -- the ONLY path from the vscode editor to the inner Docker daemon.

Runs in the orchestrator container (which holds /run/inner/docker.sock).
Listens on a unix socket shared with the vscode container and accepts a
FIXED vocabulary of requests (see `Request` type below).
Anything else is rejected. 

In addition to the narrow `op` vocabulary, a policy check takes place
on the project's devcontainer.json file. This is necessary as the editor
can freely edit any devcontainer.json file, and if the broker started whatever
that file said, a malicious extension could inject an attack into any project
by modifying its (or its siblings') devcontainer.json file(s).

The editor therefore cannot create arbitrary containers, mount arbitrary volumes,
or exec into siblings even if a malicious extension owns it completely.

Four things make that validation sound:

  - GROUND TRUTH. We do not parse devcontainer.json ourselves and hope our
    parser agrees with the CLI's. We ask the CLI (`read-configuration
    --include-merged-configuration`) and enforce on what it reports.

  - SNAPSHOT. The validated spec is copied into a directory only the
    orchestrator can write, and the container is started from THAT copy via
    --override-config. Without this the editor could swap the file between
    the check and the start (i.e., a TOCTOU attack).

  - FAIL CLOSED. Anything we cannot resolve, parse or classify is refused.
*/

import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  realpathSync,
  statSync,
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { resolveSpec } from "./devcontainer.ts";
import { list as listProjects, volumeNamespace } from "./projects.ts";
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

/**
 * Overridable via environment so tests can drive
 * the REAL broker against a throwaway workspace and a stub runner.
 * Nothing should set these in production.
 */
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

const project = {
  validate: (() => {
    /** Longest single path segment of a project name may be (in characters).
     *
     * Two `maxSegment`s (one for owner, one for repo) plus a slash is therefore the
     * ceiling for a whole project name.
     */
    const maxSegment = 64;
    /**
     * Single path segment of a project.
     *
     * Must START with alphanumeric, to rule out "..", ".", hidden dirs,
     * and anything beginning with a dash.
     */
    const segment = `[a-zA-Z0-9][a-zA-Z0-9._-]{0,${maxSegment - 1}}`;
    /**
     * Match a project which is either a direct child of /workspaces,
     * or a single level deeper (so a repo can be scoped by its owner).
     */
    const pattern = new RegExp(`^${segment}(?:/${segment})?$`);
    return Object.assign(
      /**
       * Project must be a plain name (one or two segments) AND resolve to exactly
       * that path under /workspaces.
       *
       * The realpath comparison mitigates the risk that a symlink named legally
       * could still point anywhere.
       */
      (query: unknown): string => {
        if (!project.validate.syntax(query))
          throw new Error("invalid project name");

        if (!volumeNamespace.supports(query))
          throw new Error(
            `project name cannot contain "__" (double underscore): it is how ` +
              `"/" is encoded into docker object names, so 'a/b' and 'a__b' ` +
              `would claim the same volume namespace`,
          );

        let real: string;

        try {
          real = realpathSync(join(config.workspaces, query));
        } catch {
          throw new Error("project is missing");
        }

        if (real !== join(realpathSync(config.workspaces), query))
          throw new Error(
            "project must resolve to that exact path under /workspaces",
          );

        if (!statSync(real).isDirectory())
          throw new Error("project is not a directory");
        return query;
      },
      {
        syntax: (query: unknown): query is string =>
          typeof query === "string" && pattern.test(query),
      },
    );
  })(),
};

const spec = {
  /**
   * Owner only. The snapshot IS the TOCTOU defense -- the copy the policy
   * validated and the container starts from -- so anything able to write it can
   * swap a validated spec for an unvalidated one after the check has passed.
   */
  directoryPermissions: 0o700 as const,
  /**
   * Freeze the devcontainer spec where the editor cannot reach it, and return
   * the path to the snapshotted devcontainer.json.
   */
  snapshot: (project: string) => {
    const base = join(config.workspaces, project);
    const dotDir = join(base, ".devcontainer");
    const flat = join(base, ".devcontainer.json");

    const dest = join(config.specs, project);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true, mode: spec.directoryPermissions });

    if (existsSync(join(dotDir, "devcontainer.json"))) {
      // The whole directory: the CLI resolves `build.dockerfile` and
      // `build.context` relative to the config file. `dereference` because a
      // symlink out of the project would still point at editor-writable state.
      cpSync(dotDir, dest, { recursive: true, dereference: true });
      const file = join(dest, "devcontainer.json");
      if (!existsSync(file)) throw new Error("no devcontainer.json in project");
      return file;
    }
    if (existsSync(flat)) {
      copyFileSync(flat, join(dest, "devcontainer.json"));
      return join(dest, "devcontainer.json");
    }
    throw new Error("no devcontainer.json in project");
  },
};

type Send = (line: string) => void;

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
      return send(
        JSON.stringify({ ok: true, projects: listProjects(config.workspaces) }),
      );

    const validated = project.validate(req.project);
    let flags: Flags[];
    switch (req.op) {
      case "start":
      case "rebuild": {
        const configPath = spec.snapshot(validated);
        const workspace = join(config.workspaces, validated);
        enforcePolicy(
          validated,
          resolveSpec(workspace, configPath),
          config.workspaces,
          listProjects(config.workspaces),
        );
        flags = [
          ["--config", configPath],
          ...(req.op === "rebuild" ? (["--rebuild"] as const) : []),
        ];
        break;
      }
      case "stop":
      case "ports":
        flags = [`--${req.op}`] as const;
        break;
    }

    const code = await desolate(validated, flags, send);
    send(JSON.stringify({ ok: code === 0, exit: code }));
  } finally {
    request.inflight--;
  }
}

mkdirSync(dirname(config.broker), { recursive: true });

// Wipe rather than reuse: a spec left by a previous run was validated against a
// /workspaces that may since have gained or lost projects, which changes who
// owns a volume namespace.
rmSync(config.specs, { recursive: true, force: true });
mkdirSync(config.specs, { recursive: true, mode: spec.directoryPermissions });

try {
  unlinkSync(config.broker);
} /* no stale socket */ catch {}

createServer((connection) => {
  let buffer = "";
  let handled = false;

  const send = Object.assign(
    (line: string) => {
      if (connection.writable) connection.write(line + "\n");
    },
    {
      error: (error: string, kind?: "policy" | "error") =>
        send(JSON.stringify({ ok: false, error, ...(kind ? { kind } : {}) })),
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
