/**
 * locks.ts -- one operation on a target at a time, across every runner in the
 * orchestrator: the broker's (the editor's panel and its `desolate`) and the
 * Mac's (`cli.sh desolate`) both run desolate.ts there, with one /tmp.
 *
 * Two operations on one target at once undo each other. A start copies the
 * target's spec to one place per target and reads it back minutes later; a
 * second start rewrites that copy in between, and the first fails to read
 * it. Every sandbox step removes whatever sandbox the target already has
 * (docker.ts worktreeSandbox), so a second one kills the first's. So the
 * second is refused, saying who holds the target, and exits BUSY_EXIT -- a
 * caller can tell "busy, try again" from a failure.
 *
 * A runner can outlive its caller: `docker exec` does not pass a ^C on, so the
 * Mac's side ends while the start goes on here. That is why the lock is the
 * runner's and not the caller's. A holder that died without letting go is
 * found dead by its pid and taken over.
 */
import { closeSync, constants, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export const LOCK_DIR = process.env.DESOLATE_LOCK_DIR ?? "/tmp/desolate-locks";

/** EX_TEMPFAIL: the target is busy; the same command later may well work. */
export const BUSY_EXIT = 75;

export interface Holder {
  pid: number;
  /** What it is doing, in words: "starting", "reviewing". */
  what: string;
  /** When it began, ISO 8601. */
  since: string;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM is a process that is there and not ours to signal.
    return err?.code === "EPERM";
  }
};

const fileOf = (key: string, dir: string) => join(dir, `${key}.lock`);

/** Who holds `key`, if a live process does. */
export const holderOf = (key: string, dir = LOCK_DIR): Holder | undefined => {
  try {
    const held = JSON.parse(readFileSync(fileOf(key, dir), "utf8"));
    if (Number.isInteger(held?.pid) && held.pid > 0 && alive(held.pid))
      return { pid: held.pid, what: String(held.what ?? "?"), since: String(held.since ?? "") };
  } catch { /* no holder, or none that says who */ }
  return undefined;
};

/**
 * Hold `key` for `what` until this process exits -- or, when a live process
 * holds it already, who that is. `key` is a target's namespace, which names
 * no other target.
 */
export const hold = (key: string, what: string, dir = LOCK_DIR, now = new Date()):
  { held: true; release: () => void } | { held: false; holder: Holder } => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = fileOf(key, dir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, what, since: now.toISOString() }));
      closeSync(fd);
      const release = () => {
        try {
          if (JSON.parse(readFileSync(file, "utf8")).pid === process.pid) rmSync(file, { force: true });
        } catch { /* gone already */ }
      };
      process.on("exit", release);
      return { held: true, release };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      const holder = holderOf(key, dir);
      if (holder) return { held: false, holder };
      rmSync(file, { force: true });   // its holder is gone: taken over
    }
  }
  return { held: false, holder: holderOf(key, dir) ?? { pid: 0, what: "something", since: "" } };
};
