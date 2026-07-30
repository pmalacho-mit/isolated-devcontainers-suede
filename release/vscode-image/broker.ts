// broker.ts -- the ONLY path from the editor to the inner Docker daemon.
//
// Runs in the orchestrator container (which holds /run/inner/docker.sock).
// Listens on a unix socket shared with the editor container and accepts a
// FIXED vocabulary of requests:
//
//   {"op":"start","project":"myapp"}
//   {"op":"stop","project":"myapp"}
//   {"op":"ports","project":"myapp"}
//   {"op":"list"}
//
// Anything else is rejected. The editor therefore cannot create arbitrary
// containers, mount arbitrary volumes, or exec into siblings even if a
// malicious extension owns it completely.
//
// WHY THE POLICY CHECK MATTERS (this is the load-bearing part):
// the editor can EDIT /workspaces/<proj>/.devcontainer/devcontainer.json. If
// the broker started whatever that file said, a malicious extension could add
//    "mounts": ["source=otherproject-secrets,target=/steal,type=volume"]
// to its own project, ask us to start it, and read another project's secrets
// from inside a container it legitimately controls. A narrow op vocabulary
// alone would be theater. So before starting anything we validate the SPEC.
//
// Three things make that validation sound; all three were added after each was
// shown to be exploitable in its absence (tests/unit/broker keeps a regression
// case for every one):
//
//   * GROUND TRUTH. We do not parse devcontainer.json ourselves and hope our
//     parser agrees with the CLI's. We ask the CLI (`read-configuration
//     --include-merged-configuration`) and enforce on what it reports. That
//     closes both the JSONC-divergence bypass and the feature bypass, since
//     mergedConfiguration is where a feature's privileged/capAdd/mounts land.
//
//   * SNAPSHOT. The validated spec is copied into a directory only the
//     orchestrator can write, and the container is started from THAT copy via
//     --override-config. Without this the editor could swap the file between
//     the check and the start (TOCTOU) and the check would be decorative.
//
//   * FAIL CLOSED. Anything we cannot resolve, parse or classify is refused.

import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import { enforcePolicy, parseJsonc, PolicyError, type ResolvedSpec } from "./policy.ts";

// Overridable so tests/integration/broker can drive the REAL broker against a
// throwaway workspace and a stub runner. Nothing sets these in production.
const WORKSPACES = process.env.DESOLATE_WORKSPACES ?? "/workspaces";
const SOCKET = process.env.DESOLATE_BROKER ?? "/run/broker/desolate.sock";
const RUNNER = process.env.DESOLATE_RUNNER ?? "/usr/local/lib/desolate/desolate.ts";

// Snapshots live on the orchestrator's OWN filesystem. Deliberately not under
// /workspaces and not in any volume shared with the editor -- the whole point
// is that the editor cannot reach the copy we validated.
const SPEC_DIR = process.env.DESOLATE_SPEC_DIR ?? "/tmp/desolate-specs";

// One start at a time per project, and a ceiling overall: the editor can call
// as fast as it likes, and each start spawns a devcontainer CLI.
const MAX_CONCURRENT = 4;
let inFlight = 0;

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------
// One path segment. Must START with alphanumeric, which is what rules out "..",
// ".", hidden dirs and anything beginning with a dash.
const SEGMENT = "[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}";
// A project is either a direct child of /workspaces, or ONE level deeper so a
// repo can be scoped by its owner: `pmalacho-mit/typescript2mermaid-suede`.
// Exactly one optional slash -- deeper nesting is not a project.
const PROJECT_RE = new RegExp(`^${SEGMENT}(?:/${SEGMENT})?$`);

/** Project must be a plain name (one or two segments) AND resolve to exactly
 *  that path under /workspaces.
 *
 *  The realpath comparison is the load-bearing half: the regex already forbids
 *  "..", but a SYMLINK named legally could still point anywhere. Comparing the
 *  resolved path against the resolved workspaces root plus the name closes
 *  that, and does so identically at either depth -- the old `dirname(real) ===
 *  root` test would have needed a second case and is easy to get subtly wrong. */
