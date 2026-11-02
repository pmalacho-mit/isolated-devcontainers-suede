/**
 * restrictions.ts -- which projects the proxy holds to what is allowed by
 * name (addon.py "A PROJECT RESTRICTED"), as the runner needs to know it.
 *
 * The proxy can tell one project's requests from another's only by the
 * address of the dind they come from; on the shared daemon every project's
 * requests are no project's. A project picks its daemon in its own spec, so a
 * restricted one could step around its restriction by declaring the shared
 * daemon -- unless the runner refuses to start it there. That is all this is
 * for: the proxy enforces; this keeps what it enforces attributable.
 *
 * The file is the VM's /var/lib/desolate-proxy/policy/projects.json, mounted
 * read-only into the orchestrator (docker-compose.yml) and written by
 * `cli.sh proxy learn|enforce`. Read as the proxy reads it: an entry that
 * cannot be read restricts; a file that cannot be read restricts everyone, so
 * the runner refuses the shared daemon to every project until it can.
 */
import { readFileSync } from "node:fs";

export const POLICY_FILE = process.env.DESOLATE_POLICY_FILE ?? "/run/desolate-policy/projects.json";

/** "deny" or "learn" for a project held to less than the default, or
 *  undefined for one that is not. `text` is the file's content, or null for
 *  a file that is not there. */
export const restrictionOf = (text: string | null, project: string, now: number): "deny" | "learn" | undefined => {
  if (text === null) return undefined;
  let policies: unknown;
  try {
    policies = JSON.parse(text);
  } catch {
    return "deny";
  }
  if (typeof policies !== "object" || policies === null || Array.isArray(policies)) return "deny";
  const entry = (policies as Record<string, unknown>)[project];
  if (entry === undefined) return undefined;
  const { action, until, then } = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
  if (action === "allow") return undefined;
  if (action === "deny") return "deny";
  if (action === "learn" && typeof until === "number" && (then === "allow" || then === "deny"))
    return now < until ? "learn" : then === "deny" ? "deny" : undefined;
  return "deny";
};

/** The file's content, or null when there is none. */
export const readPolicies = (file = POLICY_FILE): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    return "unreadable";
  }
};
