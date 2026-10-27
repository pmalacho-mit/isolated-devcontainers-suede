/**
 * transfer.ts -- `desolate --push` and `--pull`, in the editor: a project's
 * branch to its GitHub repository and back, without git ever running in the
 * project here.
 *
 * `git push` or `git pull` typed in the editor's terminal is the project's own
 * git: it runs the repository's hooks (pre-push, post-merge, post-checkout),
 * obeys its config (core.sshCommand is a command; url.*.insteadOf sends the
 * push somewhere else), and follows its refs and alternates wherever they
 * point -- into another project, say. And the editor is the one container that
 * can write every project and use every deploy key. So nothing here reads a
 * project's git: not its config, hooks, refs or objects. Each direction is two
 * halves that meet at one bundle file in the project's own git dir:
 *
 *   push  The target's sandbox, which sees that project alone, bundles the
 *         branch checked out there (docker.ts bundleScript). Here, a fresh,
 *         empty repository fetches the bundle and pushes the commit the
 *         sandbox named -- to the repository `repo add` registered for this
 *         project, with that repository's key. Never forced; never the default
 *         branch unless asked.
 *   pull  Here, a fresh, empty repository fetches every branch of that same
 *         repository and bundles them into the project's git dir. The target's
 *         sandbox takes them as origin/* and fast-forwards the branch checked
 *         out, when it can (docker.ts pullScript).
 *
 * The bundle is opened as data, and only if it is a file of that project
 * (status.ts openContained). What it holds is the project's own, or the
 * remote's: a project can only put in it what it can already read.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { ask } from "./broker-client.ts";
import { openContained } from "./status.ts";

const WORKSPACES = process.env.DESOLATE_WORKSPACES ?? "/workspaces";
/** newrepo.ts's: the per-repository host aliases live there. */
const SSH_CONFIG = `${homedir()}/.ssh/config`;
const KEYRING_RUN = process.env.DESOLATE_KEYRING_RUN ?? "/run/keyring";

export class TransferError extends Error {}
const fail = (message: string): never => { throw new TransferError(message); };

/** Where this project's branches go: what `repo add owner/repo` set up. */
export interface Registration {
  /** The keyring's name for its deploy key: `owner__name`. */
  tag: string;
  /** The GitHub repository, `owner/repo`. */
  ownerRepo: string;
  /** Through the host alias, so ssh offers that key and no other. */
  url: string;
}

/**
 * A project's registration, from the editor's OWN git config -- never the
 * project's. `repo add` clones `owner/repo` to /workspaces/<owner>/<alias>,
 * keys it as `<owner>__<alias>`, and writes the rewrite that names the
 * repository: `url.git@github.com-<tag>:<owner/repo>.insteadOf`. `config` is
 * `git config --global --get-regexp '^url\.'`.
 */
export const registrationOf = (project: string, config: string): Registration | undefined => {
  const parts = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(project);
  if (!parts) return undefined;
  const tag = `${parts[1]}__${parts[2]}`;
  const prefix = `url.git@github.com-${tag}:`;
  const repos = new Set(config.split("\n").flatMap((line) => {
    const key = line.trim().split(/\s+/)[0] ?? "";
    if (!key.startsWith(prefix) || !key.endsWith(".insteadof")) return [];
    const repo = key.slice(prefix.length, -".insteadof".length);
    return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) ? [repo] : [];
  }));
  if (repos.size !== 1) return undefined;
  const [ownerRepo] = repos;
  return { tag, ownerRepo, url: `git@github.com-${tag}:${ownerRepo}.git` };
};

/** Git with nothing configured but what is said here: no system or global
 *  config, no hooks, no prompt, and ssh through the editor's host aliases. */
export const cleanGit = (args: string[], options: { capture?: boolean; ssh?: string } = {}) => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: options.ssh ?? `ssh -F ${SSH_CONFIG}`,
  });
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** The project's directory, if it is one: not a link (projects.ts refuses
 *  those too), so its realpath is what openContained holds files to. */
