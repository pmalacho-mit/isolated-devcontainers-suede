// desolate -- open a project's devcontainer as a full browser IDE, with dynamic
// port allocation for dev servers.
//
//   desolate myproject           -> starts devcontainer + editor, prints URL map
//   desolate owner/myrepo        -> same, for a repo cloned under its owner
//   desolate --rebuild <project> -> recreate the container from the current spec
//   desolate --stop <project>    -> stop devcontainer and remove its relays
//   desolate --ports <project>   -> show current port map
//
// A project is a directory under /workspaces, either a direct child or ONE
// level deeper so repositories can be scoped by owner (`cli.sh repo add` clones
// to /workspaces/<owner>/<repo>). Docker object names cannot contain "/", so
// volumes, relay containers and state files use the encoded form from
// policy.ts: `owner/repo` -> `owner__repo`.
//
// Plain start REUSES an existing container: `devcontainer up` finds it by label
// and starts it without re-reading devcontainer.json. So editing the spec and
// restarting does NOT apply the edit -- that is what --rebuild is for, and a
// fingerprint of .devcontainer/ is kept so the mismatch is reported instead of
// silently ignored.
//
// Projects declare CONTAINER-side ports only, in devcontainer.json:
//
//   "customizations": { "desolate": { "ports": [5173] } }
//
// desolate allocates free host ports from the dind published range at start time,
// remembers each project's allocation (stable URLs across restarts), and
// forwards each port with a socat relay container on the inner daemon:
//
//   Mac 127.0.0.1:8081 -> dind:8081 (relay) -> <devcontainer-ip>:5173

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { parseJsonc, volumeNamespace } from "./policy.ts";

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------
const WORKSPACES = "/workspaces";

// Piping our output to `head`/`grep -q` closes stdout early; bash tools
// ignore the resulting SIGPIPE, Node crashes on EPIPE. Exit quietly instead.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const SERVER_SRC = "/server-dist";      // the pristine server; OVERLAY LOWER only
const SERVER_DST = "/vscode-server";    // where it lands in the devcontainer
const HELPER_IMAGE = "alpine:3";        // tiny, for volume setup + verification

/** The host-port range relays are allocated from.
 *
 *  This MUST equal the range dind publishes in docker-compose.yml
 *  (`127.0.0.1:MIN-MAX:MIN-MAX`). Both sides read the same
 *  DESOLATE_PORT_MIN/DESOLATE_PORT_MAX, so they cannot drift while compose is
 *  the source of truth -- but if they ever do, the widening direction is the
 *  one that hurts: a relay outside dind's published range binds perfectly well
 *  inside dind's netns and is simply unreachable from the Mac. The symptom is
 *  a probe timeout with nothing wrong in any log, which is why compose passes
 *  the variables rather than each side carrying its own default. */
function portRange(): { min: number; max: number } {
  const read = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535)
      die(`${name}='${raw}' is not a port number (1-65535)`);
    return n;
  };
  const min = read("DESOLATE_PORT_MIN", 8080);
  const max = read("DESOLATE_PORT_MAX", 8090);
  if (max < min)
    die(`DESOLATE_PORT_MIN=${min} is above DESOLATE_PORT_MAX=${max} -- empty range`);
  return { min, max };
}
const { min: PORT_MIN, max: PORT_MAX } = portRange();

const EDITOR_INTERNAL = 31580;          // editor's fixed in-container port
const RELAY_IMAGE = "alpine/socat";
const CA_DIR = "/desolate-ca";              // bind-mounted from the VM (public cert only)
const PROBE_HOST = process.env.DEVC_PROBE_HOST ?? "dind";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function die(msg: string): never {
  console.error(`desolate: ${msg}`);
  process.exit(1);
}

/** Run a command; return stdout. Throws on failure unless `allowFail`. */
function run(cmd: string, args: string[], allowFail = false): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch (err: any) {
    if (allowFail) return "";
    throw err;
  }
}

/** Run a command for its side effects; return the exit code instead of
 *  throwing. `quiet` drops stdout (e.g. the devcontainer CLI's JSON chatter)
 *  while keeping stderr visible for real errors. */
function runStatus(cmd: string, args: string[], quiet = false): number {
  try {
    execFileSync(cmd, args, { stdio: [ "ignore", quiet ? "ignore" : "inherit", "inherit" ] });
    return 0;
  } catch (err: any) {
    return err.status ?? 1;
  }
}

const lines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);

