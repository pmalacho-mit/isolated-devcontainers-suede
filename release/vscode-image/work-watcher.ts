/**
 * work-watcher.ts -- the factory's hands: requests in, worktrees opened,
 * closed and pushed, outcomes back on desolate's own outbox.
 *
 * Runs in the EDITOR container, started by shell-entry.sh: git already runs
 * there, the broker socket is already mounted there, and the deploy key's
 * agent socket is there for the one push it may make. It acts only on
 * projects with a policy file in /workspaces/.desolate/factory/ -- outside
 * every repository, where no devcontainer reaches (work-policy.ts says why).
 *
 * What it does is what a person does, by the same commands, as subprocesses:
 *
 *   open   worktree add <p> <w> <branch> [<from>]   (no checkout: worktrees.ts)
 *          desolate <p> --worktree <w>              (broker: populate, policy, start)
 *   close  desolate --stop / --purge --worktree <w> <p>
 *          (the broker reclaims root-owned files, refuses uncommitted work)
 *          worktree remove <p> <w> --checked-clean
 *   push   git push origin refs/heads/<b>:refs/heads/<b>   -- never main, never
 *          forced, and only a branch under the policy's prefix
 *
 * Every git it runs itself is plumbing, hardened (work-git.ts); the push is
 * hardened further, since a push is the one command that can be told by the
 * repository's config to execute something (see `push`).
 *
 * A request it refuses is answered once, on desolate's outbox, and recorded
 * as handled outside the repository; one over the cap waits, said once, and is
 * opened when a worktree closes. A malformed request is refused like any
 * other: nothing a request says can stop the loop.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { target as resolveTarget, volumeNamespace, worktreesOf, type Target } from "./projects.ts";
import { isEntryPoint } from "./utils.ts";
import * as workGit from "./work-git.ts";
import {
  approvals,
  FACTORY_DIRECTORY,
  REOPENED,
  handled,
  readPolicy,
  recordHandled,
  type Policy,
} from "./work-policy.ts";
import { tickForge } from "./work-forge.ts";
import {
  author,
  isTarget,
  ulid,
  MessageError,
  parseMessage,
  parseRequest,
  refs,
  subjectOf,
  type Message,
  type Request,
} from "./work-protocol.ts";

const config = {
  workspaces: process.env.DESOLATE_WORKSPACES ?? "/workspaces",
  intervalMs: Number(process.env.DESOLATE_WORK_INTERVAL ?? "15") * 1000,
  /** The commands a person would type; replaceable so a test can record them. */
  worktree: process.env.DESOLATE_WORK_WORKTREE_CMD ?? "worktree",
  desolate: process.env.DESOLATE_WORK_DESOLATE_CMD ?? "desolate",
};

// ---------------------------------------------------------------- deciding --

export interface World {
  /** The project's worktrees, by name. */
  worktrees: string[];
  /** Whether its repository has hooks of its own. */
  hooks: boolean;
}

export type Decision =
  | { kind: "open" | "close" | "push" }
  | { kind: "refuse"; reason: string }
  | { kind: "wait"; reason: string };

const refuse = (reason: string): Decision => ({ kind: "refuse", reason });

/** What to do with one request. Pure: everything it knows is an argument. */
export const decide = (
  request: Request,
  authorName: string,
  policy: Policy,
  world: World,
  approved: boolean,
): Decision => {
  // Tamper-evidence, not security: the writer's identity must match its claim.
  if (authorName !== author(request.from).name)
    return refuse(`written as '${authorName}', but it claims to be from '${request.from}'`);
  const exists = world.worktrees.includes(request.worktree);
  switch (request.action) {
    case "open":
      if (!approved && !policy.requesters.includes(request.from))
        return refuse(`'${request.from}' is not among this factory's requesters; a human may approve it`);
      if (!request.branch!.startsWith(policy.branch_prefix))
        return refuse(`branch '${request.branch}' is not under the policy's prefix '${policy.branch_prefix}'`);
      if (exists) return refuse(`${request.worktree} exists already`);
      if (world.hooks && !policy.allow_hooks && !approved)
        return refuse("the repository has hooks of its own, and the policy does not allow_hooks; a human may approve it");
      if (world.worktrees.length >= policy.max_open_worktrees)
        return { kind: "wait", reason: `${world.worktrees.length} of ${policy.max_open_worktrees} worktrees are open` };
      return { kind: "open" };
    case "close":
      // The overseer may open worktrees, never close them: a close is the
      // forge's (after a merge) or a human's.
      if (!approved && !(request.from.startsWith("forge/") && policy.requesters.includes(request.from)))
        return refuse(`only a forge adapter among the requesters may close a worktree, not '${request.from}'; a human may approve it`);
      if (!exists) return refuse(`there is no worktree ${request.worktree}`);
      return { kind: "close" };
    case "push":
      if (!approved && policy.on_done !== "push")
        return refuse("the policy holds pushes (on_done: hold): a human pushes, with cli.sh work push");
      if (!exists) return refuse(`there is no worktree ${request.worktree}`);
      return { kind: "push" };
  }
};

