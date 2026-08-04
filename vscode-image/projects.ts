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

export const SLASH_REPLACEMENT = "__";

/** Whether `volumeNamespace` can encode this name without risking a collision. */
const namespaceable = (project: string) => !project.includes(SLASH_REPLACEMENT);

export const list = Object.assign(
  /**
   * Every name under `workspaces` that can claim a volume namespace.
   *
   * Names are returned in the `<top>` and `<top>/<sub>` forms (not absolute)
   *
   * Names `volumeNamespace` cannot encode are omitted, so one unsupported
   * directory refuses only itself (at `validate`) rather than every project
   * that has to be measured against the list.
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
      if (!namespaceable(candidate.name)) continue;

      const dir = join(workspaces, candidate.name);
      out.push(candidate.name);

      if (hasDevcontainerConfig(dir)) continue;

      try {
        for (const sub of readdirSync(dir, { withFileTypes: true }))
          if (
            sub.isDirectory() &&
            !sub.name.startsWith(".") &&
            namespaceable(sub.name)
          )
            out.push(`${candidate.name}/${sub.name}`);
      } /* unreadable owner dir -- its children simply do not claim */ catch {}
    }

    return out;
  },
  {
    /**
     * The subset of `list` that can actually be started right now (answering
     * "what can I open?", rather than "who could contest this volume name?").
     */
    startable: (workspaces: string) =>
      list(workspaces).filter((name) =>
        hasDevcontainerConfig(join(workspaces, name)),
      ),
  },
);

/**
 * Is this a syntactically valid project name -- one or two plain path segments
 * that can be turned into a volume namespace?
 */
export const validName = (() => {
  /** Longest single path segment of a project name, in characters. Two of them
   *  plus a slash is the ceiling for a whole name. */
  const maxSegment = 64;
  /** Must START with alphanumeric, which rules out "..", ".", hidden dirs, and
   *  anything beginning with a dash. */
  const segment = `[a-zA-Z0-9][a-zA-Z0-9._-]{0,${maxSegment - 1}}`;
  /** A direct child of /workspaces, or one level deeper so a repo can be scoped
   *  by its owner. */
  const pattern = new RegExp(`^${segment}(?:/${segment})?$`);

  return (query: unknown): query is string =>
    typeof query === "string" && pattern.test(query) && namespaceable(query);
})();

/** A project name usable as a docker object name.
 *
 *  Projects may be nested one level -- `owner/repo` -- so that repositories from
 *  different owners can share a repo name. Docker volume and container names
 *  cannot contain `/`, so that must replaced.
 *
 * @throws If project name remapping could result in a collision. Callers that
 * hold a name they did not validate should ask `supports` first -- `list` omits
 * such names, so reaching the throw means an unvalidated name got this far.
 */
export const volumeNamespace = Object.assign(
  <T extends string>(project: T) => {
    if (!namespaceable(project))
      throw new Error(
        [
          `Project name cannot contain a "${SLASH_REPLACEMENT}" (double underscore)`,
          `as that is reserved for replacing "/"s (slashes) within volume names`,
        ].join(" "),
      );

    return project.replace(/\//g, SLASH_REPLACEMENT) as ReplaceAll<
      T,
      "/",
      "__"
    >;
  },
  { supports: namespaceable },
);