/** Blocking sleep (we are in a sequential CLI, not an event loop hot path). */
function sleepSync(ms: number): void {
  execFileSync("sleep", [String(ms / 1000)]);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
type Command = "run" | "stop" | "ports";

interface Args {
  command: Command;
  project: string;
  config: string;
  rebuild: boolean;
  noCache: boolean;
}

/** `--config <path>` names a devcontainer.json OUTSIDE the project tree.
 *
 *  The broker uses it to hand us the exact spec it validated, snapshotted onto
 *  the orchestrator's own filesystem. Every CLI call below is then made against
 *  that copy (`--override-config`), so nothing the editor writes to
 *  /workspaces between the check and the start can change what we launch.
 *  Empty when invoked directly from the Mac (`cli.sh desolate`), which is
 *  already a trusted path. */
function parseArgs(argv: string[]): Args {
  let command: Command = "run";
  let config = "";
  let rebuild = false;
  let noCache = false;
  const rest: string[] = [];

  // Order-independent, and unknown --flags are refused rather than silently
  // taken for the project name. The old positional parsing accepted
  // `desolate --rebiuld foo` as "start the project named --rebiuld".
  const queue = [...argv];
  while (queue.length) {
    const a = queue.shift()!;
    switch (a) {
      case "--config":   config = queue.shift() ?? ""; break;
      case "--stop":     command = "stop"; break;
      case "--ports":    command = "ports"; break;
      case "--rebuild":  rebuild = true; break;
      // A fresh image as well as a fresh container. Only useful when the
      // Dockerfile is unchanged but its inputs are not (apt/npm indexes) --
      // a changed Dockerfile already produces a new image tag.
      case "--no-cache": noCache = true; rebuild = true; break;
      default:
        if (a.startsWith("--")) die(`unknown option '${a}'\n${USAGE}`);
        rest.push(a);
    }
  }

  const raw = rest[0];
  if (!raw) die(USAGE);
  // A project is `name` or `owner/name` -- so NOT `.pop()`, which used to
  // collapse `owner/repo` to `repo` and open the wrong directory. Accept an
  // absolute path too, since tab-completion produces one.
  const project = raw
    .replace(/\/+$/, "")
    .replace(new RegExp(`^${WORKSPACES}/`), "");
  return { command, project, config, rebuild, noCache };
}

const USAGE =
  "usage: desolate [--config <path>] [--rebuild [--no-cache]] [--stop|--ports] <project>\n" +
  "       <project> is 'name' or 'owner/name', relative to /workspaces";

/** Extra CLI args pinning every devcontainer invocation to the frozen spec. */
function configArgs(config: string): string[] {
  return config ? ["--override-config", config] : [];
}

// ---------------------------------------------------------------------------
// Port map persistence: /workspaces/.desolate/<project>.ports
// Format: one "label hostPort" pair per line; label is "editor" or a
// container port number like "5173".
// ---------------------------------------------------------------------------
type PortMap = Map<string, number>;

function mapFilePath(project: string): string {
  return `${WORKSPACES}/.desolate/${volumeNamespace(project)}.ports`;
}

function loadPortMap(project: string): PortMap {
  const map: PortMap = new Map();
  try {
    for (const line of lines(fs.readFileSync(mapFilePath(project), "utf8"))) {
      const [label, port] = line.split(/\s+/);
      if (label && port) map.set(label, Number(port));
    }
  } catch { /* no saved map yet -- fine */ }
  return map;
}

function savePortMap(project: string, map: PortMap): void {
  fs.mkdirSync(`${WORKSPACES}/.desolate`, { recursive: true });
  const body = [...map].map(([label, port]) => `${label} ${port}`).join("\n");
  fs.writeFileSync(mapFilePath(project), body + "\n");
}

// ---------------------------------------------------------------------------
// Spec fingerprint: what the running container was actually built from.
//
// `devcontainer up` finds an existing container by label and STARTS it -- it
// does not re-read devcontainer.json and does not notice the spec changed.
// `desolate --stop` only stops the container, so the edit-stop-start cycle
// people naturally reach for silently gives them the old container back, with
// nothing said about why the change did not take.
//
// So: record what the spec looked like when the container was created, and
// compare on every start. Recreating is NOT automatic -- it destroys anything
// written inside the container outside /workspaces -- so this reports and
// hands over `--rebuild` rather than deciding for you.
// ---------------------------------------------------------------------------
function specFingerprint(dir: string, config: string): string {
  const parts: string[] = [];
  // Labels are RELATIVE. The broker's --override-config snapshot lives at a
  // fresh temp path on every call, so hashing absolute paths would make the
  // fingerprint differ every run and cry wolf on every start.
  const walk = (p: string, label: string): void => {
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { return; }   // absent contributes nothing
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p).sort()) walk(`${p}/${e}`, `${label}/${e}`);
    } else {
      try { parts.push(`${label}\0${fs.readFileSync(p, "utf8")}`); } catch { /* unreadable */ }
    }
  };
  // The whole .devcontainer/ tree, not just devcontainer.json: a Dockerfile or
  // postCreate script edit needs a rebuild exactly as much as a json edit does.
  walk(`${dir}/.devcontainer`, ".devcontainer");
  walk(`${dir}/.devcontainer.json`, ".devcontainer.json");
  if (config) walk(config, "override");
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// The editor server: a PER-PROJECT copy-on-write view, never a shared mount.
//
// Every devcontainer EXECUTES ${SERVER_DST}/bin/openvscode-server. Handing them
// all one mount of the same directory makes that a shared, writable, executed
// path: one project overwrites the binary, and every other project runs it as
// its own user on next start. A privileged project could do that even to a
// read-only bind -- MS_RDONLY is a per-mount flag, and CAP_SYS_ADMIN in dind's
// user namespace can `mount -o remount,rw` it away.
//
// So each project gets an overlayfs volume whose LOWER is the pristine server.
// overlayfs never writes down: modifications are copied up into that project's
// own upper. The lower is therefore protected by how the filesystem works
// rather than by a flag someone can clear, and the cost is ~8K per project
// instead of a full copy of the server tree.
//
// Verified viable on dind-under-sysbox by tests/probes/dind-overlay-volume.sh:
// dind's storage driver is overlayfs, but /var/lib/docker (where the upper
// lives) is ext4 -- overlayfs cannot be an upperdir, and this satisfies that.
//
// There is deliberately NO fallback to a shared mount. If the overlay cannot be
// built, `desolate` refuses to start the project.
// ---------------------------------------------------------------------------
interface OverlayMount {
  /** Short label; the volumes are `<project>-<name>` and `<project>-<name>-data`,
   *  both of which policy.ts already permits under its `<project>-*` rule. */
  name: string;
  /** The pristine directory on dind's filesystem -- the overlay LOWER. */
  lower: string;
  /** Where it appears inside the devcontainer. */
  target: string;
  /** Identity of the lower's contents. When this changes the view is rebuilt,
   *  so a file left in a project's upper can never shadow newer content below. */
  key: () => string;
  /** A path that must exist through the mount, proving it really mounted. */
  proof: string;
  /** Why this one matters, quoted verbatim when it cannot be built. */
  why: string;
}

const sha16 = (raw: string) => createHash("sha256").update(raw).digest("hex").slice(0, 16);

function readOrDie(path: string, hint: string): string {
  try { return fs.readFileSync(path, "utf8"); }
  catch { die(`cannot read ${path} -- ${hint}`); }
}

