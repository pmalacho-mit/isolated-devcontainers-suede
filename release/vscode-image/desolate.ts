// desolate -- open a project's devcontainer as a full browser IDE, with dynamic
// port allocation for dev servers.
//
//   desolate myproject           -> starts devcontainer + editor, prints URL map
//   desolate owner/myrepo        -> same, for a repo cloned under its owner
//   desolate <p> --worktree wip  -> same, for one of that project's worktrees
//   desolate --rebuild <project> -> recreate the container from the current spec
//   desolate --stop <project>    -> stop devcontainer and remove its relays
//   desolate --ports <project>   -> show current port map
//   desolate --purge <project>   -> remove its container, relays, volumes, state
//
// A project is a directory under /workspaces, either a direct child or ONE
// level deeper so repositories can be scoped by owner (`cli.sh repo add` clones
// to /workspaces/<owner>/<repo>). Each project may also carry worktrees under
// `<project>/.worktrees/<name>`, which run as targets of their own. Docker
// object names can contain neither "/" nor "@", so volumes, relay containers
// and state files use `volumeNamespace`'s encoded form: `owner/repo` ->
// `owner__repo`, and `owner/repo@wip` -> `owner__repo--wt--wip`.
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
import {
  EVERY_TARGET,
  list as listTargets,
  meansEveryTarget,
  SLASH_REPLACEMENT,
  WORKTREE_REPLACEMENT,
  WORKTREES_DIRECTORY,
  validName,
  validWorktree,
  worktreesOf,
  target as resolveTarget,
  type Target,
} from "./projects.ts";
import { directory as stateDirectory, stateFile } from "./state.ts";
import * as worktrees from "./worktrees.ts";
import { parse as parseJsonc } from "./jsonc.ts";
import { isEntryPoint, run, type JSONValue } from "./utils.ts";
import { parseArgs, USAGE, type Args } from "./args.ts";
import { createDocker, type NetworkAttachment, type Runner } from "./docker.ts";
import {
  OVERLAY_KEY_LABEL,
  SERVER_DST,
  SHARED_DIRECTORIES,
  overlayOptions,
  overlayVolumes,
  type SharedDirectory,
} from "./overlay.ts";
import {
  EDITOR_INTERNAL_PORT,
  EDITOR_LOG,
  editorCustomizations,
  editorStartScript,
  type EditorCustomizations,
  isValidToken,
  mintToken,
} from "./editor.ts";
import * as relay from "./relays.ts";
import * as shutdown from "./shutdown.ts";
import { snapshotDirectory, snapshot, initDirectory } from "./snapshot.ts";
import {
  allocatePorts,
  ownRelayPorts,
  portMapFile,
  portRange,
  publishedPorts,
  type PortMap,
} from "./ports.ts";
import {
  labelledConfig,
  resolveSpec,
  tryLocateConfig,
  type ResolvedSpec,
} from "./devcontainer.ts";
import {
  caTrustingImage,
  installInstructions,
  trust,
} from "./certificates.ts";

/** Overridable so this can be pointed at a throwaway workspace, and because the
 *  broker validates against the same variable and hands us its environment --
 *  the two disagreeing about where projects live is not a state worth having.
 *  Nothing sets it in production. */
const WORKSPACES = process.env.DESOLATE_WORKSPACES ?? "/workspaces";

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
  status: (argv, options) => run.status("docker", argv, options),
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

/** How to name this target back on a command line, so every hint printed below
 *  can be pasted rather than translated. */
const invocation = ({ project, worktree }: Target) =>
  worktree ? `${project} --worktree ${worktree}` : project;

const readOrDie = (path: string, hint: string) => {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return die(`cannot read ${path} -- ${hint}`);
  }
};

const resolveOrDie = (target: Target, config: string) => {
  try {
    return resolveSpec(target.dir, config);
  } catch (err) {
    return die(
      `Unable to resolve devcontainer spec for ${target.name} @ ${config}:\n\n${err}`,
    );
  }
};

