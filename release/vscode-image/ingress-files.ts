/**
 * ingress-files.ts -- desolate-ingress's ports/ directory, from the writing side.
 *
 * One file per host port, `<dind>:<port> <owner>`; the ingress (ingress.py)
 * opens 127.0.0.1:<host port> in the VM for each, which Lima carries to the
 * Mac. A file here IS the forward, and removing it closes it.
 *
 * It is also the one registry of host ports every start can see, whichever
 * daemon it runs on. So a port is CLAIMED here the moment it is allocated -- an
 * exclusive create, which two starts cannot both win -- and only the target
 * that claimed it ever removes it: the port a stopped target last held may be
 * someone else's by the time it stops again, or is purged.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { PortMap } from "./ports.ts";

/** One file's content. The owner is a target's namespace, which is already a
 *  docker-name-safe spelling, so it needs no quoting of its own. */
export const ingressFile = {
  format: (dindName: string, hostPort: number, owner: string) => `${dindName}:${hostPort} ${owner}\n`,
  /** "" for a file that names no owner: somebody's, but not provably anyone's. */
  ownerOf: (content: string) => content.trim().split(/\s+/)[1] ?? "",
};

export class IngressMissingError extends Error {}

export const ingressDirectory = (directory: string) => {
  const fileOf = (hostPort: number) => path.join(directory, String(hostPort));
  /** An owner that could match a file naming none would own every such file. */
  const named = (owner: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(owner)) throw new Error(`'${owner}' cannot own a forward`);
    return owner;
  };

  const files = {
    /** Every file, by name, with its content. */
    read: (): Map<string, string> => {
      let names: string[];
      try {
        names = fs.readdirSync(directory);
      } catch {
        throw new IngressMissingError(directory);
      }
      const entries = new Map<string, string>();
      for (const name of names) {
        try {
          entries.set(name, fs.readFileSync(path.join(directory, name), "utf8"));
        } catch {} // gone between the listing and the read: not held
      }
      return entries;
    },

    /** undefined when there is no file. */
    ownerOf: (hostPort: number) => {
      try {
        return ingressFile.ownerOf(fs.readFileSync(fileOf(hostPort), "utf8"));
      } catch {
        return undefined;
      }
    },

    /** Make the file `owner`'s: created if there is none (a hard link of a
     *  staged copy, which fails rather than replaces), REWRITTEN if it is
     *  `owner`'s already -- a rewrite is what makes the ingress reopen a
     *  listener, which a collided port needs (L6). False when another owner
     *  holds it. Atomic either way, as the ingress expects. */
    claim: (hostPort: number, dindName: string, owner: string): boolean => {
      // Not a port name, so the ingress ignores it while it exists.
      const staged = path.join(directory, `.${hostPort}.${process.pid}`);
      fs.writeFileSync(staged, ingressFile.format(dindName, hostPort, named(owner)));
      try {
        try {
          fs.linkSync(staged, fileOf(hostPort));
          return true;
        } catch (err: any) {
          if (err?.code !== "EEXIST") throw err;
        }
        if (files.ownerOf(hostPort) !== owner) return false;
        fs.renameSync(staged, fileOf(hostPort));
        return true;
      } finally {
        fs.rmSync(staged, { force: true });
      }
    },

    /** Removed only if `owner` claimed it. Nobody else can replace a file
     *  between this read and the removal: another owner only ever creates a
     *  file that is absent, and rewrites only its own. */
    release: (hostPort: number, owner: string) => {
      if (files.ownerOf(hostPort) === named(owner)) fs.rmSync(fileOf(hostPort), { force: true });
    },

    /** `owner`'s forwards, exactly: what it held before and no longer does is
     *  released, then each port in `map` is rewritten. Returns the ports it
     *  could not, because another owner holds them. */
    publish: (previous: PortMap, map: PortMap, dindName: string, owner: string): number[] => {
      const now = new Set(map.values());
      for (const port of previous.values()) if (!now.has(port)) files.release(port, owner);
      return [...map.values()].filter((port) => !files.claim(port, dindName, owner));
    },

    withdraw: (map: PortMap, owner: string) => {
      for (const port of map.values()) files.release(port, owner);
    },
  };
  return files;
};

/** The host ports whose file names `owner`, from `read()`'s entries. */
export const ownedForwards = (entries: Map<string, string>, owner: string): Set<number> =>
  new Set(
    [...entries]
      .filter(([name, content]) => /^[1-9][0-9]{0,4}$/.test(name) && ingressFile.ownerOf(content) === owner)
      .map(([name]) => Number(name)),
  );