const projectDirOf = (project: string) => {
  const dir = join(WORKSPACES, project);
  try {
    if (lstatSync(dir).isDirectory() && realpathSync(dir) === dir) return dir;
  } catch { /* fall through */ }
  return fail(`${project} is not a project directory under ${WORKSPACES}`);
};

const registered = (project: string, config: string) => {
  const registration = registrationOf(project, config);
  if (!registration)
    return fail(`${project} has no repository registered: push and pull go only to the one \`repo add\` set up.
       On the Mac:  ./cli.sh repo add ${project.includes("/") ? project : "owner/repo"}`);
  return registration;
};

const globalUrlConfig = () => {
  const env = { ...process.env };
  const result = spawnSync("git", ["config", "--global", "--get-regexp", "^url\\."], { env, encoding: "utf8" });
  return result.stdout ?? "";
};

/** All of it: one write can take less than it is given. */
const writeAll = (fd: number, bytes: Buffer) => {
  for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
};

const transferName = () => `desolate-transfer-${randomBytes(8).toString("hex")}.bundle`;

/** `git ls-remote --symref <url> HEAD`'s answer: the remote's default branch. */
export const defaultBranchOf = (lsRemote: string) =>
  /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(lsRemote)?.[1];

export interface Options {
  worktree?: string;
  /** Push to the remote's default branch, which is refused otherwise. */
  allowDefault?: boolean;
  /** For tests: the registration, and how git reaches it. */
  registration?: Registration;
  ssh?: string;
  /** For tests: the broker, as `ask` with a line reader. */
  ask?: (request: Record<string, unknown>, onLog: (line: string) => boolean) => Promise<number>;
}

