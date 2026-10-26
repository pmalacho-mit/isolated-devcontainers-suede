/**
 * dind.ts -- the docker daemon a project gets to ITSELF: which projects need
 * one, and what everything it owns is called.
 *
 * These names are the only place a project daemon's owner is recorded in a form
 * other code reads back, so composing them belongs here rather than in a
 * template literal at each caller.
 *
 * ONE DAEMON PER PROJECT, shared by that project's worktrees -- which is why
 * everything below is keyed on `projectNamespace` and not on the target's own.
 * A worktree's `.git` is a file naming its project's, whose `commondir` names
 * another path again, so a daemon that could see only the worktree could not
 * run git in it at all. Bind sources resolve on the daemon that starts the
 * container, so the daemon has to see the whole project either way.
 */
import { projectNamespace, type Target } from "./projects.ts";
import { sha16 } from "./utils.ts";

/** Floating major, as the shared dind's image is and for the same reason:
 *  patch rebuilds carry the Alpine security fixes and a hard pin rots. */
export const IMAGE = "docker:29-dind";

const PREFIX = "desolate-dind";

export const name = (target: Target) => `${PREFIX}-${projectNamespace(target)}`;

/**
 * The addresses a dind's OWN daemon hands out: its `docker0`, and the pool its
 * networks are cut from. Pinned outside docker's default pools, which the VM's
 * daemon draws its bridges from too (172.17-172.31, then 192.168).
 *
 * Unpinned, the two daemons chose independently, and the inner one remembers
 * its choice in its data volume. Measured on the VM (2026-10-26): a `down` and
 * `up` gave `desolate_dindnet` 172.18.0.0/16 -- the subnet the shared dind's
 * `docker0` had held since its first start, at the very address the VM's
 * gateway now had. The dind then answered the VM's ARP on the wrong interface:
 * the ingress could reach nothing on it, and its route out was its own bridge.
 * Every dind is a namespace of its own, so they can all share this range.
 */
export const INNER_BRIDGE_IP = "10.234.255.1/24";
export const INNER_POOL = { base: "10.234.0.0/17", size: 24 } as const;

/**
 * A project dind's mirror (#11): a registry that trust-proxy-in-builds.sh
 * --shadow starts in the dind on first use, on its loopback, and pushes the
 * CA-trusting derivative to under the base's own name. Listed in every
 * project dind's daemon.json, where the containerd image store makes BuildKit
 * honour it -- so a build posted to the Engine API gets the derivative too
 * (T5.3, S7). A dind that never shadows has nothing listening there, and its
 * pulls fall through to Docker Hub. An odd port, so a project's own `:5000`
 * is not taken from it; tests/static/14 holds the script to the same values.
 */
export const MIRROR = {
  address: "127.0.0.1:5995",
  image: "registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373",
} as const;

/** Matches EVERY project dind, for sweeps that know no targets. */
export const LABEL_KEY = "desolate.dind";

/** Matches one project's dind, and no other container.
 *
 *  The value is the project's WRITTEN name rather than its namespace, for the
 *  same reason a relay's label is: `acme/widgets` is what a user would type. */
export const label = ({ project }: Target) => `${LABEL_KEY}=${project}`;

/** What a dind keeps, split by what a stop is allowed to discard.
 *
 *  Stopping a dind must leave its images unpacked -- that is the whole reason
 *  idle dinds are stopped rather than destroyed -- so the image store is a
 *  volume of its own and only a purge removes it.
 *
 *  Its SOCKET is not a volume of its own. Every project dind listens in one
 *  shared volume (`sockets.volume`), each in the directory named for its
 *  namespace, mounted into that dind alone with `volume-subpath`. The
 *  orchestrator, which drives every project, mounts the whole volume -- a
 *  container's mounts are fixed at creation, so a volume per project could
 *  never reach an orchestrator that is already running. */
