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
/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { enforcePolicy } from "./policy.ts";
import { list as listProjects, volumeNamespace } from "./projects.ts";
import { parse as parseJsonc } from "./jsonc.ts";
import { isEntryPoint, run } from "./utils.ts";
import { parseArgs } from "./args.ts";
import { createDocker, NetworkAttachment, type Runner } from "./docker.ts";
import {
  CA_DIR,
  OVERLAY_KEY_LABEL,
  SERVER_DST,
  SHARED_DIRECTORIES,
  overlayOptions,
  overlayVolumes,
  type SharedDirectory,
} from "./overlay.ts";
import {
  EDITOR_INTERNAL_PORT,
  editorStartScript,
  isValidExtensionId,
  isValidToken,
  mintToken,
} from "./editor.ts";
import * as relay from "./relays.ts";
import {
  allocatePorts,
  ownRelayPorts,
  portMapFile,
  portRange,
  publishedPorts,
  type PortMap,
} from "./ports.ts";
import {
  resolveSpec,
  tryLocateConfig,
  type ResolvedSpec,
} from "./devcontainer.ts";
import { caTrustingImage, installInstructions } from "./certificates.ts";

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

const HELPER_IMAGE = "alpine:3"; // tiny, for volume setup + verification

const die = (msg: string): never => {
  console.error(`desolate: ${msg}`);
  process.exit(1);
};

/** Run `produce`, turning any throw into desolate's own exit.
 *
 *  The modules this file composes throw so they can be tested; a CLI exits. */
const dieOnError = <T>(produce: () => T): T => {
  try {
    return produce();
  } catch (err: any) {
    return die(String(err?.message ?? err));
  }
};

/** The production runner: the real docker CLI, in the three shapes docker.ts
 *  asks for. Kept here rather than in docker.ts so the module stays injectable. */
const dockerRunner: Runner = {
  output: (argv) => run("docker", argv, { encoding: "utf8" }, true),
  status: (argv, quiet = false) => run.status("docker", argv, quiet),
  build: (argv, input) => {
    try {
      execFileSync("docker", argv, {
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { ok: true, output: "" };
    } catch (err: any) {
      return { ok: false, output: String(err?.stderr || err?.stdout || err) };
    }
  },
};

const docker = createDocker(dockerRunner);

/** Blocking sleep (we are in a sequential CLI, not an event loop hot path). */
const sleep = (ms: number) => execFileSync("sleep", [String(ms / 1000)]);

const sha16 = (raw: string) =>
  createHash("sha256").update(raw).digest("hex").slice(0, 16);

const desolog = (...[first, ...rest]: string[]) =>
  console.log(`desolate: ${first}`, ...rest);

const readOrDie = (path: string, hint: string) => {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return die(`cannot read ${path} -- ${hint}`);
  }
};

const resolveOrDie = (project: string, config: string) => {
  try {
    return resolveSpec(project, config);
  } catch (err) {
    return die(
      `Unable to resolve devcontainer spec for ${project} @ ${config}:\n\n${err}`,
    );
  }
};

const overrideConfigFlag = (config?: string) =>
  config ? ["--override-config", config] : [];

const stateDir = `${WORKSPACES}/.desolate`;

const ports = {
  file: (project: string) => `${stateDir}/${volumeNamespace(project)}.ports`,
  load: (project: string): PortMap => {
    try {
      return portMapFile.parse(fs.readFileSync(ports.file(project), "utf8"));
    } catch {
      return new Map(); // no saved map yet -- fine
    }
  },
  save: (project: string, map: PortMap) => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(ports.file(project), portMapFile.format(map));
  },
  allocate: (project: string, appPorts: number[]): PortMap => {
    const map = dieOnError(() =>
      allocatePorts(
        {
          range: portRange(process.env),
          published: publishedPorts(docker.container.publishedPortsTable()),
          ownRelayPorts: ownRelayPorts(ownRelayNames(project)),
          previous: ports.load(project),
        },
        appPorts,
      ),
    );
    ports.save(project, map);
    return map;
  },
};

