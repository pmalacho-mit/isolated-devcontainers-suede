/*
The ONE holder of the VM's docker socket.

Runs in its own container (desolate-supervisor), which mounts the VM daemon's
socket and nothing a project can write. It creates, starts, stops and purges
project dinds -- one per project that uses docker (dind.ts) -- and answers a
FIXED vocabulary over a unix socket in the supervisor-run volume, which only
the orchestrator mounts, never the editor:

  ensure <project>   a running, healthy dind for it: started if stopped (a warm
                     boot, images intact), created otherwise, admitted against
                     the VM's headroom (capacity.ts) first
  stop   <project>   quiesced (shutdown.ts), then stopped; its images stay
  reset  <project>   restarted, the container and so its daemon alone, then
                     waited on: rung 2 of `cli.sh dind reset`
  purge  <project>   stopped, then its container, image store and bridge gone
  status             every project dind: state, health, in use, idle since,
                     memory, image-store size; and the VM's headroom

A request names a project, never a docker flag, exactly as the broker's do: a
compromised orchestrator holding this socket can start and stop daemons and do
nothing else with the VM's. That is the whole reason this is a process of its
own rather than a mount on the orchestrator.

It also stops dinds nobody has used for DESOLATE_DIND_IDLE (capacity.reapable),
and publishes each running dind's bridge address for desolate-ingress (T2.2).
*/
/// <reference types="node" />
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import * as capacity from "./capacity.ts";
import * as dind from "./dind.ts";
import { createDocker, type DindSpec, type Runner } from "./docker.ts";
import {
  target as resolveTarget,
  validName,
  volumeNamespace,
  type Target,
} from "./projects.ts";
import * as shutdown from "./shutdown.ts";
import { ask } from "./supervisor-client.ts";
import { isEntryPoint } from "./utils.ts";

// ------------------------------------------------------------ the vocabulary --

export const operations = ["ensure", "stop", "reset", "purge", "status"] as const;
type Operation = (typeof operations)[number];

export type Request =
  | { op: "status" }
  | { op: Exclude<Operation, "status">; project: string };

const MAX_REQUEST_BYTES = 1024;

export const isRequest = (query: unknown): query is Request =>
  query !== null &&
  typeof query === "object" &&
  "op" in query &&
  typeof query.op === "string" &&
  (operations as readonly string[]).includes(query.op) &&
  (query.op === "status"
    ? Object.keys(query).length === 1
    : "project" in query &&
      typeof query.project === "string" &&
      Object.keys(query).length === 2);

/** A project name, held to the rules every other component holds it to.
 *  Not checked against the filesystem: this container mounts no workspace,
 *  and a project that is not there fails as a `volume-subpath` docker refuses
 *  to mount -- which is a refusal, not a daemon over an empty directory. */
export const targetOf = (project: string): Target => {
  if (!validName(project)) throw new Error(`'${project}' is not a usable project name`);
  if (!volumeNamespace.supports(project))
    throw new Error(`project name cannot contain "__": it is how "/" is encoded into docker names`);
  return resolveTarget("/workspaces", project);
};

// -------------------------------------------------------------- the settings --

export interface Settings {
  runtime: DindSpec["runtime"];
  image: string;
  volumePrefix: string;
  caDirectory: string;
  limits: DindSpec["limits"];
  daemonJson: string;
  idleMs: number;
  bootSeconds: number;
}

/**
 * @throws for `runc` outside the nested harness: --privileged on the VM is
 * exactly what a project dind exists to avoid, so the one switch that asks for
 * it has to be asked for twice, by the one file that sets both
 * (tests/environments/nested/compose.nested.yml).
 */
