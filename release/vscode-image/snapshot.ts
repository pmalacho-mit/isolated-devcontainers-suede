/**
 * snapshot.ts -- freeze a project's devcontainer spec where the editor cannot
 * reach it.
 *
 * This is the TOCTOU defence, and it is the reason validating the spec means
 * anything at all: /workspaces is writable by the editor (and by the project's
 * own container), so a spec that is validated in place can be swapped for
 * another between the check and `devcontainer up`. The copy lives on the
 * orchestrator's own filesystem, in a 0700 directory, and the container is
 * started from THAT via --override-config.
 *
 * It lives here rather than in broker.ts because there are TWO ways into
 * desolate -- the broker (from the editor) and `desolate-run` (from the Mac,
 * via `cli.sh desolate`) -- and only the first used to snapshot. The Mac is the
 * trust root, but the FILE it validates is not: it is attacker-authored content
 * in a directory attacker-controlled code can rewrite. Both entry points need
 * the same guarantee, so both call the same function.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/** Owner only. Anything able to write here can swap a validated spec for an
 *  unvalidated one after the check has passed. */
export const SNAPSHOT_DIRECTORY_MODE = 0o700 as const;

/** A symlink cycle inside .devcontainer would otherwise recurse forever. Far
 *  above any real spec directory, so hitting it means something is wrong. */
const MAX_DEPTH = 32;

/**
 * Copy `from` to `to`, reading THROUGH every symlink on the way.
 *
 * Not `fs.cpSync(..., { dereference: true })`, which is what this used to be
 * and which does not do it. A symlink inside the copied tree is reproduced in
 * the destination AS A SYMLINK, still pointing at the original, so the copy is
 * not a copy: `.devcontainer/devcontainer.json` as a link to a file the project
 * can rewrite left the policy validating one document and `devcontainer up`
 * reading whatever replaced it -- the exact attack the snapshot exists to stop.
 *
 * WHY it does not do it, because "cpSync is broken" is not a maintainable note.
 * `lib/internal/fs/cp/cp-sync.js` has two implementations of copyDir:
 *
 *     function copyDir(src, dest, opts, mkDir, srcMode) {
 *       if (!opts.filter) {
 *         return fsBinding.cpSyncCopyDir(src, dest, opts.force, opts.dereference, ...);
 *       }
 *       ... JS walk, calling getStats() per entry, which honours dereference ...
 *
 * The JS walk is correct. The C++ fast path ignores `dereference` for directory
 * entries -- and it is the one that runs, because it is selected by the ABSENCE
 * of an unrelated option. Measured on node 24.18 (the version the image pins),
 * `{recursive: true, dereference: true}` keeps nested symlinks while
 * `{recursive: true, dereference: true, filter: () => true}` resolves them.
 *
 * So `filter: () => true` is a working one-line "fix", and it is not used here
 * on purpose: a security boundary that depends on passing a no-op filter to
 * select a differently-behaved code path is one upstream can take away without
 * ever touching a documented API. tests/unit/broker/snapshot.test.ts pins the
 * node behaviour itself, so if this is fixed upstream we are told.
 *
 * `cp -RL` and `rsync -aL` both dereference correctly and were the alternative;
 * see the note in that test file for why this walk was preferred.
 *
 * `statSync` follows links, so a link to a directory is walked as a directory
 * and `copyFileSync` reads a link's TARGET into a fresh regular file.
 *
 * @throws on a broken link, a cycle, or anything that is not a regular file or
 * directory -- all of which are refusals, not copies. A spec we cannot freeze
 * is a spec we cannot honestly claim to have validated.
 */
export const copyDereferenced = (from: string, to: string, depth = 0): void => {
  if (depth > MAX_DEPTH)
    throw new Error(
      `refusing to snapshot ${from}: more than ${MAX_DEPTH} levels deep ` +
        `(a symlink cycle inside .devcontainer?)`,
    );

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(from);
  } catch (err: any) {
    throw new Error(
      `refusing to snapshot ${from}: ${err?.code ?? err?.message ?? err} ` +
        `(a symlink pointing nowhere, or a path we cannot read)`,
    );
  }

  if (stats.isDirectory()) {
    mkdirSync(to, { recursive: true, mode: SNAPSHOT_DIRECTORY_MODE });
    for (const entry of readdirSync(from))
      copyDereferenced(join(from, entry), join(to, entry), depth + 1);
    return;
  }

  if (!stats.isFile())
    throw new Error(
      `refusing to snapshot ${from}: not a regular file or directory`,
    );

  copyFileSync(from, to);
};

export interface SnapshotOptions {
  /** Where projects live -- `/workspaces` in production. */
  workspaces: string;
  /** Root the snapshot is written under. Must NOT be in any volume the editor
   *  mounts, and must be on the orchestrator's own filesystem. */
  specs: string;
}

/**
 * Copy `project`'s devcontainer spec into `specs/<project>` and return the path
 * to the snapshotted devcontainer.json.
 *
 * @throws if the project carries no devcontainer.json in either layout.
 */
export const snapshot = (
  project: string,
  { workspaces, specs }: SnapshotOptions,
): string => {
  const base = join(workspaces, project);
  const dotDir = join(base, ".devcontainer");
  const flat = join(base, ".devcontainer.json");

  const dest = join(specs, project);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true, mode: SNAPSHOT_DIRECTORY_MODE });

  if (existsSync(join(dotDir, "devcontainer.json"))) {
    copyDereferenced(dotDir, dest);
    const file = join(dest, "devcontainer.json");
    if (!existsSync(file)) throw new Error("no devcontainer.json in project");
    return file;
  }
  if (existsSync(flat)) {
    copyFileSync(flat, join(dest, "devcontainer.json"));
    return join(dest, "devcontainer.json");
  }
  throw new Error("no devcontainer.json in project");
};

/**
 * Wipe rather than reuse: a spec left by a previous run was validated against a
 * /workspaces that may since have gained or lost projects, which changes who
 * owns a volume namespace.
 * @param location
 */
export const initDirectory = (location: string) => {
  rmSync(location, { recursive: true, force: true });
  mkdirSync(location, { recursive: true, mode: SNAPSHOT_DIRECTORY_MODE });
};