const spec = {
  /**
   * Capture what the running container was actually built from.
   * @param dir
   * @param config
   */
  fingerprint: (dir: string, config?: string) => {
    const parts: string[] = [];
    /**
     *
     * @param path
     * @param label relative location, as the absolute path of `config` changes
     * every call, so hasing on it would cause a miss every subsequnet run
     * @returns
     */
    const walk = (path: string, label: string) => {
      let stats: fs.Stats;
      try {
        stats = fs.statSync(path);
      } catch {
        return; // absent
      }
      if (stats.isDirectory())
        for (const e of fs.readdirSync(path).sort())
          walk(`${path}/${e}`, `${label}/${e}`);
      else
        try {
          parts.push(`${label}\0${fs.readFileSync(path, "utf8")}`);
        } catch {} /* unreadable */
    };

    walk(`${dir}/.devcontainer`, ".devcontainer");
    walk(`${dir}/.devcontainer.json`, ".devcontainer.json");
    if (config) walk(config, "override");
    return sha16(parts.join("\0"));
  },
  file: (project: string) =>
    `${WORKSPACES}/.desolate/${volumeNamespace(project)}.spec`,

  load(project: string) {
    try {
      return fs.readFileSync(spec.file(project), "utf8").trim();
    } catch {
      return;
    }
  },

  save(project: string, fingerprint: string) {
    fs.mkdirSync(`${WORKSPACES}/.desolate`, { recursive: true });
    fs.writeFileSync(spec.file(project), fingerprint + "\n");
  },
};

/**
 * Enables sharing data per project, without risking one project
 * 'poisoning' it for others.
 *
 * Establishes a copy-on-write mounted volume.
 */
const overlay = {
  /**
   * Checks if a CACHE HIT is still trustworthy
   */
  intact: (vol: string, data: string, lower: string) => {
    const mountpoint = docker.volume.mountpoint(data);
    if (!mountpoint) return false; // -data pruned or removed
    return docker.volume.options(vol) === overlayOptions(lower, mountpoint);
  },
  /**
   * Build (or reuse) one project's copy-on-write view of a shared directory.
   * @returns the volume name; dies loudly rather than degrading to a shared mount. */
  ensureVolume: (project: string, mount: SharedDirectory) => {
    const { view: volume, data } = overlayVolumes(project, mount.name);
    const want = sha16(readOrDie(mount.identityFile, mount.missing));

    const have = docker.volume.label(volume, OVERLAY_KEY_LABEL);
    if (have === want) {
      if (overlay.intact(volume, data, mount.lower)) return volume;
      desolog(
        `${project}'s view of ${mount.lower} is stamped current but its
          backing volume '${data}' is missing or has moved (pruned?) -- rebuilding`,
      );
    } else if (have)
      desolog(`${mount.lower} changed -- rebuilding ${project}'s view of it`);

    const cleanup = () => docker.volume.remove([volume, data]);

    cleanup();

    const fail = (reason: string): never => {
      cleanup();
      return die(
        `could not build ${project}'s copy-on-write view of ${mount.lower}: ${reason}.

      ${mount.why}

      This is not optional and there is no fallback -- desolate refuses to start
      rather than quietly hand out a shared mount instead.

      Diagnose with:  ./tests/probes/dind-overlay-volume.sh`,
      );
    };

    if (docker.volume.create(data, { "desolate.overlay.of": volume }) !== 0)
      fail(`could not create the volume '${data}'`);

    if (
      docker.inVolume(HELPER_IMAGE, data, "/d", [
        "sh",
        "-c",
        "mkdir -p /d/upper /d/work",
      ]) !== 0
    )
      fail(
        `could not prepare upper/work in '${data}' (is ${HELPER_IMAGE} pullable?)`,
      );

    const mountpoint = docker.volume.mountpoint(data);

    if (!mountpoint) fail(`could not resolve the mountpoint of '${data}'`);

    const options = overlayOptions(mount.lower, mountpoint);

    if (
      docker.volume.createOverlay(volume, options, {
        [OVERLAY_KEY_LABEL]: want,
      }) !== 0
    )
      fail(`the daemon refused the overlay options (${options})`);

    // Confirm `volume create` completes (necessary as docker executes lazily)
    if (
      docker.inVolume(HELPER_IMAGE, volume, mount.target, [
        "test",
        "-e",
        mount.proof,
      ]) !== 0
    )
      fail("the overlay volume was created but could not be mounted");

    desolog(`built ${project}'s copy-on-write view of ${mount.lower}`);
    return volume;
  },
};

/** Names of this project's relay containers (running or not). */
const ownRelayNames = (project: string) =>
  docker.container.namesWithLabel(relay.label(project));

/** The devcontainer's container id for a workspace folder ("" if none). */
const devcontainerId = (dir: string, includeStopped = false) =>
  docker.container.forWorkspace(dir, { includeStopped });

