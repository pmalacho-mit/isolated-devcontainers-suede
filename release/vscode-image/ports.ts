/**
 * ports.ts -- which host port each of a project's services gets.
 *
 * The allocation rule is separated from the two things it needs to know about
 * the world (what the daemon already publishes, what this project already
 * holds), so the rule can be exercised on port maps that would take a running
 * stack to reproduce.
 */
import { hint } from "./hints.ts";
import * as relay from "./relays.ts";

export type PortMap = Map<string, number>;

/** The label every project allocates, whatever else it asks for. */
export const EDITOR_LABEL = "editor";

export class PortRangeError extends Error {}
export class PortsExhaustedError extends Error {}

/** Where allocation starts, and the bound it can never go under.
 *
 *  There is no range any more: a host port is a listener desolate-ingress
 *  opens on demand, so nothing has to be published in advance. Below 1024,
 *  Lima forwards a VM listener onto the Mac's LAN (vm-loopback-forward.sh L3),
 *  so the ingress refuses those -- and so does this. */
export const DEFAULT_BASE = 8080;
const LOWEST_FORWARDED = 1024;
const HIGHEST = 65535;

/** DESOLATE_PORT_BASE, or the default.
 *
 *  @throws PortRangeError if it is not a port the ingress would forward. */
export const portBase = (environment: Record<string, string | undefined>) => {
  const raw = environment.DESOLATE_PORT_BASE;
  if (raw === undefined || raw === "") return DEFAULT_BASE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < LOWEST_FORWARDED || value > HIGHEST)
    throw new PortRangeError(
      `DESOLATE_PORT_BASE='${raw}' must be a port from ${LOWEST_FORWARDED} to ${HIGHEST} ` +
        `(below ${LOWEST_FORWARDED}, Lima forwards onto the Mac's LAN)`,
    );
  return value;
};

/** What the allocator has to be told about the world it is allocating in. */
export interface PortWorld {
  /** The lowest port it may give out. */
  base: number;
  /** Host port -> who holds it: every ports/ file the ingress serves, and
   *  anything the inner daemon publishes. */
  published: Map<number, string>;
  /** Ports this project's own relays already hold; taking one back is not a clash. */
  ownRelayPorts: Set<number>;
  /** Ports whose ports/ file this target claimed; nor is taking one of those. */
  ownForwards: Set<number>;
  /** This project's previous allocation, so URLs stay stable across restarts. */
  previous: PortMap;
}

/** Ports this project's relays hold, read back off their container names. */
export const ownRelayPorts = (relayNames: string[]): Set<number> =>
  new Set(
    relayNames
      .map(relay.hostPort)
      .filter((port): port is number => port !== undefined),
  );

/** Every host port the ingress is serving, and what each one forwards to --
 *  `<dind>:<port>`, the file's own content -- read from its ports/ directory.
 *  Only files named as ports count; the ingress ignores the rest too. */
export const ingressPorts = (entries: Map<string, string>): Map<number, string> => {
  const held = new Map<number, string>();
  for (const [name, content] of entries)
    if (/^[1-9][0-9]{0,4}$/.test(name)) held.set(Number(name), content.trim() || "(empty)");
  return held;
};

/** Why no port could be given out, listing who holds the lowest of them. */
const exhausted = (label: string, world: PortWorld, taken: Set<number>) => {
  const holders = [...world.published]
    .filter(([port]) => port >= world.base)
    .sort(([a], [b]) => a - b)
    .slice(0, 40)
    .map(([port, holder]) => `        ${port}  ${taken.has(port) ? "this project" : holder}`);
  return new PortsExhaustedError(
    `no host port is free from ${world.base} to ${HIGHEST} for '${label}'
      The lowest holders:

${holders.join("\n")}
      Free some:  ${hint.desolate("--stop <project> [--worktree <name>]")}
      Or start lower:  DESOLATE_PORT_BASE in the .env next to docker-compose.yml.`,
  );
};

/** Give every label a host port, preferring the one it had last time, and
 *  otherwise the lowest free one from `base`.
 *
 *  @throws PortsExhaustedError naming who holds the ports. */
export const allocatePorts = (
  world: PortWorld,
  appPorts: number[],
): PortMap => {
  const taken = new Set<number>();

  const available = (port: number) =>
    port >= world.base &&
    port <= HIGHEST &&
    !taken.has(port) &&
    (!world.published.has(port) || world.ownRelayPorts.has(port) || world.ownForwards.has(port));

  const claim = (label: string): number => {
    const remembered = world.previous.get(label);
    if (remembered !== undefined && available(remembered)) {
      taken.add(remembered);
      return remembered;
    }
    for (let port = world.base; port <= HIGHEST; port++)
      if (available(port)) {
        taken.add(port);
        return port;
      }
    throw exhausted(label, world, taken);
  };

  const allocated: PortMap = new Map();
  allocated.set(EDITOR_LABEL, claim(EDITOR_LABEL));
  for (const port of appPorts) allocated.set(String(port), claim(String(port)));
  return allocated;
};

/** Move one label to a port the caller chose (`desolate --ports <p> --move`):
 *  for when the Mac already holds the one it had, which Lima never forwards.
 *
 *  @throws PortRangeError for an unknown label, a port the ingress would not
 *  serve, or one somebody else holds. */
export const movePort = (world: PortWorld, label: string, port: number): PortMap => {
  if (!world.previous.has(label))
    throw new PortRangeError(`no port is allocated to '${label}' (have: ${[...world.previous.keys()].join(", ")})`);
  if (!Number.isInteger(port) || port < LOWEST_FORWARDED || port > HIGHEST)
    throw new PortRangeError(`${port} is not a port the ingress forwards (${LOWEST_FORWARDED}-${HIGHEST})`);
  const holder = world.published.get(port);
  if (holder !== undefined && !world.ownRelayPorts.has(port) && !world.ownForwards.has(port))
    throw new PortRangeError(`${port} is held by ${holder}`);
  for (const [other, held] of world.previous)
    if (other !== label && held === port)
      throw new PortRangeError(`${port} is already this target's '${other}'`);
  return new Map([...world.previous].map(([l, p]) => [l, l === label ? port : p]));
};

/** Host ports published across the inner daemon, from `docker ps` output.
 *
 *  Takes the text rather than running docker, because the mapping from that
 *  format to (port -> container) is the part worth pinning down. */
export const publishedPorts = (dockerPsLines: string): Map<number, string> => {
  const published = new Map<number, string>();
  for (const line of dockerPsLines.split("\n")) {
    const [name, ports = ""] = line.trim().split("\t");
    if (!name) continue;
    for (const match of ports.matchAll(/:(\d+)->/g))
      published.set(Number(match[1]), name);
  }
  return published;
};

/** The on-disk form of a port map: one `<label> <port>` per line. */
export const portMapFile = {
  parse: (contents: string): PortMap => {
    const map: PortMap = new Map();
    for (const line of contents.split("\n")) {
      const [label, port] = line.trim().split(/\s+/);
      if (label && port && /^\d+$/.test(port)) map.set(label, Number(port));
    }
    return map;
  },
  format: (map: PortMap) =>
    [...map].map(([label, port]) => `${label} ${port}`).join("\n") + "\n",
};
