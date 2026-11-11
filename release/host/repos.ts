// clone, fetch, repos, keys: the host's part. The root makes keys and fetches; the host only
// registers the public halves with the forge, using the person's own credentials there.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { refuse } from "../shared/exit.ts";
import { parseRepo, repoId } from "../shared/names.ts";
import { run } from "../shared/run.ts";
import { INSTANCE } from "./paths.ts";
import { config, rootctl } from "./stack.ts";

type Out = (line: string) => void;
type Key = { role: "read" | "write"; pubkey: string };

const repoArg = (value: string | undefined) =>
  parseRepo(value) ?? refuse(`'${value ?? ""}' is not a repository`, "name it as <owner>/<repo>");

/** Register one deploy key. GitHub: the person's `gh`. Stand-in: the command in
 *  DESOLATE_FORGE_ADMIN (tests). Read keys are read-only; write keys read-write. */
const register = async (repo: string, key: Key) => {
  const forge = config()!.forge;
  if (forge.kind === "stand-in") {
    const admin = process.env.DESOLATE_FORGE_ADMIN;
    if (!admin) refuse("the stand-in forge needs its admin command to register a key", "set DESOLATE_FORGE_ADMIN to the forge's admin script");
    const result = await run(admin!, ["add-key", repo, key.role, key.pubkey]);
    if (result.code !== 0) throw new Error(`the stand-in forge refused the ${key.role} key: ${result.stderr.trim()}`);
    return "registered";
  }
  const file = path.join(os.tmpdir(), `desolate-${process.pid}-${key.role}.pub`);
  fs.writeFileSync(file, key.pubkey + "\n");
  try {
    const args = ["repo", "deploy-key", "add", file, "--repo", repo, "--title", `desolate ${key.role} (${os.hostname()}, ${INSTANCE})`];
    if (key.role === "write") args.push("--allow-write");
    const result = await run("gh", args);
    if (result.code === 0) return "registered";
    if (/already in use|already exists/i.test(result.stderr)) return "already registered";
    if (result.code === 127) refuse("registering a deploy key needs GitHub's CLI", "install gh and run `gh auth login`, or add this key to the repository's deploy keys by hand:\n" + key.pubkey);
    refuse(`GitHub refused the ${key.role} deploy key for ${repo}: ${result.stderr.trim().split("\n").pop()}`,
      key.role === "write" ? `if you cannot administer ${repo}, clone it with --no-push; if you cannot add any key, with --anonymous` : `if you cannot add a key to ${repo} and it is public, clone it with --anonymous`);
  } finally {
    fs.rmSync(file, { force: true });
  }
  return "registered";
};

export const clone = async (name: string | undefined, options: { push: boolean; anonymous: boolean }, out: Out, json: boolean) => {
  const repo = repoId(repoArg(name));
  const prepared = await rootctl<{ pushable: boolean; anonymous: boolean; keys: Key[] }>("repo.prepare", { repo, push: options.push, anonymous: options.anonymous });
  for (const key of prepared.keys) {
    const how = await register(repo, key);
    if (!json) out(`  ${key.role} key: ${how}${key.role === "write" ? " (it asks you before every push)" : ""}`);
  }
  const fetched = await rootctl<Record<string, unknown>>("repo.fetch", { repo });
  if (json) return out(JSON.stringify({ ...prepared, keys: prepared.keys.map((k) => k.role), ...fetched }));
  out(`cloned ${repo}: ${fetched.branches} branch(es), default ${fetched.defaultBranch ?? "none"}, ${fetched.lfsObjects} LFS object(s); ${prepared.pushable ? "pushable" : prepared.anonymous ? "read-only, fetched anonymously" : "read-only (no write key)"}.`);
  out(`next: desolate domain create <slug> && desolate domain <slug> add --repo ${repo}`);
};

export const fetch = async (name: string | undefined, out: Out, json: boolean) => {
  const repo = repoId(repoArg(name));
  const fetched = await rootctl<Record<string, unknown>>("repo.fetch", { repo });
  out(json ? JSON.stringify(fetched) : `fetched ${repo}: ${fetched.branches} branch(es), ${fetched.lfsObjects} LFS object(s) in the mirror.`);
};

export const repos = async (out: Out, json: boolean) => {
  const list = await rootctl<{ repo: string; pushable: boolean; anonymous: boolean; defaultBranch: string | null; fetchedAt: string | null }[]>("repo.list", {}, { quiet: true });
  if (json) return out(JSON.stringify(list));
  if (list.length === 0) return out("no repositories yet. Start with: desolate clone <owner>/<repo>");
  for (const r of list) out(`${r.repo}  ${r.pushable ? "pushable" : r.anonymous ? "read-only (anonymous)" : "read-only"}  default ${r.defaultBranch ?? "?"}  fetched ${r.fetchedAt ?? "never"}`);
};
