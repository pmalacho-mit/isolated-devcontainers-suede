/**
 * overlay.ts -- per-project copy-on-write views of the directories every
 * devcontainer receives from outside its own project.
 *
 * Both of those directories are EXECUTED inside every project, and neither
 * passes through the broker's mount policy -- desolate injects them. Handed
 * over as plain binds they are the stack's sharpest cross-project edge:
 * whoever can write one runs code in every other project. A read-only bind is
 * not enough either, because MS_RDONLY is per-mount and a privileged
 * devcontainer holds CAP_SYS_ADMIN in dind's user namespace, so it can remount
 * the bind rw and write through to the shared original. An overlay whose lower
 * is never writable through the mount is the shape that holds.
 */
import { SERVER_BIN } from "./editor.ts";
import { volumeNamespace } from "./projects.ts";

/** The pristine editor server on dind's filesystem -- an overlay LOWER only. */
export const SERVER_SRC = "/server-dist";
/** Where that server appears inside the devcontainer. */
export const SERVER_DST = "/vscode-server";
/** The proxy CA, bind-mounted from the VM (public cert only). */
export const CA_DIR = "/desolate-ca";

/** Label carrying the identity of the lower a cached view was built from. */
export const OVERLAY_KEY_LABEL = "desolate.overlay.key";

export interface SharedDirectory {
  /** Short label. The volumes are `<namespace>-<name>` and `-<name>-data`, both
   *  of which policy.ts already permits under its `<project>-*` rule. */
  name: string;
  lower: string;
  target: string;
  /** A path that must exist through the mount, proving it really mounted. */
  proof: string;
  /** File whose contents identify the lower. When it changes the view is
   *  rebuilt, so a file left in a project's upper can never shadow newer
   *  content below. */
  identityFile: string;
  /** Read when the identity file cannot be, quoted verbatim. */
  missing: string;
  /** Why this one matters, quoted verbatim when the view cannot be built. */
  why: string;
}

export const SHARED_DIRECTORIES: readonly SharedDirectory[] = [
  {
    name: "vscode-server",
    lower: SERVER_SRC,
    target: SERVER_DST,
    proof: `${SERVER_DST}/bin/${SERVER_BIN}`,
    identityFile: `${SERVER_SRC}/.seeded-version`,
    missing: `the editor server is not seeded. volume-init populates it at stack start:
      docker logs desolate-volume-init`,
    why: `${SERVER_DST} is EXECUTED by every project. A shared writable copy would let
      any project overwrite the binary every other project runs.`,
  },
  {
    name: "desolate-ca",
    lower: CA_DIR,
    target: CA_DIR,
    proof: `${CA_DIR}/ca.pem`,
    identityFile: `${CA_DIR}/ca.pem`,
    missing: "the proxy CA is missing",
    why: `${CA_DIR}/install-ca.sh is executed AS ROOT in every devcontainer (and in
      dind's entrypoint). A shared writable copy would be root code execution
      across every project.`,
  },
];

/** The volumes one project's view of a shared directory is made of.
 *
 *  Both names sit inside the project's own policy namespace, so the mounts
 *  desolate injects are ones the project could have asked for itself -- the
 *  policy re-check on the derived spec has to pass them. */
export const overlayVolumes = (project: string, name: string) => {
  const namespace = volumeNamespace(project);
  return { view: `${namespace}-${name}`, data: `${namespace}-${name}-data` };
};

/** The mount options an overlay view of `lower` backed by `data` must have.
 *
 *  Single source of truth: creating a view and deciding whether a cached one
 *  still holds both derive the string here, so a cache hit can never be
 *  accepted on options that differ from the ones that would be created now. */
export const overlayOptions = (lower: string, dataMountpoint: string) =>
  `lowerdir=${lower},upperdir=${dataMountpoint}/upper,workdir=${dataMountpoint}/work`;
