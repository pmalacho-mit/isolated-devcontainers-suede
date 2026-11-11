// What the dashboard can ask the host to do (section 4.8): a fixed list. The root's state
// service uses it to refuse anything else at once and to show the command; the host's
// daemon uses it AGAIN, on the request it collects, to build the command it runs. The host
// never runs a command line the root VM wrote.
import { isSlug, parseRepo } from "./names.ts";

type Args = Record<string, string | undefined>;
export const HOST_ACTIONS: Record<string, (a: Args) => string[] | null> = {
  "workspace.start": (a) => (isSlug(a.domain) && isSlug(a.workspace) ? ["start", `${a.domain}/${a.workspace}`] : null),
  "workspace.stop": (a) => (isSlug(a.domain) && isSlug(a.workspace) ? ["stop", `${a.domain}/${a.workspace}`] : null),
  "workspace.up": (a) => (isSlug(a.domain) && (a.workspace === undefined || a.workspace === "" || isSlug(a.workspace)) ? ["up", a.domain, ...(a.workspace ? ["--name", a.workspace] : [])] : null),
  "repo.fetch": (a) => (a.repo !== undefined && parseRepo(a.repo) ? ["fetch", a.repo] : null),
  "domain.create": (a) => (isSlug(a.domain) ? ["domain", "create", a.domain, ...(a.title && /^[\x20-\x7e]{1,80}$/.test(a.title) && !a.title.startsWith("-") ? ["--title", a.title] : [])] : null),
  "domain.add": (a) => (isSlug(a.domain) && a.repo !== undefined && parseRepo(a.repo) ? ["domain", a.domain, "add", "--repo", a.repo] : null),
};
export const hostArgv = (kind: unknown, args: unknown): string[] | null => {
  if (typeof kind !== "string" || !Object.hasOwn(HOST_ACTIONS, kind) || typeof args !== "object" || args === null) return null;
  const clean: Args = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) if (typeof value === "string" && value.length <= 200) clean[key] = value;
  return HOST_ACTIONS[kind]!(clean);
};