/** Push the branch checked out in a target to its project's repository. */
export async function push(project: string, options: Options = {}): Promise<string> {
  const projectDir = projectDirOf(project);
  const registration = options.registration ?? registered(project, globalUrlConfig());
  if (!options.registration && !(lstatSync(`${KEYRING_RUN}/pub/${registration.tag}.pub`, { throwIfNoEntry: false })?.isFile()))
    fail(`the keyring holds no key for ${registration.tag}; on the Mac: ./cli.sh repo add ${registration.ownerRepo}`);

  const name = transferName();
  let bundled: { branch: string; commit: string; file: string } | undefined;
  const code = await (options.ask ?? ask)(
    { op: "bundle", project, ...(options.worktree ? { worktree: options.worktree } : {}), transfer: name },
    (line) => {
      const said = /^BUNDLED (\S+) ([0-9a-f]{40,64}) (\/\S+)$/.exec(line);
      if (said) bundled = { branch: said[1], commit: said[2], file: said[3] };
      return !said;
    },
  );
  if (code !== 0 || !bundled) return fail(`its sandbox did not bundle the branch (exit ${code})`);

  const scratch = mkdtempSync(join(tmpdir(), "desolate-push-"));
  const inside = relative(projectDir, bundled.file);
  const ours = basename(inside) === name && !inside.startsWith("..") && !inside.startsWith("/");
  try {
    if (!ours) fail(`the sandbox named a bundle outside ${project}: ${bundled.file}`);
    const fd = openContained(projectDir, inside, constants.O_RDONLY);
    if (fd === undefined) return fail(`the bundle is not a file of ${project}'s own: ${bundled.file}`);
    let bytes: Buffer;
    try { bytes = readFileSync(fd); } finally { closeSync(fd); }
    const bundle = join(scratch, "branch.bundle");
    const out = openContained(scratch, "branch.bundle", constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    if (out === undefined) return fail("could not write the bundle to a scratch directory");
    try { writeAll(out, bytes); } finally { closeSync(out); }

    const repo = join(scratch, "repo.git");
    const { branch, commit } = bundled;
    if (!cleanGit(["init", "--quiet", "--bare", repo]).ok) fail("could not make a scratch repository");
    if (!cleanGit(["-C", repo, "fetch", "--quiet", bundle, `refs/heads/${branch}:refs/heads/${branch}`]).ok)
      fail("the bundle did not fetch");
    const fetched = cleanGit(["-C", repo, "rev-parse", `refs/heads/${branch}`], { capture: true }).stdout.trim();
    if (fetched !== commit) fail(`the bundle holds ${fetched || "nothing"} for ${branch}, not the ${commit} its sandbox said`);

    const head = cleanGit(["-C", repo, "ls-remote", "--symref", registration.url, "HEAD"], { capture: true, ssh: options.ssh });
    if (!head.ok) fail(`could not reach ${registration.ownerRepo}: ${head.stderr.trim()}`);
    if (defaultBranchOf(head.stdout) === branch && !options.allowDefault)
      fail(`${branch} is ${registration.ownerRepo}'s default branch; push a branch of its own, or pass --allow-default`);

    if (!cleanGit(["-C", repo, "push", "--quiet", registration.url, `refs/heads/${branch}:refs/heads/${branch}`], { ssh: options.ssh }).ok)
      fail(`${registration.ownerRepo} refused ${branch} (not a fast-forward? pull first)`);
    return `pushed ${branch} (${commit.slice(0, 12)}) to ${registration.ownerRepo}`;
  } finally {
    // Whatever it turned out to be -- removing a link removes only the link.
    if (ours) try { unlinkSync(join(projectDir, inside)); } catch { /* gone already */ }
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** What the sandbox did with what was fetched, said for a person. */
const pulledMessage = (outcome: string, branch: string, ownerRepo: string) => ({
  "fast-forwarded": `${branch} fast-forwarded to origin/${branch} (${ownerRepo})`,
  current: `${branch} is up to date with origin/${branch}, or ahead of it`,
  diverged: `${branch} and origin/${branch} have diverged; merge or rebase in the devcontainer: git merge origin/${branch}`,
  blocked: `${branch} could not be fast-forwarded -- uncommitted changes in the way? In the devcontainer: git merge --ff-only origin/${branch}`,
  fetched: branch === "-"
    ? `fetched ${ownerRepo}'s branches as origin/*; nothing is checked out to move`
    : `fetched ${ownerRepo}'s branches as origin/*; it has no ${branch}`,
} as Record<string, string>)[outcome] ?? `pulled (${outcome})`;

/** Fetch the project's repository into origin/*, and fast-forward the branch
 *  checked out in the target. */
export async function pull(project: string, options: Options = {}): Promise<string> {
  const projectDir = projectDirOf(project);
  const registration = options.registration ?? registered(project, globalUrlConfig());
  try {
    if (!lstatSync(join(projectDir, ".git")).isDirectory()) throw new Error();
  } catch {
    return fail(`${project}/.git is not a directory of its own`);
  }

  const scratch = mkdtempSync(join(tmpdir(), "desolate-pull-"));
  const name = transferName();
  const inside = join(".git", name);
  try {
    const repo = join(scratch, "repo.git");
    if (!cleanGit(["init", "--quiet", "--bare", repo]).ok) fail("could not make a scratch repository");
    if (!cleanGit(["-C", repo, "fetch", "--quiet", "--no-tags", registration.url, "+refs/heads/*:refs/heads/*"], { ssh: options.ssh }).ok)
      fail(`could not fetch ${registration.ownerRepo}`);
    const bundle = join(scratch, "all.bundle");
    if (!cleanGit(["-C", repo, "bundle", "create", "--quiet", bundle, "--branches"]).ok)
      fail(`${registration.ownerRepo} has no branches to pull`);

    const fd = openContained(projectDir, inside, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    if (fd === undefined) return fail(`could not put the bundle in ${project}/.git`);
    try { writeAll(fd, readFileSync(bundle)); } finally { closeSync(fd); }

    let pulled: { outcome: string; branch: string } | undefined;
    const code = await (options.ask ?? ask)(
      { op: "pull", project, ...(options.worktree ? { worktree: options.worktree } : {}), transfer: name },
      (line) => {
        const said = /^PULLED (\S+) (\S+)$/.exec(line);
        if (said) pulled = { outcome: said[1], branch: said[2] };
        return !said;
      },
    );
    if (code !== 0 || !pulled) return fail(`its sandbox did not take the fetched branches (exit ${code})`);
    return pulledMessage(pulled.outcome, pulled.branch, registration.ownerRepo);
  } finally {
    rmSync(join(projectDir, inside), { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}