export const settingsFrom = (env: Record<string, string | undefined>): Settings => {
  const runtime = env.DESOLATE_DIND_RUNTIME ?? "sysbox-runc";
  if (runtime !== "sysbox-runc" && runtime !== "runc")
    throw new Error(`DESOLATE_DIND_RUNTIME must be sysbox-runc or runc, not '${runtime}'`);
  if (runtime === "runc" && env.DESOLATE_NESTED_HARNESS !== "1")
    throw new Error("DESOLATE_DIND_RUNTIME=runc runs project dinds --privileged; refused outside the nested test harness");
  const minutes = Number(env.DESOLATE_DIND_IDLE ?? "30");
  if (!Number.isFinite(minutes) || minutes <= 0)
    throw new Error(`DESOLATE_DIND_IDLE is minutes, a positive number, not '${env.DESOLATE_DIND_IDLE}'`);
  return {
    runtime,
    image: dind.IMAGE,
    volumePrefix: env.DESOLATE_VOLUME_PREFIX ?? "desolate_",
    caDirectory: env.DESOLATE_CA_DIRECTORY ?? "/var/lib/desolate-proxy/public",
    limits: {
      memory: env.DESOLATE_DIND_MEMORY ?? "6g",
      pids: Number(env.DESOLATE_DIND_PIDS ?? "8192"),
      cpus: env.DESOLATE_DIND_CPUS ?? "4",
    },
    daemonJson: JSON.stringify({
      builder: { gc: { enabled: true, defaultKeepStorage: env.DESOLATE_DIND_BUILD_CACHE ?? "20GB" } },
      // Outside every subnet the VM's daemon hands out (dind.ts).
      bip: dind.INNER_BRIDGE_IP,
      "default-address-pools": [dind.INNER_POOL],
    }),
    idleMs: minutes * 60_000,
    bootSeconds: Number(env.DESOLATE_DIND_BOOT_SECONDS ?? "120"),
  };
};

/** `--cpus` above what the daemon has is not a generous cap but a refused
 *  container ("range of CPUs is from 0.01 to N"), so the cap is the smaller of
 *  the setting and the machine. Memory needs no such clamp: a limit above the
 *  VM's size is merely a cap that never binds. */
export const cpusFor = (setting: string, machineCpus: number) => {
  const wanted = Number(setting);
  if (!Number.isFinite(wanted) || wanted <= 0) throw new Error(`DESOLATE_DIND_CPUS must be a positive number, not '${setting}'`);
  return String(machineCpus > 0 ? Math.min(wanted, machineCpus) : wanted);
};

export const specFor = (target: Target, settings: Settings): DindSpec => {
  const volume = (name: string) => `${settings.volumePrefix}${name}`;
  return {
    name: dind.name(target),
    label: dind.label(target),
    network: dind.network(target),
    runtime: settings.runtime,
    image: settings.image,
    project: target.project,
    volumes: {
      data: dind.volumes(target).data,
      workspaces: volume("workspaces"),
      sockets: volume(dind.sockets.volume),
      socketSubpath: dind.volumes(target).socketSubpath,
      serverDist: volume("server-dist"),
      health: volume("inner-health"),
    },
    caDirectory: settings.caDirectory,
    limits: settings.limits,
    daemonJson: settings.daemonJson,
  };
};

const UNITS: Record<string, number> = {
  B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4,
  kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12,
};

/** `docker stats` MemUsage ("490.2MiB / 15.6GiB") -> bytes used, or undefined. */
export const memoryUsed = (usage: string) => {
  const match = /^\s*([\d.]+)\s*([A-Za-z]+)\s*\//.exec(usage);
  if (!match || !(match[2] in UNITS)) return undefined;
  return Math.round(Number(match[1]) * UNITS[match[2]]);
};

// -------------------------------------------------------------- the daemon --

/** The docker CLI against the VM daemon, keeping what a failure SAID so a
 *  refusal can quote it rather than point at this container's logs. */
let lastFailure = "";
const runner: Runner = {
  output: (argv) => {
    try {
      return execFileSync("docker", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      return "";
    }
  },
  status: (argv, options) => {
    try {
      execFileSync("docker", argv, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options?.timeoutMs,
      });
      return 0;
    } catch (err: any) {
      lastFailure = String(err?.stderr ?? err?.message ?? err).trim().split("\n").slice(-3).join(" / ");
      return err?.status ?? 1;
    }
  },
  build: () => ({ ok: false, output: "the supervisor builds nothing" }),
};
const docker = createDocker(runner);