/** Everything a devcontainer receives from OUTSIDE its own project.
 *
 *  Both are shared, both are EXECUTED, and neither passes through the broker's
 *  mount policy -- desolate injects them. Handed over as plain binds they are
 *  the stack's sharpest cross-project edge: whoever can write one runs code in
 *  every other project. So each project gets its own overlay view instead. */
function overlayMounts(): OverlayMount[] {
  const mounts: OverlayMount[] = [{
    name: "vscode-server",
    lower: SERVER_SRC,
    target: SERVER_DST,
    proof: `${SERVER_DST}/bin/openvscode-server`,
    key: () => sha16(readOrDie(`${SERVER_SRC}/.seeded-version`,
      "the editor server is not seeded. volume-init populates it at stack start:\n" +
      "      docker logs desolate-volume-init")),
    why: `${SERVER_DST} is EXECUTED by every project. A shared writable copy would let\n` +
         `      any project overwrite the binary every other project runs.`,
  }];

  // Only when the proxy is installed; the stack works without it.
  if (fs.existsSync(`${CA_DIR}/ca.pem`)) {
    mounts.push({
      name: "desolate-ca",
      lower: CA_DIR,
      target: CA_DIR,
      proof: `${CA_DIR}/ca.pem`,
      key: () => sha16(readOrDie(`${CA_DIR}/ca.pem`, "the proxy CA is missing")),
      // Worse than the server, and less obvious: installProxyCa() runs
      // install-ca.sh with `docker exec -u 0` in EVERY devcontainer, and dind's
      // own entrypoint runs it too. Poisoning it once buys root execution in
      // every project and in the daemon that holds them all.
      why: `${CA_DIR}/install-ca.sh is executed AS ROOT in every devcontainer (and in\n` +
           `      dind's entrypoint). A shared writable copy would be root code execution\n` +
           `      across every project.`,
    });
  }
  return mounts;
}

/** Build (or reuse) one project's copy-on-write view of a shared directory.
 *  Returns the volume name; dies loudly rather than degrading to a shared mount. */
function ensureOverlayVolume(project: string, m: OverlayMount): string {
  // volumeNamespace, not the raw name: docker volume names cannot contain '/'
  // and a nested project has one. policy.ts checks project-declared volumes
  // against the SAME encoding, so a project can still mount its own.
  const ns   = volumeNamespace(project);
  const vol  = `${ns}-${m.name}`;
  const data = `${ns}-${m.name}-data`;
  const want = m.key();

  const have = run("docker", ["volume", "inspect", vol, "-f",
                              '{{index .Labels "desolate.overlay.key"}}'], true);
  if (have === want) return vol;
  if (have) console.log(`desolate: ${m.lower} changed -- rebuilding ${project}'s view of it`);

  // Both, together: the stale upper lives in the data volume, and keeping it is
  // exactly what invalidation exists to prevent.
  run("docker", ["volume", "rm", "-f", vol, data], true);

  const fail = (reason: string): never =>
    die(`could not build ${project}'s copy-on-write view of ${m.lower}: ${reason}.\n\n` +
        `      ${m.why}\n\n` +
        `      This is not optional and there is no fallback -- desolate refuses to start\n` +
        `      rather than quietly hand out a shared mount instead.\n\n` +
        `      Diagnose with:  ./tests/probes/dind-overlay-volume.sh`);

  if (runStatus("docker", ["volume", "create", data], true) !== 0)
    fail(`could not create the volume '${data}'`);

  // upper/ and work/ must EXIST before the overlay can mount, and only a
  // container can create them inside the volume.
  if (runStatus("docker", ["run", "--rm", "-v", `${data}:/d`, HELPER_IMAGE,
                           "sh", "-c", "mkdir -p /d/upper /d/work"], true) !== 0)
    fail(`could not prepare upper/work in '${data}' (is ${HELPER_IMAGE} pullable?)`);

  const mp = run("docker", ["volume", "inspect", data, "-f", "{{.Mountpoint}}"], true);
  if (!mp) fail(`could not resolve the mountpoint of '${data}'`);

  const opts = `lowerdir=${m.lower},upperdir=${mp}/upper,workdir=${mp}/work`;
  if (runStatus("docker", ["volume", "create", "--driver", "local",
                           "--opt", "type=overlay", "--opt", "device=overlay",
                           "--opt", `o=${opts}`,
                           "--label", `desolate.overlay.key=${want}`, vol], true) !== 0)
    fail(`the daemon refused the overlay options (${opts})`);

  // `docker volume create` is LAZY: it succeeds without mounting anything, so
  // the only real proof is a container that mounts it. Do that HERE, where the
  // failure can still be explained, rather than letting `devcontainer up` fail
  // later with a message about something else entirely.
  if (runStatus("docker", ["run", "--rm", "-v", `${vol}:${m.target}`, HELPER_IMAGE,
                           "test", "-e", m.proof], true) !== 0)
    fail("the overlay volume was created but could not be mounted");

  console.log(`desolate: built ${project}'s copy-on-write view of ${m.lower}`);
  return vol;
}

function specFilePath(project: string): string {
  return `${WORKSPACES}/.desolate/${volumeNamespace(project)}.spec`;
}

function loadSpecFingerprint(project: string): string {
  try { return fs.readFileSync(specFilePath(project), "utf8").trim(); } catch { return ""; }
}

function saveSpecFingerprint(project: string, fp: string): void {
  fs.mkdirSync(`${WORKSPACES}/.desolate`, { recursive: true });
  fs.writeFileSync(specFilePath(project), fp + "\n");
}

// ---------------------------------------------------------------------------
// Docker queries
// ---------------------------------------------------------------------------
/** Names of this project's relay containers (running or not). */
function ownRelayNames(project: string): string[] {
  return lines(run("docker", [
    "ps", "-a", "--filter", `label=desolate.relay=${project}`, "--format", "{{.Names}}",
  ], true));
}