interface ProjectConfig {
  appPorts: number[];
  extensions: string[];
  hadLegacyAppPort: boolean;
  /** Resolved `image`, "" for Dockerfile/compose-based projects. */
  image: string;
  /** True when the project builds from its own Dockerfile rather than an image. */
  usesDockerfile: boolean;
}

/** Project the CLI's own parse down to the handful of fields this file acts on.
 *
 *  A pure projection on purpose: every DECISION below is made from
 *  `spec.configuration` -- the CLI's parse -- and never from parseJsonc. The one
 *  place that still reads the file textually is deriveRunConfig, and what it
 *  produces is re-validated before anything starts from it. */
function readProjectConfig(spec: ResolvedSpec): ProjectConfig {
  const config = spec.configuration as any;

  const declared: unknown = config.customizations?.desolate?.ports;
  const appPorts = Array.isArray(declared)
    ? [...new Set(declared.map(Number).filter(Number.isInteger))].sort(
        (a, b) => a - b,
      )
    : [];

  // Collect extension ids from any customizations.*.extensions array.
  // Ids are interpolated into a shell script that runs inside the devcontainer,
  // so anything that is not a plain marketplace id is dropped rather than
  // quoted-and-hoped-for.
  const extensions = new Set<string>();
  for (const c of Object.values<any>(config.customizations ?? {})) {
    for (const e of c?.extensions ?? []) {
      if (typeof e !== "string") continue;
      if (isValidExtensionId(e)) extensions.add(e);
      else console.error(`desolate: ignoring malformed extension id '${e}'`);
    }
  }

  return {
    appPorts,
    extensions: [...extensions],
    hadLegacyAppPort: config.appPort !== undefined,
    image: typeof config.image === "string" ? config.image : "",
    usesDockerfile: Boolean(config.build?.dockerfile ?? config.dockerFile),
  };
}

/** Where deriveRunConfig materialises its rewritten specs -- one DIRECTORY per
 *  project, not one file. The orchestrator's own /tmp, so no other container can
 *  touch what we are about to start from. */
const RUN_CONFIG_DIR = "/tmp/desolate-run-config";

/**
 * The CA-trusting derivative of this spec's base image, or "" when the rewrite
 * does not apply (Dockerfile-based, no `image`, or the build failed).
 * Split out from the spec rewrite so its diagnostics still print in the cases
 * where nothing gets rewritten.
 */
function caTrustedBaseImage(cfg: ProjectConfig): string {
  if (cfg.usesDockerfile) {
    console.log(
      `NOTE -- this project builds from its own Dockerfile, so its build`,
    );
    console.log(
      `          steps do NOT trust the proxy CA. Anything fetched over HTTPS during`,
    );
    console.log(
      `          the build will fail; add the CA in the Dockerfile, or use "image".`,
    );
    console.log(
      `          Install the proxy yourself using this snippet:\n\n\n`,
    );
    console.log(installInstructions("<your image's user>"));
    return "";
  }
  if (!cfg.image) return "";

  const tag = caTrustingImage(cfg.image, docker);
  if (!tag)
    console.error(
      `desolate: warning -- proceeding with ${cfg.image}; build-time HTTPS may fail`,
    );
  return tag;
}

/**
 * Narrow, derived rewrites of a validated spec. Returns the --config path to
 * use from here on (unchanged when nothing applies).
 */
function deriveRunConfig(
  dir: string,
  config: string,
  cfg: ProjectConfig,
  project: string,
): string {
  const tag = caTrustedBaseImage(cfg);
  const src = config ?? tryLocateConfig(dir);

  if (!src) return die(`Unable to locate devcontainer config for ${project}`);

  let spec: ResolvedSpec["configuration"];
  try {
    spec = parseJsonc(fs.readFileSync(src, "utf8"));
  } catch {
    return die(`Faild to parse devcontainer config for ${project}`);
  }

  if (typeof spec !== "object" || spec === null)
    return die(`Parsed devcontainer config was not an object for ${project}`);

  const applied: string[] = [];

  if (
    project.includes("/") &&
    spec.workspaceFolder === undefined &&
    spec.workspaceMount === undefined
  ) {
    const own = `${WORKSPACES}/${project}`;
    spec.workspaceFolder = own;
    spec.workspaceMount = `source=${own},target=${own},type=bind`;
    applied.push(`workspace mounted at ${own}, mirroring its path outside`);
  }

  if (tag) {
    spec.image = tag;
    applied.push(`base image ${tag} (trusts the proxy CA)`);
  }

  if (applied.length === 0) return src; // nothing changed, config = runConfig

  for (const note of applied) desolog(`${note}`);

  const out = `${RUN_CONFIG_DIR}/${volumeNamespace(project)}`;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });

  const srcDir = path.dirname(src);
  if (config || path.basename(srcDir) === ".devcontainer")
    fs.cpSync(srcDir, out, { recursive: true, dereference: true });

  const file = `${out}/devcontainer.json`;
  fs.writeFileSync(file, JSON.stringify(spec, null, 2));
  return file;
}

