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
 * halves that meet at a bundle in the project's own git dir.
 *
 * The editor's half works in a CACHE: a bare repository per registered
 * project, of its remote, under ~/.cache/desolate/remotes -- outside
 * /workspaces, and touched by nothing but cleanGit below. It makes both
 * directions cost what changed rather than the whole history (measured on
 * git/git: a pull ~35 s -> ~2 s, a push ~21 s -> ~0.1 s, after the first).
 *
 *   push  The cache is brought up to date, and its branch tips handed to the
 *         target's sandbox, which sees that project alone (`.haves`). It
 *         bundles the branch checked out there less what the cache has
 *         (docker.ts bundleScript). The cache takes the bundle, and pushes the
 *         commit the sandbox named -- to the repository `repo add` registered
 *         for this project, with that repository's key. Never forced; never
 *         the default branch unless asked.
 *   pull  The cache is brought up to date, and bundles what the project does
 *         not have yet -- what it last handed over, it knows -- with the
 *         remote's branches beside it (`.refs`). The sandbox makes origin/*
 *         exactly those, and fast-forwards the branch checked out when it can
 *         (docker.ts pullScript). A project that turns out to lack something
 *         is sent all of it, once.
 *
 * Files are opened as data, and only if they are files of that project
 * (status.ts openContained). What a bundle holds is the project's own, or the
 * remote's: a project can only put in one what it can already read.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ask } from "./broker-client.ts";
import { openContained } from "./status.ts";

const WORKSPACES = process.env.DESOLATE_WORKSPACES ?? "/workspaces";
/** newrepo.ts's: the per-repository host aliases live there. */
const SSH_CONFIG = `${homedir()}/.ssh/config`;
const KEYRING_RUN = process.env.DESOLATE_KEYRING_RUN ?? "/run/keyring";
/** The editor's own: a project never mounts it. */
const CACHE_ROOT = process.env.DESOLATE_REMOTE_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "desolate", "remotes");

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

/** A transfer's files in the project's git dir, and where they are inside the
 *  project (for openContained). The name is the broker's TRANSFER_NAME. */
const transferFiles = (projectDir: string, name: string) => {
  const stem = join(".git", name.replace(/\.bundle$/, ""));
  return { bundle: `${stem}.bundle`, haves: `${stem}.haves`, refs: `${stem}.refs`, projectDir };
};

const writeInside = (projectDir: string, inside: string, bytes: Buffer | string) => {
  const fd = openContained(projectDir, inside, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  if (fd === undefined) return fail(`could not write ${inside} in ${projectDir}`);
  try { writeAll(fd, Buffer.from(bytes)); } finally { closeSync(fd); }
};

const readInside = (projectDir: string, inside: string) => {
  const fd = openContained(projectDir, inside, constants.O_RDONLY);
  if (fd === undefined) return fail(`${inside} is not a file of ${projectDir}'s own`);
  try { return readFileSync(fd); } finally { closeSync(fd); }
};

/** Removing a link removes only the link; a file already gone is fine. */
const removeInside = (projectDir: string, ...inside: string[]) => {
  for (const file of inside) try { unlinkSync(join(projectDir, file)); } catch { /* gone */ }
};

/** One project's cache, held for the length of one push or pull. */
interface Cache {
  dir: string;
  /** Commits this project is known to have: what the last pull handed it,
   *  and what it pushed. Only a guess -- a pull checks it, and sends all of
   *  it when the guess was wrong. */
  known: () => string[];
  remember: (commits: string[]) => void;
  release: () => void;
}

const COMMIT = /^[0-9a-f]{40,64}$/;
const KNOWN_MAX = 500;

/** The cache for `registration`, made if it is not there, and locked: two
 *  pushes or pulls of one project at once would race on its refs. A lock
 *  whose process is gone is taken over. */
const openCache = (registration: Registration): Cache => {
  mkdirSync(CACHE_ROOT, { recursive: true });
  const dir = join(CACHE_ROOT, `${registration.tag}.git`);
  const lock = join(CACHE_ROOT, `${registration.tag}.lock`);
  const knownFile = join(CACHE_ROOT, `${registration.tag}.known`);
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (err: any) {
      if (err.code !== "EEXIST" || attempt > 0) return fail(`another push or pull of ${registration.ownerRepo} is running (${lock})`);
      const holder = Number(readFileSync(lock, "utf8"));
      let alive = false;
      // EPERM is a process that is there and not ours to signal: alive.
      try { process.kill(holder, 0); alive = true; } catch (probe: any) { alive = probe.code === "EPERM"; }
      if (alive && holder !== process.pid) return fail(`another push or pull of ${registration.ownerRepo} is running (pid ${holder})`);
      rmSync(lock, { force: true });
    }
  }
  const release = () => rmSync(lock, { force: true });
  try {
    if (!existsSync(dir) && !cleanGit(["init", "--quiet", "--bare", dir]).ok) fail(`could not make the cache at ${dir}`);
  } catch (err) {
    release();
    throw err;
  }
  return {
    dir,
    known: () => {
      try {
        return readFileSync(knownFile, "utf8").split("\n").filter((line) => COMMIT.test(line));
      } catch {
        return [];
      }
    },
    remember: (commits) => {
      const kept = [...new Set([...commits, ...(() => { try { return readFileSync(knownFile, "utf8").split("\n"); } catch { return []; } })()])]
        .filter((line) => COMMIT.test(line)).slice(0, KNOWN_MAX);
      writeFileSync(knownFile, `${kept.join("\n")}\n`);
    },
    release,
  };
};