/** Host ports currently published by ANY container on the inner daemon, mapped
 *  to the container holding each. The NAME is the part that matters: an
 *  exhausted range is only actionable if you can see which project to stop. */
function usedHostPorts(): Map<number, string> {
  const out = run("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"], true);
  const used = new Map<number, string>();
  for (const line of lines(out)) {
    const [name, ports = ""] = line.split("\t");
    for (const match of ports.matchAll(/:(\d+)->/g)) used.set(Number(match[1]), name);
  }
  return used;
}

/** True when the INNER daemon runs rootless (docker:dind-rootless).
 *  Rootless dockerd runs in a user namespace where the daemon user becomes
 *  namespace-root, so a container's uid 0 maps to the real uid 1000 that owns
 *  /workspaces, while a container's uid 1000 maps into the subuid range and
 *  CANNOT write it. Hence: run the editor as container-root under rootless.
 *  That "root" is not real root -- it is the unprivileged daemon user. */
function innerDaemonIsRootless(): boolean {
  const out = run("docker", ["info", "--format", "{{json .SecurityOptions}}"], true);
  return out.includes("rootless");
}

/** The devcontainer's container id for a workspace folder ("" if none). */
function devcontainerId(dir: string, includeStopped = false): string {
  const args = ["ps", includeStopped ? "-aq" : "-q",
    "--filter", `label=devcontainer.local_folder=${dir}`];
  return lines(run("docker", args, true))[0] ?? "";
}

// ---------------------------------------------------------------------------
// Port allocation
// Prefers each label's previously saved port (stable URLs across restarts);
// otherwise takes the first free port in range. Ports held by our OWN relays
// count as free -- we recycle them when relays are recreated.
//
// Exhaustion is a hard stop, deliberately. There is no queue and no fallback
// range: a port outside what dind publishes would produce a relay the Mac
// cannot reach, which is worse than not starting. Allocation runs BEFORE
// `devcontainer up`, so failing here leaves nothing half-started and the saved
// port map untouched.
// ---------------------------------------------------------------------------

/** Dead end: report who holds every port in the range, and both ways out. */
function rangeExhausted(
  label: string, used: Map<number, string>, own: Set<number>, chosen: Set<number>,
): never {
  const held: string[] = [];
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    const who = chosen.has(p) ? "this project (allocated a moment ago)"
              : own.has(p)    ? "this project (existing relay)"
              : used.get(p)   ?? "unknown -- not published by any running container";
    held.push(`        ${p}  ${who}`);
  }
  die(`the host port range ${PORT_MIN}-${PORT_MAX} is full; nothing left for '${label}'.\n` +
      `      All ${PORT_MAX - PORT_MIN + 1} ports are spoken for:\n${held.join("\n")}\n\n` +
      `      Free some:  desolate --stop <project>\n` +
      `      Or widen the range in the .env next to docker-compose.yml and\n` +
      `      restart the stack, so dind republishes it and this allocator and\n` +
      `      that publish stay in agreement:\n` +
      `        DESOLATE_PORT_MIN=${PORT_MIN}\n` +
      `        DESOLATE_PORT_MAX=${PORT_MAX + 10}\n` +
      `        ./cli.sh up\n` +
      `      Relay containers are 'restart: unless-stopped', so one whose project\n` +
      `      was deleted by hand still holds its port -- 'docker ps' on the inner\n` +
      `      daemon (./cli.sh observe ps) shows those as desolate-relay-*.`);
}

function allocatePorts(project: string, appPorts: number[]): PortMap {
  const saved = loadPortMap(project);
  const used = usedHostPorts();
  const own = new Set(ownRelayNames(project).map(n => Number(n.split("-").pop())));
  const chosen = new Set<number>();

  const isFree = (p: number): boolean =>
    p >= PORT_MIN && p <= PORT_MAX &&
    !chosen.has(p) &&
    (!used.has(p) || own.has(p));

  const alloc = (label: string): number => {
    const wanted = saved.get(label);
    if (wanted !== undefined && isFree(wanted)) { chosen.add(wanted); return wanted; }
    for (let p = PORT_MIN; p <= PORT_MAX; p++) {
      if (isFree(p)) { chosen.add(p); return p; }
    }
    rangeExhausted(label, used, own, chosen);
  };

  const map: PortMap = new Map();
  map.set("editor", alloc("editor"));
  for (const cp of appPorts) map.set(String(cp), alloc(String(cp)));
  savePortMap(project, map);
  return map;
}

// ---------------------------------------------------------------------------
// devcontainer.json reading (via `devcontainer read-configuration`)
// ---------------------------------------------------------------------------
interface ProjectConfig {
  appPorts: number[];
  extensions: string[];
  hadLegacyAppPort: boolean;
  /** Resolved `image`, "" for Dockerfile/compose-based projects. */
  image: string;
  /** True when the project builds from its own Dockerfile rather than an image. */
  usesDockerfile: boolean;
}

function readProjectConfig(dir: string, config: string): ProjectConfig {
  let parsed: any = {};
  try {
    parsed = JSON.parse(run("devcontainer",
      ["read-configuration", "--workspace-folder", dir, ...configArgs(config)]));
  } catch { /* fall through with empty config */ }
  const cfg = parsed.configuration ?? parsed ?? {};

  const ports: unknown = cfg.customizations?.desolate?.ports;
  const appPorts = Array.isArray(ports)
    ? [...new Set(ports.map(Number).filter(Number.isInteger))].sort((a, b) => a - b)
    : [];

  // Collect extension ids from any customizations.*.extensions array.
  // Ids are interpolated into a shell script that runs inside the devcontainer,
  // so anything that is not a plain marketplace id is dropped rather than
  // quoted-and-hoped-for.
  const EXT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9._-]+)?$/;
  const extensions = new Set<string>();
  for (const c of Object.values<any>(cfg.customizations ?? {})) {
    for (const e of c?.extensions ?? []) {
      if (typeof e !== "string") continue;
      if (EXT_ID.test(e)) extensions.add(e);
      else console.error(`desolate: ignoring malformed extension id '${e}'`);
    }
  }

  return {
    appPorts,
    extensions: [...extensions],
    hadLegacyAppPort: cfg.appPort !== undefined,
    image: typeof cfg.image === "string" ? cfg.image : "",
    usesDockerfile: Boolean(cfg.build?.dockerfile ?? cfg.dockerFile),
  };
}

