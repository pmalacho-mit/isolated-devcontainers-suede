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
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { writeJson } from "../shared/json.ts";
import { isBranch, isSlug, parseRepo } from "../shared/names.ts";
import { run } from "../shared/run.ts";
import { domain as domainOf } from "./domains.ts";
import { clearRefusal, inbox, listedRefs, noteRefusal, takeBundles } from "./outbox.ts";

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

/** Check every object in a bundle BEFORE any of them enters this clone: index its pack,
 *  strictly, into a throwaway object directory that borrows this clone's objects.
 *
 *  `--strict` is git's own fsck, as fatal errors: a tree with ".git" in it (in any case, or
 *  in a form the Mac's or Windows' filesystem would fold to it), a .gitmodules that is a
 *  symlink or names an option or a path that climbs, a malformed or missing object.
 *
 *  Why not rely on fetch.fsckObjects: before git 2.46 a fetch FROM A BUNDLE checked nothing
 *  (measured on the image's 2.43: a tree containing ".git" was imported and offered). This
 *  does not depend on which git the image has. Returns why the bundle is refused, or null. */
const refusedBy = async (copy: string): Promise<string | null> => {
  // The header: a v2 bundle, which is what a workspace's git writes. v3 exists to carry
  // capabilities (another hash, a filter that leaves objects out); neither is taken.
  const head = Buffer.alloc(4 * 1024 * 1024);
  const fd = fs.openSync(copy, "r");
  const read = fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  const end = head.subarray(0, read).indexOf("\n\n");
  if (!head.subarray(0, 20).toString("latin1").startsWith("# v2 git bundle\n") || end < 0) return "it is not a bundle a workspace's git writes (v2)";
  const gitDir = (await git(["rev-parse", "--absolute-git-dir"])).stdout.trim();
  const quarantine = fs.mkdtempSync(path.join(path.dirname(copy), "check-"));
  fs.mkdirSync(path.join(quarantine, "pack"));
  try {
    const child = spawn("git", ["index-pack", "--strict", "--fix-thin", "--stdin"], {
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, GIT_OBJECT_DIRECTORY: quarantine, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(gitDir, "objects") },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    child.stdin.on("error", () => {});
    fs.createReadStream(copy, { start: end + 2 }).pipe(child.stdin);
    // A pack made to be slow is refused, not waited on.
    let late = false;
    const timer = setTimeout(() => { late = true; child.kill("SIGKILL"); }, CHECK_MS);
    const code = await new Promise<number>((resolve) => child.on("close", (status) => resolve(status ?? 1)));
    clearTimeout(timer);
    if (late) return `checking its objects took longer than ${CHECK_MS / 60_000} minutes`;
    if (code === 0) return null;
    // git names what it found ("error: object <id>: hasDotgit: contains '.git'") before its
    // last line ("fatal: fsck error in packed object"): the first is the one worth reading.
    const said = stderr.trim().split("\n");
    const why = said.find((line) => line.startsWith("error: ")) ?? said.pop() ?? "its objects did not pass git's checks";
    return why.replace(/^error: /, "").replace(/[^\x20-\x7e]/g, "?").slice(0, 300);
  } finally {
    fs.rmSync(quarantine, { recursive: true, force: true });
  }
};
const CHECK_MS = 8 * 60_000;

/** Bring the domain's waiting bundles into this root clone, then drop them. */
/** One branch with an object git calls dangerous takes its whole bundle with it, and a
 *  domain's bundle carries all its branches: until that branch is gone from the domain,
 *  nothing new from the domain is taken. Said here, recorded for the dashboard and
 *  `desolate offers`, and told to the workspace that offered. */
const refused = (why: string) => {
  noteRefusal(slug, repo, why);
  process.stderr.write(`git-remote-desolate: a bundle from ${slug} was refused and dropped: ${why.replace(/[^\x20-\x7e]/g, "?").slice(0, 300)}\n  Nothing new from ${slug} is taken while one of its branches holds what git refused: delete that branch in the workspace, then \`desolate sync\` there.\n`);
};

const importBundles = async () => {
  // One at a time: copy, check, fetch, delete. The root's disk holds one bundle of a
  // domain's at once, however many the domain left.
  let droppedInAll = 0;
  for (let round = 0, more = true; more && round < 1000; round++) {
    const taken = takeBundles(slug, repo, 1);
    more = taken.more;
    droppedInAll += taken.dropped;
    for (const copy of taken.copies) {
      // git is given a copy the root made (outbox.ts), never a path the domain controls,
      // and only after every object in it passed git's checks (refusedBy). Refs land under
      // a scratch namespace that is deleted below. What becomes <domain>/* is decided by
      // git, from `list`.
      const why = await refusedBy(copy);
      if (why === null) {
        const fetched = await git(["-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", copy, `+refs/heads/*:refs/desolate/incoming/${slug}/*`]);
        // What git says about a bundle is in part the bundle's author's text: shown as text.
        if (fetched.code !== 0) refused(`did not import: ${fetched.stderr.trim().split("\n").pop() ?? ""}`);
        else clearRefusal(slug, repo);
      } else refused(why);
      fs.rmSync(copy, { force: true });
    }
  }
  if (droppedInAll > 0) process.stderr.write(`git-remote-desolate: ${droppedInAll} file(s) in ${slug}'s outbox were not plain bundle files and were dropped\n`);
  const scratch = (await git(["for-each-ref", "--format=%(refname)", `refs/desolate/incoming/${slug}/`])).stdout.split("\n").filter(Boolean);
  for (const ref of scratch) await git(["update-ref", "-d", ref]);
};

const list = async () => {
  const lines: string[] = [];
  let missing = 0;
  for (const [branch, commit] of Object.entries(listedRefs(slug, repo))) {
    // The last word on a ref name is git's own.
    if ((await git(["check-ref-format", `refs/heads/${branch}`])).code !== 0) continue;
    // A branch whose objects the root does not hold (its bundle was refused, or has not
    // come) is not listed: one branch the root will not take does not hide the others.
    if ((await git(["cat-file", "-e", `${commit}^{commit}`])).code !== 0) {
      missing++;
      continue;
    }
    lines.push(`${commit} refs/heads/${branch}`);
  }
  // Everything the domain lists is here: whatever was refused before is no longer in it.
  if (missing === 0) clearRefusal(slug, repo);
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
