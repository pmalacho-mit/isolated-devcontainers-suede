// A root clone's push address for `origin` is `desolate-push::<owner>/<repo>`, and git runs
// this for it. So a raw `git push origin <branch>` in the root's terminal works, and still
// goes through the person (P2):
//
//   1. git tells this helper which commit goes to which branch. Nothing has been sent, and
//      no connection to the remote exists yet.
//   2. If no approval for exactly that is on file, this asks the keyring for a challenge,
//      leaves it where the host can read it, and waits. The person runs `desolate approve`
//      in a terminal ON THE HOST. Nothing in this VM can answer.
//   3. Then the push goes to the remote: LFS objects first, then the commit (send.ts).
//
// Why a helper and not the pre-push hook: git connects to the remote, which takes the write
// key's signature, BEFORE it runs pre-push. A hook can refuse a push; it cannot be where
// the approval is asked for.
import * as readline from "node:readline";
import { isBranch, parseRepo, repoId } from "../shared/names.ts";
import { run } from "../shared/run.ts";
import { git as gitIn } from "./git.ts";
import { mirrorPath } from "./layout.ts";
import { pushCommit } from "./raw-push.ts";

const fail = (message: string): never => {
  process.stderr.write(`git-remote-desolate-push: ${message}\n`);
  process.exit(1);
};
const repo = parseRepo(process.argv[3]) ?? fail(`'${process.argv[3]}' is not a repository`);
const name = repoId(repo);
const here = (args: string[]) => run("git", args, { env: process.env, timeoutMs: 600_000 });
if ((await here(["config", "--get", "desolate.repo"])).stdout.trim() !== name) fail(`this is not the root's clone of ${name}`);

/** What the remote has, as the mirror last saw it: local, and needing no key. If it is
 *  stale the remote says so when the push arrives. */
const remoteRefs = async () => (await gitIn(mirrorPath(repo), ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"])).stdout.split("\n").filter(Boolean);

const pushOne = async (spec: string): Promise<string> => {
  const forced = spec.startsWith("+");
  const [source, target] = spec.replace(/^\+/, "").split(":");
  const branch = (target ?? "").replace(/^refs\/heads\//, "");
  if (!target?.startsWith("refs/heads/") || !isBranch(branch)) return `error ${target} desolate pushes branches`;
  if (!source) return `error ${target} deleting a branch on the remote is not something desolate does: delete it on the forge`;
  const commit = (await here(["rev-parse", "--verify", "--quiet", `${source}^{commit}`])).stdout.trim();
  if (!commit) return `error ${target} no such commit`;
  const failed = await pushCommit(repo, commit, branch, forced, "a raw git push from the root's terminal", (line) => process.stderr.write(`${line}\n`));
  return failed ? `error ${target} ${failed.replace(/\n/g, " ")}` : `ok ${target}`;
};

const input = readline.createInterface({ input: process.stdin, terminal: false });
const say = (text: string) => process.stdout.write(text);
let batch: string[] = [];
for await (const line of input) {
  if (line === "capabilities") say("push\n\n");
  else if (line === "list for-push" || line === "list") say([...(await remoteRefs()), ""].join("\n") + "\n");
  else if (line.startsWith("push ")) batch.push(line.slice(5));
  else if (line === "") {
    if (batch.length === 0) break;
    for (const spec of batch) say((await pushOne(spec)) + "\n");
    say("\n");
    batch = [];
  } else fail(`unknown command from git: ${line}`);
}