// ------------------------------------------------------------------- acting --

type Say = (line: string) => void;

/** How long one command may take. A first start builds images, which is
 *  minutes; a broker that never answers must not hold every project behind it. */
const COMMAND_MS = 60 * 60 * 1000;

/** A command a person would type, run to completion; its output is logged. */
const command = (argv: string[], say: Say) => {
  const run = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", env: process.env, timeout: COMMAND_MS, killSignal: "SIGKILL" });
  if (run.error) say(`  ${argv[0]} ${argv[1] ?? ""}: ${run.error.message}`);
  for (const line of `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n")) if (line.trim()) say(`  ${line}`);
  return { status: run.status ?? 1, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
};

/** The project tree's own branch: the one a push must never be. */
const mainBranchOf = (projectDir: string) => {
  try {
    return workGit.git(projectDir, ["symbolic-ref", "-q", "--short", "HEAD"]);
  } catch {
    return "";
  }
};

export { isSafeRemote, SAFE_REMOTE } from "./work-policy.ts";

/** The exact, unforced refspec, and no hook. */
export const pushArguments = (url: string, branch: string) =>
  ["push", "--no-verify", url, `refs/heads/${branch}:refs/heads/${branch}`];

/** No config but the push's own: the URL is already the one to use (pushUrl),
 *  so neither the editor's url rewrites nor anything else is wanted. The ssh
 *  is newrepo.ts's, given here rather than read back from the repository. */
export const PUSH_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_SSH_COMMAND: `ssh -F ${homedir()}/.ssh/config`,
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  GIT_TERMINAL_PROMPT: "0",
} as const;

/**
 * Where a project's branches are pushed. Never simply its origin: a devcontainer
 * writes `.git/config`, and an origin naming another repository -- under the
 * canonical name the editor's url rewrites map to THAT repository's deploy key
 * -- would push with that key. So the host is always this project's own key
 * alias, `github.com-<namespace>` (newrepo.ts names it so, and its ssh block
 * pins the one key, IdentitiesOnly): a deploy key writes only its own
 * repository on GitHub, so a path naming any other one is refused there. Only
 * the path is taken from origin. A human can name the remote outright in the
 * policy (`work init --remote`), which is never read from the repository.
 */
export const pushUrl = (projectDir: string, project: string, policy: Policy): string | undefined => {
  if (policy.remote) return policy.remote;
  let origin = "";
  try {
    origin = workGit.git(projectDir, ["config", "--get", "remote.origin.url"]);
  } catch {
    return undefined;
  }
  const path = /^(?:git@[^:/]+:|ssh:\/\/git@[^/]+\/)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(origin)?.[1];
  if (!path || path.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
  return `git@github.com-${volumeNamespace(project)}:${path}.git`;
};

/** A branch name as the factory will push one. */
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const isBranch = (name: string) => BRANCH.test(name) && !/(^|\/)\.|\.\.|\/\/|\/$|^\/|\.lock(\/|$)|@\{/.test(name);

/**
 * Push a worktree's branch -- read where the project cannot point outside
 * itself, and sent where only its own key can write.
 *
 * The branch is bundled on the orchestrator's side by a sandbox that sees the
 * project and nothing else of /workspaces (desolate.ts bundleWorktree): the
 * editor's own git would follow a symlinked ref or alternates into any
 * project. The bundle is imported into a throwaway bare repository with no
 * hooks and no config, and pushed from there, unforced, to pushUrl.
 */
export const push = (target: Target, policy: Policy, say: Say): { ok: true; branch: string } | { ok: false; reason: string } => {
  const made = command([config.desolate, "--bundle", "--worktree", target.worktree!, target.project], say);
  const said = /^BUNDLED (\S+) ([0-9a-f]{40,64}) /m.exec(made.output);
  if (made.status !== 0 || !said) return { ok: false, reason: `${target.name}'s branch could not be bundled (exit ${made.status})` };
  const [, branch, commit] = said;
  if (!isBranch(branch)) return { ok: false, reason: `refusing to push '${branch}': not a branch name` };
  if (branch === mainBranchOf(target.projectDir)) return { ok: false, reason: `refusing to push '${branch}': it is the project's own branch` };
  if (!branch.startsWith(policy.branch_prefix))
    return { ok: false, reason: `refusing to push '${branch}': not under the policy's prefix '${policy.branch_prefix}'` };
  const url = pushUrl(target.projectDir, target.project, policy);
  if (!url) return { ok: false, reason: "no remote to push to: origin is not an ssh remote this can follow, and the policy names none" };
  // Where desolate.ts wrote it, computed here rather than read from its output.
  const bundle = join(config.workspaces, ".desolate", "factory", "push", target.namespace, "branch.bundle");

  const bare = mkdtempSync(join(tmpdir(), "desolate-push-"));
  const inBare = (args: string[]) =>
    execFileSync("git", ["--git-dir", bare, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...PUSH_ENV },
      timeout: COMMAND_MS,
    });
  try {
    inBare(["init", "--bare", "--quiet", "--template="]);
    inBare(["fetch", "--quiet", "--no-tags", bundle, `refs/heads/${branch}:refs/heads/${branch}`]);
    if (inBare(["rev-parse", `refs/heads/${branch}`]).trim() !== commit)
      return { ok: false, reason: `the bundle of ${branch} is not the commit the sandbox reported` };
    inBare(pushArguments(url, branch));
    say(`  pushed ${branch} to ${url}`);
    return { ok: true, branch };
  } catch (err: any) {
    return { ok: false, reason: `git push failed: ${String(err?.stderr || err?.message || err).trim().split("\n").slice(-2).join(" / ")}` };
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
};

const hasHooks = (projectDir: string) => {
  // Every scope the repository has -- its config, what that includes, and
  // config.worktree -- with the system and global ones off (HARDENED_ENV).
  // Not the command line's own core.hooksPath=/dev/null (HARDENED), which
  // `--show-scope` names as such.
  try {
    const set = workGit.git(projectDir, ["config", "--includes", "--show-scope", "--get-all", "core.hooksPath"]);
    if (set.split("\n").some((line) => line && !line.startsWith("command\t"))) return true;
  } catch { /* unset */ }
  const hooks = join(projectDir, ".git", "hooks");
  return existsSync(hooks) && readdirSync(hooks).some((name) => !name.endsWith(".sample"));
};

/** Desolate's answer, on its own outbox: the requester's, or everyone's. */
export const answer = (projectDir: string, to: string, body: string, fields: Record<string, unknown>) => {
  const message: Message = {
    v: 1, from: "desolate", to: [isTarget(to) ? to : "*"], type: "state", body,
    item: null, commit: null, reply_to: null, ...fields,
  };
  workGit.append(projectDir, refs.desolate, "desolate", message, subjectOf(message));
};

/** A worktree closed the way `cli.sh worktree remove` closes one: stopped,
 *  purged by the broker (which reclaims root-owned files and refuses
 *  uncommitted work), then removed here. Its outcome, and why. */
export const closeWorktree = (project: string, worktree: string, say: Say): { state: "closed" | "refused" | "failed"; body: string } => {
  command([config.desolate, "--stop", "--worktree", worktree, project], say);
  const purged = command([config.desolate, "--purge", "--worktree", worktree, project], say);
  if (purged.status === 3) return { state: "refused", body: `${worktree} holds uncommitted work; it stays` };
  if (purged.status !== 0) return { state: "failed", body: `the purge failed (exit ${purged.status})` };
  const removed = command([config.worktree, "remove", project, worktree, "--checked-clean"], say);
  if (removed.status !== 0) return { state: "failed", body: "purged, but the worktree could not be removed" };
  return { state: "closed", body: `closed ${worktree}` };
};

// ------------------------------------------------------------------ the loop --

export const tickProject = (project: string, say: Say) => {
  const root = resolveTarget(config.workspaces, project);
  let policy: Policy | undefined;
  try {
    policy = readPolicy(config.workspaces, project);
  } catch (err: any) {
    return say(`${project}: the factory policy cannot be read (${err?.message ?? err}); doing nothing`);
  }
  if (!policy || !existsSync(join(root.projectDir, ".git"))) return;
  const outside = workGit.containment(root.projectDir);
  if (outside) return say(`${project}: refusing to read its repository: ${outside}`);
  // New work items become requests first, so they are acted on this tick.
  tickForge(project, config.workspaces, policy, say, ulid);
  const done = handled(config.workspaces, project);
  const approved = approvals(config.workspaces, project);

  const pending = workGit.refsUnder(root.projectDir, "refs/desolate/requests/")
    .map(({ ref, commit }) => ({ id: ref.slice("refs/desolate/requests/".length), commit }))
    // Finished with, unless a human reopened it by approving it since.
    .filter(({ id }) => !done.has(id) || done.get(id) === REOPENED)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  for (const { id, commit } of pending) {
    const finish = (outcome: string, to: string, body: string, fields: Record<string, unknown> = {}) => {
      answer(root.projectDir, to, body, { request: id, state: outcome, ...fields });
      recordHandled(config.workspaces, project, id, outcome);
      say(`${project}: request ${id}: ${outcome} -- ${body}`);
    };
    let request: Request;
    let authorName: string;
    try {
      const read = workGit.readCommit(root.projectDir, commit);
      authorName = read.authorName;
      if (read.parents.length) throw new MessageError("a request is one commit, with no history");
      request = parseRequest(read.json);
    } catch (err: any) {
      finish("refused", "*", `request ${id} cannot be read: ${err?.message ?? err}`);
      continue;
    }
    const target = resolveTarget(config.workspaces, project, request.worktree);
    const world = { worktrees: worktreesOf(root).map(({ worktree }) => worktree!), hooks: hasHooks(root.projectDir) };
    const decision = decide(request, authorName, policy, world, approved.has(id));
    const fields = { worktree: request.worktree, item: request.item };

    if (decision.kind === "refuse") { finish("refused", request.from, decision.reason, fields); continue; }
    if (decision.kind === "wait") {
      // Said once, and remembered outside the process: a restart must not
      // announce every waiting request again.
      if (!done.has(`wait:${id}`)) {
        answer(root.projectDir, request.from, `waiting: ${decision.reason}`, { request: id, state: "waiting", ...fields });
        recordHandled(config.workspaces, project, `wait:${id}`, "announced");
        say(`${project}: request ${id}: waiting -- ${decision.reason}`);
      }
      continue;
    }

    if (decision.kind === "open") {
      const added = command([config.worktree, "add", project, request.worktree, request.branch!, ...(request.from_ref ? [request.from_ref] : [])], say);
      if (added.status !== 0) { finish("refused", request.from, `worktree add failed: ${added.output.trim().split("\n").pop()}`, fields); continue; }
      const started = command([config.desolate, project, "--worktree", request.worktree], say);
      if (started.status !== 0) { finish("failed", request.from, `the worktree was created and did not start (exit ${started.status})`, fields); continue; }
      finish("opened", request.from, `opened ${request.worktree} on ${request.branch}`, fields);
    } else if (decision.kind === "close") {
      const closed = closeWorktree(project, request.worktree, say);
      finish(closed.state, request.from, closed.body, fields);
    } else {
      const pushed = push(target, policy, say);
      if (pushed.ok) finish("pushed", request.from, `pushed ${pushed.branch}`, { ...fields, branch: pushed.branch });
      else finish("refused", request.from, pushed.reason, fields);
    }
  }

  // An agent's `done` pushes its branch when the policy says so.
  if (policy.on_done !== "push") return;
  for (const worktree of worktreesOf(root)) {
    for (const commit of workGit.history(root.projectDir, refs.outbox(worktree.worktree!))) {
      const key = `done:${commit}`;
      if (done.has(key)) continue;
      let message: Message;
      try {
        const read = workGit.readCommit(root.projectDir, commit);
        message = parseMessage(read.json);
        if (message.type !== "done" || read.authorName !== author(worktree.worktree!).name) continue;
      } catch {
        continue;
      }
      const pushed = push(worktree, policy, say);
      const body = pushed.ok ? `pushed ${pushed.branch} on ${worktree.worktree}'s done` : pushed.reason;
      answer(root.projectDir, worktree.worktree!, body, { state: pushed.ok ? "pushed" : "refused", worktree: worktree.worktree, done: commit });
      recordHandled(config.workspaces, project, key, pushed.ok ? "pushed" : "refused");
      say(`${project}: ${worktree.worktree} done (${commit.slice(0, 12)}): ${body}`);
    }
  }
};

/** Every project with a factory: a policy file, named for its namespace. */
export const factoryProjects = (workspaces: string) => {
  try {
    return readdirSync(FACTORY_DIRECTORY(workspaces))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length).replaceAll("__", "/"));
  } catch {
    return [];
  }
};

export const tick = (say: Say) => {
  for (const project of factoryProjects(config.workspaces)) {
    try {
      tickProject(project, say);
    } catch (err: any) {
      say(`${project}: ${err?.message ?? err}`);   // one project's failure is not the loop's
    }
  }
};

if (isEntryPoint(import.meta.url)) {
  const say: Say = (line) => console.log(`work-watcher: ${line}`);
  if (process.argv.includes("--once")) tick(say);
  else {
    say(`watching ${FACTORY_DIRECTORY(config.workspaces)} every ${config.intervalMs / 1000}s`);
    const loop = () => {
      tick(say);
      setTimeout(loop, config.intervalMs);
    };
    loop();
  }
}
