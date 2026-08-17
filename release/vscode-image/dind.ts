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
 *  volume of its own and only a purge removes it. */
export const volumes = (target: Target) => {
  const namespace = projectNamespace(target);
  return { data: `dind-data-${namespace}`, socket: `dind-sock-${namespace}` };
};

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
 * Feature ids that put a docker client or daemon into a project.
 *
 * An allowlist, and deliberately narrow. A feature this does not recognise
 * yields NO dedicated daemon, which leaves a project without docker -- the
 * failure a user reports in a minute -- rather than a project quietly sharing
 * everyone else's, which is the failure nobody sees.
 */
const DAEMON_FEATURES = [
  /^ghcr\.io\/devcontainers\/features\/docker-in-docker(?:[:@]|$)/i,
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
