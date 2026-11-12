// In the git VM, a clone's push address for `origin` is `desolate-out::<owner>/<repo>`, and
// git runs this for it: `git push origin <branch>` works as it does anywhere, and still goes
// through the person on the host.
//
//   1. git says which commit goes to which branch.
//   2. This writes a bundle of that commit (what the mirror lacks of it), its new LFS
//      objects, and the request, into /desolate/out: the only place this VM writes that the
//      host reads.
//   3. The host hands it to the root, which checks every object (as it does a domain's),
//      and pushes it as a raw push is: after you approve it on the approval page.
//   4. The host leaves the answer here; this prints it.
//
// No key, no network, nothing of the root's to run: this VM can ask, and that is all.
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const OUT = "/desolate/out";
/** The host's answers: a directory this VM can read and not write. */
const ANSWERS = "/desolate/answers";
const WAIT_MS = 20 * 60_000;
const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/;
const repo = process.argv[3] ?? "";
const fail = (message: string): never => {
  process.stderr.write(`git-remote-desolate-out: ${message}\n`);
  process.exit(1);
};
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) fail(`'${repo}' is not a repository`);
const mirror = `/desolate/mirrors/${repo}.git`;
const git = (args: string[], input?: string) => spawnSync("git", args, { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
const gitDir = git(["rev-parse", "--absolute-git-dir"]).stdout.trim();

/** The remote's branches, as the mirror last saw them. */
const remoteRefs = () => git(["--git-dir", mirror, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"]).stdout.split("\n").filter(Boolean);

/** The LFS objects a commit's history adds to what the mirror has. */
const lfsOf = (commit: string, have: string[]) => {
  const ids = git(["rev-list", "--objects", commit, ...have.map((id) => `^${id}`)]).stdout.split("\n").map((line) => line.split(" ")[0]!).filter((id) => /^[0-9a-f]{40}$/.test(id));
  if (ids.length === 0) return [];
  const sizes = git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], ids.join("\n") + "\n").stdout;
  const oids = new Set<string>();
  for (const line of sizes.split("\n")) {
    const [id, type, size] = line.split(" ");
    if (type !== "blob" || Number(size) >= 400) continue;
    const match = POINTER.exec(git(["cat-file", "blob", id!]).stdout);
    if (match) oids.add(match[1]!);
  }
  return [...oids];
};

const pushOne = async (spec: string): Promise<string> => {
  const forced = spec.startsWith("+");
  const [source, target] = spec.replace(/^\+/, "").split(":");
  const branch = (target ?? "").replace(/^refs\/heads\//, "");
  if (!target?.startsWith("refs/heads/") || !branch) return `error ${target} desolate pushes branches`;
  if (!source) return `error ${target} deleting a branch on the remote is not something desolate does: delete it on the forge`;
  const commit = git(["rev-parse", "--verify", "--quiet", `${source}^{commit}`]).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) return `error ${target} no such commit`;
  const id = randomBytes(8).toString("hex");
  const ref = `refs/desolate/out/${id}`;
  const have = remoteRefs().map((line) => line.split(" ")[0]!).filter((tip) => git(["cat-file", "-e", `${tip}^{commit}`]).status === 0);
  try {
    git(["update-ref", ref, commit]);
    const bundle = path.join(OUT, `${id}.bundle`);
    let made = git(["bundle", "create", "--quiet", `${bundle}.part`, ref, ...have.map((tip) => `^${tip}`)]);
    // A commit the remote has already (a new branch at it): the bundle carries its history.
    if (made.status !== 0 && /empty bundle/i.test(made.stderr)) made = git(["bundle", "create", "--quiet", `${bundle}.part`, ref]);
    if (made.status !== 0) return `error ${target} could not bundle the commit: ${made.stderr.trim().split("\n").pop()}`;
    fs.renameSync(`${bundle}.part`, bundle);
    // LFS objects the mirror lacks, from this clone's store.
    const lfs: string[] = [];
    for (const oid of lfsOf(commit, have)) {
      const file = path.join(gitDir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
      if (!fs.existsSync(file)) continue;
      if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== oid) return `error ${target} the LFS object ${oid.slice(0, 12)} here does not hash to its name`;
      fs.copyFileSync(file, path.join(OUT, `${id}.${oid}.lfs`));
      lfs.push(oid);
    }
    const request = path.join(OUT, `${id}.json`);
    fs.writeFileSync(`${request}.part`, JSON.stringify({ repo, branch, commit, forced, lfs }));
    fs.renameSync(`${request}.part`, request);
    process.stderr.write(`desolate: handed to the root. Approve it on the approval page (on the Mac: desolate approve --web prints its address).\n  ${repo}  ${branch}  ${commit}\n`);
    const result = path.join(ANSWERS, `${id}.json`);
    for (const until = Date.now() + WAIT_MS; Date.now() < until; ) {
      if (fs.existsSync(result)) {
        const answer = JSON.parse(fs.readFileSync(result, "utf8")) as { pushed?: boolean; error?: string; said?: string[] };
        for (const line of answer.said ?? []) process.stderr.write(`${line}\n`);
        return answer.pushed ? `ok ${target}` : `error ${target} ${String(answer.error ?? "not pushed").replace(/\n/g, " ")}`;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return `error ${target} the host did not answer in ${WAIT_MS / 60_000} minutes; nothing is known to be pushed (git fetch origin shows)`;
  } finally {
    git(["update-ref", "-d", ref]);
  }
};

const input = readline.createInterface({ input: process.stdin, terminal: false });
const say = (text: string) => process.stdout.write(text);
let batch: string[] = [];
for await (const line of input) {
  if (line === "capabilities") say("push\n\n");
  else if (line === "list for-push" || line === "list") say([...remoteRefs(), ""].join("\n") + "\n");
  else if (line.startsWith("push ")) batch.push(line.slice(5));
  else if (line === "") {
    if (batch.length === 0) break;
    for (const spec of batch) say((await pushOne(spec)) + "\n");
    say("\n");
    batch = [];
  } else fail(`unknown command from git: ${line}`);
}
