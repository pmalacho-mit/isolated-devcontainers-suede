/*
snapshot.ts -- copy a project's devcontainer config somewhere the editor cannot
reach, dereferencing symlinks but never leaving the project.

The copy exists for TOCTOU reasons (see broker.ts): the container starts from a
frozen copy of the spec the policy validated, not from the live file. Making
that copy means DEREFERENCING symlinks -- a link into editor-writable state
would otherwise still be a live file at build time.

Dereferencing is a file READ, performed with the orchestrator's privileges on
the project's behalf, and it is the reason this module is not a
`cpSync(..., { dereference: true })` call:

    ln -s ../../../root/.ssh/id_ed25519 myproject/.devcontainer/key

Committed to a repo, that link is followed HERE, in the one container holding
the inner Docker socket, and cp would copy what it points at into the snapshot.
Nothing in the spec policy sees it: every key in that devcontainer.json is
legal, and the read is in the filesystem underneath it.

Measured against @devcontainers/cli 0.88.0, that copy does not TODAY reach an
image: `--override-config` changes which JSON is read, not where relative paths
resolve from, so `build.context` and `build.dockerfile` are taken from the live
project directory and this snapshot is never handed to `docker build`. The
stolen bytes land in a directory only the orchestrator can read. Say what is
verified rather than what sounds worse.

It is still refused, for three reasons that do not depend on that measurement:
the orchestrator should not be a file-read oracle for a project at all; the
copy is meant to be a FROZEN COPY OF THE PROJECT, and one containing /root's
private key is not that; and the day this directory does become the build
context -- which is the obvious way to make the freeze cover the Dockerfile
too -- the escape would be live and nothing here would have changed to say so.

A link to a sibling project is refused for the same reason as a link to /root:
it is somebody else's trust domain. What the LIVE build context may reach is a
separate rule, enforced by policy.ts (`build.context` must stay in the project)
and, for symlinks, by BuildKit, which refuses to follow one out of the context.

Refusal, not silent skipping: a snapshot that quietly dropped a file would
produce a build failure somewhere far away from the cause.
*/
/// <reference types="node" />
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  rmSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, relative } from "node:path";
import { isWithin } from "./utils.ts";

/** Owner only. Anything able to write here can swap a validated spec for an
 *  unvalidated one after the check has passed. */
export const SNAPSHOT_DIRECTORY_MODE = 0o700 as const;

export class ContainmentError extends Error {}

const fail = (message: string): never => {
  throw new ContainmentError(message);
};

/** Describe a path the way the person who wrote the symlink would recognise it. */
const describe = (root: string, path: string) => relative(root, path) || ".";

/**
 * Resolve `target` and refuse it unless it lands inside `root`.
 *
 * `root` must already be a real path -- resolving it here on every call would
 * hide the case where the project directory ITSELF is a link.
 */
export const resolveWithin = (root: string, target: string): string => {
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return fail(
      `refusing to snapshot '${describe(root, target)}': it cannot be resolved ` +
        `-- a broken symlink, or one whose target was removed while the spec ` +
        `was being snapshotted`,
    );
  }
  if (!isWithin(root, real))
    return fail(
      `refusing to snapshot '${describe(root, target)}': it resolves to ` +
        `'${real}', which is outside '${root}'. A devcontainer config may only ` +
        `reference files within its own project -- this copy is made in the ` +
        `orchestrator, which holds the inner Docker socket, so following a link ` +
        `out of the project reads a file on the project's behalf that the ` +
        `project cannot reach itself`,
    );
  return real;
};

/**
 * Copy one already-resolved regular file.
 *
 * O_NOFOLLOW closes the gap between resolving a link and reading what it
 * pointed at. `real` was not a symlink when realpath returned it, and the
 * editor can write /workspaces at any moment, so if it IS one by the time this
 * opens it, the tree changed underneath the check and the copy is refused
 * rather than followed.
 */
const copyFile = (root: string, real: string, destination: string) => {
  let descriptor: number;
  try {
    descriptor = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail(
      `'${describe(root, real)}' could not be read as a plain file -- it ` +
        `changed while the spec was being snapshotted`,
    );
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile())
      fail(`'${describe(root, real)}' is not a regular file`);
    // mode: a build context can legitimately carry executable scripts, and cp
    // preserved that. Ownership deliberately does not follow -- the snapshot
    // belongs to the orchestrator.
    writeFileSync(destination, readFileSync(descriptor), {
      mode: stats.mode & 0o777,
    });
  } finally {
    closeSync(descriptor);
  }
};

const copyTree = (
  root: string,
  from: string,
  to: string,
  visited: Set<string>,
) => {
  mkdirSync(to, { recursive: true, mode: 0o700 });

  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const destination = join(to, entry.name);

    // Dirent reports on the LINK, never on what it points at, which is what
    // makes the three cases below distinguishable at all.
    if (entry.isSymbolicLink()) {
      const real = resolveWithin(root, source);
      if (lstatSync(real).isDirectory()) {
        // Only a link can produce a cycle; a real directory cannot contain
        // itself. Without this, `.devcontainer/self -> .` recurses until the
        // path is too long to open, and the failure names neither the link nor
        // the project.
        if (visited.has(real))
          fail(
            `'${describe(root, source)}' points at '${describe(root, real)}', ` +
              `which is already being copied -- the config directory contains a ` +
              `symlink cycle`,
          );
        visited.add(real);
        copyTree(root, real, destination, visited);
      } else {
        copyFile(root, real, destination);
      }
      continue;
    }

    if (entry.isDirectory()) {
      copyTree(root, source, destination, visited);
      continue;
    }

    if (entry.isFile()) {
      copyFile(root, source, destination);
      continue;
    }

    fail(
      `'${describe(root, source)}' is neither a file, a directory, nor a ` +
        `symlink to one, so it cannot be snapshotted`,
    );
  }
};

/**
 * Copy `from` (a directory inside `root`) to `to`, dereferencing every symlink
 * that stays inside `root` and refusing every one that does not.
 *
 * @param root the project directory; the containment boundary
 * @param from the directory to copy (`root` itself, or below it)
 * @param to   where the copy lands -- outside `root`, and not editor-writable
 * @throws ContainmentError naming the offending path
 */
export const snapshotDirectory = (root: string, from: string, to: string) => {
  const base = realpathSync(root);
  const source = resolveWithin(base, from);
  copyTree(base, source, to, new Set([source]));
};

/**
 * The single-file case (`.devcontainer.json` in the project root), under the
 * same rule: the file may be a link, but not one that leaves the project.
 * @throws ContainmentError naming the offending path
 */
export const snapshotFile = (root: string, from: string, to: string) => {
  const base = realpathSync(root);
  copyFile(base, resolveWithin(base, from), to);
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
    // The whole directory, not just the json: it is the record of what was
    // approved. Symlinks are dereferenced, because one into editor-writable
    // state would still be a live file afterwards -- and refused when they
    // leave the project, because this copy is made in the orchestrator, where
    // `.devcontainer/key -> /root/.ssh/id_ed25519` is a file it can read and
    // the project cannot.
    snapshotDirectory(base, dotDir, dest);
    const file = join(dest, "devcontainer.json");
    if (!existsSync(file)) throw new Error("no devcontainer.json in project");
    return file;
  }
  if (existsSync(flat)) {
    snapshotFile(base, flat, join(dest, "devcontainer.json"));
    return join(dest, "devcontainer.json");
  }
  throw new Error("no devcontainer.json in project");
};
