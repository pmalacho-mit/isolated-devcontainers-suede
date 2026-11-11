// Domains and their workspaces, as the root records them (sections 2, 5). The root decides
// who holds which checkout; the domain's own VMs do the git (P4).
import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT, refuse } from "../shared/exit.ts";
import { readJson, writeJson } from "../shared/json.ts";
import { isBranch, isSlug, parseRepo, repoId, workspaceVmName } from "../shared/names.ts";
import { checkoutPath } from "../shared/plan.ts";
import type { Checkout, WorkspacePlan } from "../shared/plan.ts";
import { git, gitOk } from "./git.ts";
import { clonePath, domainPath, ROOT } from "./layout.ts";
import { recordOf, registry } from "./repos.ts";

/** `env`: the repository whose devcontainer.json is the domain's environment (section 4.5,
 *  way 1). Unset: the first checkout that has one. */
export type Domain = { slug: string; title: string; repos: string[]; createdAt: string; env?: string };

const file = (slug: string) => path.join(domainPath(slug), "domain.json");
const workspacesDir = (slug: string) => path.join(domainPath(slug), "workspaces");
const workspaceFile = (slug: string, name: string) => path.join(workspacesDir(slug), `${name}.json`);

export const slugOf = (value: unknown, what: string): string =>
  isSlug(value) ? value : refuse(`'${String(value)}' is not a ${what} name`, `a ${what} name is a slug: lowercase letters, digits and single dashes, at most 40, starting with a letter or digit`, EXIT.usage);

export const domain = (slug: string): Domain =>
  readJson<Domain | null>(file(slug), null) ?? refuse(`there is no domain '${slug}'`, `desolate domain create ${slug}`);

export const domains = (): Domain[] => {
  try {
    return fs.readdirSync(ROOT.domains, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(file(entry.name)))
      .map((entry) => domain(entry.name)).sort((a, b) => a.slug.localeCompare(b.slug));
  } catch {
    return [];
  }
};

export const create = (slugArg: unknown, title: unknown) => {
  const slug = slugOf(slugArg, "domain");
  // `origin` and `root` are remote names in every clone; a domain is a remote in the root's.
  if (slug === "origin" || slug === "root") refuse(`a domain cannot be called '${slug}'`, "choose another name");
  if (fs.existsSync(file(slug))) refuse(`the domain '${slug}' already exists`, `desolate domain ${slug} show`);
  for (const dir of ["repos", "outbox", "inbox", "workspaces"]) fs.mkdirSync(path.join(domainPath(slug), dir), { recursive: true });
  const value: Domain = { slug, title: typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : slug, repos: [], createdAt: new Date().toISOString() };
  writeJson(file(slug), value);
  return value;
};

/** `desolate domain <d> env [--from <owner/repo>]`: which repository's spec this domain's
 *  workspaces are built from. Written here, by the root, outside every repository. */
export const setEnv = (slugArg: unknown, repoArg: unknown) => {
  const d = domain(slugOf(slugArg, "domain"));
  if (repoArg !== undefined) {
    const repo = parseRepo(repoArg) ?? refuse(`'${String(repoArg)}' is not a repository`, "name it as <owner>/<repo>", EXIT.usage);
    if (!d.repos.includes(repoId(repo))) refuse(`${repoId(repo)} is not in the domain ${d.slug}`, `desolate domain ${d.slug} add --repo ${repoId(repo)}`);
    d.env = repoId(repo);
    writeJson(file(d.slug), d);
  }
  return { domain: d.slug, env: d.env ?? null, repos: d.repos };
};

export const addRepo = async (slugArg: unknown, repoArg: unknown) => {
  const d = domain(slugOf(slugArg, "domain"));
  const repo = parseRepo(repoArg) ?? refuse(`'${String(repoArg)}' is not a repository`, "name it as <owner>/<repo>", EXIT.usage);
  recordOf(repo);
  const id = repoId(repo);
  const added = !d.repos.includes(id);
  if (added) {
    d.repos = [...d.repos, id].sort();
    writeJson(file(d.slug), d);
  }
  // In the root clone, the domain is a remote (section 6.5), through desolate's helper.
  const clone = clonePath(repo);
  const have = await git(clone, ["remote", "get-url", d.slug]);
  if (have.code !== 0) await gitOk(clone, ["remote", "add", d.slug, `desolate::${d.slug}`]);
  const running = workspaces(d.slug).length;
  return { domain: d.slug, repo: id, added, note: added && running > 0 ? `${running} existing workspace(s) of ${d.slug} were made before this and do not see it: \`desolate rm\` and \`desolate up\` them to pick it up` : "" };
};

export type Workspace = WorkspacePlan & { state: "planned" | "up" | "stopped" };

export const workspaces = (slug: string): Workspace[] => {
  try {
    return fs.readdirSync(workspacesDir(slug)).filter((name) => name.endsWith(".json"))
      .map((name) => readJson<Workspace | null>(path.join(workspacesDir(slug), name), null))
      .filter((value): value is Workspace => value !== null).sort((a, b) => a.workspace.localeCompare(b.workspace));
  } catch {
    return [];
  }
};

export const workspace = (slug: string, name: string): Workspace =>
  readJson<Workspace | null>(workspaceFile(slug, name), null) ?? refuse(`there is no workspace '${slug}/${name}'`, `desolate list ${slug}`);

type Wanted = { repo: string; kind: "main" | "worktree"; branch?: string };

/** Decide what a new workspace is: its checkouts, and that nobody else holds them. One
 *  workspace holds a given checkout at a time, the main checkout included (section 5.2). */