export const volumes = (target: Target) => ({
  data: dataVolume(projectNamespace(target)),
  socketSubpath: projectNamespace(target),
});

const dataVolume = (namespace: string) => `dind-data-${namespace}`;

/** A dind's image store from its container name alone, for callers that list
 *  containers and hold no target: both are named for the same namespace. */
export const dataVolumeOf = (containerName: string) => {
  if (!containerName.startsWith(`${PREFIX}-`)) throw new Error(`${containerName} is not a project dind`);
  return dataVolume(containerName.slice(PREFIX.length + 1));
};

/** Where the shared sockets volume lives, from each side of it. */
export const sockets = {
  /** The compose volume (compose prefixes it with the project, `desolate_`). */
  volume: "dind-sockets",
  /** Where the orchestrator mounts the whole of it. */
  orchestratorMount: "/run/dind-sockets",
  /** One project's socket, as the orchestrator reaches it. */
  forOrchestrator: (target: Target) =>
    `/run/dind-sockets/${projectNamespace(target)}/docker.sock`,
};

/** The network a project dind sits on is named for the bridge it pins, so a
 *  sweep that knows only bridges can find it. */
export const network = (target: Target) => bridge(target);

/** Linux caps interface names at IFNAMSIZ-1 and silently REJECTS longer ones,
 *  which is why this is hashed: a namespace may be 129 characters. */
const MAX_INTERFACE_NAME = 15;
const BRIDGE_PREFIX = "br-d-";

export const bridge = (target: Target) =>
  BRIDGE_PREFIX +
  sha16(projectNamespace(target)).slice(
    0,
    MAX_INTERFACE_NAME - BRIDGE_PREFIX.length,
  );

/** The daemon listens in a directory of its own rather than in the dind's
 *  /var/run, so the volume that carries the socket to the devcontainer carries
 *  nothing else. */
const SOCKET_DIRECTORY = "/run/dind-sock";

const SPELLINGS = [
  `${SOCKET_DIRECTORY}/docker.sock`,
  /** Where `docker-outside-of-docker` binds from. The dind links it to the
   *  path above, so the feature works unmodified. */
  "/var/run/docker.sock",
] as const;

export const socket = {
  directory: SOCKET_DIRECTORY,
  path: SPELLINGS[0],
  alias: SPELLINGS[1],
  /**
   * Does this bind source name a project daemon's socket?
   *
   * Equality against a closed set, never a prefix: `/var/run/docker.sock.evil`
   * is not this socket, and a prefix rule would say that it was.
   */
  isNamedBy: (source: string) =>
    (SPELLINGS as readonly string[]).includes(source),
};

/**
 * Feature ids that get a project a daemon of its own.
 *
 * ONE, and deliberately: `docker-outside-of-docker` is a client that expects a
 * socket, which is exactly what a project dind hands it. `docker-in-docker`
 * puts a second daemon INSIDE the devcontainer, which is the `--privileged`
 * shape this whole design removes -- policy refuses it with a migration
 * message rather than provisioning for it (docs/dind, v2.1).
 *
 * An allowlist. A feature this does not recognise yields NO dedicated daemon,
 * which leaves a project without docker -- the failure a user reports in a
 * minute -- rather than a project quietly sharing everyone else's, which is
 * the failure nobody sees.
 */
const DAEMON_FEATURES = [
  /^ghcr\.io\/devcontainers\/features\/docker-outside-of-docker(?:[:@]|$)/i,
];

/**
 * Does a spec declaring these features need a daemon of its own?
 *
 * The single source of the provisioning rule. Whether a project gets a dind and
 * whether its devcontainer may bind a docker socket are the same question, and
 * two spellings of it would drift into a devcontainer holding a socket nobody
 * provisioned -- which is the shared daemon, and every other project on it.
 */
export const isRequiredBy = (featureIds: Iterable<string>) =>
  [...featureIds].some((id) =>
    DAEMON_FEATURES.some((feature) => feature.test(id)),
  );
