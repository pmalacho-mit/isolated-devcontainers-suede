/**
 * ports.ts -- which host port each of a project's services gets.
 *
 * The allocation rule is separated from the two things it needs to know about
 * the world (what the daemon already publishes, what this project already
 * holds), so the rule can be exercised on port maps that would take a running
 * stack to reproduce.
 */
import * as relay from "./relays.ts";

export type PortMap = Map<string, number>;

/** The label every project allocates, whatever else it asks for. */
export const EDITOR_LABEL = "editor";

export interface PortRange {
  min: number;
  max: number;
}

export class PortRangeError extends Error {}
export class PortsExhaustedError extends Error {}

/** Read a port range from the environment, falling back to the compose default.
 *
 *  The default has to match docker-compose.yml's publish exactly, and forty
 *  ports is what a project's worktrees need: each target takes one for its
 *  editor before it asks for a single dev server, so a repo with three branches
 *  open is already four.
 *
 *  @throws PortRangeError if a bound is not a port, or the range is empty. */
export const portRange = (
  environment: Record<string, string | undefined>,
  fallback: PortRange = { min: 8080, max: 8119 },
): PortRange => {
  const read = (name: string, whenAbsent: number): number => {
    const raw = environment[name];
    if (raw === undefined || raw === "") return whenAbsent;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new PortRangeError(
        `${name}='${raw}' is not a port number (1-65535)`,
      );
    return value;
  };

  const min = read("DESOLATE_PORT_MIN", fallback.min);
  const max = read("DESOLATE_PORT_MAX", fallback.max);
  if (max < min)
    throw new PortRangeError(
      `DESOLATE_PORT_MIN=${min} is above DESOLATE_PORT_MAX=${max} -- empty range`,
    );
  return { min, max };
};

/** What the allocator has to be told about the world it is allocating in. */
export interface PortWorld {
  range: PortRange;
  /** Host port -> the container publishing it, across the whole inner daemon. */
  published: Map<number, string>;
  /** Ports this project's own relays already hold; taking one back is not a clash. */
  ownRelayPorts: Set<number>;
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

/** Why no port could be given out, listing who holds each one.
 *
 *  An exhausted range is only actionable if you can see which project to stop,
 *  so every port in the range is named with its holder. */
const exhausted = (label: string, world: PortWorld, taken: Set<number>) => {
  const { min, max } = world.range;
  const holder = (port: number) =>
    taken.has(port)
      ? "this project (allocated a moment ago)"
      : world.ownRelayPorts.has(port)
        ? "this project (existing relay)"
        : (world.published.get(port) ??
          "unknown -- not published by any running container");

  const held: string[] = [];
  for (let port = min; port <= max; port++)
    held.push(`        ${port}  ${holder(port)}`);

  return new PortsExhaustedError(
    `the host port range ${min}-${max} is full; nothing left for '${label}'
      All ${max - min + 1} ports are spoken for:

${held.join("\n")}
      Free some:  desolate --stop <project> [--worktree <name>]
      Every target holds a port for its editor, and a project's worktrees are
      targets of their own -- the holders above name each one, because a relay
      is called desolate-relay-<project>[--wt--<worktree>]-<port>.
      Or widen the range in the .env next to docker-compose.yml and
      restart the stack, so dind republishes it and this allocator and
      that publish stay in agreement:
        DESOLATE_PORT_MIN=${min}
        DESOLATE_PORT_MAX=${max + 10}
        ./cli.sh up
      Relay containers are 'restart: unless-stopped', so one whose project
      was deleted by hand still holds its port -- 'docker ps' on the inner
      daemon (./cli.sh observe ps) shows those as desolate-relay-*.`,
  );
};

/** Give every label a host port, preferring the one it had last time.
 *
 *  @throws PortsExhaustedError naming who holds each port in the range. */
export const allocatePorts = (
  world: PortWorld,
  appPorts: number[],
): PortMap => {
  const { min, max } = world.range;
  const taken = new Set<number>();

  const available = (port: number) =>
    port >= min &&
    port <= max &&
    !taken.has(port) &&
    (!world.published.has(port) || world.ownRelayPorts.has(port));

  const claim = (label: string): number => {
    const remembered = world.previous.get(label);
    if (remembered !== undefined && available(remembered)) {
      taken.add(remembered);
      return remembered;
    }
    for (let port = min; port <= max; port++)
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
