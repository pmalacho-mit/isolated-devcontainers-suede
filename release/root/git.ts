// How the root runs git. Only ever in a repository the root owns: a mirror or a root clone
// (P4). There is no function here that takes a path into a domain.
import * as fs from "node:fs";
import { run } from "../shared/run.ts";
import type { RunOptions, RunResult } from "../shared/run.ts";
import { parseRepo, repoId } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { readJson } from "../shared/json.ts";
import { FORGE, GITCONFIG, KEYRING, ROOT } from "./layout.ts";

/** Which forge the root reaches. GitHub in real use; a stand-in in tests (section 13.2). */
export type Forge = {
  kind: "github" | "stand-in";
  ssh: { user: string; host: string; port: number };
  /** known_hosts lines for the forge's host key. Never learned on first use. */
  knownHosts: string;
};

export const forge = (): Forge => {
  const value = readJson<Forge | null>(FORGE, null);
  if (!value) throw new Error("the root has no forge configured; run `desolate bootstrap` again");
  return value;
};

export const remoteUrl = (repo: Repo, f: Forge = forge()) =>
  `ssh://${f.ssh.user}@${f.ssh.host}:${f.ssh.port}/${repo.owner}/${repo.name}.git`;

const KNOWN_HOSTS = `${ROOT.state}/known_hosts`;

/** ssh for one repository in one role: that role's agent, that key only, a pinned host key,
 *  no config file, no prompt. A fetch path built with the read key cannot push: the forge
 *  refuses the key, and no other identity is offered. */
export const sshCommand = (repo: Repo, role: "read" | "write") =>
  [
    "ssh", "-F", "/dev/null",
    "-o", `IdentityAgent=${role === "read" ? KEYRING.readAgent : KEYRING.writeAgent}`,
    "-o", `IdentityFile=${KEYRING.pub}/${repo.owner}/${repo.name}/${role}.pub`,
    "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${KNOWN_HOSTS}`,
    "-o", "ConnectTimeout=20",
  ].join(" ");

export const writeKnownHosts = (f: Forge) => fs.writeFileSync(KNOWN_HOSTS, f.knownHosts.trim() + "\n", { mode: 0o644 });

const baseEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LANG: "C.UTF-8",
  GIT_TERMINAL_PROMPT: "0",
  // The root's global config is desolate's file, not a dotfile anything else writes.
  GIT_CONFIG_GLOBAL: GITCONFIG,
  GIT_LFS_SKIP_SMUDGE: process.env.GIT_LFS_SKIP_SMUDGE,
});

/** The directory must be under the mirrors or the root clones. Checked on every call, so a
 *  bug elsewhere cannot make the root run git in a domain's repository. */
export const ownedByRoot = (dir: string): boolean => {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return false;
  }
  return real.startsWith(`${ROOT.mirrors}/`) || real.startsWith(`${ROOT.clones}/`);
};

export const git = (dir: string, args: string[], options: RunOptions = {}): Promise<RunResult> => {
  if (!ownedByRoot(dir)) throw new Error(`the root does not run git in ${dir}: it is not a mirror or a root clone (P4)`);
  // A mirror is a bare repository, named outright: the root's config (safe.bareRepository)
  // lets git use a bare repository only when it is told which one, never by finding one.
  const where = fs.realpathSync(dir).startsWith(`${ROOT.mirrors}/`) ? ["--git-dir", dir] : ["-C", dir];
  return run("git", [...where, ...args], { ...options, env: { ...baseEnv(), ...(options.env ?? {}) } });
};

export const gitOk = async (dir: string, args: string[], options: RunOptions = {}): Promise<string> => {
  const result = await git(dir, args, options);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(result.stderr || result.stdout).trim().slice(-1500)}`);
  return result.stdout;
};

/** git with no repository (init, clone): the target is checked by the caller. */
export const gitBare = (args: string[], options: RunOptions = {}) =>
  run("git", args, { ...options, env: { ...baseEnv(), ...(options.env ?? {}) } });

export const repoOf = (value: unknown): Repo => {
  const repo = parseRepo(value);
  if (!repo) throw new Error(`not a repository name (owner/repo): ${String(value)}`);
  return repo;
};
export { repoId };
