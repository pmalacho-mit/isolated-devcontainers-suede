// git's remote helper for a domain (section 6.5). In a root clone each domain is a remote,
// `desolate::<domain>`, so ordinary git works in the root's terminal and editor:
//
//   git fetch <domain>            that domain's branches arrive as <domain>/*
//   git fetch --all               every domain, and the mirror
//   git push <domain> <branch>    a delivery to that domain (a local transfer, not a push
//                                 to any remote): a bundle in its inbox, imported there as
//                                 root/<branch>
//
// NOTHING HERE RUNS GIT IN A DOMAIN'S REPOSITORY (P4). Fetch reads the bundles and the list of
// refs the domain's own VM wrote to its outbox; git's local transport, which would run
// upload-pack inside the domain's clone under the domain's config, is never used.
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { writeJson } from "../shared/json.ts";
import { isBranch, isSlug, parseRepo } from "../shared/names.ts";
import { run } from "../shared/run.ts";
import { domain as domainOf } from "./domains.ts";
import { inbox, listedRefs, pendingBundles } from "./outbox.ts";

const slug = process.argv[3] ?? "";
const fail = (message: string): never => {
  process.stderr.write(`git-remote-desolate: ${message}\n`);
  process.exit(1);
};
if (!isSlug(slug)) fail(`'${slug}' is not a domain`);
const git = (args: string[]) => run("git", args, { env: process.env, timeoutMs: 600_000 });
const repo = (await git(["config", "--get", "desolate.repo"])).stdout.trim();
if (!parseRepo(repo)) fail("this is not one of the root's clones (no desolate.repo in its config)");
if (!domainOf(slug).repos.includes(repo)) fail(`${repo} is not in the domain '${slug}'`);

/** Bring the domain's waiting bundles into this root clone, then drop them. */
const importBundles = async () => {
  for (const bundle of pendingBundles(slug, repo)) {
    // Objects are checked as they are indexed; refs land under a scratch namespace that is
    // deleted below. What becomes <domain>/* is decided by git, from `list`.
    const fetched = await git(["-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", bundle, `+refs/heads/*:refs/desolate/incoming/${slug}/*`]);
    if (fetched.code !== 0) process.stderr.write(`git-remote-desolate: a bundle from ${slug} did not import and was dropped: ${fetched.stderr.trim().split("\n").pop()}\n`);
    fs.rmSync(bundle, { force: true });
  }
  const scratch = (await git(["for-each-ref", "--format=%(refname)", `refs/desolate/incoming/${slug}/`])).stdout.split("\n").filter(Boolean);
  for (const ref of scratch) await git(["update-ref", "-d", ref]);
};

const list = async () => {
  const lines: string[] = [];
  for (const [branch, commit] of Object.entries(listedRefs(slug, repo))) {
    // The last word on a ref name is git's own.
    if ((await git(["check-ref-format", `refs/heads/${branch}`])).code !== 0) continue;
    lines.push(`${commit} refs/heads/${branch}`);
  }
  return lines;
};

const deliver = async (source: string, branch: string): Promise<string> => {
  if (!isBranch(branch)) return "error refs/heads/" + branch + " not a branch name desolate will carry";
  const commit = (await git(["rev-parse", "--verify", "--quiet", `${source}^{commit}`])).stdout.trim();
  if (!commit) return `error refs/heads/${branch} no such commit`;
  const dir = path.join(inbox(slug), "deliveries", repo);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now().toString(36)}-${process.pid}`;
  // The domain borrows the mirror too, so what the mirror has need not travel. A scratch
  // branch gives the bundle a ref to carry; the domain reads the commit from the note.
  const scratch = `refs/heads/desolate-deliver-${id}`;
  await git(["update-ref", scratch, commit]);
  const made = await git(["bundle", "create", "--quiet", path.join(dir, `${id}.bundle.tmp`), scratch, "--not", "--remotes=origin"]);
  await git(["update-ref", "-d", scratch]);
  const empty = made.code !== 0 && /empty bundle/i.test(made.stderr);
  if (made.code !== 0 && !empty) return `error refs/heads/${branch} ${made.stderr.trim().split("\n").pop()}`;
  if (!empty) fs.renameSync(path.join(dir, `${id}.bundle.tmp`), path.join(dir, `${id}.bundle`));
  else fs.rmSync(path.join(dir, `${id}.bundle.tmp`), { force: true });
  // With no bundle, the commit is one the mirror already has: the note alone delivers it.
  writeJson(path.join(dir, `${id}.json`), { branch, commit, bundle: !empty, at: new Date().toISOString() });
  return `ok refs/heads/${branch}`;
};

const input = readline.createInterface({ input: process.stdin, terminal: false });
const say = (text: string) => process.stdout.write(text);
let batch: string[] = [];
for await (const line of input) {
  if (line === "capabilities") say("fetch\npush\n\n");
  else if (line === "list" || line === "list for-push") {
    if (line === "list") await importBundles();
    say([...(await list()), ""].join("\n") + "\n");
  } else if (line.startsWith("fetch ") || line.startsWith("push ")) batch.push(line);
  else if (line === "") {
    if (batch.length === 0) break;
    if (batch[0]!.startsWith("fetch ")) {
      await importBundles();
      say("\n");
    } else {
      for (const item of batch) {
        const spec = item.slice(5).replace(/^\+/, "");
        const [source, target] = spec.split(":");
        const branch = (target ?? "").replace(/^refs\/heads\//, "");
        if (!source) say(`error ${target} deleting a branch in a domain is the domain's to do\n`);
        else say((await deliver(source, branch)) + "\n");
      }
      say("\n");
    }
    batch = [];
  } else fail(`unknown command from git: ${line}`);
}