/** Where the project's directory is ACTUALLY mounted inside the running
 *  container -- read from the daemon, not derived.
 *
 *  Returns "" when no bind of `dir` is found, which is the caller's cue that it
 *  has nothing better than the outer path to offer. */
const containerWorkspaceFolder = (dir: string, cid: string) =>
  docker.container.mounts(cid).find(({ source }) => source === dir)
    ?.destination ?? "";

function connectionToken(project: string): string {
  const file = `${WORKSPACES}/.desolate/${volumeNamespace(project)}.token`;
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (isValidToken(existing)) return existing;
    if (existing)
      // Do not reuse it and do not try to repair it -- mint a fresh one. The URL
      // printed at the end carries the new token, so the only visible effect is
      // that an older bookmarked link stops working.
      console.error(
        `desolate: warning -- ${file} does not hold a valid token; ` +
          `replacing it (a previously bookmarked URL will stop working)`,
      );
  } catch /* create below */ {}
  fs.mkdirSync(`${WORKSPACES}/.desolate`, { recursive: true });
  const token = mintToken((length) =>
    crypto.getRandomValues(new Uint8Array(length)),
  );
  fs.writeFileSync(file, token + "\n");
  return token;
}

const devcontainerUp = (
  project: string,
  dir: string,
  config: string,
  noCache = false,
) => {
  const args = ["up", "--workspace-folder", dir, ...overrideConfigFlag(config)];
  for (const mount of SHARED_DIRECTORIES)
    args.push(
      "--mount",
      `type=volume,source=${overlay.ensureVolume(project, mount)},target=${mount.target}`,
    );

  if (noCache) args.push("--build-no-cache");
  const code = run.status("devcontainer", args, /* quiet */ true);
  if (code !== 0) die(`devcontainer up failed (exit ${code})`);
};

/** Trust the proxy CA inside the devcontainer. Runs as container-root via the
 *  daemon (the orchestrator has that authority; the project never needs sudo,
 *  and no postCreateCommand is required). */
function installProxyCa(dir: string): void {
  const id = devcontainerId(dir);
  if (!id) return;
  if (
    docker.container.execAsRoot(
      id,
      [
        "sh",
        "-c",
        `${CA_DIR}/install-ca.sh >/dev/null 2>&1 && ` +
          `{ pgrep dockerd >/dev/null 2>&1 && ` +
          `  { service docker restart >/dev/null 2>&1 || pkill -HUP dockerd || true; } ; true; }`,
      ],
      { quiet: false },
    ) === 0
  )
    console.log("desolate: proxy CA installed in devcontainer");
  else
    console.log(
      "desolate: warning -- could not install proxy CA (TLS may fail);\n" +
        "          check that the image has update-ca-certificates",
    );
}

function startEditor(
  project: string,
  dir: string,
  cfg: ProjectConfig,
  token: string,
  config: string,
): void {
  const script = editorStartScript(SERVER_DST, cfg.extensions, token);
  const code = run.status("devcontainer", [
    "exec",
    "--workspace-folder",
    dir,
    ...overrideConfigFlag(config),
    "bash",
    "-lc",
    script,
  ]);
  if (code === 0) return;

  if (code === 126) {
    console.log(
      "desolate: container has stale mounts (runc rc 126) -- recreating...",
    );
    const stale = devcontainerId(dir, true);
    if (stale) docker.container.remove([stale]);
    devcontainerUp(project, dir, config);
    const retry = run.status("devcontainer", [
      "exec",
      "--workspace-folder",
      dir,
      ...overrideConfigFlag(config),
      "bash",
      "-lc",
      script,
    ]);
    if (retry !== 0)
      console.log(
        `desolate: warning -- exec still unclean (rc ${retry}); trusting the probe`,
      );
  } else
    console.log(
      `desolate: warning -- exec channel closed uncleanly (rc ${code}); trusting the probe instead`,
    );
}

