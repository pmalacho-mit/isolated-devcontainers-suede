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

/**
 * Admission is HEADROOM, not a count (docs/dind, v2.1): another daemon starts
 * when the VM still has `floor` free after it has, evicting idle daemons to
 * get there. The count stays as a hard cap -- it bounds the daemons competing
 * for the cores and the blast area when one misbehaves -- but at 16 it is a
 * backstop, so ten concurrent projects are a budget rather than a ceiling.
 */
export const DEFAULTS = {
  maxDinds: 16,
  /** What must stay free on the VM once a new daemon is up. */
  memFloor: 2 * 1024 ** 3,
  /** What one more daemon is expected to take. Measured on the VM: ~490 MiB
   *  with 15 images, and `docker stats` counts page cache, so this is an
   *  upper bound rather than an RSS (v2-baseline.sh B2). */
  newcomer: 512 * 1024 ** 2,
} as const;

/** What admission is measured against. All memory figures in bytes. */
export interface Budget {
  /** Hard cap on RUNNING daemons. */
  max: number;
  /** The VM's MemAvailable right now. */
  available: number;
  floor: number;
  newcomer: number;
}

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
  /** What it holds now, in bytes, if measured -- what stopping it frees.
   *  Absent is read as the newcomer estimate. */
  memory?: number;
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
  | {
      admitted: false;
      /** Which limit could not be met even after every allowed eviction. */
      reason: "ceiling" | "memory";
      /** The busy daemons in the way -- the ones to go and stop. */
      blockedBy: string[];
    };

/**
 * May another daemon start, and what has to stop first?
 *
 * Idle daemons give way longest-idle first, each freeing what it holds, until
 * both limits hold: fewer than `max` running, and `floor` still free once the
 * newcomer has taken its share. A daemon whose devcontainer is UP is never
 * evicted -- stopping it kills whatever is running inside to make room for
 * something else, which is worse than the refusal -- so a budget that only
 * busy daemons could free is a refusal, and `blockedBy` names them.
 */
export const admit = (daemons: readonly ProjectDaemon[], budget: Budget): Admission => {
  const running = daemons.filter((daemon) => daemon.running);
  const candidates = running.filter(stoppable).sort(leastRecentlyUsed);
  const evict: string[] = [];
  let count = running.length;
  let available = budget.available;

  const underCeiling = () => count + 1 <= budget.max;
  const leavesFloor = () => available - budget.newcomer >= budget.floor;

  for (const daemon of candidates) {
    if (underCeiling() && leavesFloor()) break;
    evict.push(daemon.name);
    count -= 1;
    available += daemon.memory ?? budget.newcomer;
  }

  if (underCeiling() && leavesFloor()) return { admitted: true, evict };
  return {
    admitted: false,
    reason: underCeiling() ? "memory" : "ceiling",
    blockedBy: running.filter((daemon) => !stoppable(daemon)).map(({ name }) => name),
  };
};

/** `MemAvailable` from /proc/meminfo, in bytes; NaN when it is not there,
 *  which `budget` refuses rather than reading as zero or as plenty. */
export const memAvailable = (meminfo: string) => {
  const kib = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
  return kib === undefined ? NaN : Number(kib) * 1024;
};

const positiveInteger = (raw: string | undefined, fallback: number, name: string) => {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0)
    throw new Error(`${name} must be a positive integer, not '${raw}'`);
  return Number(raw);
};

/**
 * The budget from the supervisor's environment and the VM's /proc/meminfo.
 *
 * @throws when a variable is malformed or MemAvailable is missing: an
 * admission computed from a guess is one that fails open.
 */
export const budget = (env: Record<string, string | undefined>, meminfo: string): Budget => {
  const available = memAvailable(meminfo);
  if (!Number.isFinite(available))
    throw new Error("no MemAvailable in /proc/meminfo; refusing to guess the VM's headroom");
  return {
    max: positiveInteger(env.DESOLATE_MAX_DINDS, DEFAULTS.maxDinds, "DESOLATE_MAX_DINDS"),
    available,
    floor: positiveInteger(env.DESOLATE_DIND_MEM_FLOOR, DEFAULTS.memFloor, "DESOLATE_DIND_MEM_FLOOR"),
    newcomer: positiveInteger(env.DESOLATE_DIND_MEM_EXPECTED, DEFAULTS.newcomer, "DESOLATE_DIND_MEM_EXPECTED"),
  };
};
