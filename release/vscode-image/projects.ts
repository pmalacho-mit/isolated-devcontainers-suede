/**
 * projects.ts -- what counts as a project, and who can claim a volume namespace.
 *
 * Implications for naming projects:
 * - Only two levels supported:
 *  - projects in the root of /workspaces
 *  - projects nested under a parent (matching the owner/repo layout)
 * - Projects cannot start with a `.`
 * - Usage of `__` within a project name is forbidden, as a volume name collision
 *   can happen in the case of `parent/child` vs `parent__child`
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { hasConfig as hasDevcontainerConfig } from "./devcontainer.ts";
import type { ReplaceAll } from "./utils.ts";

export const list = Object.assign(
  /**
   * Every name under `workspaces` that can claim a volume namespace.
   *
   * Names are returned in the `<top>` and `<top>/<sub>` forms (not absolute)
   *
   * Projects can either live in the `worskpaces` directory or
   * nest one level (e.g.`owner/repo`, allowing two owners to share a repo name).
   * A top-level directory is therefore one of two things,
   * and its own devcontainer spec is what distinguishes them:
   *
   *   - it HAS a spec       -> it is a project. Its subdirectories are its own
   *                            source tree, not sibling projects.
   *   - it has NO spec      -> it is an owner directory. Its children are the
   *                            projects, and each can claim `<top>__<sub>`.
   *
   * The owner directory is listed either way. It is a real name that a real
   * project could occupy in the future, and reserving it costs nothing.
   *
   * @throws if `workspaces` is unreadable
   */
  (workspaces: string): string[] => {
    const out: string[] = [];

    let top;
    try {
      top = readdirSync(workspaces, { withFileTypes: true });
    } catch (err: any) {
      throw new Error(
        [
          `cannot enumerate projects: ${workspaces} is unreadable`,
          `(${err?.code ?? err?.message ?? err}). Refusing to continue, because`,
          `an empty project list silently WIDENS every volume-namespace claim.`,
        ].join(" "),
      );
    }

    for (const candidate of top) {
      // Dotfiles are infrastructure, not projects: `.desolate` alongside them
      // holds this stack's own per-project spec fingerprints.
      if (!candidate.isDirectory() || candidate.name.startsWith(".")) continue;

      const dir = join(workspaces, candidate.name);
      out.push(candidate.name);

      if (hasDevcontainerConfig(dir)) continue;

      try {
        for (const sub of readdirSync(dir, { withFileTypes: true }))
          if (sub.isDirectory() && !sub.name.startsWith("."))
            out.push(`${candidate.name}/${sub.name}`);
      } /* unreadable owner dir -- its children simply do not claim */ catch {}
    }

    return out;
  },
  {
    /**
     * The subset of `listProjects` that can actually be started right now
     * (to answer a human wondering "what can I open?", instead of a policy
     * asking "who could contest this volume name?")
     */
    startable: (workspaces: string) =>
      list(workspaces).filter((name) =>
        hasDevcontainerConfig(join(workspaces, name)),
      ),
  },
);

/** A project name usable as a docker object name.
 *
 *  Projects may be nested one level -- `owner/repo` -- so that repositories from
 *  different owners can share a repo name. Docker volume and container names
 *  cannot contain `/`, so that must replaced.
 *
 * @throws If project name remapping could result in a collision
 */
export const volumeNamespace = <T extends string>(project: T) => {
  if (project.includes("__"))
    throw new Error(
      [
        `Project name cannot contain a "__" (double underscore)`,
        `as that is reserved for replacing "/"s (slashes) within volume names`,
      ].join(" "),
    );

  return project.replace(/\//g, "__") as ReplaceAll<T, "/", "__">;
};