const startRelay = (
  project: string,
  dir: string,
  { network, ip: targetIp }: NetworkAttachment,
  { hostPort, targetPort }: Record<`${"host" | "target"}Port`, number>,
) => {
  // Chain: Mac:hostPort -> (daemon #0 range publish) -> dind ns:hostPort
  //        -> (this relay's publish on daemon #1) -> socat -> devcontainer IP.
  // The relay joins the devcontainer's network so `ip` is directly routable.
  const code = docker.relay.start({
    image: relay.IMAGE,
    name: relay.name(project, hostPort),
    label: relay.label(project),
    network,
    hostPort,
    targetIp,
    targetPort,
  });

  if (code !== 0)
    die(
      [
        `relay for ${hostPort} failed to start`,
        `(first run must pull ${relay.IMAGE} -- is your network ok?)`,
      ].join(" "),
    );

  const checkSocatRelay = { intervalMs: 400, retries: 5 } as const;
  const name = relay.name(project, hostPort);
  for (let i = 0; i < checkSocatRelay.retries; i++) {
    const state = docker.container.state(name);
    if (state === "running") return; // relay is up
    if (state === "exited" || state === "restarting") break;
    sleep(checkSocatRelay.intervalMs);
  }

  const why = docker.container.logsTail(name, 3);
  die(
    [
      `relay for ${hostPort} started but died.\n      socat says: ${why}`,
      `      Most common cause: something else already publishes ${hostPort} on the`,
      `      inner daemon -- usually a leftover "appPort" in devcontainer.json.`,
      `      Remove appPort (desolate allocates host ports itself), then:`,
      `        docker rm -f $(docker ps -aq --filter label=devcontainer.local_folder=${dir})`,
      `        desolate ${project}`,
    ].join("\n"),
  );
};

/**
 * Relays: one socat container per mapped port, named desolate-relay-<proj>-<port>
 * so the host port is recoverable from the name alone
 */
function recreateRelays(project: string, dir: string, map: PortMap): void {
  const cid = devcontainerId(dir);
  if (!cid) die("devcontainer is not running after up");

  const nets = docker.container.networks(cid);
  // First network with an actual address. A container can legitimately sit on
  // several; any ONE of them is routable from a relay joined to that same
  // network, so this needs no cleverness -- only consistency.
  const attach = nets.find(({ ip }) => ip);
  if (!attach) {
    const reported = nets.length
      ? nets.map((n) => `${n.network}(ip='${n.ip}')`).join(", ")
      : "none";
    return die(
      [
        `could not resolve a network address for the devcontainer.`,
        `      Networks reported: ${reported}`,
        `      A relay has to join one of the container's networks and dial its`,
        `      address on that network; with no address there is nothing to dial.`,
      ].join("\n"),
    );
  }
  const { network, ip } = attach;
  if (nets.length > 1)
    console.log(
      `desolate: devcontainer is on ${nets.length} networks ` +
        `(${nets.map((n) => n.network).join(", ")}); relays will use ${network}`,
    );

  const old = ownRelayNames(project);
  docker.container.remove(old);

  for (const [label, hostPort] of map)
    startRelay(project, dir, attach, {
      hostPort,
      targetPort: label === "editor" ? EDITOR_INTERNAL_PORT : Number(label),
    });
}

/**
 * Is the project's editor answering? Asked THROUGH the project's own relay,
 * from inside it.
 *
 * `docker exec` reaches the relay over the inner daemon's unix socket, crossing
 * no bridge at all, and lands on the far side of the wall by design. It tests
 * everything except the two pure docker publishes that carry the Mac's traffic in.
 */
function probeEditor(project: string, port: number): boolean {
  const config = { retries: 5, gapMs: 1000 } as const;
  const name = relay.name(project, port);
  for (let attempt = 0; attempt < config.retries; attempt++) {
    if (docker.relay.answers(name, port)) return true;
    if (attempt < config.retries - 1) sleep(config.gapMs);
  }
  return false;
}

function showPorts(project: string): void {
  const map = ports.load(project);
  if (map.size === 0) return console.log(`no ports allocated for ${project}`);

  for (const [label, port] of map) {
    const name = label === "editor" ? "editor       " : `container:${label}`;
    console.log(`  ${name} -> http://127.0.0.1:${port}`);
  }
}

