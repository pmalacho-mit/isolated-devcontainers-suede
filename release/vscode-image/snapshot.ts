/*
snapshot.ts -- copy a project's devcontainer config somewhere the editor cannot
reach, dereferencing symlinks but never leaving the project.

The copy exists for TOCTOU reasons (see broker.ts): the container starts from a
frozen copy of the spec the policy validated, not from the live file. Making
that copy means DEREFERENCING symlinks -- a link into editor-writable state
would otherwise still be a live file at build time.

Dereferencing is where a second escape lives, and it is the reason this module
is not a `cpSync(..., { dereference: true })` call:

    ln -s ../../../root/.ssh/id_ed25519 myproject/.devcontainer/key

Committed to a repo, that link is followed HERE, in the orchestrator -- the one
container holding the inner Docker socket. cp would happily copy the file it
points at into the snapshot, and the snapshot is the build context the CLI
hands to `docker build`, so a one-line `COPY key /` in the project's own
Dockerfile lifts it into an image the project owns. Nothing in the spec policy
sees this: every key in devcontainer.json is legal, and the theft is in the
filesystem underneath it.

So every link is resolved and required to land inside the project directory,
which is exactly the boundary the project already owns. A link to a sibling
project is refused for the same reason as a link to /root: it is somebody
else's trust domain.

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
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

export class ContainmentError extends Error {}

const fail = (message: string): never => {
  throw new ContainmentError(message);
};

/** Is `candidate` at or under `root`? Both must already be real paths.
 *
 *  The separator is load-bearing: a bare `startsWith` would accept
 *  `/workspaces/web-api` as being inside `/workspaces/web`. */
const within = (root: string, candidate: string) =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);

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
      `'${describe(root, target)}' cannot be resolved -- a broken symlink, or ` +
        `one whose target was removed while the spec was being snapshotted`,
    );
  }
  if (!within(root, real))
    return fail(
      `'${describe(root, target)}' resolves to '${real}', which is outside ` +
        `'${root}'. A devcontainer config may only reference files within its ` +
        `own project: the snapshot becomes the build context, so a link out of ` +
        `the project would copy somebody else's file into this project's image`,
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