// ---------------------------------------------------------------------------
// Build-time proxy-CA trust
//
// installProxyCa() below trusts the CA inside the RUNNING container -- which is
// too late for anything the image BUILD fetches. Build steps execute in
// containers made from the project's base image, whose trust store has never
// seen our CA, so every build-time HTTPS fetch dies with:
//
//   fatal: unable to access 'https://github.com/...':
//          SSL certificate problem: unable to get local issuer certificate
//
// That breaks most devcontainer Features, which is how most projects install
// anything. (Build-time `apt` survives only because Ubuntu's archives are plain
// http, so there is no certificate to check -- which is why this hid for a
// while.)
//
// Fix: derive a thin image FROM the project's base with the CA installed, and
// point the spec at it. One build per (base image, CA) pair, cached in the
// inner daemon afterwards. Nothing bypasses the proxy; the build simply trusts
// it like everything else does.
// ---------------------------------------------------------------------------
const CA_IMAGE_REPO = "desolate-ca/base";
const CA_CONFIG_DIR = "/tmp/desolate-ca-config";

/** Build (once) an image identical to `baseImage` but trusting the proxy CA.
 *  Returns its tag, or "" if it could not be produced. */
function caTrustingImage(baseImage: string): string {
  const caPem = fs.readFileSync(`${CA_DIR}/ca.pem`, "utf8");
  // Keyed on base AND CA: regenerating the CA must not silently reuse an image
  // that trusts the old one.
  const digest = createHash("sha256").update(`${baseImage}\0${caPem}`).digest("hex").slice(0, 16);
  const tag = `${CA_IMAGE_REPO}:${digest}`;

  if (run("docker", ["image", "inspect", "-f", "{{.Id}}", tag], true)) return tag;

  console.log(`desolate: deriving a CA-trusting image from ${baseImage}`);
  console.log(`          (once per base image; cached as ${tag})`);

  // The base must be local before we can read its USER.
  if (!run("docker", ["image", "inspect", "-f", "{{.Id}}", baseImage], true)) {
    if (runStatus("docker", ["pull", baseImage], /* quiet */ true) !== 0) {
      console.error(`desolate: warning -- could not pull ${baseImage} to derive a CA image`);
      return "";
    }
  }
  // Root is needed to run the CA tool; the original user must be restored, or
  // the devcontainer CLI's assumptions about the image user break.
  const baseUser = run("docker", ["image", "inspect", "-f", "{{.Config.User}}", baseImage], true) || "root";

  // Both cert locations are populated so one Dockerfile covers Debian/Ubuntu
  // /Alpine (update-ca-certificates) and RHEL-family (update-ca-trust). Missing
  // BOTH tools is a hard failure, not a silent skip -- a base image we cannot
  // teach to trust the proxy cannot build anything over HTTPS, and saying so
  // here is far cheaper than an x509 error deep in a Feature install.
  const dockerfile = `
FROM ${baseImage}
USER root
COPY ca.pem /usr/local/share/ca-certificates/desolate-proxy.crt
COPY ca.pem /etc/pki/ca-trust/source/anchors/desolate-proxy.crt
RUN set -eu; \\
    if command -v update-ca-certificates >/dev/null 2>&1; then update-ca-certificates; \\
    elif command -v update-ca-trust >/dev/null 2>&1; then update-ca-trust extract; \\
    else echo 'desolate: this base image has neither update-ca-certificates nor update-ca-trust;' >&2; \\
         echo '          install the ca-certificates package in it to build behind the proxy.' >&2; \\
         exit 1; fi
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt
ENV GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/desolate-proxy.crt
USER ${baseUser}
`;

  try {
    execFileSync("docker", ["build", "-t", tag, "-f", "-", CA_DIR],
      { input: dockerfile, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return tag;
  } catch (err: any) {
    console.error(`desolate: warning -- could not derive a CA-trusting image from ${baseImage}:`);
    console.error(String(err?.stderr ?? err?.message ?? err).split("\n").slice(-8).join("\n"));
    return "";
  }
}

/** Find the devcontainer.json a project would be started from. */
function projectConfigPath(dir: string): string {
  for (const p of [`${dir}/.devcontainer/devcontainer.json`, `${dir}/.devcontainer.json`]) {
    if (fs.existsSync(p)) return p;
  }
  return "";
}

/** Point the spec at a CA-trusting derivative of its base image.
 *  Returns the --config path to use from here on (unchanged if not applicable).
 *
 *  NOTE ON TRUST: on the broker path this rewrites a spec that enforcePolicy
 *  has already validated. That is deliberate and deliberately narrow -- the
 *  ONLY field changed is `image`, and only to a tag this process just built
 *  `FROM` the image the policy approved. No project-supplied value is
 *  introduced, and the rewritten file lands in the orchestrator's own /tmp,
 *  which no other container can write. */
function withCaTrustedBase(
  dir: string, config: string, cfg: ProjectConfig, project: string,
): string {
  if (!fs.existsSync(`${CA_DIR}/ca.pem`)) return config;   // proxy not installed
  if (cfg.usesDockerfile) {
    console.log(`desolate: NOTE -- this project builds from its own Dockerfile, so its build`);
    console.log(`          steps do NOT trust the proxy CA. Anything fetched over HTTPS during`);
    console.log(`          the build will fail; add the CA in the Dockerfile, or use "image".`);
    return config;
  }
  if (!cfg.image) return config;

  const tag = caTrustingImage(cfg.image);
  if (!tag) {
    console.error(`desolate: warning -- proceeding with ${cfg.image}; build-time HTTPS may fail`);
    return config;
  }

  const src = config || projectConfigPath(dir);
  if (!src) return config;
  let spec: any;
  try { spec = parseJsonc(fs.readFileSync(src, "utf8")); } catch { return config; }
  if (typeof spec !== "object" || spec === null) return config;
  spec.image = tag;

  fs.mkdirSync(CA_CONFIG_DIR, { recursive: true });
  const out = `${CA_CONFIG_DIR}/${volumeNamespace(project)}.json`;
  fs.writeFileSync(out, JSON.stringify(spec, null, 2));
  return out;
}

// ---------------------------------------------------------------------------
// Connection token: one per project, persisted alongside the port map.
// ---------------------------------------------------------------------------
function connectionToken(project: string): string {
  const file = `${WORKSPACES}/.desolate/${volumeNamespace(project)}.token`;
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch { /* create below */ }
  fs.mkdirSync(`${WORKSPACES}/.desolate`, { recursive: true });
  const token = [...crypto.getRandomValues(new Uint8Array(24))]
    .map(b => b.toString(16).padStart(2, "0")).join("");
  fs.writeFileSync(file, token + "\n");
  return token;
}

// ---------------------------------------------------------------------------
// Starting the editor inside the devcontainer.
// This snippet is bash BY NECESSITY: it runs inside arbitrary devcontainer
// images, where Node may not exist. It (1) installs declared extensions from
// Open VSX, (2) starts openvscode-server on EDITOR_INTERNAL unless something
// is already listening there (checked with a real TCP connect, not pgrep).
// ---------------------------------------------------------------------------
function editorStartScript(extensions: string[], token: string, rootless: boolean): string {
  // Under a rootless inner daemon the editor must run as container-root so its
  // writes land as the real uid 1000 that owns /workspaces (see
  // innerDaemonIsRootless). SUDO is resolved at runtime so images without sudo
  // simply run unelevated rather than failing outright.
  // Under rootless we need the editor to run as container-root. Two ways in:
  //   (a) the container ALREADY runs as root -> nothing to do (preferred; works
  //       even with no-new-privileges, since no escalation occurs);
  //   (b) escalate with sudo -> only possible when no-new-privileges is NOT set.
  // We TEST sudo rather than merely checking it exists, because
  // `--security-opt no-new-privileges:true` makes an installed sudo fail at
  // runtime with "the no new privileges flag is set".
  const elevate = rootless
    ? `SUDO=""
if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    SUDO="sudo -E"
  else
    echo "desolate: ROOTLESS daemon, but this devcontainer runs as uid $(id -u) and" >&2
    echo "      cannot become root (sudo missing, or no-new-privileges is set)." >&2
    echo "      Editor writes will fail with EACCES on /workspaces." >&2
    echo "      Fix -- add to this project's devcontainer.json:" >&2
    echo '        "remoteUser": "root", "containerUser": "root"' >&2
    echo "      (Safe here: under a rootless daemon, container-root maps to the" >&2
    echo "       unprivileged host uid -- it is not real root.)" >&2
    echo "      Then recreate the container and rerun desolate." >&2
  fi
fi`
    : `SUDO=""`;
  return `
set -e
${elevate}
SRV=${SERVER_DST}/bin/openvscode-server
DATA="$HOME/.openvscode-desolate"
mkdir -p "$DATA/extensions"
if [ ! -x "$SRV" ]; then
  echo 'desolate: server not found in container -- is the base image glibc (Debian/Ubuntu)?' >&2
  exit 1
fi
for e in ${extensions.map(e => `'${e}'`).join(" ")}; do
  $SUDO "$SRV" --install-extension "$e" \\
      --extensions-dir "$DATA/extensions" --server-data-dir "$DATA" \\
      >/dev/null 2>&1 || echo "desolate: extension unavailable on Open VSX: $e" >&2
done
if (exec 3<>/dev/tcp/127.0.0.1/${EDITOR_INTERNAL}) 2>/dev/null; then
  exec 3>&- 3<&-
  echo 'desolate: editor already listening'
else
  setsid nohup $SUDO "$SRV" \\
    --host 0.0.0.0 --port ${EDITOR_INTERNAL} \\
    --connection-token '${token}' \\
    --extensions-dir "$DATA/extensions" --server-data-dir "$DATA" \\
    >/tmp/openvscode-desolate.log 2>&1 < /dev/null &
  sleep 2
fi`;
}

function devcontainerUp(project: string, dir: string, config: string, noCache = false): void {
  // EVERY injected mount is type=volume, never a bind of the shared directory.
  // These two are what a devcontainer receives from outside its own project,
  // they are both executed, and neither passes through the broker's mount
  // policy -- desolate adds them itself. As plain binds they were the stack's
  // sharpest cross-project edge; as per-project overlays the shared originals
  // cannot be written through at all. See overlayMounts/ensureOverlayVolume.
  //
  // A read-only bind was NOT sufficient here, which is worth remembering before
  // "simplifying" this back: MS_RDONLY is a per-mount flag, and a devcontainer
  // with allowPrivileged holds CAP_SYS_ADMIN in dind's user namespace, so it
  // can `mount -o remount,bind,rw` its own copy and write through to the shared
  // file. Measured, not assumed.
  const args = ["up", "--workspace-folder", dir, ...configArgs(config)];
  for (const m of overlayMounts()) {
    args.push("--mount",
      `type=volume,source=${ensureOverlayVolume(project, m)},target=${m.target}`);
  }
  if (noCache) args.push("--build-no-cache");
  const code = runStatus("devcontainer", args, /* quiet */ true);
  if (code !== 0) die(`devcontainer up failed (exit ${code})`);
}

/** Trust the proxy CA inside the devcontainer. Runs as container-root via the
 *  daemon (the orchestrator has that authority; the project never needs sudo,
 *  and no postCreateCommand is required). Silent no-op when the proxy isn't
 *  installed -- the stack works fine without it. */
function installProxyCa(dir: string): void {
  if (!fs.existsSync(`${CA_DIR}/ca.pem`)) return;
  const cid = devcontainerId(dir);
  if (!cid) return;
  // A nested daemon (the docker-in-docker feature) starts with the container,
  // i.e. BEFORE this runs, and Go caches the system cert pool on first use --
  // so a dockerd that has already spoken TLS keeps a CA-less pool and every
  // image pull through the proxy fails with an opaque x509 error. Restarting
  // it after the CA lands is the difference between "docker compose up --build
  // works" and a support ticket. No-op when there is no nested daemon.
  const code = runStatus("docker", ["exec", "-u", "0", cid, "sh", "-c",
    `${CA_DIR}/install-ca.sh >/dev/null 2>&1 && ` +
    `{ pgrep dockerd >/dev/null 2>&1 && ` +
    `  { service docker restart >/dev/null 2>&1 || pkill -HUP dockerd || true; } ; true; }`]);
  if (code === 0) console.log("desolate: proxy CA installed in devcontainer");
  else console.log("desolate: warning -- could not install proxy CA (TLS may fail);\n" +
                   "          check that the image has update-ca-certificates");
}

function startEditor(project: string, dir: string, cfg: ProjectConfig, token: string, config: string): void {
  const rootless = innerDaemonIsRootless();
  if (rootless) {
    console.log("desolate: inner daemon is rootless -- starting editor as container-root");
    console.log("      (maps to the unprivileged host uid that owns /workspaces)");
  }
  const script = editorStartScript(cfg.extensions, token, rootless);
  const code = runStatus("devcontainer",
    ["exec", "--workspace-folder", dir, ...configArgs(config), "bash", "-lc", script]);
  if (code === 0) return;

  if (code === 126) {
    // runc refuses execs into a container whose bind-mount source was deleted
    // and recreated (e.g. the project dir was replaced). The container is
    // dead state: recreate it once and retry.
    console.log("desolate: container has stale mounts (runc rc 126) -- recreating...");
    const stale = devcontainerId(dir, true);
    if (stale) run("docker", ["rm", "-f", stale], true);
    devcontainerUp(project, dir, config);
    const retry = runStatus("devcontainer",
      ["exec", "--workspace-folder", dir, ...configArgs(config), "bash", "-lc", script]);
    if (retry !== 0) console.log(`desolate: warning -- exec still unclean (rc ${retry}); trusting the probe`);
  } else {
    // The exec channel can close uncleanly (attach race) even when the server
    // started fine; the reachability probe is the authoritative signal.
    console.log(`desolate: warning -- exec channel closed uncleanly (rc ${code}); trusting the probe instead`);
  }
}

// ---------------------------------------------------------------------------
// Relays: one socat container per mapped port, named desolate-relay-<proj>-<port>
// so the host port is recoverable from the name alone.
// ---------------------------------------------------------------------------
function recreateRelays(project: string, dir: string, map: PortMap): void {
  const cid = devcontainerId(dir);
  if (!cid) die("devcontainer is not running after up");

  const network = lines(run("docker", ["inspect", "-f",
    "{{range $n,$_ := .NetworkSettings.Networks}}{{$n}}{{end}}", cid]))[0];
  const ip = lines(run("docker", ["inspect", "-f",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", cid]))[0];
  if (!ip) die("could not resolve devcontainer IP");

  const old = ownRelayNames(project);
  if (old.length) run("docker", ["rm", "-f", ...old], true);

  for (const [label, hostPort] of map) {
    const target = label === "editor" ? EDITOR_INTERNAL : Number(label);
    // Chain: Mac:hostPort -> (daemon #0 range publish) -> dind ns:hostPort
    //        -> (this relay's publish on daemon #1) -> socat -> devcontainer IP.
    // The relay joins the devcontainer's network so `ip` is directly routable.
    const code = runStatus("docker", [
      "run", "-d", "--restart", "unless-stopped",
      "--name", `desolate-relay-${volumeNamespace(project)}-${hostPort}`,
      "--label", `desolate.relay=${project}`,
      "--network", network,
      "-p", `${hostPort}:${hostPort}`,
      RELAY_IMAGE,
      `tcp-listen:${hostPort},fork,reuseaddr`, `tcp:${ip}:${target}`,
    ]);
    if (code !== 0) die(`relay for ${hostPort} failed to start ` +
      `(first run pulls ${RELAY_IMAGE} -- network ok?)`);

    // `docker run -d` exits 0 once the container is CREATED -- socat can still
    // die immediately (e.g. port taken by a stale appPort publish). Verify it
    // is actually up, and surface socat's own error if not.
    const name = `desolate-relay-${volumeNamespace(project)}-${hostPort}`;
    let alive = false;
    for (let i = 0; i < 5; i++) {
      const state = run("docker", ["inspect", "-f", "{{.State.Status}}", name], true);
      if (state === "running") { alive = true; break; }
      if (state === "exited" || state === "restarting") break;
      sleepSync(400);
    }
    if (!alive) {
      const why = run("docker", ["logs", "--tail", "3", name], true);
      die(`relay for ${hostPort} started but died.\n      socat says: ${why}\n` +
          `      Most common cause: something else already publishes ${hostPort} on the\n` +
          `      inner daemon -- usually a leftover "appPort" in devcontainer.json.\n` +
          `      Remove appPort (desolate allocates host ports itself), then:\n` +
          `        docker rm -f $(docker ps -aq --filter label=devcontainer.local_folder=${dir})\n` +
          `        desolate ${project}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Reachability probe: hit the editor through dind's eth0 -- the same
// interface path the Mac's traffic uses. Any HTTP status counts as success.
// ---------------------------------------------------------------------------
async function probeEditor(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fetch(`http://${PROBE_HOST}:${port}/`, { signal: AbortSignal.timeout(2000) });
      return true;                       // any response at all means reachable
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------
function showPorts(project: string): void {
  const map = loadPortMap(project);
  if (map.size === 0) { console.log(`no ports allocated for ${project}`); return; }
  for (const [label, port] of map) {
    const name = label === "editor" ? "editor       " : `container:${label}`;
    console.log(`  ${name} -> http://127.0.0.1:${port}`);
  }
}

function stopProject(project: string, dir: string): void {
  const relays = ownRelayNames(project);
  if (relays.length) { run("docker", ["rm", "-f", ...relays], true); console.log("removed relays"); }
  const cid = devcontainerId(dir);
  if (cid) {
    run("docker", ["stop", cid], true);
    // Say that the container is KEPT. Stopping and starting again looks like it
    // should pick up an edited devcontainer.json, and it does not -- `up`
    // restarts the existing container rather than rebuilding from the spec.
    console.log(`stopped ${project} (container kept, so restarting is fast;`);
    console.log(`         use 'desolate --rebuild ${project}' to apply spec changes)`);
  } else console.log("not running");
}

async function runProject(
  project: string, dir: string, config: string, rebuild = false, noCache = false,
): Promise<void> {
  const hasConfig = config !== "" ||
                    fs.existsSync(`${dir}/.devcontainer/devcontainer.json`) ||
                    fs.existsSync(`${dir}/.devcontainer.json`);
  if (!hasConfig) die(`no devcontainer.json under ${dir}`);

  const cfg = readProjectConfig(dir, config);
  if (cfg.hadLegacyAppPort) {
    // Not merely cosmetic: appPort makes daemon #1 publish that port inside
    // dind's namespace, which is exactly where desolate's relays need to bind.
    // A leftover appPort therefore guarantees "address in use" for the relay.
    die(`devcontainer.json still contains "appPort".\n` +
        `      desolate allocates host ports itself, and an appPort publish occupies the\n` +
        `      same port the relay must bind -- the relay will fail with "address in use".\n` +
        `      Fix: delete the appPort entry and declare container-side ports instead:\n` +
        `        "customizations": { "desolate": { "ports": [5173] } }\n` +
        `      Then recreate:  docker rm -f $(docker ps -aq --filter label=devcontainer.local_folder=${dir})`);
  }

  // Decide about the container BEFORE allocating ports, so a --rebuild that
  // cannot proceed costs nothing.
  const fingerprint = specFingerprint(dir, config);
  const savedFingerprint = loadSpecFingerprint(project);
  const existing = devcontainerId(dir, /* includeStopped */ true);

  if (rebuild && existing) {
    run("docker", ["rm", "-f", existing], true);
    console.log(`desolate: removed the existing container (--rebuild)`);
  } else if (existing && savedFingerprint && savedFingerprint !== fingerprint) {
    // Report, do not act. Recreating destroys anything installed inside the
    // container outside /workspaces, which is not ours to discard silently.
    console.log(
      `\n  NOTE: this project's spec has changed since its container was created.\n` +
      `        'devcontainer up' reuses an existing container without re-reading\n` +
      `        devcontainer.json, so THE CHANGE IS NOT IN EFFECT below.\n` +
      `          .devcontainer fingerprint: ${savedFingerprint} -> ${fingerprint}\n` +
      `        Apply it:  desolate --rebuild ${project}\n` +
      `        Not automatic: recreating loses anything written inside the\n` +
      `        container outside /workspaces.\n`);
  }

  // A container created from THIS spec is the only case where recording the
  // fingerprint is honest. Reusing a stale one must keep the old value, so the
  // warning above persists across restarts until it is actually rebuilt.
  const willCreate = rebuild || !existing;

  const map = allocatePorts(project, cfg.appPorts);
  const editorPort = map.get("editor")!;
  const token = connectionToken(project);

  // From here on, every devcontainer CLI call uses runConfig, not config: the
  // image the build runs FROM has to be the CA-trusting one, and `exec` later
  // must resolve the same container. The FINGERPRINT above deliberately used
  // the original -- it tracks what the user wrote, not what we derived.
  const runConfig = withCaTrustedBase(dir, config, cfg, project);

  console.log(`desolate: starting devcontainer for ${project} ...`);
  devcontainerUp(project, dir, runConfig, noCache);
  if (willCreate) saveSpecFingerprint(project, fingerprint);
  installProxyCa(dir);
  startEditor(project, dir, cfg, token, runConfig);
  recreateRelays(project, dir, map);

  if (!(await probeEditor(editorPort))) {
    die(`editor not reachable through ${PROBE_HOST}:${editorPort} -- check the log:\n` +
        `      devcontainer exec --workspace-folder ${dir} cat /tmp/openvscode-desolate.log`);
  }

  console.log(`\n  ${project} is ready:\n`);
  console.log(`    http://127.0.0.1:${editorPort}/?tkn=${token}&folder=${dir}\n`);
  for (const [label, port] of map) {
    if (label === "editor") continue;
    console.log(`    dev server on container port ${label} -> http://127.0.0.1:${port}`);
  }
  if (cfg.appPorts.length) {
    console.log(`\n  Start servers bound to 0.0.0.0 (e.g. 'npx vite --host 0.0.0.0');`);
    console.log(`  the relay is live now, the URL answers once the server is up.`);
  }
  console.log(`\n  Port map: desolate --ports ${project}    Stop: desolate --stop ${project}`);
}

// ---------------------------------------------------------------------------
// Entry point (wrapped in main() -- no top-level await, so the file runs
// under both CJS and ESM interpretation)
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { command, project, config, rebuild, noCache } = parseArgs(process.argv.slice(2));
  const dir = `${WORKSPACES}/${project}`;
  if (!fs.existsSync(dir)) die(`no such project: ${dir}`);

  if (command === "ports") showPorts(project);
  else if (command === "stop") stopProject(project, dir);
  else await runProject(project, dir, config, rebuild, noCache);
}

main().catch((err) => { console.error(`desolate: ${err?.message ?? err}`); process.exit(1); });
