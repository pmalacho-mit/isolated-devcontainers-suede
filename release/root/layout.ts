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
  /** Root's too: each domain's proxies' directories, made by root/proxy-user.sh, where
   *  nothing of the root's ordinary user's is on the way. */
  proxies: process.env.DESOLATE_ROOT_PROXIES ?? "/var/lib/desolate-proxies",
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
  /** Where the write agent is reached: a directory only the keyring and the pusher can enter
   *  (root/start.sh). The root's ordinary user, which parses what domains send, cannot reach
   *  a write key at all; it hands a push to the pusher (root/pusher.ts). */
  writeRun: `${ROOT.run}/keyring-write`,
  /** The agent for write keys: every signature needs an approval a person gave (P2). */
  writeAgent: `${ROOT.run}/keyring-write/write-agent.sock`,
  /** The pusher's questions to the keyring: what an approval names, and revoking it. */
  pusher: `${ROOT.run}/keyring-write/pusher.sock`,
  /** The reviewer's way to the read agent and its one question (a read key's public half):
   *  a directory only the keyring and the reviewer enter (root/start.sh). */
  reviewRun: `${ROOT.run}/keyring-review`,
  reviewerReadAgent: `${ROOT.run}/keyring-review/read-agent.sock`,
  reviewer: `${ROOT.run}/keyring-review/reviewer.sock`,
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
/** The forge's address and host key, as the host gave them, in root's own directory: what the
 *  pusher reads (root/forge-pin.ts writes them). The root's user's copies (FORGE and its
 *  known_hosts) are for fetching, and that user could rewrite them. */
export const PINNED_FORGE = { config: `${ROOT.sys}/forge.json`, knownHosts: `${ROOT.sys}/known_hosts` } as const;
/** Where the host leaves a push from the git VM (a bundle) for the root to take in: in the
 *  root clones' share, which the host writes and the git VM cannot. */
export const GIT_IN = `${ROOT.clones}/.git-in`;
/** Raw `git push` in the root's terminal waits here for `desolate approve` on the host. */
export const APPROVALS = `${ROOT.state}/approvals`;
export const FORGE = `${ROOT.state}/forge.json`;

/** The reviewer (root/reviewer.ts): a user of its own, that says what a push would send. */
export const REVIEWER = {
  user: "desolate-reviewer",
  home: process.env.DESOLATE_REVIEWER_HOME ?? "/var/lib/desolate-reviewer",
  run: `${ROOT.run}/reviewer`,
  control: `${ROOT.run}/reviewer/control.sock`,
} as const;

/** The pusher (root/pusher.ts): the one process that can use a write key, as its own user. */
export const PUSHER = {
  user: "desolate-pusher",
  /** Its own repositories, one per remote: what it pushes is fetched into these. */
  home: process.env.DESOLATE_PUSHER_HOME ?? "/var/lib/desolate-pusher",
  run: `${ROOT.run}/pusher`,
  /** Where the root's user hands it a push: an approval's id, a bundle, LFS objects. */
  control: `${ROOT.run}/pusher/control.sock`,
} as const;
