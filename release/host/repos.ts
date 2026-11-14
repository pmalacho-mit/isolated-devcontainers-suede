// clone, fetch, repos, keys: the host's part. The root makes keys and fetches; the host only
// registers the public halves with the forge, using the person's own credentials there.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXIT, refuse } from "../shared/exit.ts";
import { domainNamesFor, isSlug, parseRepo, repoId } from "../shared/names.ts";
import { run } from "../shared/run.ts";
import { INSTANCE } from "./paths.ts";
import { config, ensureProxyUser, rootctl } from "./stack.ts";

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
    // The title is seen by everyone who administers the repository. A Mac's hostname is
    // often its owner's name ("Someones-MacBook-Pro"), so the host is named by a hash of it:
    // enough to tell two machines' keys apart, nothing about who owns them.
    const host = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 8);
    const args = ["repo", "deploy-key", "add", file, "--repo", repo, "--title", `desolate ${key.role} (host ${host}, ${INSTANCE})`];
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

/** The domain a clone lands in: the one named (made if it is new), or one named after the
 *  repository, made for it. A domain that already holds the repository is reused, so a
 *  second clone changes nothing. */
const domainFor = async (repo: string, named: string | undefined): Promise<{ slug: string; made: boolean; added: boolean } | { taken: string[] }> => {
  const existing = await rootctl<{ slug: string; repos: string[] }[]>("domain.list", {}, { quiet: true });
  const holding = (slug: string) => existing.find((d) => d.slug === slug);
  const join = async (slug: string) => {
    const there = holding(slug);
    if (there?.repos.includes(repo)) return { slug, made: false, added: false };
    if (!there) {
      await rootctl("domain.create", { slug, title: repo }, { quiet: true });
      await ensureProxyUser(slug);
    }
    await rootctl("domain.add-repo", { slug, repo }, { quiet: true });
    return { slug, made: !there, added: true };
  };
  if (named !== undefined) return join(named);
  // Already in a domain of its own name (a second clone): nothing to do.
  const candidates = domainNamesFor(repoArg(repo));
  for (const slug of candidates) if (holding(slug)?.repos.includes(repo)) return { slug, made: false, added: false };
  for (const slug of candidates) if (!holding(slug)) return join(slug);
  return { taken: candidates };
};

export const clone = async (name: string | undefined, options: { push: boolean; anonymous: boolean; domain?: string | false }, out: Out, json: boolean) => {
  const repo = repoId(repoArg(name));
  if (typeof options.domain === "string" && !isSlug(options.domain))
    refuse(`'${options.domain}' is not a domain name`, "a domain name is a slug: lowercase letters, digits and single dashes, at most 40", EXIT.usage);
  const prepared = await rootctl<{ pushable: boolean; anonymous: boolean; keys: Key[] }>("repo.prepare", { repo, push: options.push, anonymous: options.anonymous });
  for (const key of prepared.keys) {
    const how = await register(repo, key);
    if (!json) out(`  ${key.role} key: ${how}${key.role === "write" ? " (it asks you before every push)" : ""}`);
  }
  const fetched = await rootctl<Record<string, unknown>>("repo.fetch", { repo });
  const placed = options.domain === false ? null : await domainFor(repo, options.domain);
  const domain = placed && "slug" in placed ? placed : null;
  if (json) return out(JSON.stringify({ ...prepared, keys: prepared.keys.map((k) => k.role), ...fetched, domain: domain?.slug ?? null }));
  out(`cloned ${repo}: ${fetched.branches} branch(es), default ${fetched.defaultBranch ?? "none"}, ${fetched.lfsObjects} LFS object(s); ${prepared.pushable ? "pushable" : prepared.anonymous ? "read-only, fetched anonymously" : "read-only (no write key)"}.`);
  if (domain) {
    out(domain.made ? `domain ${domain.slug}: made for ${repo}.` : domain.added ? `domain ${domain.slug}: ${repo} added.` : `domain ${domain.slug}: already holds ${repo}.`);
    return out(`next: desolate up ${domain.slug}   (or: desolate task ${domain.slug} "<what to do>")`);
  }
  if (placed && "taken" in placed) out(`no domain was made: ${placed.taken.join(" and ")} are domains already, holding other repositories.`);
  out(`next: desolate domain create <slug> --repo ${repo}   (or, to a domain you have: desolate domain <slug> add --repo ${repo}; or clone again with --domain <slug>)`);
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

/** The keys the root holds, and a key's public half, for adding it to a forge by hand. */
export const keys = async (name: string | undefined, out: Out, json: boolean) => {
  const held = await rootctl<{ repo: string; role: string }[]>("keys.list", {}, { quiet: true });
  if (!name) {
    if (json) return out(JSON.stringify(held));
    if (held.length === 0) return out("the root holds no keys yet. `desolate clone <owner>/<repo>` makes a repository's.");
    for (const key of held) out(`${key.repo}  ${key.role}${key.role === "write" ? "  (asks you before every push)" : ""}`);
    return out("a key's public half: desolate keys <owner>/<repo>");
  }
  const repo = repoId(repoArg(name));
  const mine = held.filter((key) => key.repo === repo);
  if (mine.length === 0) refuse(`the root holds no key for ${repo}`, `desolate clone ${repo}`);
  const shown: { role: string; pubkey: string }[] = [];
  for (const key of mine) shown.push({ role: key.role, pubkey: (await rootctl<{ pubkey: string }>("keys.pubkey", { repo, role: key.role }, { quiet: true })).pubkey });
  if (json) return out(JSON.stringify(shown));
  for (const key of shown) out(`${repo}  ${key.role} key (a deploy key${key.role === "write" ? " with write access" : ", read-only"}):\n  ${key.pubkey}`);
  out("Only public halves are ever shown: the private halves do not leave the root's keyring.");
};