function validateProject(name: unknown): string {
  if (typeof name !== "string" || !PROJECT_RE.test(name)) {
    throw new Error("invalid project name");
  }
  const real = fs.realpathSync(path.join(WORKSPACES, name));   // throws if missing
  if (real !== path.join(fs.realpathSync(WORKSPACES), name)) {
    throw new Error("project must resolve to that exact path under /workspaces");
  }
  if (!fs.statSync(real).isDirectory()) throw new Error("project is not a directory");
  return name;
}

/** Every project directory under /workspaces.
 *
 *  Serves the `list` op AND the volume-namespace rule in policy.ts: a project
 *  owns `<project>-*`, but that pattern also matches a LONGER project's name
 *  ('web' matching 'web-api-secrets'), so the policy has to know who else
 *  exists to award each volume to the longest claim. */
function hasDevcontainer(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".devcontainer", "devcontainer.json"))
      || fs.existsSync(path.join(dir, ".devcontainer.json"));
}

function listProjects(): string[] {
  const out: string[] = [];
  let top: fs.Dirent[];
  try { top = fs.readdirSync(WORKSPACES, { withFileTypes: true }); }
  catch { return []; }   // unreadable /workspaces: the prefix rule alone still applies

  for (const e of top) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dir = path.join(WORKSPACES, e.name);
    out.push(e.name);
    // Descend only into directories that are NOT themselves projects. An owner
    // directory (`pmalacho-mit/`) holds projects; a project directory holds
    // `src/`, `tests/` and so on, which are not projects and must not be listed
    // as siblings -- doing so would hand them a volume namespace.
    if (hasDevcontainer(dir)) continue;
    try {
      for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
        if (sub.isDirectory() && !sub.name.startsWith(".")) out.push(`${e.name}/${sub.name}`);
      }
    } catch { /* unreadable owner dir */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snapshot: freeze the spec where the editor cannot reach it
// ---------------------------------------------------------------------------
/** Copy the project's devcontainer config into SPEC_DIR and return the path to
 *  the snapshotted devcontainer.json.
 *
 *  The whole .devcontainer DIRECTORY is copied, not just the json, because a
 *  config may reference local features ("./myfeature") whose metadata carries
 *  privilege of its own -- snapshotting only the json would leave those
 *  swappable after validation. */
function snapshotSpec(project: string): string {
  const dir = path.join(WORKSPACES, project);
  const dotDir = path.join(dir, ".devcontainer");
  const flat = path.join(dir, ".devcontainer.json");

  const dest = path.join(SPEC_DIR, project);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });

  if (fs.existsSync(path.join(dotDir, "devcontainer.json"))) {
    // cpSync with dereference:false keeps symlinks as symlinks; we want the
    // opposite -- a symlink out of the project would still point at live,
    // editor-writable state after the copy.
    fs.cpSync(dotDir, dest, { recursive: true, dereference: true });
    const file = path.join(dest, "devcontainer.json");
    if (!fs.existsSync(file)) throw new Error("no devcontainer.json in project");
    return file;
  }
  if (fs.existsSync(flat)) {
    fs.copyFileSync(flat, path.join(dest, "devcontainer.json"));
    return path.join(dest, "devcontainer.json");
  }
  throw new Error("no devcontainer.json in project");
}

// ---------------------------------------------------------------------------
// Ground truth: what the devcontainer CLI itself thinks this project is
// ---------------------------------------------------------------------------
/** Ask the CLI to resolve the (snapshotted) config, features merged.
 *
 *  Using the CLI's answer rather than our own parse is the point: any
 *  disagreement between "what the policy saw" and "what gets started" is a
 *  bypass, and the only way to have none is to ask the thing that starts it. */
