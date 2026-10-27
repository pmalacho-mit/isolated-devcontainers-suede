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
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as dind from "./dind.ts";
import { builtBeyondDeclared, daemonOf, enforcePolicy, type Daemon } from "./policy.ts";
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
import { isEntryPoint, isWithin, run, sha16, type JSONValue } from "./utils.ts";
import { parseArgs, USAGE, type Args } from "./args.ts";
import { hint } from "./hints.ts";
import {
  createDocker,
  parseWorktreeChanges,
  type NetworkAttachment,
  type Runner,
} from "./docker.ts";
import {
  CA_DIR,
  DESOLATE_DIR,
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
  externalEnvironment,
  targetEnvironment,
  externalProfile,
  type EditorCustomizations,
  isValidToken,
  mintToken,
} from "./editor.ts";
import * as relay from "./relays.ts";
import * as shutdown from "./shutdown.ts";
import { ingressDirectory, IngressMissingError, ownedForwards } from "./ingress-files.ts";
import { ask as askSupervisor } from "./supervisor-client.ts";
import { snapshotDirectory, snapshot, initDirectory } from "./snapshot.ts";
import {
  allocatePorts,
  ingressPorts,
  movePort,
  ownRelayPorts,
  portBase,
  portMapFile,
  publishedPorts,
  type PortMap,
  type PortWorld,
} from "./ports.ts";
import {
  labelledConfig,
  remoteUserOf,
  resolveSpec,
  tryLocateConfig,
  type ResolvedSpec,
} from "./devcontainer.ts";
import {
  caTrustingImage,
  pinnedImage,
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

/**
 * Which daemon this process is driving.
 *
 * Every docker and devcontainer call it makes is a CLI that reads DOCKER_HOST,
 * so choosing a daemon IS pointing that at its socket: the shared dind's (the
 * orchestrator's own environment), or a project dind's, which the supervisor
 * keeps in one directory each of the dind-sockets volume (dind.sockets).
 */
const daemons = {
  shared: process.env.DOCKER_HOST ?? "unix:///run/inner/docker.sock",
  socketOf: (target: Target, daemon: Daemon) =>
    daemon === "project" ? `unix://${dind.sockets.forOrchestrator(target)}` : daemons.shared,
  use: (target: Target, daemon: Daemon) => {
    process.env.DOCKER_HOST = daemons.socketOf(target, daemon);
  },
  saved: (target: Target): Daemon => {
    try {
      return fs.readFileSync(stateFile(target, "daemon"), "utf8").trim() === "project" ? "project" : "shared";
    } catch {
      return "shared";
    }
  },
  save: (target: Target, daemon: Daemon) => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile(target, "daemon"), `${daemon}\n`);
  },
  /** Does the daemon at this socket answer right now? A project dind the
   *  reaper stopped does not, and nothing of the target is running on it. */
  answers: (socket: string) => {
    // A question, not a command: a daemon that is down is an answer, and the
    // CLI's "failed to connect" on stderr would print through --list.
    try {
      execFileSync("docker", ["-H", socket, "info", "--format", "ok"], { stdio: "ignore", timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  },
};

/** Every project dind and the VM's headroom, as the supervisor answers
 *  `status`, printed as JSON for a program (the editor's extension). */
async function showDinds(): Promise<void> {
  const answer = await supervisor.ask({ op: "status" });
  if (answer.ok !== true) return die(`the supervisor did not say: ${answer.error ?? "no answer"}`);
  console.log(JSON.stringify({ dinds: answer.dinds ?? [], headroom: answer.headroom ?? null }));
}

/** The supervisor (supervisor.ts), over its socket in supervisor-run. */
const supervisor = {
  socket: process.env.DESOLATE_SUPERVISOR ?? "/run/supervisor/supervisor.sock",
  ask: (request: Record<string, string>) =>
    askSupervisor(supervisor.socket, request, (line) => desolog(line)),
};

/**
 * T3.4. A target whose existing container, on the shared daemon, predates the
 * daemon it runs on now -- the pre-v2 privileged shape with a nested dockerd,
 * or one now moving to a daemon of its own -- needs --rebuild: both would
 * otherwise keep running beside the new one, over the same directory. With
 * it, that container goes, with its relays, its forwards, and the nested
 * daemon's dind-var-lib-* volumes (orphaned by definition once no nested
 * daemon exists). Called while DOCKER_HOST is the shared daemon.
 */
function migrateOffTheSharedDaemon(target: Target, daemon: Daemon, rebuild: boolean): void {
  const legacy = devcontainerId(target.dir, true);
  if (!legacy) return;
  const privileged = docker.container.isPrivileged(legacy);
  if (daemon === "shared" && !privileged) return;

  const why = privileged
    ? "it was created --privileged, with a Docker daemon inside it (docker-in-docker), which desolate no longer runs"
    : "it now runs on a Docker daemon of its own, and its existing container is on the shared one";
  if (!rebuild)
    die(`${target.name} needs migrating: ${why}.
      Recreate it -- this discards anything written inside the old container outside
      /workspaces (/workspaces itself is untouched):
        ${hint.desolate(`--rebuild ${invocation(target)}`)}
      If devcontainer.json still says docker-in-docker, switch it first to
        "ghcr.io/devcontainers/features/docker-outside-of-docker:1"`);

  const nested = docker.container.volumeNames(legacy).filter((name) => /^dind-var-lib-(docker|containerd)-/.test(name));
  docker.container.remove(ownRelayNames(target));
  ingressFiles.withdraw(ports.load(target), target);
  docker.container.remove([legacy]);
  docker.volume.remove(nested);
  desolog(`migrated: removed the old container${nested.length ? ` and its nested daemon's volumes (${nested.join(", ")})` : ""}`);
}

/**
 * A target that no longer declares docker-outside-of-docker still has its
 * container on its own dind, over the same directory -- left running there,
 * --stop would no longer reach it (the saved daemon is about to say shared)
 * and the reaper would never stop that dind (it hosts a devcontainer). So it
 * is removed, on --rebuild like the other migration. A dind that is not up
 * runs nothing of it; what it keeps goes with that dind's purge.
 */
function migrateOffItsOwnDaemon(target: Target, daemon: Daemon, rebuild: boolean): void {
  if (daemon !== "shared" || daemons.saved(target) !== "project") return;
  if (!driveSaved(target)) return void daemons.use(target, "shared");
  const old = devcontainerId(target.dir, true);
  if (old) {
    if (!rebuild)
      die(`${target.name} needs migrating: it no longer uses docker-outside-of-docker, and its
        existing container is on its own daemon. Recreate it on the shared one -- this discards
        anything written inside the old container outside /workspaces:
          ${hint.desolate(`--rebuild ${invocation(target)}`)}`);
    docker.container.remove(ownRelayNames(target));
    ingressFiles.withdraw(ports.load(target), target);
    docker.container.remove([old]);
    desolog(`migrated: removed the old container from ${dind.name(target)}`);
  }
  daemons.use(target, "shared");
}

/** Drive the daemon this target last ran on. False when that is a project
 *  dind that is not up (the reaper stopped it), in which case nothing of the
 *  target is running and there is nothing to drive. */
const driveSaved = (target: Target) => {
  const daemon = daemons.saved(target);
  if (daemon === "project" && !daemons.answers(daemons.socketOf(target, "project"))) return false;
  daemons.use(target, daemon);
  return true;
};

/**
 * Start (or confirm) this project's own daemon, and drive it from here on.
 *
 * Fail closed: a project that declares docker-outside-of-docker never falls
 * back to the shared daemon -- that would hand it a socket that is root over
 * every other project.
 */
async function useProjectDaemon(target: Target): Promise<void> {
  const answer = await supervisor.ask({ op: "ensure", project: target.project });
  if (answer.ok !== true)
    die(`${target.name} uses docker-outside-of-docker, so it runs on a daemon of its own,
      and that daemon is not available -- refusing to start (it never falls back to the
      shared one). The supervisor said: ${answer.error ?? "nothing"}`);
  daemons.use(target, "project");
}

/** Blocking sleep (we are in a sequential CLI, not an event loop hot path). */
const sleep = (ms: number) => execFileSync("sleep", [String(ms / 1000)]);

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

/**
 * desolate-ingress's ports/ directory (ingress-files.ts), for targets: each
 * file's owner is the target that claimed it.
 *
 * A file names the dind the target's relays publish on: its project's own,
 * or the shared one (dindOf).
 */
const ingress = ingressDirectory(process.env.DESOLATE_INGRESS_PORTS ?? "/run/ingress/ports");
const ingressFiles = {
  owner: (target: Target) => target.namespace,
  /** The dind a target's relays publish on, as dinds/ names it. */
  dindOf: (target: Target, daemon: Daemon) => (daemon === "project" ? dind.name(target) : "desolate-dind"),
  read: (): Map<string, string> => {
    try {
      return ingress.read();
    } catch (err) {
      if (!(err instanceof IngressMissingError)) throw err;
      return die(`the ingress directory ${err.message} is missing, so no port could
        reach your Mac. The VM predates desolate-ingress: install it, then restart:
          ${hint.mac("vm install --proxy-only")}  and  ${hint.mac("down")} / ${hint.mac("up")}`);
    }
  },
  claim: (hostPort: number, target: Target, dindName: string) =>
    ingress.claim(hostPort, dindName, ingressFiles.owner(target)),
  release: (hostPort: number, target: Target) => ingress.release(hostPort, ingressFiles.owner(target)),
  publish: (previous: PortMap, map: PortMap, target: Target, dindName: string) => {
    const lost = ingress.publish(previous, map, dindName, ingressFiles.owner(target));
    if (lost.length)
      die(`${target.name}'s forwards on ${lost.join(", ")} are held by another target now
        (${lost.map((port) => ingress.ownerOf(port) || "a file that names no owner").join(", ")}).
        Start it again for fresh ports.`);
  },
  withdraw: (map: PortMap, target: Target) => ingress.withdraw(map, ingressFiles.owner(target)),
  ownerOf: (hostPort: number) => ingress.ownerOf(hostPort),
};

const CLAIM_ATTEMPTS = 5;

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
  /** Who holds what: every ingress forward, and anything the inner daemon
   *  publishes (a stricter union than either alone, at no cost). */
  world: (target: Target): PortWorld => ({
    base: dieOnError(() => portBase(process.env)),
    published: new Map([
      ...publishedPorts(docker.container.publishedPortsTable()),
      ...ingressPorts(ingressFiles.read()),
      // The editor's own publish, which no forward may take.
      [Number(process.env.VSCODE_PORT ?? "3000"), "the editor (VSCODE_PORT)"],
    ]),
    ownRelayPorts: ownRelayPorts(ownRelayNames(target)),
    ownForwards: ownedForwards(ingressFiles.read(), ingressFiles.owner(target)),
    previous: ports.load(target),
  }),
  /** Allocated AND claimed: a start on another daemon, minutes from writing
   *  anything else, sees these as taken from here on. A claim lost to a start
   *  that got there between the read and the create gives back what this one
   *  took, and looks again. */
  allocate: (target: Target, appPorts: number[], dindName: string): PortMap => {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
      const world = ports.world(target);
      const map = dieOnError(() => allocatePorts(world, appPorts));
      const claimed = [...map.values()].filter((port) => ingressFiles.claim(port, target, dindName));
      if (claimed.length === map.size) {
        ports.save(target, map);
        return map;
      }
      for (const port of claimed) if (!world.ownForwards.has(port)) ingressFiles.release(port, target);
    }
    return die(`could not claim host ports for ${target.name}: other starts took them ${CLAIM_ATTEMPTS} times running`);
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

  // Derived from the image as pinned now, so the derivative is keyed on what
  // it was built from (T5.4).
  const pinned = pinnedImage(cfg.image, docker);
  if (pinned && pinned !== cfg.image) desolog(`${cfg.image} is ${pinned.split("@")[1]} here; deriving from that`);
  else if (!pinned) desolog(`${cfg.image} has no registry digest here; deriving from it unpinned`);
  const tag = caTrustingImage(pinned || cfg.image, docker);
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
  daemon: Daemon,
) => {
  if (daemon === "project") {
    // Unconditional on a project daemon: `docker run -v $(pwd)` from inside
    // hands that daemon the devcontainer's path, and docker creates a missing
    // bind source as an EMPTY directory -- the build "succeeds" on nothing.
    // So the path has to mean the same directory on both sides, always.
    const own = (value: unknown) =>
      value === undefined || value === target.dir ||
      (typeof value === "string" && /(^|,)\s*source=([^,]*)/.exec(value)?.[2] === target.dir &&
        /(^|,)\s*target=([^,]*)/.exec(value)?.[2] === target.dir);
    if (!own(spec.workspaceFolder) || !own(spec.workspaceMount))
      die(`${target.name} runs on a daemon of its own, where the workspace must sit at its
        own path (${target.dir}) on both sides -- otherwise 'docker run -v $(pwd)' binds a
        directory that daemon does not have, which docker silently creates empty.
        Remove "workspaceFolder" and "workspaceMount" from devcontainer.json; desolate
        mounts it at ${target.dir} itself.`);
    return true;
  }
  return target.worktree !== undefined ||
    (target.project.includes("/") &&
      spec.workspaceFolder === undefined &&
      spec.workspaceMount === undefined);
};

/**
 * Narrow, derived rewrites of a validated spec. Returns the --config path to
 * use from here on (unchanged when nothing applies).
 */
function deriveRunConfig(
  target: Target,
  config: string,
  cfg: ProjectConfig,
  daemon: Daemon,
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

  if (mustMirrorItsOwnPath(target, spec, daemon)) {
    spec.workspaceFolder = dir;
    // A worktree's mount is its project's root, the worktree inside it:
    // never a bind of a path its project could have made a link
    // (worktrees.ts projectRoot).
    const source = target.worktree ? target.projectDir : dir;
    spec.workspaceMount = `source=${source},target=${source},type=bind`;
    applied.push(target.worktree
      ? `workspace: ${dir}, inside its project mounted at ${source}`
      : `workspace mounted at ${dir}, mirroring its path outside`);
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
 * or its own -- however it spells it. None of them is a bind of a path under
 * /workspaces: the project could have made it a link (worktrees.ts).
 */
const injectedMounts = (target: Target) => [
  ...SHARED_DIRECTORIES.map(
    (mount) =>
      `type=volume,source=${overlay.ensureVolume(target, mount)},target=${mount.target}`,
  ),
  ...worktrees.mounts(target),
];

/**
 * Check a worktree's files out, the first time it starts.
 *
 * The editor creates worktrees with `--no-checkout`, because a checkout runs
 * the repository's hooks, filters and fsmonitor and the editor reaches every
 * project (worktrees.ts). So the checkout happens here instead, in a throwaway
 * container on the same daemon and with the same mounts this worktree's
 * devcontainer is about to get -- the reach that code would have anyway. It
 * has to precede the snapshot: `.devcontainer/` is one of the files it writes.
 */
/** A worktree's sandbox, with any one a crash left for it removed first: two
 *  at once would be two writers of the same index. */
const worktreeSandbox = (target: Target, mounts: string[]) => {
  const label = `${worktrees.SANDBOX_LABEL}=${target.name}`;
  docker.container.remove(docker.container.namesWithLabel(label));
  return {
    image: worktrees.CHECKOUT_IMAGE,
    label,
    dir: target.dir,
    mounts,
    seconds: worktrees.SANDBOX_SECONDS,
  };
};

function populateWorktree(target: Target): void {
  if (!worktrees.awaitsCheckout(target)) return;
  const ca = SHARED_DIRECTORIES.find((mount) => mount.target === DESOLATE_DIR)!;

  desolog(`checking out ${target.name} in a sandbox (first start) ...`);
  const code = docker.checkoutWorktree({
    ...worktreeSandbox(
      target,
      worktrees.checkoutMounts(target, overlay.ensureVolume(target, ca), DESOLATE_DIR),
    ),
    caFile: `${CA_DIR}/ca.pem`,
  });
  // A hook that fails after the files land still exits non-zero, and git has
  // written the index by then -- so the index, not the status, says whether
  // there is a checkout to start from.
  if (!worktrees.isPopulated(target))
    die(`the checkout of ${target.name} failed in its sandbox (exit ${code}; its output is above).
      The worktree is left empty, and the next start tries again.`);
  if (code !== 0)
    desolog(`the checkout of ${target.name} landed, but git exited ${code} -- a
      post-checkout hook failing in the sandbox, most likely (see above)`);
}

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

/** Where a dev server is, as a human reaches it (#17): written as root, for
 *  login shells, before the editor starts -- whose own environment, and so its
 *  terminals', carries the same variables (editorStartScript). */
function publishExternalPorts(target: Target, external: [string, string][]): void {
  const id = devcontainerId(target.dir);
  if (!id) return;
  const wrote = docker.container.execAsRoot(id, [
    "sh",
    "-c",
    'printf "%s" "$1" > /etc/profile.d/desolate-ports.sh && chmod 0644 /etc/profile.d/desolate-ports.sh',
    "sh",
    externalProfile(external),
  ]);
  if (wrote !== 0)
    desolog(`could not write /etc/profile.d/desolate-ports.sh; DESOLATE_EXTERNAL_* reaches
      the editor's terminals only`);
}

function startEditor(
  target: Target,
  cfg: ProjectConfig,
  token: string,
  config: string,
  external: [string, string][] = [],
): void {
  const dir = target.dir;
  const script = editorStartScript(SERVER_DST, cfg, token, external);
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
  // On a project daemon a dev-server port may be published by a compose
  // sibling on the dind, not served from the devcontainer: fall back to the
  // dind itself when the devcontainer refuses. Never for the editor.
  const fallbackIp =
    daemons.saved(target) === "project" && targetPort !== EDITOR_INTERNAL_PORT
      ? docker.networkGateway(network) || undefined
      : undefined;
  const code = dieOnError(() => docker.relay.start({
    image: relay.IMAGE,
    name: relay.name(target, hostPort),
    label: relay.label(target),
    network,
    hostPort,
    targetIp,
    targetPort,
    fallbackIp,
  }));

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
      `      Remove appPort (desolate allocates host ports itself), then recreate`,
      `      the container without it:`,
      `        ${hint.desolate(`--rebuild ${invocation(target)}`)}`,
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

/** `--ports <p> --move <label> <port>`. A running target's relays move with
 *  it; a stopped one keeps the new port for its next start. */
function movePorts(target: Target, move: { label: string; port: number }, reachable: boolean): void {
  const world = ports.world(target);
  const map = dieOnError(() => movePort(world, move.label, move.port));
  ports.save(target, map);
  if (reachable && devcontainerId(target.dir)) {
    const dindName = ingressFiles.dindOf(target, daemons.saved(target));
    if (!ingressFiles.claim(move.port, target, dindName))
      die(`${move.port} was taken by ${ingressFiles.ownerOf(move.port) || "another target"} just now; pick another`);
    recreateRelays(target, map);
    ingressFiles.publish(world.previous, map, target, dindName);
    publishExternalPorts(target, dieOnError(() => [...targetEnvironment(target), ...externalEnvironment(map)]));
    console.log(`  login shells see the new DESOLATE_EXTERNAL_* now; the editor's terminals on its
  next start:  ${hint.desolate(invocation(target))}`);
  }
  showPorts(target);
}

function showPorts(target: Target, json = false): void {
  const map = ports.load(target);
  if (json)
    return console.log(JSON.stringify({
      target: target.name, project: target.project, worktree: target.worktree ?? null,
      ports: Object.fromEntries(map),
    }));
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
/** Every running target, across every daemon that answers: the shared one,
 *  and each project dind a target last ran on. */
const runningTargets = (): Target[] => {
  const bySocket = new Map<string, Target[]>();
  for (const target of listTargets(WORKSPACES)) {
    const socket = daemons.socketOf(target, daemons.saved(target));
    bySocket.set(socket, [...(bySocket.get(socket) ?? []), target]);
  }
  const running: Target[] = [];
  for (const [socket, targets] of bySocket) {
    if (socket !== daemons.shared && !daemons.answers(socket)) continue;
    process.env.DOCKER_HOST = socket;
    const up = docker.container.runningWorkspaceFolders();
    running.push(...targets.filter(({ dir }) => up.has(dir)));
  }
  process.env.DOCKER_HOST = daemons.shared;
  return running;
};

/**
 * Join the devcontainer to every network on its project's daemon (Q5b).
 *
 * Sibling services sit on compose's bridge, which docker isolates from the
 * devcontainer's own, so `wget http://web:8000` does not resolve until the two
 * share one -- measured in tests/probes/sibling-docker.sh. On a project dind
 * every network is the project's, so joining them all is joining its own.
 * Networks made later (a `compose up` from inside) are `desolate-net join`.
 */
function joinProjectNetworks(target: Target): void {
  const id = devcontainerId(target.dir);
  if (!id) return;
  const on = new Set(docker.container.networks(id).map(({ network }) => network));
  for (const network of docker.userNetworks())
    if (!on.has(network) && docker.connectNetwork(network, id) === 0)
      desolog(`joined ${network}, so its services resolve by name`);
}

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
function showRunning(json = false): void {
  const running = runningTargets();
  if (json) {
    const rows = running.map((target) => {
      driveSaved(target);
      return {
        target: target.name, project: target.project, worktree: target.worktree ?? null,
        daemon: daemons.saved(target), url: editorUrl(target) || null,
        ports: Object.fromEntries(ports.load(target)),
      };
    });
    return console.log(JSON.stringify(rows));
  }
  if (!running.length)
    return console.log(
      `nothing is running.  Start something:  ${hint.desolate("<project>")}`,
    );

  const width = Math.max(...running.map(({ name }) => name.length));
  for (const target of running) {
    driveSaved(target); // its folder is asked of the daemon it runs on
    console.log(
      `  ${target.name.padEnd(width)}  ` +
        `${target.worktree ? "worktree" : "project "}  ${editorUrl(target)}`,
    );
  }

  console.log(`\n  Ports: ${hint.desolate("--ports <project>")}`);
  console.log(`  Stop:  ${hint.desolate("--stop <project> | --stop all")}`);
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
  worktreesOf(target).filter(isRunningOnItsDaemon);

/** Asked of the daemon THIS target last ran on, not the one being driven: a
 *  project's worktrees decide their daemons by their own specs, so a project
 *  on its own dind can have a worktree on the shared one, and vice versa. */
const isRunningOnItsDaemon = (target: Target) => {
  const daemon = daemons.saved(target);
  const socket = daemons.socketOf(target, daemon);
  if (daemon === "project" && !daemons.answers(socket)) return false;
  return run("docker", ["-H", socket, "ps", "-q", "--filter", `label=devcontainer.local_folder=${target.dir}`],
             { encoding: "utf8" }, true) !== "";
};

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
${running.map((w) => `        ${hint.desolate(`--stop ${invocation(w)}`)}`).join("\n")}`);
}

function stopTarget(target: Target): void {
  if (!driveSaved(target)) {
    ingressFiles.withdraw(ports.load(target), target);
    return console.log(`not running (${target.name}'s own daemon is stopped)`);
  }
  refuseIfWorktreesAreRunning(target);

  const relays = ownRelayNames(target);
  if (relays.length) {
    docker.container.remove(relays);
    console.log("removed relays");
  }
  // The relays are gone, so the forwards would lead nowhere: close them.
  ingressFiles.withdraw(ports.load(target), target);
  const id = devcontainerId(target.dir);
  if (id) {
    // On a project daemon the devcontainer holds a docker CLI and NO daemon of
    // its own -- shutdown.ts's quiesce, which reads "has a CLI" as "has a
    // daemon", would stop every sibling on the project's dind, this container
    // and its relays included. Only a legacy shared-daemon container, with a
    // nested dockerd, still needs it (docs/dind/HANDOFF.md section 6).
    if (daemons.saved(target) === "project") docker.container.stop(id);
    else shutdown.devcontainer(docker, id, desolog);
    // Say that the container is KEPT. Stopping and starting again looks like it
    // should pick up an edited devcontainer.json, and it does not -- `up`
    // restarts the existing container rather than rebuilding from the spec.
    console.log(
      `stopped ${target.name} (container kept, so restarting is fast;`,
    );
    console.log(`         to apply spec changes: ${hint.desolate(`--rebuild ${invocation(target)}`)})`);
  } else console.log("not running");

  // The next step for a worktree is usually to remove it, and the command that
  // does that properly -- purge here, then git in the editor -- exists only on
  // the Mac (#9).
  if (target.worktree)
    console.log(
      `  done with it?  ${hint.mac(`worktree remove ${target.project} ${target.worktree}`)}`,
    );
}

/**
 * Is this worktree safe to delete -- nothing uncommitted, nothing untracked?
 *
 * Asked in its sandbox, because answering reads content through the
 * repository's own filters, and the editor that deletes it must not run those
 * (worktrees.ts). `cli.sh worktree remove` asks this first and passes the
 * answer on. Exits 0 when there is nothing to lose, 3 when there is (and says
 * what), 1 when the check could not run -- which is never read as clean.
 */
function reportUncommitted(target: Target): void {
  if (!target.worktree)
    return die(`--uncommitted asks about a worktree; name one with --worktree`);
  refuseUnlessItsOwnPath(target);
  const removal = worktrees.removal(target, false);
  if (removal.kind === "nothing")
    return console.log(`${target.name} was never checked out; nothing in it to lose`);
  if (removal.kind === "refuse") {
    console.error(`${target.name} was never checked out, but holds files put there by hand:`);
    for (const entry of removal.stray.slice(0, 20)) console.error(`  ${entry}`);
    console.error(`move them out, or discard them with:
  ${forcedRemoval(target)}`);
    process.exit(3);
  }

  const report = docker.worktreeChanges(
    worktreeSandbox(target, worktrees.sandboxMounts(target)),
  );
  const changes = parseWorktreeChanges(report);
  if (changes === null)
    return die(`could not check ${target.name} for uncommitted changes in its sandbox,
      so it is not known to be safe to remove.${report ? `\n      git said: ${report.split("\n").slice(0, 3).join(" / ")}` : ""}
      To discard whatever is in it:
        ${forcedRemoval(target)}`);
  if (changes.length === 0) return console.log(`${target.name} has no uncommitted changes`);

  console.error(`${target.name} has uncommitted or untracked files:`);
  for (const line of changes.slice(0, 20)) console.error(`  ${line}`);
  if (changes.length > 20) console.error(`  ... and ${changes.length - 20} more`);
  console.error(`commit or stash them, or discard them with:
  ${forcedRemoval(target)}`);
  process.exit(3);
}

/** The command that removes this worktree whatever is in it. */
const forcedRemoval = (target: Target) => {
  const args = `${target.project} ${target.worktree} --force`;
  return hint.anywhere(`worktree remove ${args}`, `./cli.sh worktree remove ${args}`);
};

/**
 * A target must be the directory its names denote -- not a link that a
 * project put where its worktree, or its `.worktrees`, should be. The broker
 * asks the same of every request from the editor; this is for the ones that
 * arrive from the Mac, and for the commands below that read and delete.
 */
function refuseUnlessItsOwnPath(target: Target): void {
  const real = (dir: string) => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return "";
    }
  };
  const own = resolveTarget(real(WORKSPACES), target.project, target.worktree);
  for (const [dir, expected] of [[target.projectDir, own.projectDir], [target.dir, own.dir]])
    if (fs.existsSync(dir) && real(dir) !== expected)
      die(`${dir} is a link to ${real(dir) || "nothing"}, not a directory of
        ${target.project}'s own; refusing to act on it`);
}

/** Its sandbox, working in its project's root: the one directory every step
 *  of a worktree's life can count on, including the ones that make it and
 *  delete it. */
const projectSandbox = (target: Target) => ({
  ...worktreeSandbox(target, worktrees.sandboxMounts(target)),
  dir: target.projectDir,
});

/**
 * Create a worktree with nothing checked out, in its sandbox -- what the
 * editor's `worktree add` asks the broker for. Not git in the editor: with
 * the project's `.git`, `.worktrees` or `.git/info/exclude` made a link into
 * another project, git there wrote into THAT project (measured). The sandbox
 * mounts the project's root alone, so those links resolve to nothing.
 */
function createWorktree(target: Target, branch: string, from?: string): void {
  if (!worktrees.validBranch(branch)) return die(`'${branch}' is not a usable branch name`);
  if (from !== undefined && !worktrees.validBranch(from)) return die(`'${from}' is not a usable start point`);
  refuseUnlessItsOwnPath(target);
  const code = docker.worktreeScript(
    projectSandbox(target),
    worktrees.createScript,
    worktrees.createArguments(target, branch, from),
  );
  const { CREATE_EXIT } = worktrees;
  if (code === CREATE_EXIT.exists) die(`${target.dir} already exists`);
  if (code === CREATE_EXIT.start) die(`'${from}' is not a commit in ${target.projectDir}`);
  if (code === CREATE_EXIT.lock)
    die(`the worktree was created but could not be LOCKED. Unlocked, a prune in
      a container that cannot see it destroys it, and no part of that is
      recoverable. Remove it with
        ${forcedRemoval(target)}
      and report this.`);
  if (code === CREATE_EXIT.exclude)
    desolog(`could not add '${WORKTREES_DIRECTORY}/' to ${target.projectDir}/.git/info/exclude;
      the main tree's \`git status\` will list .worktrees as untracked`);
  else if (code !== 0) die(`git could not create the worktree (exit ${code}; see its message above)`);
  console.log(`worktree: ${target.name} is at ${target.dir}`);
  console.log(`          its files are checked out in a sandbox when it first starts`);
}

/**
 * Remove a worktree: refused if anything in it would be lost (unless
 * `force`), then what desolate made for it purged, then the worktree itself
 * removed in its sandbox. Purge first: once git has removed the directory
 * there is nothing left to identify the container by.
 */
function removeWorktree(target: Target, force: boolean): void {
  refuseUnlessItsOwnPath(target);
  if (!force) reportUncommitted(target);
  purgeTarget(target);
  const code = docker.worktreeScript(
    projectSandbox(target),
    worktrees.removeScript,
    worktrees.removeArguments(target),
  );
  if (code === worktrees.REMOVE_EXIT.relocked)
    die(`git could not remove the worktree (see its message above); it is locked again`);
  if (code === worktrees.REMOVE_EXIT.partial)
    die(`git unregistered the worktree but could not delete all of ${target.dir}
      (see its message above) -- files a container wrote as root, most likely.
      What is left there is no longer a worktree.`);
  if (code !== 0) die(`the removal of ${target.name} failed in its sandbox (exit ${code})`);
  console.log(`worktree: removed ${target.name}`);
}

/**
 * Run a command inside a running target's devcontainer -- how a harness starts
 * an agent in it (`cli.sh exec`, docs/agents.md). As the container's remote
 * user (its metadata label), in its workspace folder, through a login shell so
 * the PATH its features set up is there; the container's own environment,
 * placeholder secrets and all, it has already. stdin, stdout and a TTY are the
 * caller's. Exits with the command's status.
 *
 * `docker exec`, not `devcontainer exec`: that one finds the container by the
 * config it was STARTED with, and a harness's exec comes later, after the spec
 * may have moved on.
 */
function execTarget(target: Target, argv: string[]): never {
  if (!driveSaved(target))
    return die(`${target.name}'s own daemon is not running. Start it: ${hint.desolate(invocation(target))}`);
  const id = devcontainerId(target.dir);
  if (!id) return die(`${target.name} is not running. Start it: ${hint.desolate(invocation(target))}`);
  const user = remoteUserOf(docker.container.metadata(id));
  const folder = containerWorkspaceFolder(target.dir, id) || target.dir;
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const result = spawnSync("docker", [
    "exec", "-i", ...(tty ? ["-t"] : []), ...(user ? ["-u", user] : []), "-w", folder, id,
    "sh", "-lc", 'exec "$@"', "sh", ...argv,
  ], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

/** The editor's user, which owns /workspaces and is the only one there. */
const EDITOR_UID = 1000;

/**
 * Give the editor back what a container wrote as someone else (#15).
 *
 * A compose service running as its image's root leaves root-owned files on
 * /workspaces, and the editor -- uid 1000, no sudo -- can then neither delete
 * them nor remove the worktree they are in. This chowns them back, as root in
 * a helper on the target's own daemon. The helper mounts the PROJECT's root,
 * which no container can swap for a link, and reaches `path` inside it there
 * (docker.reclaimArgv), so neither a `..` nor a planted symlink can turn this
 * into a chown of somebody else's tree.
 */
async function reclaimTarget(target: Target, relative = ""): Promise<void> {
  const within = path.join(target.dir, relative);
  if (!isWithin(target.dir, within))
    return die(`'${relative}' is not inside ${target.name}`);
  if (daemons.saved(target) === "project") await useProjectDaemon(target);
  else daemons.use(target, "shared");
  const inProject = path.relative(target.projectDir, within) || ".";
  const changed = docker.reclaim(worktrees.CHECKOUT_IMAGE, target.projectDir, inProject, EDITOR_UID);
  if (changed === null)
    return die(`could not reclaim ${path.join(target.name, relative)}: the helper did not finish
      (its image is ${worktrees.CHECKOUT_IMAGE})`);
  console.log(changed === 0
    ? `nothing to reclaim under ${within}: the editor owns all of it`
    : `reclaimed ${changed} entr${changed === 1 ? "y" : "ies"} under ${within} for the editor (uid ${EDITOR_UID})`);
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
        ${hint.desolate(`--stop ${invocation(target)}`)}`);

  docker.container.remove(ownRelayNames(target));
  ingressFiles.withdraw(ports.load(target), target);
  const id = devcontainerId(target.dir, /* includeStopped */ true);
  if (id) docker.container.remove([id]);

  docker.volume.remove(
    SHARED_DIRECTORIES.flatMap((mount) =>
      Object.values(overlayVolumes(target, mount.name)),
    ),
  );

  for (const kind of ["ports", "spec", "token", "daemon"] as const)
    fs.rmSync(stateFile(target, kind), { force: true });

  console.log(`purged ${target.name} (container, relays, volumes and state)`);
}

/**
 * A project's purge takes its daemon's image store with it -- but only the
 * PROJECT's purge, and only once nothing else of it is left: its worktrees run
 * on the same daemon, and a worktree's purge must not cost its siblings their
 * images. Refused, not skipped, so the store left behind is never a surprise.
 */
async function purgeProjectDaemon(target: Target): Promise<void> {
  if (target.worktree) return;
  const remaining = worktreesOf(target).map(({ name }) => name);
  if (remaining.length)
    return void desolog(`kept ${dind.volumes(target).data}, this project's image store: its worktrees`,
      `still use it (${remaining.join(", ")}). Remove them, then purge ${target.name} again.`);
  const answer = await supervisor.ask({ op: "purge", project: target.project });
  if (answer.ok !== true)
    die(`could not purge ${dind.name(target)}: ${answer.error ?? "the supervisor said nothing"}`);
}

async function runTarget(
  target: Target,
  config?: string,
  rebuild = false,
  noCache = false,
): Promise<void> {
  const { name, dir } = target;
  populateWorktree(target);
  config ??= dieOnError(() => snapshot(target, { specs: DIRECT_SPEC_DIR }));

  const resolved = resolveOrDie(target, config);
  const project = readProjectConfig(resolved);
  const daemon = daemonOf(resolved);
  if (project.hadLegacyAppPort)
    return die(`devcontainer.json still contains "appPort".
      desolate allocates host ports itself, and an appPort publish occupies the
      same port the relay must bind -- the relay will fail with "address in use".
      Fix: delete the appPort entry and declare container-side ports instead:
        "customizations": { "desolate": { "ports": [5173] } }`);

  // Before leaving the shared daemon: a container this target already has
  // THERE is either the pre-v2 shape (privileged, a nested daemon) or simply
  // the one it had before it moved to a daemon of its own.
  daemons.use(target, "shared");
  migrateOffTheSharedDaemon(target, daemon, rebuild);

  // And the other way: off its own daemon, onto the shared one.
  migrateOffItsOwnDaemon(target, daemon, rebuild);

  // From here on, every docker call is to the daemon this target runs on.
  if (daemon === "project") await useProjectDaemon(target);
  else daemons.use(target, "shared");

  // A rebuild takes the old container away BEFORE anything is judged, so
  // nothing below is decided on a daemon that still holds it (#26).
  const before = devcontainerId(dir, true);
  if (rebuild && before) {
    docker.container.remove([before]);
    desolog(`removed the existing container (--rebuild)`);
  }

  // fingerprint before deriving
  const fingerprint = spec.fingerprint(dir, config);

  config = deriveRunConfig(target, config, project, daemon);
  const derived = resolveOrDie(target, config);

  try {
    enforcePolicy(
      target,
      derived,
      listTargets(WORKSPACES),
      daemon,
    );
  } catch (err: any) {
    die(`the spec desolate derived for ${name} does not pass the policy
      (refusing to start -- this is a desolate bug, not a problem with
      your devcontainer.json): ${err?.message ?? err}`);
  }
  // Only once it will run: a refused start must not change which daemon
  // --stop and --purge drive.
  daemons.save(target, daemon);

  const saved = spec.load(target);
  const existing = rebuild ? "" : devcontainerId(dir, true);

  // The policy judged the spec as declared; `up` would start an existing
  // container as it was BUILT. One built with more than the spec now asks for
  // -- privileged, under docker-in-docker, before v2 -- must not be started
  // behind a spec that passed (#26).
  const beyond = existing ? builtBeyondDeclared(docker.container.metadata(existing), derived.mergedConfiguration) : [];
  if (beyond.length)
    return die(`${name}'s existing container was built from a different spec than the one it
      declares now: it has ${beyond.join(", ")}, which devcontainer.json no longer asks for,
      and starting it would run it as it was built. Recreate it from the spec:
        ${hint.desolate(`--rebuild ${invocation(target)}`)}`);
  if (existing && saved && saved !== fingerprint)
    console.log(`
  NOTE: this project's spec has changed since its container was created.
        'devcontainer up' reuses an existing container without re-reading
        devcontainer.json, so THE CHANGE IS NOT IN EFFECT below.
          .devcontainer fingerprint: ${saved} -> ${fingerprint}
        Apply it:  ${hint.desolate(`--rebuild ${invocation(target)}`)}
        Why not automatic: recreating loses anything written inside the
        container outside /workspaces.
        `);

  const willCreate = rebuild || !existing;

  const previousPorts = ports.load(target);
  const map = ports.allocate(target, project.appPorts, ingressFiles.dindOf(target, daemon));
  const editorPort = map.get("editor")!;
  const token = connectionToken(target);

  desolog(`starting devcontainer for ${name} ...`);
  devcontainerUp(target, config, noCache);
  if (willCreate) spec.save(target, fingerprint);
  installProxyCa(dir);
  shadowBaseImages(dir, project.shadowImages);
  const external = dieOnError(() => [...targetEnvironment(target), ...externalEnvironment(map)]);
  publishExternalPorts(target, external);
  startEditor(target, project, token, config, external);
  recreateRelays(target, map);
  ingressFiles.publish(previousPorts, map, target, ingressFiles.dindOf(target, daemon));
  if (daemon === "project") joinProjectNetworks(target);

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
  console.log(`\n  Port map: ${hint.desolate(`--ports ${paste}`)}`);
  console.log(`  Stop:     ${hint.desolate(`--stop ${paste}`)}`);
}

/** Turn a validated command line into the one directory it denotes.
 *
 *  Worktrees are NOT created here: this process holds the inner Docker socket
 *  and must never run a repository's git. The editor creates them, hardened
 *  and without a checkout; `populateWorktree` checks them out in a sandbox. */
function targetFromArguments(project: string, worktree?: string, absent = false): Target {
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

  if (absent) {
    // lstat, not exists: a dangling link is something there all the same.
    if (fs.lstatSync(target.dir, { throwIfNoEntry: false }))
      die(`${target.dir} already exists`);
    return target;
  }

  if (!fs.existsSync(target.dir))
    die(`no such worktree: ${target.dir}
      Create it:
        ${hint.anywhere(`worktree add ${project} ${worktree}`, `./cli.sh worktree add ${project} ${worktree}`)}`);

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
  `THAT project.\n          To stop every running target: ${hint.desolate("--stop --all")}`;

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

  if (args.command === "list") return showRunning(args.json);
  if (args.command === "dinds") return showDinds();
  if (args.command === "stop") return stopFromArguments(args);

  if (args.command === "create-worktree") {
    const target = targetFromArguments(args.project!, args.worktree, /* absent */ true);
    return createWorktree(target, args.branch ?? args.worktree!, args.from);
  }

  const target = targetOf(args);
  if (args.command === "remove-worktree") {
    // Its purge has to reach the target's containers and volumes, as
    // --purge's does, so its own daemon is brought up for it.
    if (daemons.saved(target) === "project") await useProjectDaemon(target);
    return removeWorktree(target, args.force);
  }
  if (args.command === "ports" && args.move) {
    movePorts(target, args.move, driveSaved(target));
  } else if (args.command === "ports") showPorts(target, args.json);
  else if (args.command === "purge") {
    // A purge has to reach the target's containers and volumes, so its own
    // daemon is brought up for it.
    const daemon = daemons.saved(target);
    if (daemon === "project") await useProjectDaemon(target);
    purgeTarget(target);
    if (daemon === "project") await purgeProjectDaemon(target);
  }
  else if (args.command === "uncommitted") reportUncommitted(target);
  else if (args.command === "reclaim") await reclaimTarget(target, args.path);
  else if (args.command === "exec") execTarget(target, args.execArgv!);
  else if (args.command === "populate") populateWorktree(target);
  else await runTarget(target, args.config, args.rebuild, args.noCache);
}

if (isEntryPoint(import.meta.url))
  main().catch((err) => {
    console.error(`desolate: ${err?.message ?? err}`);
    process.exit(1);
  });
