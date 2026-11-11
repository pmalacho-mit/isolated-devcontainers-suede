// What the root tells a workspace VM to be: written by the root into the domain's inbox
// (read-only to the domain), read by the workspace's init. Frozen when the workspace is made.
export type Checkout = {
  repo: string;
  /** "main": the domain clone's own checkout. "worktree": `.worktrees/<name>` on `branch`. */
  kind: "main" | "worktree";
  /** The worktree's directory name; unused for "main". */
  name: string;
  branch: string;
  /** What a new branch starts from: a local branch or a remote-tracking one (origin/main). */
  base: string;
  /** Where it is inside the workspace. */
  path: string;
};

export type WorkspacePlan = {
  domain: string;
  workspace: string;
  vm: string;
  title: string;
  checkouts: Checkout[];
  /** The repository whose devcontainer.json is the environment, if the domain names one. */
  env?: string;
  /** Refresh origin/* from the mirror before creating worktrees. */
  fetch: boolean;
  createdAt: string;
};

export const checkoutPath = (repo: string, kind: "main" | "worktree", name: string) =>
  kind === "main" ? `/workspaces/${repo}` : `/workspaces/${repo}/.worktrees/${name}`;
