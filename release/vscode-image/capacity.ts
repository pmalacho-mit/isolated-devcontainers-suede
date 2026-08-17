/**
 * capacity.ts -- how many project daemons may run at once, and which one gives
 * way when another project needs to start.
 *
 * Pure and side-effect free: it decides, and the supervisor acts.
 *
 * The two rules here are what keep a per-project daemon from becoming a machine
 * that fills up. Neither is an optimisation. With most of the tree eligible for
 * a daemon of its own, an unreaped dind per project IS the resource problem.
 */

/** Measured on the VM rather than guessed: one dind is ~490 MiB with 15 images,
 *  so eight of them is ~4 GB. Memory is not what this bounds -- the machine has
 *  far more of it than that -- it bounds the number of daemons competing for 8
 *  cores, and the blast area when one of them misbehaves. */
export const DEFAULT_MAX_DINDS = 8;

/** One project daemon, as the supervisor currently sees it. */
export interface ProjectDaemon {
  name: string;
  running: boolean;
  /** Its devcontainer is up right now, so a user or an agent is inside it. */
  inUse: boolean;
  /** When its devcontainer was last seen up, in epoch milliseconds.
   *
   *  Absent while `inUse`, because "how long has it been idle" is not a
   *  question about a daemon somebody is working in. */
  idleSince?: number;
}

/** Stopping a daemon keeps its image store, so the cost of being wrong about
 *  idleness is a warm restart -- seconds -- and never a lost build cache. */
const stoppable = ({ running, inUse }: ProjectDaemon) => running && !inUse;

const idleLongEnough = (before: number) => (daemon: ProjectDaemon) =>
  daemon.idleSince !== undefined && daemon.idleSince <= before;

/** Longest idle first, so the daemon most likely to be wanted again survives. */
const leastRecentlyUsed = (a: ProjectDaemon, b: ProjectDaemon) =>
  (a.idleSince ?? Infinity) - (b.idleSince ?? Infinity);

/**
 * Which daemons have been idle long enough to stop.
 *
 * `now` and `idleFor` are required rather than defaulted: a default clock is
 * how a test passes while the real caller reaps on a different rule.
 */
export const reapable = (
  daemons: readonly ProjectDaemon[],
  now: number,
  idleFor: number,
): string[] =>
  daemons
    .filter(stoppable)
    .filter(idleLongEnough(now - idleFor))
    .map(({ name }) => name);

export type Admission =
  | { admitted: true; evict: string[] }
  | { admitted: false; blockedBy: string[] };

/**
 * May another daemon start, and what has to stop first?
 *
 * A daemon whose devcontainer is UP is never evicted. Stopping it would kill
 * whatever is running inside it to make room for something else, which is a
 * worse outcome than the refusal -- so a full set of busy daemons is a refusal,
 * and `blockedBy` names who to go and stop.
 */
export const admit = (
  daemons: readonly ProjectDaemon[],
  max: number,
): Admission => {
  const running = daemons.filter((daemon) => daemon.running);
  const overBy = running.length + 1 - max;
  if (overBy <= 0) return { admitted: true, evict: [] };

  const evictable = running.filter(stoppable).sort(leastRecentlyUsed);
  if (evictable.length < overBy)
    return {
      admitted: false,
      blockedBy: running
        .filter((daemon) => !stoppable(daemon))
        .map(({ name }) => name),
    };

  return {
    admitted: true,
    evict: evictable.slice(0, overBy).map(({ name }) => name),
  };
};