/** The cache, up to date with the remote: what changed comes down, a branch
 *  deleted there is deleted here. */
const refresh = (cache: Cache, registration: Registration, ssh?: string) => {
  if (!cleanGit(["-C", cache.dir, "fetch", "--quiet", "--no-tags", "--prune", registration.url, "+refs/heads/*:refs/heads/*"], { ssh }).ok)
    fail(`could not fetch ${registration.ownerRepo}`);
};

/** The cache's branches, `[commit, name]`, newest first. */
const branchesOf = (cache: Cache) =>
  cleanGit(["-C", cache.dir, "for-each-ref", "--sort=-committerdate", "--format=%(objectname) %(refname:strip=2)", "refs/heads/"], { capture: true })
    .stdout.split("\n").flatMap((line) => {
      const [commit, name] = line.split(" ");
      return commit && name && COMMIT.test(commit) ? [[commit, name] as const] : [];
    });

const hasCommit = (cache: Cache, commit: string) =>
  COMMIT.test(commit) && cleanGit(["-C", cache.dir, "cat-file", "-e", `${commit}^{commit}`], { capture: true }).ok;

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

  const cache = openCache(registration);
  const name = transferName();
  const files = transferFiles(projectDir, name);
  const scratch = mkdtempSync(join(tmpdir(), "desolate-push-"));
  try {
    refresh(cache, registration, options.ssh);
    // What the sandbox may leave out: the cache's newest branch tips, and what
    // the project is known to have of the cache's.
    const haves = [...new Set([...branchesOf(cache).slice(0, 200).map(([commit]) => commit), ...cache.known()])]
      .filter((commit) => hasCommit(cache, commit));
    writeInside(projectDir, files.haves, haves.map((commit) => `${commit}\n`).join(""));

    let bundled: { branch: string; commit: string; bundled: boolean } | undefined;
    const code = await (options.ask ?? ask)(
      { op: "bundle", project, ...(options.worktree ? { worktree: options.worktree } : {}), transfer: name },
      (line) => {
        const said = /^BUNDLED (\S+) ([0-9a-f]{40,64}) (bundled|none)$/.exec(line);
        if (said) bundled = { branch: said[1], commit: said[2], bundled: said[3] === "bundled" };
        return !said;
      },
    );
    if (code !== 0 || !bundled) return fail(`its sandbox did not bundle the branch (exit ${code})`);
    const { branch, commit } = bundled;

    const outgoing = `refs/desolate/outgoing/${branch}`;
    if (bundled.bundled) {
      const bundle = join(scratch, "branch.bundle");
      writeFileSync(bundle, readInside(projectDir, files.bundle));
      if (!cleanGit(["-C", cache.dir, "fetch", "--quiet", bundle, `+refs/heads/${branch}:${outgoing}`]).ok)
        fail("the bundle did not fetch into the cache");
      const fetched = cleanGit(["-C", cache.dir, "rev-parse", outgoing], { capture: true }).stdout.trim();
      if (fetched !== commit) fail(`the bundle holds ${fetched || "nothing"} for ${branch}, not the ${commit} its sandbox said`);
    } else if (!hasCommit(cache, commit)) {
      fail(`the sandbox sent nothing for ${branch}, and the cache does not have ${commit}`);
    }

    const head = cleanGit(["-C", cache.dir, "ls-remote", "--symref", registration.url, "HEAD"], { capture: true, ssh: options.ssh });
    if (!head.ok) fail(`could not reach ${registration.ownerRepo}: ${head.stderr.trim()}`);
    if (defaultBranchOf(head.stdout) === branch && !options.allowDefault)
      fail(`${branch} is ${registration.ownerRepo}'s default branch; push a branch of its own, or pass --allow-default`);

    if (!cleanGit(["-C", cache.dir, "push", "--quiet", registration.url, `${commit}:refs/heads/${branch}`], { ssh: options.ssh }).ok)
      fail(`${registration.ownerRepo} refused ${branch} (not a fast-forward? pull first)`);
    // GitHub has it now, and so does the cache's copy of GitHub.
    cleanGit(["-C", cache.dir, "update-ref", `refs/heads/${branch}`, commit]);
    cleanGit(["-C", cache.dir, "update-ref", "-d", outgoing]);
    cache.remember([commit]);
    return `pushed ${branch} (${commit.slice(0, 12)}) to ${registration.ownerRepo}`;
  } finally {
    removeInside(projectDir, files.bundle, files.haves);
    rmSync(scratch, { recursive: true, force: true });
    cache.release();
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

  const cache = openCache(registration);
  const scratch = mkdtempSync(join(tmpdir(), "desolate-pull-"));
  const created: string[] = [];
  try {
    refresh(cache, registration, options.ssh);
    const branches = branchesOf(cache);
    if (!branches.length) fail(`${registration.ownerRepo} has no branches to pull`);
    const refs = branches.map(([commit, name]) => `${commit} ${name}\n`).join("");

    /** One handover: what the project lacks (all of it when `full`), and the
     *  remote's branches; the sandbox's answer. */
    const handOver = async (full: boolean) => {
      const name = transferName();
      const files = transferFiles(projectDir, name);
      created.push(files.bundle, files.refs);
      const excluded = full ? [] : cache.known().filter((commit) => hasCommit(cache, commit));
      const bundle = join(scratch, name);
      const made = cleanGit(["-C", cache.dir, "bundle", "create", "--quiet", bundle, "--branches", ...excluded.map((commit) => `^${commit}`)], { capture: true });
      if (made.ok) writeInside(projectDir, files.bundle, readFileSync(bundle));
      else if (!/empty bundle/.test(made.stderr)) fail(`could not bundle ${registration.ownerRepo}: ${made.stderr.trim()}`);
      writeInside(projectDir, files.refs, refs);
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
      return pulled;
    };

    let pulled = await handOver(false);
    if (pulled.outcome === "needs-full") pulled = await handOver(true);
    if (pulled.outcome === "needs-full") fail("its sandbox still lacks what the whole of the remote holds");
    cache.remember(branches.map(([commit]) => commit));
    return pulledMessage(pulled.outcome, pulled.branch, registration.ownerRepo);
  } finally {
    removeInside(projectDir, ...created);
    rmSync(scratch, { recursive: true, force: true });
    cache.release();
  }
}