type Say = (line: string) => void;

const HELPER_IMAGE = "alpine:3";

/** When each dind was last seen hosting a devcontainer, by name. A dind first
 *  seen idle counts from that moment: after a restart of this process, the
 *  reaper waits a whole idle period rather than reaping on a guess. */
const lastBusy = new Map<string, number>();

const daemons = {
  observe: (): capacity.ProjectDaemon[] => {
    const names = docker.dind.all(dind.LABEL_KEY);
    const running = names.filter((name) => docker.dind.state(name) === "running");
    const memory = new Map<string, number | undefined>();
    for (const line of docker.dind.memoryUsage(running)) {
      const [name, usage = ""] = line.split("\t");
      memory.set(name, memoryUsed(usage));
    }
    const now = Date.now();
    return names.map((name) => {
      const isRunning = running.includes(name);
      const inUse = isRunning && docker.dind.hostsDevcontainer(name);
      if (inUse || !lastBusy.has(name)) lastBusy.set(name, now);
      return {
        name,
        running: isRunning,
        inUse,
        idleSince: inUse ? undefined : lastBusy.get(name),
        memory: memory.get(name),
      };
    });
  },

  /** healthy, or why not: the shared dind's own three-state verdict. */
  waitHealthy: async (name: string, settings: Settings, say: Say) => {
    let wedgedFor = 0;
    for (let second = 0; second < settings.bootSeconds; second++) {
      const health = docker.dind.health(name);
      if (health === 0) return "healthy";
      wedgedFor = health === 2 ? wedgedFor + 1 : 0;
      if (wedgedFor >= 10) return "wedged";
      if (second === 5) say(`${name}: still booting ...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return "booting";
  },

  stop: (name: string, say: Say, purging = false) => {
    if (docker.dind.state(name) !== "running") return;
    say(`${name}: quiescing, then stopping${purging ? "" : " (its images stay)"}`);
    shutdown.dind(docker, name, say);
  },
};

/** desolate-ingress forwards only to dinds listed here (T2.2). Each file is
 *  written under a dot-prefixed scratch name and renamed into place: the
 *  addon reads this directory too, and `desolate-dind-<p>.tmp` was a name it
 *  attributed to a project `<p>.tmp` while it existed. */
const ingress = {
  publish: (target: Target) => {
    const name = dind.name(target);
    const address = docker.dind.address(name, dind.network(target));
    if (!address) throw new Error(`${name} is up but has no address on ${dind.network(target)}`);
    const file = join(config.ingressDinds, name);
    const scratch = join(config.ingressDinds, `.${name}.tmp`);
    writeFileSync(scratch, `${address}\n`);
    renameSync(scratch, file);
  },
  withdraw: (name: string) => rmSync(join(config.ingressDinds, name), { force: true }),
  /** Entries for project dinds that are not running: left by a stack that
   *  went down under them (cli.sh down removes dinds directly), and naming an
   *  address docker may hand a different dind next. */
  prune: () => {
    let names: string[] = [];
    try {
      names = readdirSync(config.ingressDinds);
    } catch {
      return;
    }
    for (const name of names)
      if (name.startsWith("desolate-dind-") && docker.dind.state(name) !== "running") ingress.withdraw(name);
      // A crash between write and rename leaves one. This process is the
      // only writer, and it is not mid-write while it prunes.
      else if (name.startsWith(".desolate-dind") && name.endsWith(".tmp")) ingress.withdraw(name);
  },
  /** The SHARED dind's address too: every target without a daemon of its own
   *  publishes its relays there, and reaches the Mac the same way (T2.4).
   *  Re-read on every tick, so a recreated dind's new address follows it. */
  publishShared: (settings: Settings) => {
    // Listed as `desolate-dind` whatever its container is called: that is the
    // name every ports/ file for a shared-dind target carries (desolate.ts).
    const container = process.env.DESOLATE_SHARED_DIND_CONTAINER ?? "desolate-dind";
    const address = docker.dind.address(container, `${settings.volumePrefix}dindnet`);
    const file = join(config.ingressDinds, "desolate-dind");
    if (!address) return rmSync(file, { force: true });
    let current = "";
    try {
      current = readFileSync(file, "utf8").trim();
    } catch {}
    if (current === address) return;
    const scratch = join(config.ingressDinds, ".desolate-dind.tmp");
    writeFileSync(scratch, `${address}\n`);
    renameSync(scratch, file);
  },
};

const refuse = (message: string): never => {
  throw new Error(message.replace(/\s*\n\s*/g, " "));
};

const operations_ = {
  ensure: async (target: Target, settings: Settings, say: Say) => {
    const name = dind.name(target);
    const state = docker.dind.state(name);

    if (state !== "running") {
      const admission = capacity.admit(
        daemons.observe(),
        capacity.budget(process.env, readFileSync(config.meminfo, "utf8")),
        Date.now(),
      );
      if (!admission.admitted)
        return refuse(admission.reason === "memory"
          ? `the VM has no headroom for another dind: starting ${name} would leave less than
             the floor free, and only busy or just-started dinds could make room (${admission.blockedBy.join(", ") || "none"}).
             Stop one of their projects, or raise DESOLATE_DIND_MEM_FLOOR.`
          : `${name} would exceed DESOLATE_MAX_DINDS, and every running dind is in use or
             started in the last DESOLATE_DIND_GRACE minutes (${admission.blockedBy.join(", ")}).
             Stop one of their projects first.`);
      for (const evicted of admission.evict) {
        say(`making room: ${evicted} has been idle longest`);
        daemons.stop(evicted, say);
        ingress.withdraw(evicted);
      }
    }

    if (state === "") {
      const base = specFor(target, settings);
      const spec = { ...base, limits: { ...base.limits, cpus: cpusFor(base.limits.cpus, docker.cpus()) } };
      if (!docker.dind.networkExists(spec.network) &&
          docker.dind.createNetwork(spec.network, spec.network, spec.label) !== 0)
        refuse(`could not create ${spec.network}: ${lastFailure}`);
      // volume-subpath refuses a path that does not exist yet.
      if (docker.inVolume(HELPER_IMAGE, spec.volumes.sockets, "/s",
                          ["mkdir", "-p", `/s/${spec.volumes.socketSubpath}`]) !== 0)
        refuse(`could not prepare ${name}'s socket directory: ${lastFailure}`);
      say(`${name}: creating (${settings.runtime}, ${target.project} only)`);
      if (docker.dind.create(spec) !== 0)
        refuse(`docker refused to create ${name} (docker ${docker.version()}): ${lastFailure}`);
    } else if (state !== "running") {
      say(`${name}: starting (warm: its images are where it left them)`);
      if (docker.dind.start(name) !== 0) refuse(`could not start ${name}: ${lastFailure}`);
    }

    const health = await daemons.waitHealthy(name, settings, say);
    if (health === "wedged")
      refuse(`${name}'s daemon is wedged: its socket is bound and 'docker info' does not
              answer. Stop it and ensure it again; purging it, which discards its
              images, is the last resort.`);
    if (health !== "healthy")
      refuse(`${name} did not become healthy in ${settings.bootSeconds}s (still booting)`);
    ingress.publish(target);
    lastBusy.set(name, Date.now());
    return { dind: name, socket: dind.sockets.forOrchestrator(target) };
  },

  reset: async (target: Target, settings: Settings, say: Say) => {
    const name = dind.name(target);
    if (docker.dind.state(name) === "")
      refuse(`${target.project} has no dind to reset; starting the project creates one`);
    ingress.withdraw(name);
    say(`${name}: restarting (nothing else on the VM is touched)`);
    if (docker.dind.restart(name) !== 0) refuse(`could not restart ${name}: ${lastFailure}`);
    const health = await daemons.waitHealthy(name, settings, say);
    if (health !== "healthy")
      refuse(`${name} is ${health} after a restart. What is left is its image store:
              cli.sh dind reset ${target.project} --reset-data-root`);
    ingress.publish(target);
    lastBusy.set(name, Date.now());
    return { dind: name, health };
  },

  stop: async (target: Target, _settings: Settings, say: Say) => {
    const name = dind.name(target);
    ingress.withdraw(name);
    daemons.stop(name, say);
    return { dind: name, state: docker.dind.state(name) || "absent" };
  },

  purge: async (target: Target, settings: Settings, say: Say) => {
    const spec = specFor(target, settings);
    ingress.withdraw(spec.name);
    daemons.stop(spec.name, say, /* purging */ true);
    docker.container.remove([spec.name]);
    docker.volume.remove([spec.volumes.data]);
    if (docker.dind.networkExists(spec.network) && docker.dind.removeNetwork(spec.network) !== 0)
      say(`${spec.network} is still in use (${lastFailure}); left in place`);
    docker.inVolume(HELPER_IMAGE, spec.volumes.sockets, "/s", ["rm", "-rf", `/s/${spec.volumes.socketSubpath}`]);
    lastBusy.delete(spec.name);
    say(`${spec.name}: purged (container, image store, bridge)`);
    return { dind: spec.name, state: "absent" };
  },

  status: () => {
    const observed = daemons.observe();
    const budget = capacity.budget(process.env, readFileSync(config.meminfo, "utf8"));
    return {
      dinds: observed.map((daemon) => ({
        ...daemon,
        project: docker.dind.projectOf(daemon.name, dind.LABEL_KEY),
        health: daemon.running ? healthOf(docker.dind.health(daemon.name)) : "stopped",
        imageStoreKib: docker.volumeKib(HELPER_IMAGE, dind.dataVolumeOf(daemon.name)),
      })),
      headroom: {
        running: observed.filter(({ running }) => running).length,
        max: budget.max,
        available: budget.available,
        floor: budget.floor,
      },
    };
  },
};

/** inner-health.sh's exit status, as a word. */
const HEALTH: Record<number, string> = { 0: "healthy", 1: "booting", 2: "wedged" };
const healthOf = (status: number) => HEALTH[status] ?? `unknown (inner-health.sh exited ${status})`;

/** Reap on a timer what capacity.reapable says has been idle long enough. */
const reap = (settings: Settings, say: Say) => {
  for (const name of capacity.reapable(daemons.observe(), Date.now(), settings.idleMs)) {
    say(`reaping ${name}: idle for ${settings.idleMs / 60_000} min`);
    ingress.withdraw(name);
    daemons.stop(name, say);
  }
};

// -------------------------------------------------------------- the server --

const config = {
  socket: process.env.DESOLATE_SUPERVISOR ?? "/run/supervisor/supervisor.sock",
  ingressDinds: process.env.DESOLATE_INGRESS_DINDS ?? "/run/ingress/dinds",
  meminfo: process.env.DESOLATE_MEMINFO ?? "/proc/meminfo",
};

/** Mutating requests run one at a time: two admissions computed side by side
 *  would each see room the other is about to take. */
let queue: Promise<unknown> = Promise.resolve();
const serially = <T>(work: () => Promise<T>): Promise<T> => {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
};

const serve = (settings: Settings) => {
  mkdirSync(dirname(config.socket), { recursive: true });
  try {
    unlinkSync(config.socket);
  } catch {}
  createServer((connection) => {
    let buffer = "";
    let handled = false;
    const send = (payload: Record<string, unknown>) => {
      if (connection.writable) connection.write(JSON.stringify(payload) + "\n");
    };
    const say: Say = (line) => {
      send({ log: line });
      console.log(line);
    };
    connection.on("data", async (chunk) => {
      if (handled) return;
      buffer += chunk.toString();
      if (buffer.length > MAX_REQUEST_BYTES) return void (send({ ok: false, error: "request too large" }), connection.end());
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      handled = true;
      try {
        const request: unknown = JSON.parse(buffer.slice(0, at));
        if (!isRequest(request)) throw new Error("not a request this supervisor knows");
        const result = request.op === "status"
          ? operations_.status()
          : await serially<Record<string, unknown>>(() =>
              operations_[request.op](targetOf(request.project), settings, say));
        send({ ok: true, ...result });
      } catch (err: any) {
        send({ ok: false, error: String(err?.message ?? err) });
      } finally {
        connection.end();
      }
    });
    connection.on("error", () => undefined);
  }).listen(config.socket, () => {
    // The volume this lives in is mounted by the orchestrator alone; that
    // mount, not a mode, is the access control. 0666 so its uid 1000 connects.
    chmodSync(config.socket, 0o666);
    console.log(`supervisor listening on ${config.socket} (${settings.runtime})`);
  });

  ingress.prune();
  ingress.publishShared(settings);
  setInterval(() => {
    serially(async () => {
      ingress.prune();
      ingress.publishShared(settings);
      reap(settings, console.log);
    }).catch((err) => console.error(`reaper: ${err?.message ?? err}`));
  }, Math.min(settings.idleMs, 60_000)).unref?.();
};

// -------------------------------------------------------------- the client --
// `cli.sh dind` runs these with `docker exec desolate-supervisor`: the one
// container that mounts this socket besides the orchestrator, and the Mac's
// docker context reaches it without a network.

const USAGE = `usage: supervisor.ts                         serve
       supervisor.ts ask <op> [<project>]      one request: its log on stderr, its answer on stdout
       supervisor.ts list                      every project dind, and the VM's headroom`;

const GIB = 1024 ** 3;
const gib = (bytes?: number) => (bytes === undefined ? "?" : `${(bytes / GIB).toFixed(1)} GiB`);
const ago = (since: number | undefined, now: number) =>
  since === undefined ? "-" : `${Math.round((now - since) / 60_000)} min`;

/** `status`'s answer as the table `cli.sh dind list` prints. */
export const formatStatus = (answer: Record<string, any>, now = Date.now()) => {
  const rows = [["PROJECT", "STATE", "IN USE", "IDLE FOR", "MEMORY", "IMAGE STORE"]];
  for (const d of answer.dinds ?? [])
    rows.push([
      d.project || d.name,
      d.health,
      d.running ? (d.inUse ? "yes" : "no") : "-",
      d.running && !d.inUse ? ago(d.idleSince, now) : "-",
      d.running ? gib(d.memory) : "-",
      d.imageStoreKib === undefined ? "?" : gib(d.imageStoreKib * 1024),
    ]);
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  const table = rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd());
  const { running, max, available, floor } = answer.headroom ?? {};
  return [
    ...(rows.length > 1 ? table : ["no project dinds"]),
    "",
    `headroom: ${running} of ${max} dinds running; ${gib(available)} free, ${gib(floor)} of it kept back`,
  ].join("\n");
};

const client = async ([verb, op, project, ...rest]: string[]) => {
  const say = (line: string) => console.error(line);
  if (verb === "list" && op === undefined) {
    const answer = await ask(config.socket, { op: "status" }, say);
    if (answer.ok !== true) throw new Error(answer.error);
    return console.log(formatStatus(answer));
  }
  const request = project === undefined ? { op } : { op, project };
  if (verb !== "ask" || rest.length || !isRequest(request)) throw new Error(USAGE);
  const answer = await ask(config.socket, request as Record<string, string>, say);
  if (answer.ok !== true) throw new Error(answer.error);
  console.log(JSON.stringify(answer));
};

if (isEntryPoint(import.meta.url)) {
  const argv = process.argv.slice(2);
  // A promise chain, not a top-level await: tsx in the image compiles this
  // file to CommonJS, which has none (tests/static/09 checks every file).
  new Promise<void>((resolve) => resolve(argv.length ? client(argv) : serve(settingsFrom(process.env))))
    .catch((err: any) => {
      console.error(`supervisor: ${err?.message ?? err}`);
      process.exit(1);
    });
}