function stopProject(project: string, dir: string): void {
  const relays = ownRelayNames(project);
  if (relays.length) {
    docker.container.remove(relays);
    console.log("removed relays");
  }
  const id = devcontainerId(dir);
  if (id) {
    docker.container.stop(id);
    // Say that the container is KEPT. Stopping and starting again looks like it
    // should pick up an edited devcontainer.json, and it does not -- `up`
    // restarts the existing container rather than rebuilding from the spec.
    console.log(`stopped ${project} (container kept, so restarting is fast;`);
    console.log(
      `         use 'desolate --rebuild ${project}' to apply spec changes)`,
    );
  } else console.log("not running");
}

async function runProject(
  name: string,
  dir: string,
  config?: string,
  rebuild = false,
  noCache = false,
): Promise<void> {
  config ??= tryLocateConfig(dir);
  if (!config) return die(`no devcontainer.json under ${dir}`);

  const project = readProjectConfig(resolveOrDie(dir, config));
  if (project.hadLegacyAppPort)
    return die(`devcontainer.json still contains "appPort".
      desolate allocates host ports itself, and an appPort publish occupies the
      same port the relay must bind -- the relay will fail with "address in use".
      Fix: delete the appPort entry and declare container-side ports instead:
        "customizations": { "desolate": { "ports": [5173] } }`);

  // fingerprint before deriving
  const fingerprint = spec.fingerprint(dir, config);

  config = deriveRunConfig(dir, config, project, name);

  try {
    enforcePolicy(
      name,
      resolveOrDie(dir, config),
      WORKSPACES,
      listProjects(WORKSPACES),
    );
  } catch (err: any) {
    die(`the spec desolate derived for ${name} does not pass the policy
      (refusing to start -- this is a desolate bug, not a problem with
      your devcontainer.json): ${err?.message ?? err}`);
  }

  const saved = spec.load(name);
  const existing = devcontainerId(dir, true);

  if (rebuild && existing) {
    docker.container.remove([existing]);
    desolog(`removed the existing container (--rebuild)`);
  } else if (existing && saved && saved !== fingerprint)
    console.log(`
  NOTE: this project's spec has changed since its container was created.
        'devcontainer up' reuses an existing container without re-reading
        devcontainer.json, so THE CHANGE IS NOT IN EFFECT below.
          .devcontainer fingerprint: ${saved} -> ${fingerprint}
        Apply it:  desolate --rebuild ${name}
        Why not automatic: recreating loses anything written inside the
        container outside /workspaces.
        `);

  const willCreate = rebuild || !existing;

  const map = ports.allocate(name, project.appPorts);
  const editorPort = map.get("editor")!;
  const token = connectionToken(name);

  desolog(`starting devcontainer for ${name} ...`);
  devcontainerUp(name, dir, config, noCache);
  if (willCreate) spec.save(name, fingerprint);
  installProxyCa(dir);
  startEditor(name, dir, project, token, config);
  recreateRelays(name, dir, map);

  if (!probeEditor(name, editorPort))
    return die(`editor did not answer through the relay on :${editorPort} -- check the log:
      devcontainer exec --workspace-folder ${dir} cat /tmp/openvscode-desolate.log
      and the relay itself:  docker logs ${relay.name(name, editorPort)}`);

  const id = devcontainerId(dir);
  const folder = (id && containerWorkspaceFolder(dir, id)) || dir;

  console.log(`\n  ${name} is ready:\n`);
  console.log(
    `    http://127.0.0.1:${editorPort}/?tkn=${token}&folder=${folder}\n`,
  );

  for (const [label, port] of map)
    if (label !== "editor")
      console.log(
        `    dev server on container port ${label} -> http://127.0.0.1:${port}`,
      );

  if (project.appPorts.length) {
    console.log(
      `\n  Start servers bound to 0.0.0.0 (e.g. 'npx vite --host 0.0.0.0');`,
    );
    console.log(
      `  the relay is live now, the URL answers once the server is up.`,
    );
  }
  console.log(
    `\n  Port map: desolate --ports ${name}    Stop: desolate --stop ${name}`,
  );
}

async function main(): Promise<void> {
  const { command, project, config, rebuild, noCache } = dieOnError(() =>
    parseArgs(process.argv.slice(2), WORKSPACES),
  );
  const dir = `${WORKSPACES}/${project}`;
  if (!fs.existsSync(dir)) die(`no such project: ${dir}`);

  if (command === "ports") showPorts(project);
  else if (command === "stop") stopProject(project, dir);
  else await runProject(project, dir, config, rebuild, noCache);
}

if (isEntryPoint(import.meta.url))
  main().catch((err) => {
    console.error(`desolate: ${err?.message ?? err}`);
    process.exit(1);
  });