export const plan = (args: { instance: string; domain: unknown; name: unknown; checkouts: unknown; base: unknown; fetch: unknown }): Workspace => {
  const d = domain(slugOf(args.domain, "domain"));
  if (d.repos.length === 0) refuse(`the domain '${d.slug}' has no repositories yet`, `desolate domain ${d.slug} add --repo <owner>/<repo>`);
  const existing = workspaces(d.slug);
  let name = args.name;
  if (name === undefined || name === null || name === "") {
    for (let n = 1; ; n++) if (!existing.some((w) => w.workspace === `w${n}`)) {
      name = `w${n}`;
      break;
    }
  }
  const workspaceName = slugOf(name, "workspace");
  if (existing.some((w) => w.workspace === workspaceName)) refuse(`the workspace '${d.slug}/${workspaceName}' already exists`, `desolate up ${d.slug} --name <another>, or desolate rm ${d.slug}/${workspaceName}`);

  const wanted = new Map<string, Wanted>();
  for (const raw of Array.isArray(args.checkouts) ? args.checkouts : []) {
    // <owner/repo>=main | <owner/repo>=worktree:<branch>
    const match = /^([^=]+)=(main|worktree:(.+))$/.exec(String(raw));
    if (!match) refuse(`--checkout '${String(raw)}' is not understood`, "use --checkout <owner>/<repo>=main or --checkout <owner>/<repo>=worktree:<branch>", EXIT.usage);
    const repo = match![1]!;
    if (!d.repos.includes(repo)) refuse(`${repo} is not in the domain '${d.slug}'`, `desolate domain ${d.slug} add --repo ${repo}`);
    if (match![3] !== undefined && !isBranch(match![3])) refuse(`'${match![3]}' is not a branch name desolate will carry`, "letters, digits, '.', '_', '-' and '/', not starting with a dash");
    wanted.set(repo, match![3] !== undefined ? { repo, kind: "worktree", branch: match![3] } : { repo, kind: "main" });
  }
  const baseArg = args.base === undefined || args.base === null ? null : String(args.base);
  if (baseArg !== null && !isBranch(baseArg)) refuse(`--base '${baseArg}' is not a branch`, "use a local branch (main) or a remote-tracking one (origin/main)", EXIT.usage);

  const held = (repo: string, kind: "main" | "worktree", worktree: string) =>
    existing.find((w) => w.checkouts.some((c) => c.repo === repo && c.kind === kind && (kind === "main" || c.name === worktree)));
  const checkouts: Checkout[] = d.repos.map((repo) => {
    const want = wanted.get(repo);
    const defaultBranch = registry().repos[repo]?.defaultBranch ?? "main";
    const base = baseArg ?? defaultBranch;
    const worktree = (branch: string): Checkout => {
      const dir = branch.replace(/\//g, "-");
      const holder = held(repo, "worktree", dir);
      if (holder) refuse(`the worktree '${dir}' of ${repo} is held by the workspace '${d.slug}/${holder.workspace}'`, `use another branch, or desolate rm ${d.slug}/${holder.workspace}`, EXIT.busy);
      return { repo, kind: "worktree", name: dir, branch, base, path: checkoutPath(repo, "worktree", dir) };
    };
    if (want?.kind === "worktree") return worktree(want.branch!);
    const holder = held(repo, "main", "");
    if (want?.kind === "main") {
      if (holder) refuse(`the main checkout of ${repo} is held by the workspace '${d.slug}/${holder.workspace}'. Two editors and two agents in one working tree is a corruption, not a feature`, `take a worktree instead: --checkout ${repo}=worktree:<branch>`, EXIT.busy);
      return { repo, kind: "main", name: "", branch: defaultBranch, base: defaultBranch, path: checkoutPath(repo, "main", "") };
    }
    // Not named: the main checkout if it is free, else a fresh worktree named for the workspace.
    if (!holder) return { repo, kind: "main", name: "", branch: defaultBranch, base: defaultBranch, path: checkoutPath(repo, "main", "") };
    return worktree(workspaceName);
  });

  const value: Workspace = {
    ...(d.env ? { env: d.env } : {}),
    domain: d.slug, workspace: workspaceName, vm: workspaceVmName(args.instance, d.slug, workspaceName),
    title: d.title, checkouts, fetch: args.fetch === true, createdAt: new Date().toISOString(), state: "planned",
  };
  writeJson(workspaceFile(d.slug, workspaceName), value);
  // The plan the workspace's own init reads: in the inbox, which the domain cannot write.
  writeJson(path.join(domainPath(d.slug), "inbox", "workspaces", `${workspaceName}.json`), value);
  return value;
};

export const setState = (slug: string, name: string, state: Workspace["state"]) => {
  const w = workspace(slug, name);
  writeJson(workspaceFile(slug, name), { ...w, state });
};

export const removeWorkspace = (slug: string, name: string) => {
  const w = workspace(slug, name);
  fs.rmSync(workspaceFile(slug, name), { force: true });
  fs.rmSync(path.join(domainPath(slug), "inbox", "workspaces", `${name}.json`), { force: true });
  return w;
};

/** Remove a domain: its clones and caches, never the root's (section 8). */
export const remove = async (slugArg: unknown) => {
  const d = domain(slugOf(slugArg, "domain"));
  const left = workspaces(d.slug);
  if (left.length > 0) refuse(`the domain '${d.slug}' still has ${left.length} workspace(s): ${left.map((w) => w.workspace).join(", ")}`, left.map((w) => `desolate rm ${d.slug}/${w.workspace}`).join(" && "), EXIT.busy);
  for (const id of d.repos) {
    const repo = parseRepo(id);
    if (repo && fs.existsSync(clonePath(repo))) await git(clonePath(repo), ["remote", "remove", d.slug]);
  }
  fs.rmSync(domainPath(d.slug), { recursive: true, force: true });
  return { domain: d.slug, kept: "the root clones keep this domain's branches for as long as they are wanted" };
};