function resolveSpec(project: string, configPath: string): ResolvedSpec {
  const dir = path.join(WORKSPACES, project);
  let stdout: string;
  try {
    stdout = execFileSync("devcontainer", [
      "read-configuration",
      "--include-merged-configuration",
      "--workspace-folder", dir,
      "--override-config", configPath,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  } catch (err: any) {
    // Fail closed: if we cannot resolve it, we do not start it.
    const detail = String(err?.stderr || err?.stdout || err?.message || err).slice(-400);
    throw new Error(`could not resolve devcontainer.json (refusing to start): ${detail}`);
  }

  // The CLI interleaves progress lines with its JSON result; take the last
  // line that parses and carries a configuration.
  //
  // BOTH keys are required. Accepting a result with only `configuration` was a
  // fail-open: enforcePolicy would run, succeed, and never see a single
  // feature-injected privileged/capAdd/securityOpt/mount -- the E3 escape class,
  // silently un-checked. mergedConfiguration is also the only thing that
  // normalises types (a string `"privileged": "true"` arrives as a real boolean),
  // so losing it re-opens that bypass too. It is not optional to this policy, so
  // it is not optional here: a result without it means the CLI's contract changed
  // under us, and the right response to that is to stop, not to approve a spec
  // we can only partly see.
  for (const line of stdout.split("\n").reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed?.configuration && parsed?.mergedConfiguration) return parsed as ResolvedSpec;
    } catch { /* not the result line */ }
  }
  throw new Error(
    "devcontainer read-configuration produced no result carrying BOTH " +
    "configuration and mergedConfiguration (refusing to start). The merged view " +
    "is where a feature's privileged/capAdd/mounts appear, so without it the " +
    "policy cannot see what this spec actually asks for.");
}

/** Defence in depth: our own parse of the snapshot must also succeed and must
 *  agree with the CLI on the keys the policy cares about. A disagreement means
 *  one of the two parsers is wrong, and we do not get to guess which. */