const overrideConfigFlag = (config?: string) =>
  config ? ["--override-config", config] : [];

const stateDir = stateDirectory(WORKSPACES);

const ports = {
  load: (target: Target): PortMap => {
    try {
      return portMapFile.parse(
        fs.readFileSync(stateFile(target, "ports"), "utf8"),
      );
    } catch {
      return new Map(); // no saved map yet -- fine
    }
  },
  save: (target: Target, map: PortMap) => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile(target, "ports"), portMapFile.format(map));
  },
  allocate: (target: Target, appPorts: number[]): PortMap => {
    const map = dieOnError(() =>
      allocatePorts(
        {
          range: portRange(process.env),
          published: publishedPorts(docker.container.publishedPortsTable()),
          ownRelayPorts: ownRelayPorts(ownRelayNames(target)),
          previous: ports.load(target),
        },
        appPorts,
      ),
    );
    ports.save(target, map);
    return map;
  },
};

const spec = {
  /** Capture what the running container was actually built from. */
  fingerprint: (dir: string, config?: string) => {
    const parts: string[] = [];
    /** @param label the location RELATIVE to the tree being walked. A snapshot's
     *  absolute path changes every call, so hashing it would miss every run. */
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

  load(target: Target) {
    try {
      return fs.readFileSync(stateFile(target, "spec"), "utf8").trim();
    } catch {
      return;
    }
  },

  save(target: Target, fingerprint: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile(target, "spec"), fingerprint + "\n");
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
   * Build (or reuse) one target's copy-on-write view of a shared directory.
   * @returns the volume name; dies loudly rather than degrading to a shared mount. */
  ensureVolume: (target: Target, mount: SharedDirectory) => {
    const { view: volume, data } = overlayVolumes(target, mount.name);
    const want = sha16(readOrDie(mount.identityFile, mount.missing));

    const have = docker.volume.label(volume, OVERLAY_KEY_LABEL);
    if (have === want) {
      if (overlay.intact(volume, data, mount.lower)) return volume;
      desolog(
        `${target.name}'s view of ${mount.lower} is stamped current but its
          backing volume '${data}' is missing or has moved (pruned?) -- rebuilding`,
      );
    } else if (have)
      desolog(
        `${mount.lower} changed -- rebuilding ${target.name}'s view of it`,
      );

    const cleanup = () => docker.volume.remove([volume, data]);

    cleanup();

    const fail = (reason: string): never => {
      cleanup();
      return die(
        `could not build ${target.name}'s copy-on-write view of ${mount.lower}: ${reason}.

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

    desolog(`built ${target.name}'s copy-on-write view of ${mount.lower}`);
    return volume;
  },
};

/** Names of this target's relay containers (running or not). */
const ownRelayNames = (target: Target) =>
  docker.container.namesWithLabel(relay.label(target));

/**
 * The container this project's workspace folder belongs to, "" if there is none.
 *
 * The config file is derived here rather than taken as an argument, and that is
 * the point: every caller has a `config` in hand -- the snapshot, or the
 * rewritten copy from deriveRunConfig -- and it is the WRONG value. The CLI
 * labels a container with the config inside the workspace folder whatever
 * --override-config said, so passing what we read matches nothing. See
 * labelledConfig.
 */
const devcontainerId = (dir: string, includeStopped = false) =>
  docker.container.forWorkspace(dir, {
    includeStopped,
    configFile: labelledConfig(dir),
  });

interface ProjectConfig extends EditorCustomizations {
  appPorts: number[];
  hadLegacyAppPort: boolean;
  /** Resolved `image`, "" for Dockerfile/compose-based projects. */
  image: string;
  /** True when the project builds from its own Dockerfile rather than an image. */
  usesDockerfile: boolean;
  /** Base images whose tag should point at a CA-trusting derivative inside this
   *  project's own daemon. */
  shadowImages: string[];
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

  const customizations = config.customizations ?? {};

  // Shape is enforced by policy.ts, which runs before any of these reach a
  // container; this is the same defensive projection the two keys above get,
  // and it keeps a malformed entry from reaching an argv either way.
  const shadowImages: string[] = Array.isArray(
    config.customizations?.desolate?.shadowImages,
  )
    ? config.customizations.desolate.shadowImages.filter(
        (entry: unknown): entry is string =>
          typeof entry === "string" && entry.trim() !== "",
      )
    : [];

  return {
    appPorts,
    ...editorCustomizations(customizations),
    hadLegacyAppPort: config.appPort !== undefined,
    image: typeof config.image === "string" ? config.image : "",
    usesDockerfile: Boolean(config.build?.dockerfile ?? config.dockerFile),
    shadowImages,
  };
}

/** Where deriveRunConfig materialises its rewritten specs -- one DIRECTORY per
 *  project, not one file. The orchestrator's own /tmp, so no other container can
 *  touch what we are about to start from. */
const RUN_CONFIG_DIR = "/tmp/desolate-run-config";

/** Where a DIRECT invocation (`cli.sh desolate`, i.e. not via the broker)
 *  snapshots the spec it validated. Deliberately not the broker's own
 *  directory: that one is wiped when the broker starts, and the two paths
 *  should not be able to pull the ground out from under each other. */
const DIRECT_SPEC_DIR = "/tmp/desolate-direct-specs";

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

/** A spec key that holds a list, read the way the CLI reads it -- a lone string
 *  where a list belongs is coerced rather than dropped. */
const asList = (value: JSONValue | undefined): JSONValue[] =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value
      : [value];

/**
 * Must this target's folder appear inside its container at the same absolute
 * path it has outside?
 *
 * A worktree has no say: its `.git` file and the project's `commondir` record
 * absolute paths, so anywhere else is a container where git does not work at
 * all -- which is why a declared workspaceMount is REPLACED rather than
 * respected. A nested project only needs it when it declared nothing, because
 * the CLI's default (`/workspaces/<basename>`) would drop its owner and two
 * owners' repos of one name would collide.
 */
const mustMirrorItsOwnPath = (
  target: Target,
  spec: ResolvedSpec["configuration"],
) =>
  target.worktree !== undefined ||
  (target.project.includes("/") &&
    spec.workspaceFolder === undefined &&
    spec.workspaceMount === undefined);

/**
 * Narrow, derived rewrites of a validated spec. Returns the --config path to
 * use from here on (unchanged when nothing applies).
 */
function deriveRunConfig(
  target: Target,
  config: string,
  cfg: ProjectConfig,
): string {
  const { dir, name } = target;
  const tag = caTrustedBaseImage(cfg);
  const src = config ?? tryLocateConfig(dir);

  if (!src) return die(`Unable to locate devcontainer config for ${name}`);

  let spec: ResolvedSpec["configuration"];
  try {
    spec = parseJsonc(fs.readFileSync(src, "utf8"));
  } catch {
    return die(`Failed to parse devcontainer config for ${name}`);
  }

  if (typeof spec !== "object" || spec === null)
    return die(`Parsed devcontainer config was not an object for ${name}`);

  const applied: string[] = [];

  if (mustMirrorItsOwnPath(target, spec)) {
    spec.workspaceFolder = dir;
    spec.workspaceMount = `source=${dir},target=${dir},type=bind`;
    applied.push(`workspace mounted at ${dir}, mirroring its path outside`);
  }

  const mask = worktrees.runArgs(target);
  if (mask.length) {
    spec.runArgs = [...asList(spec.runArgs), ...mask];
    applied.push(
      `${WORKTREES_DIRECTORY} hidden, so one filename means one file`,
    );
  }

  if (tag) {
    spec.image = tag;
    applied.push(`base image ${tag} (trusts the proxy CA)`);
  }

  if (applied.length === 0) return src; // nothing changed, config = runConfig

  for (const note of applied) desolog(`${note}`);

  const out = `${RUN_CONFIG_DIR}/${target.namespace}`;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });

  const srcDir = path.dirname(src);
  if (config || path.basename(srcDir) === ".devcontainer")
    snapshotDirectory(config ? srcDir : dir, srcDir, out);

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

const readToken = (target: Target) => {
  try {
    return fs.readFileSync(stateFile(target, "token"), "utf8").trim();
  } catch {
    return "";
  }
};

/** The token this target's URLs already carry, or "" when there is none worth
 *  reusing. Separate from `connectionToken` because reading is not minting: a
 *  listing that invented a token would invalidate the URL already in a
 *  browser tab. */
const savedToken = (target: Target) => {
  const existing = readToken(target);
  return isValidToken(existing) ? existing : "";
};

function connectionToken(target: Target): string {
  const file = stateFile(target, "token");
  const existing = readToken(target);
  if (isValidToken(existing)) return existing;
  if (existing)
    // Do not reuse it and do not try to repair it -- mint a fresh one. The URL
    // printed at the end carries the new token, so the only visible effect is
    // that an older bookmarked link stops working.
    console.error(
      `desolate: warning -- ${file} does not hold a valid token; ` +
        `replacing it (a previously bookmarked URL will stop working)`,
    );
  fs.mkdirSync(stateDir, { recursive: true });
  const token = mintToken((length) =>
    crypto.getRandomValues(new Uint8Array(length)),
  );
  fs.writeFileSync(file, token + "\n");
  return token;
}

/**
 * The mounts desolate adds to every container, over and above the ones the spec
 * asks for.
 *
 * They are passed as `--mount` flags rather than written into the spec, and
 * that is what keeps them out of a project's reach: policy.ts refuses every
 * bind a spec declares, so a project cannot name `/workspaces/other/.git` --
 * or its own -- however it spells it.
 */
const injectedMounts = (target: Target) => [
  ...SHARED_DIRECTORIES.map(
    (mount) =>
      `type=volume,source=${overlay.ensureVolume(target, mount)},target=${mount.target}`,
  ),
  ...worktrees.mounts(target),
];

const devcontainerUp = (target: Target, config: string, noCache = false) => {
  const args = [
    "up",
    "--workspace-folder",
    target.dir,
    ...overrideConfigFlag(config),
    ...injectedMounts(target).flatMap((mount) => ["--mount", mount]),
  ];

  if (noCache) args.push("--build-no-cache");
  const code = run.status("devcontainer", args, { quiet: true });
  if (code !== 0) die(`devcontainer up failed (exit ${code})`);
};

const trustMessage = {
  caInstalled: "desolate: proxy CA installed in devcontainer",

  caFailed:
    "desolate: warning -- could not install proxy CA (TLS may fail);\n" +
    "          check that the image has update-ca-certificates, and the\n" +
    "          line above for a daemon that did not come back",

  noDaemonToShadowIn:
    "desolate: warning -- this project declares shadowImages but has no docker\n" +
    "          CLI, so it has no daemon of its own to shadow them in. Add the\n" +
    "          docker-in-docker feature to devcontainer.json, or drop the key.",

  shadowing: (images: string[]) =>
    `desolate: shadowing ${images.join(", ")}\n` +
    `          (a first run pulls and rebuilds each one -- minutes, once)`,

  shadowingUnfinished: (images: string[]) =>
    `desolate: warning -- the shadowImages job did not finish cleanly;\n` +
    `          builds FROM ${images.join(", ")} may not trust the proxy CA`,
} as const;

/** Container-root is the orchestrator's to take via the daemon, so the project
 *  never needs sudo and no postCreateCommand is required. Both trust steps are
 *  slow enough that silence would read as a hang, so both show their progress
 *  rather than swallowing it. */
const trustStepSucceeds = (id: string, argv: string[]) =>
  docker.container.execAsRoot(id, argv, { quiet: false }) === 0;

/** Returns with the container's own docker daemon, if it has one, restarted AND
 *  answering -- which is what lets everything downstream stop guessing at
 *  readiness. */
function installProxyCa(dir: string): void {
  const id = devcontainerId(dir);
  if (!id) return;

  const installed = trustStepSucceeds(id, trust.inContainer());
  console.log(installed ? trustMessage.caInstalled : trustMessage.caFailed);
}

/**
 * Apply `customizations.desolate.shadowImages`, if the project declared any.
 *
 * In the FOREGROUND, and deliberately: on a first start this pulls and rebuilds
 * every image named, which is minutes of nested image build inside a container
 * whose lifetime desolate itself hands to the user. Detached, that work could
 * still be holding overlayfs mounts when `desolate --stop` arrives a minute
 * later -- and a container stopped mid-build cannot tear its mount namespace
 * down, so its init never reports an exit and the daemon supervising it hangs
 * waiting for one. Blocking binds the work to a command the user can see and
 * interrupt; its progress goes to the terminal for the same reason. Nothing
 * here is allowed to FAIL the start.
 *
 * Run on every start rather than only on create, because it is the cheap thing
 * to do: a derivative that already trusts the current CA is a handful of local
 * inspects and a retag, so only a container that was recreated (or a project
 * that just added an image) pays the pull. Gating on `willCreate` would instead
 * silently ignore a newly declared image until the next --rebuild.
 */
function shadowBaseImages(dir: string, images: string[]): void {
  if (!images.length) return;

  const id = devcontainerId(dir);
  if (!id) return;

  if (!docker.container.hasDockerCli(id))
    return console.log(trustMessage.noDaemonToShadowIn);

  console.log(trustMessage.shadowing(images));

  if (!trustStepSucceeds(id, trust.inBuilds(images)))
    console.log(trustMessage.shadowingUnfinished(images));
}

function startEditor(
  target: Target,
  cfg: ProjectConfig,
  token: string,
  config: string,
): void {
  const dir = target.dir;
  const script = editorStartScript(SERVER_DST, cfg, token);
  const code = run.status("devcontainer", [
    "exec",
    "--workspace-folder",
    dir,
    ...overrideConfigFlag(config),
    "bash",
    "-lc",
    script,
  ]);
  if (code === 0) return console.log("desolate: editor started");

  if (code === 126) {
    console.log(
      "desolate: container has stale mounts (runc rc 126) -- recreating...",
    );
    const stale = devcontainerId(dir, true);
    if (stale) docker.container.remove([stale]);
    devcontainerUp(target, config);
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
  target: Target,
  { network, ip: targetIp }: NetworkAttachment,
  { hostPort, targetPort }: Record<`${"host" | "target"}Port`, number>,
) => {
  // Chain: Mac:hostPort -> (daemon #0 range publish) -> dind ns:hostPort
  //        -> (this relay's publish on daemon #1) -> socat -> devcontainer IP.
  // The relay joins the devcontainer's network so `ip` is directly routable.
  const code = docker.relay.start({
    image: relay.IMAGE,
    name: relay.name(target, hostPort),
    label: relay.label(target),
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
  else console.log(`desolate: relay started for ${hostPort}`);

  const checkSocatRelay = { intervalMs: 100, retries: 20 } as const;
  const name = relay.name(target, hostPort);
  for (let i = 0; i < checkSocatRelay.retries; i++) {
    const state = docker.container.state(name);
    if (state === "running") return; // relay is up
    if (state === "exited" || state === "restarting") break;
    console.log(`desolate: waiting for ${hostPort} relay to be running...`);
    sleep(checkSocatRelay.intervalMs);
  }

  const why = docker.container.logsTail(name, 3);
  die(
    [
      `relay for ${hostPort} started but died.\n      socat says: ${why}`,
      `      Most common cause: something else already publishes ${hostPort} on the`,
      `      inner daemon -- usually a leftover "appPort" in devcontainer.json.`,
      `      Remove appPort (desolate allocates host ports itself), then:`,
      `        docker rm -f $(docker ps -aq --filter label=devcontainer.local_folder=${target.dir})`,
      `        desolate ${invocation(target)}`,
    ].join("\n"),
  );
};

/** One relay per mapped port, replacing whatever this target had before. */
function recreateRelays(target: Target, map: PortMap): void {
  const cid = devcontainerId(target.dir);
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
  else
    console.log(`desolate: devcontainer relays will use network: ${network}`);

  const old = ownRelayNames(target);
  docker.container.remove(old);

  for (const [label, hostPort] of map)
    startRelay(target, attach, {
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
function probeEditor(target: Target, port: number): boolean {
  const config = { retries: 5, gapMs: 1000 } as const;
  const name = relay.name(target, port);
  for (let attempt = 0; attempt < config.retries; attempt++) {
    if (docker.relay.answers(name, port)) return true;
    if (attempt < config.retries - 1) sleep(config.gapMs);
  }
  return false;
}

function showPorts(target: Target): void {
  const map = ports.load(target);
  if (map.size === 0)
    return console.log(`no ports allocated for ${target.name}`);

  for (const [label, port] of map) {
    const name = label === "editor" ? "editor       " : `container:${label}`;
    console.log(`  ${name} -> http://127.0.0.1:${port}`);
  }
}

/**
 * Every target that is UP, project or worktree, across all of /workspaces.
 *
 * One `docker ps` decides it, rather than one per directory on disk: the
 * question scales with how many projects EXIST, and the answer is usually a
 * handful. What comes back is display-grade, which is why `stopTarget` below
 * still resolves each container by its full identity before touching it.
 */
const runningTargets = (): Target[] => {
  const up = docker.container.runningWorkspaceFolders();
  return listTargets(WORKSPACES).filter(({ dir }) => up.has(dir));
};

/** The URL that opens this target's editor, or "" when nothing is saved to
 *  build one from. Same shape `runTarget` prints, so a listed row is as usable
 *  as the line printed at start. */
const editorUrl = (target: Target): string => {
  const port = ports.load(target).get("editor");
  const token = savedToken(target);
  if (!port || !token) return "";

  const id = devcontainerId(target.dir);
  const folder = (id && containerWorkspaceFolder(target.dir, id)) || target.dir;
  return `http://127.0.0.1:${port}/?tkn=${token}&folder=${folder}`;
};

/**
 * What is running right now, and how to open it.
 *
 * Deliberately NOT the list of directories that could be started: that question
 * is answered by tab-completion the moment it is asked, whereas "what did I
 * leave up, and where is it" has no other answer at all.
 */
function showRunning(): void {
  const running = runningTargets();
  if (!running.length)
    return console.log(
      "nothing is running.  Start something:  desolate <project>",
    );

  const width = Math.max(...running.map(({ name }) => name.length));
  for (const target of running)
    console.log(
      `  ${target.name.padEnd(width)}  ` +
        `${target.worktree ? "worktree" : "project "}  ${editorUrl(target)}`,
    );

  console.log(
    `\n  Ports: desolate --ports <project>    ` +
      `Stop: desolate --stop <project> | --stop all`,
  );
}

/**
 * Stop every running target.
 *
 * Worktrees first, and that ordering is the whole reason this is not a plain
 * loop in list order: stopping a project while its own worktrees are up is
 * REFUSED, and that refusal exits the process. Taking them down first means the
 * refusal never has cause to fire, so `--stop all` cannot stop half the stack
 * and then die on the arrangement it was asked to take apart.
 */
function stopAll(): void {
  const running = runningTargets();
  if (!running.length) return console.log("nothing is running");

  for (const target of [...running].sort(worktreesFirst)) {
    console.log(`stopping ${target.name} ...`);
    stopTarget(target);
  }
}

const worktreesFirst = (a: Target, b: Target) =>
  Number(Boolean(b.worktree)) - Number(Boolean(a.worktree));

/** The worktrees of this project whose containers are up right now. */
const runningWorktrees = (target: Target) =>
  worktreesOf(target).filter(({ dir }) => devcontainerId(dir));

/**
 * Refuse to stop a project while its worktrees are running.
 *
 * They are separate containers with separate relays, so stopping the project
 * leaves them up -- and "I stopped it, why is the port still answering?" is a
 * question with no visible answer. Naming each one is the whole refusal.
 */
function refuseIfWorktreesAreRunning(target: Target): void {
  if (target.worktree) return;
  const running = runningWorktrees(target);
  if (running.length === 0) return;

  die(`${target.name} has ${running.length} worktree(s) still running.
      They are containers of their own, so stopping the project would leave
      them up. Stop them first:
${running.map((w) => `        desolate --stop ${invocation(w)}`).join("\n")}`);
}

function stopTarget(target: Target): void {
  refuseIfWorktreesAreRunning(target);

  const relays = ownRelayNames(target);
  if (relays.length) {
    docker.container.remove(relays);
    console.log("removed relays");
  }
  const id = devcontainerId(target.dir);
  if (id) {
    shutdown.devcontainer(docker, id, desolog);
    // Say that the container is KEPT. Stopping and starting again looks like it
    // should pick up an edited devcontainer.json, and it does not -- `up`
    // restarts the existing container rather than rebuilding from the spec.
    console.log(
      `stopped ${target.name} (container kept, so restarting is fast;`,
    );
    console.log(
      `         use 'desolate --rebuild ${invocation(target)}' to apply spec changes)`,
    );
  } else console.log("not running");
}

/**
 * Remove everything desolate created for this target: its container, its
 * relays, the copy-on-write views it was given, and its saved ports, token and
 * spec fingerprint.
 *
 * Named volumes the PROJECT declared are deliberately left alone -- this is
 * what `cli.sh worktree remove` calls, and a branch going away is not a reason
 * to delete a database.
 */
function purgeTarget(target: Target): void {
  refuseIfWorktreesAreRunning(target);

  if (devcontainerId(target.dir))
    die(`${target.name} is running. Purging would pull its filesystem out from
      under it, so stop it first:
        desolate --stop ${invocation(target)}`);

  docker.container.remove(ownRelayNames(target));
  const id = devcontainerId(target.dir, /* includeStopped */ true);
  if (id) docker.container.remove([id]);

  docker.volume.remove(
    SHARED_DIRECTORIES.flatMap((mount) =>
      Object.values(overlayVolumes(target, mount.name)),
    ),
  );

  for (const kind of ["ports", "spec", "token"] as const)
    fs.rmSync(stateFile(target, kind), { force: true });

  console.log(`purged ${target.name} (container, relays, volumes and state)`);
}

async function runTarget(
  target: Target,
  config?: string,
  rebuild = false,
  noCache = false,
): Promise<void> {
  const { name, dir } = target;
  config ??= dieOnError(() => snapshot(target, { specs: DIRECT_SPEC_DIR }));

  const project = readProjectConfig(resolveOrDie(target, config));
  if (project.hadLegacyAppPort)
    return die(`devcontainer.json still contains "appPort".
      desolate allocates host ports itself, and an appPort publish occupies the
      same port the relay must bind -- the relay will fail with "address in use".
      Fix: delete the appPort entry and declare container-side ports instead:
        "customizations": { "desolate": { "ports": [5173] } }`);

  // fingerprint before deriving
  const fingerprint = spec.fingerprint(dir, config);

  config = deriveRunConfig(target, config, project);

  try {
    enforcePolicy(
      target,
      resolveOrDie(target, config),
      listTargets(WORKSPACES),
    );
  } catch (err: any) {
    die(`the spec desolate derived for ${name} does not pass the policy
      (refusing to start -- this is a desolate bug, not a problem with
      your devcontainer.json): ${err?.message ?? err}`);
  }

  const saved = spec.load(target);
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
        Apply it:  desolate --rebuild ${invocation(target)}
        Why not automatic: recreating loses anything written inside the
        container outside /workspaces.
        `);

  const willCreate = rebuild || !existing;

  const map = ports.allocate(target, project.appPorts);
  const editorPort = map.get("editor")!;
  const token = connectionToken(target);

  desolog(`starting devcontainer for ${name} ...`);
  devcontainerUp(target, config, noCache);
  if (willCreate) spec.save(target, fingerprint);
  installProxyCa(dir);
  shadowBaseImages(dir, project.shadowImages);
  startEditor(target, project, token, config);
  recreateRelays(target, map);

  if (!probeEditor(target, editorPort))
    return die(`editor did not answer through the relay on :${editorPort} -- check the log:
      devcontainer exec --workspace-folder ${dir} cat ${EDITOR_LOG}
      and the relay itself:  docker logs ${relay.name(target, editorPort)}`);

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
  const paste = invocation(target);
  console.log(
    `\n  Port map: desolate --ports ${paste}    Stop: desolate --stop ${paste}`,
  );
}

/** Turn a validated command line into the one directory it denotes.
 *
 *  Worktrees are NOT created here. `git worktree add` reads the repository's
 *  own config and fires its hooks, and this process holds the inner Docker
 *  socket; the editor container is where git already runs against project
 *  content, so that is where creating one belongs. */
function targetFromArguments(project: string, worktree?: string): Target {
  if (!validName(project))
    die(`'${project}' is not a usable project name.
      A project is one path segment under /workspaces, or two for an
      owner-scoped repo ('owner/repo'). Each segment must start with a letter
      or digit and hold only [A-Za-z0-9._-], and the name cannot contain
      '${SLASH_REPLACEMENT}' or '${WORKTREE_REPLACEMENT}' (that is how '/' and
      a worktree are encoded into docker object names).`);

  if (worktree !== undefined && !validWorktree(worktree))
    die(`'${worktree}' is not a usable worktree name.
      A worktree is ONE path segment under <project>/.worktrees, starting with a
      letter or digit. It names a DIRECTORY, not a branch -- a branch with a '/'
      in it is fine, it just gets a single-segment directory to live in.`);

  const target = dieOnError(() => resolveTarget(WORKSPACES, project, worktree));

  if (!fs.existsSync(target.projectDir))
    die(`no such project: ${target.projectDir}`);

  if (!fs.existsSync(target.dir))
    die(`no such worktree: ${target.dir}
      Create it from the editor, where git already runs against this project:
        ./cli.sh worktree add ${project} ${worktree}
      (or, in the editor's terminal: worktree add ${project} ${worktree})`);

  return target;
}

/** @throws when a command that needs a target was parsed without one. The
 *  grammar allows that only for `list` and `--all`, both handled before this. */
const targetOf = ({ project, worktree }: Args): Target =>
  project === undefined
    ? die(`that command needs a project.\n${USAGE}`)
    : targetFromArguments(project, worktree);

const ALL_IS_ALSO_A_PROJECT =
  `desolate: '${EVERY_TARGET}' is a project in ${WORKSPACES}, so this stops ` +
  `THAT project.\n          To stop every running target: desolate --stop --all`;

/** `--all`, the word `all`, or one named target -- in that order, because only
 *  the first two can be widened by accident. */
function stopFromArguments(args: Args): void {
  if (args.all) return stopAll();
  if (meansEveryTarget(WORKSPACES, args.project)) return stopAll();

  if (args.project === EVERY_TARGET) console.log(ALL_IS_ALSO_A_PROJECT);
  stopTarget(targetOf(args));
}

async function main(): Promise<void> {
  initDirectory(DIRECT_SPEC_DIR);

  const args = dieOnError(() => parseArgs(process.argv.slice(2), WORKSPACES));

  if (args.command === "list") return showRunning();
  if (args.command === "stop") return stopFromArguments(args);

  const target = targetOf(args);
  if (args.command === "ports") showPorts(target);
  else if (args.command === "purge") purgeTarget(target);
  else await runTarget(target, args.config, args.rebuild, args.noCache);
}

if (isEntryPoint(import.meta.url))
  main().catch((err) => {
    console.error(`desolate: ${err?.message ?? err}`);
    process.exit(1);
  });
