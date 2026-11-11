// The root VM's own layout. Keys and secrets live on the root VM's disk, never on a share:
// nothing on the host and nothing in a workspace has a path to them (P3).
import type { Repo } from "../shared/names.ts";

export const ROOT = {
  mirrors: "/desolate/mirrors",
  clones: "/desolate/root",
  domains: process.env.DESOLATE_ROOT_DOMAINS ?? "/desolate/domains",
  release: "/desolate/release",
  state: process.env.DESOLATE_ROOT_STATE ?? "/var/lib/desolate",
  run: process.env.DESOLATE_ROOT_RUN ?? "/run/desolate",
} as const;

export const mirrorPath = (repo: Repo) => `${ROOT.mirrors}/${repo.owner}/${repo.name}.git`;
export const clonePath = (repo: Repo) => `${ROOT.clones}/${repo.owner}/${repo.name}`;
export const domainPath = (domain: string) => `${ROOT.domains}/${domain}`;

export const KEYRING = {
  keys: `${ROOT.state}/keyring`,
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
  audit: `${ROOT.state}/keyring/audit.log`,
  /** The HOST approver's public key, installed by root at bootstrap. An approval is a
   *  signature that verifies against it (keyring.ts). */
  approver: "/etc/desolate/approver.pub",
  user: "desolate-keyring",
} as const;

export const REGISTRY = `${ROOT.state}/registry.json`;
export const HOOKS = `${ROOT.state}/hooks`;
export const MIRROR_HOOKS = `${ROOT.state}/mirror-hooks`;
/** Raw `git push` in the root's terminal waits here for `desolate approve` on the host. */
export const APPROVALS = `${ROOT.state}/approvals`;
export const FORGE = `${ROOT.state}/forge.json`;