function crossCheckParse(configPath: string, spec: ResolvedSpec): void {
  let own: any;
  try { own = parseJsonc(fs.readFileSync(configPath, "utf8")); }
  catch (err: any) { throw new Error(`devcontainer.json is not parseable: ${err?.message ?? err}`); }

  const cli = spec.configuration ?? {};

  // PRESENCE and SHAPE, not exact values.
  //
  // Comparing values was wrong, and wrong in a way that refused ordinary
  // projects: the CLI performs VARIABLE SUBSTITUTION on .configuration, so
  //   "mounts": ["source=${localWorkspaceFolderBasename}-node_modules,..."]
  // -- the standard node_modules idiom, straight out of Microsoft's docs --
  // arrives as "source=myrepo-node_modules,...". Our parse of the file keeps
  // the variables, the strings differ, and the start was refused with a message
  // blaming comments. Nothing about the file was wrong.
  //
  // What this tripwire is actually for is the E4 escape: a key VISIBLE to the
  // CLI but INVISIBLE to our parser (or vice versa), because the two disagree
  // about where a comment or string ends. Presence catches that, and array
  // length catches an entry smuggled into one view and not the other --
  // neither of which substitution can change.
  const shape = (v: any): string =>
    Array.isArray(v) ? `array[${v.length}]` : v === null ? "null" : typeof v;

  for (const key of ["mounts", "runArgs", "workspaceMount", "appPort",
                     "dockerComposeFile", "initializeCommand", "features", "privileged"]) {
    const inOwn = own[key] !== undefined;
    const inCli = cli[key] !== undefined;
    if (inOwn !== inCli) {
      throw new Error(
        `"${key}" is visible to ${inCli ? "the devcontainer CLI" : "our parser"} ` +
        `but not to ${inCli ? "our parser" : "the devcontainer CLI"} -- refusing to ` +
        `start. Two JSONC parsers reading the same file differently is how a key ` +
        `gets past the policy, so this is never tolerated. Simplify the comments ` +
        `and escape sequences around "${key}" and retry.`);
    }
    if (!inOwn) continue;
    if (shape(own[key]) !== shape(cli[key])) {
      throw new Error(
        `"${key}" has a different shape for each parser (${shape(own[key])} vs ` +
        `${shape(cli[key])}) -- refusing to start. Values may legitimately differ ` +
        `(the CLI substitutes \${...} variables), but the structure may not.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Executing the (now-validated) request
// ---------------------------------------------------------------------------
function runDesolate(args: string[], send: (line: string) => void): Promise<number> {
  return new Promise(resolve => {
    const child = spawn("tsx", [RUNNER, ...args], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const relay = (buf: Buffer) => {
      for (const line of buf.toString().split("\n")) {
        if (line.trim()) send(JSON.stringify({ log: line }));
      }
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    child.on("close", code => resolve(code ?? 1));
  });
}

async function handle(req: any, send: (line: string) => void): Promise<void> {
  const op = req?.op;
  if (op === "list") {
    send(JSON.stringify({ ok: true, projects: listProjects() }));
    return;
  }

  const project = validateProject(req?.project);
  let args: string[];
  switch (op) {
    case "start":
    case "rebuild": {
      // ---- the load-bearing sequence: snapshot, resolve, enforce, start ----
      // `rebuild` MUST share this path, not shortcut it. It is the op most
      // likely to be reached for right after editing devcontainer.json, i.e.
      // exactly when the spec is newly hostile -- enforcing the old snapshot,
      // or none, would make "I changed the spec" the way around the policy.
      const configPath = snapshotSpec(project);
      const spec = resolveSpec(project, configPath);
      crossCheckParse(configPath, spec);
      // The sibling list settles volume-namespace collisions: '<project>-*'
      // also matches a longer project's name, so the policy needs to know who
      // else exists to award the volume to the longest claim.
      enforcePolicy(project, spec, { workspaces: WORKSPACES, projects: listProjects() });
      args = ["--config", configPath, ...(op === "rebuild" ? ["--rebuild"] : []), project];
      break;
    }
    case "stop":  args = ["--stop", project]; break;
    case "ports": args = ["--ports", project]; break;
    default: throw new Error(`unknown op '${op}' (start|rebuild|stop|ports|list)`);
  }

  if (inFlight >= MAX_CONCURRENT) {
    throw new Error(`too many operations in flight (max ${MAX_CONCURRENT}); retry shortly`);
  }
  inFlight++;
  try {
    const code = await runDesolate(args, send);
    send(JSON.stringify({ ok: code === 0, exit: code }));
  } finally {
    inFlight--;
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
fs.mkdirSync(path.dirname(SOCKET), { recursive: true });
fs.rmSync(SPEC_DIR, { recursive: true, force: true });
fs.mkdirSync(SPEC_DIR, { recursive: true, mode: 0o700 });
try { fs.unlinkSync(SOCKET); } catch { /* no stale socket */ }

const server = net.createServer(conn => {
  let buffer = "";
  let handled = false;
  const send = (line: string) => { if (conn.writable) conn.write(line + "\n"); };

  conn.on("data", async chunk => {
    if (handled) return;                       // one request per connection
    buffer += chunk.toString();
    const idx = buffer.indexOf("\n");
    if (idx < 0) {
      if (buffer.length > 4096) { send(JSON.stringify({ ok: false, error: "request too large" })); conn.end(); }
      return;
    }
    const line = buffer.slice(0, idx).trim();
    handled = true;
    if (!line) { conn.end(); return; }
    if (line.length > 4096) {
      send(JSON.stringify({ ok: false, error: "request too large" })); conn.end(); return;
    }
    try {
      await handle(JSON.parse(line), send);
    } catch (err: any) {
      const kind = err instanceof PolicyError ? "policy" : "error";
      send(JSON.stringify({ ok: false, kind, error: String(err?.message ?? err) }));
    }
    conn.end();
  });
  conn.on("error", () => { /* client vanished */ });
});

server.listen(SOCKET, () => {
  fs.chmodSync(SOCKET, 0o660);
  console.log(`broker: listening on ${SOCKET}`);
  console.log("broker: ops = start|rebuild|stop|ports|list (spec policy enforced on start+rebuild)");
  console.log(`broker: spec snapshots in ${SPEC_DIR} (orchestrator-private)`);
});
