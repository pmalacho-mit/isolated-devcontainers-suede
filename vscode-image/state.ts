/**
 * state.ts -- where a target's small persistent facts are kept.
 *
 * Three files, one per kind, all named from the target's namespace. They live
 * beside the projects rather than inside any of them, so no project can read or
 * rewrite another's -- `.desolate` is dot-prefixed, which is what keeps
 * `projects.list` from ever mistaking it for a project.
 */
import { join } from "node:path";
import type { Target } from "./projects.ts";

/** ports: the host port each service had last time, so URLs stay stable.
 *  spec:  a fingerprint of what the running container was built from.
 *  token: the editor's connection token, so a bookmarked URL keeps working. */
type Kind = "ports" | "spec" | "token";

export const directory = (workspaces: string) => join(workspaces, ".desolate");

export const stateFile = (target: Target, kind: Kind) =>
  join(directory(target.workspaces), `${target.namespace}.${kind}`);
