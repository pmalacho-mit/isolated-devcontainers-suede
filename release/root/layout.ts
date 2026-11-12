// The root VM's own layout. Keys and secrets live on the root VM's disk, never on a share:
// nothing on the host and nothing in a workspace has a path to them (P3).
import type { Repo } from "../shared/names.ts";

export const ROOT = {
  mirrors: "/desolate/mirrors",
  clones: "/desolate/root",
  domains: process.env.DESOLATE_ROOT_DOMAINS ?? "/desolate/domains",
  release: "/desolate/release",
  /** The root's ordinary user's: registry, forge, approvals, secrets, proxies, logs. */
  state: process.env.DESOLATE_ROOT_STATE ?? "/var/lib/desolate",
  /** Root's: what root and the keyring rely on, where the ordinary user can neither write
   *  nor rename anything. The ordinary user runs everything that reads a domain's data, so
   *  nothing that must not be changed by such a process may live in a directory it owns:
   *  it could swap the entry for a link or a directory of its own (start.sh, as root,
   *  would then follow it). */
  sys: process.env.DESOLATE_ROOT_SYS ?? "/var/lib/desolate-root",
  run: process.env.DESOLATE_ROOT_RUN ?? "/run/desolate",
} as const;

export const mirrorPath = (repo: Repo) => `${ROOT.mirrors}/${repo.owner}/${repo.name}.git`;
export const clonePath = (repo: Repo) => `${ROOT.clones}/${repo.owner}/${repo.name}`;
export const domainPath = (domain: string) => `${ROOT.domains}/${domain}`;

export const KEYRING = {
  keys: `${ROOT.sys}/keyring`,
  run: `${ROOT.run}/keyring`,
  /** The agent for read keys: signs with no prompt, so fetches are automatic. */
  readAgent: `${ROOT.run}/keyring/read-agent.sock`,
  /** The agent for write keys: every signature needs an approval a person gave (P2). */
  writeAgent: `${ROOT.run}/keyring/write-agent.sock`,
  /** Where ssh-agent itself listens: the keyring user's alone. The two sockets above are
   *  the keyring's filtering relays in front of these. */
  private: `${ROOT.run}/keyring/private`,
  /** Requests any root process may make: create, pubkey, list, remove, audit. No export. */
  control: `${ROOT.run}/keyring/control.sock`,
  /** The askpass's socket. Only the keyring's own user can connect (mode 0600). */
  internal: `${ROOT.run}/keyring/internal.sock`,
  pub: `${ROOT.run}/keyring/pub`,
  audit: `${ROOT.sys}/keyring/audit.log`,
  /** The HOST approver's public key, installed by root at bootstrap. An approval is a
   *  signature that verifies against it (keyring.ts). */
  approver: "/etc/desolate/approver.pub",
  user: "desolate-keyring",
} as const;

export const REGISTRY = `${ROOT.state}/registry.json`;
export const HOOKS = `${ROOT.sys}/hooks`;
export const MIRROR_HOOKS = `${ROOT.sys}/mirror-hooks`;
/** The root's git settings (start.sh writes them): root's, so that what reads a domain's
 *  packs cannot weaken the checks that apply to them. */
export const GITCONFIG = `${ROOT.sys}/gitconfig`;
/** Raw `git push` in the root's terminal waits here for `desolate approve` on the host. */
export const APPROVALS = `${ROOT.state}/approvals`;
export const FORGE = `${ROOT.state}/forge.json`;
