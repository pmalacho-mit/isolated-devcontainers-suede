/**
 * work-policy.ts -- what a project's factory may do, decided OUTSIDE its repo.
 *
 * WHERE IT LIVES, AND WHY NOT IN THE REPOSITORY
 *
 * The plan read `.desolate/factory.json` from the project's own branch. Every
 * agent in the project can commit there -- the overseer in `main` most of all
 * -- so the policy would be whatever the agents it governs last wrote: an
 * `on_done: "push"` an agent committed is the editor's deploy key pushing that
 * agent's branches, and a branch pushed is CI running with the repository's
 * secrets. Likewise any devcontainer can write any ref in `.git`, so a
 * request's `from` is self-declared: tamper-evidence, never authority.
 *
 * So the policy, the approvals and the watcher's own record of what it has
 * handled live in /workspaces/.desolate/factory/, which the editor (the human)
 * writes and no devcontainer can reach -- a devcontainer mounts its project
 * alone. A project without a policy file there has no factory: enabling one is
 * a human act outside the repository (`cli.sh work init`).
 *
 *   <ns>.json       the policy, below
 *   <ns>.approved   request ids a human approved, one per line
 *   <ns>.handled    request ids the watcher has finished with, and how
 *
 * What `requesters` still does, given `from` can be forged: it keeps a
 * well-behaved agent inside its lane. A hostile one is bounded by what the
 * actions themselves allow -- opens are capped, a close refuses a worktree
 * holding uncommitted work, and a push happens only when THIS file says so.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { volumeNamespace } from "./projects.ts";
import { HUMAN, MAIN, isTarget } from "./work-protocol.ts";

export const FACTORY_DIRECTORY = (workspaces: string) => join(workspaces, ".desolate", "factory");

export interface Policy {
  v: 1;
  /** Worktrees open at once, per project -- independent of the supervisor's
   *  headroom rule, because a self-feeding queue is twenty worktrees by morning. */
  max_open_worktrees: number;
  /** Who may ask for an `open`. `close` is the forge's and the human's alone:
   *  the overseer may open worktrees, never close them. */
  requesters: string[];
  /** Every branch the factory opens or pushes starts with this. */
  branch_prefix: string;
  /** `push`: an agent's `done`, or a `push` request, pushes its branch.
   *  `hold`: nothing is pushed until a human runs `cli.sh work push`. */
  on_done: "push" | "hold";
  /** Open a worktree in a repository with hooks? They run in the worktree's
   *  sandbox at its first start (worktrees.ts), never in the editor. */
  allow_hooks: boolean;
}

export const DEFAULT_POLICY: Policy = {
  v: 1,
  max_open_worktrees: 4,
  requesters: [MAIN],
  branch_prefix: "factory/",
  on_done: "hold",
  allow_hooks: false,
};

export class PolicyFileError extends Error {}

const isRequester = (name: unknown) =>
  typeof name === "string" && (isTarget(name) || /^forge\/[a-z][a-z0-9-]{0,30}$/.test(name));

/** A policy, held to its schema. Any key it does not know is refused: a
 *  misspelt `on_dnoe` silently meaning the default is not a policy. */
export const parsePolicy = (text: string): Policy => {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PolicyFileError("not JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PolicyFileError("not an object");
  const known = new Set(Object.keys(DEFAULT_POLICY));
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length) throw new PolicyFileError(`unknown key(s): ${unknown.join(", ")}`);
  const policy = { ...DEFAULT_POLICY, ...value };
  if (policy.v !== 1) throw new PolicyFileError(`v must be 1`);
  if (!Number.isInteger(policy.max_open_worktrees) || policy.max_open_worktrees < 1 || policy.max_open_worktrees > 64)
    throw new PolicyFileError("max_open_worktrees must be a whole number from 1 to 64");
  if (!Array.isArray(policy.requesters) || !policy.requesters.every(isRequester))
    throw new PolicyFileError(`requesters must be targets (${MAIN}, a worktree, ${HUMAN}) or forge/<adapter>`);
  if (typeof policy.branch_prefix !== "string" || !/^([A-Za-z0-9._-]+\/)*$/.test(policy.branch_prefix))
    throw new PolicyFileError("branch_prefix must be empty or path segments ending in /");
  if (policy.on_done !== "push" && policy.on_done !== "hold") throw new PolicyFileError("on_done must be push or hold");
  if (typeof policy.allow_hooks !== "boolean") throw new PolicyFileError("allow_hooks must be true or false");
  return policy;
};

/** The three files of one project's factory. */
export const factoryFiles = (workspaces: string, project: string) => {
  const base = join(FACTORY_DIRECTORY(workspaces), volumeNamespace(project));
  return { policy: `${base}.json`, approved: `${base}.approved`, handled: `${base}.handled` };
};

/** The policy, undefined when the project has no factory; throws a
 *  PolicyFileError naming what is wrong with one that cannot be read. */
export const readPolicy = (workspaces: string, project: string): Policy | undefined => {
  const file = factoryFiles(workspaces, project).policy;
  if (!existsSync(file)) return undefined;
  return parsePolicy(readFileSync(file, "utf8"));
};

const lines = (file: string) => {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

/** Request ids a human approved. */
export const approvals = (workspaces: string, project: string) =>
  new Set(lines(factoryFiles(workspaces, project).approved).map((line) => line.trim()));

/** `<id> <outcome>` per request the watcher finished with. */
export const handled = (workspaces: string, project: string) =>
  new Map(lines(factoryFiles(workspaces, project).handled).map((line) => {
    const [id, ...outcome] = line.split(" ");
    return [id, outcome.join(" ")] as const;
  }));

const appendLine = (file: string, line: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  appendFileSync(file, `${line}\n`);
};

export const recordHandled = (workspaces: string, project: string, id: string, outcome: string) =>
  appendLine(factoryFiles(workspaces, project).handled, `${id} ${outcome.replace(/\s+/g, " ")}`);

export const recordApproval = (workspaces: string, project: string, id: string) =>
  appendLine(factoryFiles(workspaces, project).approved, id);
