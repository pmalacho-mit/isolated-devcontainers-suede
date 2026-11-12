// Where everything lives on the host (section 4.1). The host reads these as data and never
// runs git in them (P4).
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Repo } from "../shared/names.ts";

export const RELEASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `instance` separates stacks on one machine: an end-to-end test runs beside the real one
 *  with its own home, VM names and ports. */
export const INSTANCE = (() => {
  const value = process.env.DESOLATE_INSTANCE ?? "main";
  if (!/^[a-z0-9]{1,12}$/.test(value)) throw new Error(`DESOLATE_INSTANCE must be 1-12 of [a-z0-9], not '${value}'`);
  return value;
})();

export const HOME = path.resolve(process.env.DESOLATE_HOME ?? path.join(os.homedir(), ".desolate"));

export const paths = {
  home: HOME,
  mirrors: path.join(HOME, "mirrors"),
  rootClones: path.join(HOME, "root"),
  domains: path.join(HOME, "domains"),
  /** Host-owned facts: which VMs exist, the forwarder's pid and socket. */
  state: path.join(HOME, "state"),
  /** Sockets the host shows to VMs (each workspace's link to its proxy). */
  run: path.join(HOME, "run"),
  images: path.join(HOME, "images"),
  tools: path.join(HOME, "tools"),
  logs: path.join(HOME, "logs"),
  mirror: (repo: Repo) => path.join(HOME, "mirrors", repo.owner, `${repo.name}.git`),
  domain: (domain: string) => path.join(HOME, "domains", domain),
  domainRepos: (domain: string) => path.join(HOME, "domains", domain, "repos"),
  outbox: (domain: string) => path.join(HOME, "domains", domain, "outbox"),
  inbox: (domain: string) => path.join(HOME, "domains", domain, "inbox"),
  domainCache: (domain: string) => path.join(HOME, "domains", domain, "cache"),
  link: (vm: string) => path.join(HOME, "run", vm),
} as const;

/** The same places, as every VM sees them. The mirror's path must be identical in every VM,
 *  because a clone's alternates file names it (section 6.2). */
export const guest = {
  release: "/desolate/release",
  mirrors: "/desolate/mirrors",
  mirror: (repo: Repo) => `/desolate/mirrors/${repo.owner}/${repo.name}.git`,
  rootClones: "/desolate/root",
  domains: "/desolate/domains",
  workspaces: "/workspaces",
  outbox: "/desolate/outbox",
  inbox: "/desolate/inbox",
  cache: "/desolate/cache",
  link: "/desolate/link",
  linkSocket: "/desolate/link/proxy.sock",
} as const;
