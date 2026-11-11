// A root clone's push address for `origin` is `desolate-push::<owner>/<repo>`, and git runs
// this for it. So a raw `git push origin <branch>` in the root's terminal works, and still
// goes through the person (P2):
//
//   1. git tells this helper which commit goes to which branch. Nothing has been sent, and
//      no connection to the remote exists yet.
//   2. If no approval for exactly that is on file, this asks the keyring for a challenge,
//      leaves it where the host can read it, and waits. The person runs `desolate approve`
//      in a terminal ON THE HOST (Touch ID on a Mac). Nothing in this VM can answer.
//   3. Then the push goes to the remote: LFS objects first, then the commit (send.ts).
//
// Why a helper and not the pre-push hook: git connects to the remote, which takes the write
// key's signature, BEFORE it runs pre-push. A hook can refuse a push; it cannot be where
// the approval is asked for.
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { parseApproval } from "../shared/approval.ts";
import { isBranch, parseRepo, repoId } from "../shared/names.ts";
import { run } from "../shared/run.ts";
import { git as gitIn } from "./git.ts";
import { ask } from "./keyring-client.ts";
import { APPROVALS, KEYRING, mirrorPath } from "./layout.ts";
import { registry } from "./repos.ts";
import * as repos from "./repos.ts";
import { send } from "./send.ts";

const fail = (message: string): never => {
  process.stderr.write(`git-remote-desolate-push: ${message}\n`);
  process.exit(1);
};
const repo = parseRepo(process.argv[3]) ?? fail(`'${process.argv[3]}' is not a repository`);
const name = repoId(repo);
const here = (args: string[]) => run("git", args, { env: process.env, timeoutMs: 600_000 });
if ((await here(["config", "--get", "desolate.repo"])).stdout.trim() !== name) fail(`this is not the root's clone of ${name}`);
const WAIT_MS = Number(process.env.DESOLATE_APPROVAL_WAIT_MS) || 110_000;

/** What the remote has, as the mirror last saw it: local, and needing no key. If it is
 *  stale the remote says so when the push arrives. */
const remoteRefs = async () => (await gitIn(mirrorPath(repo), ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"])).stdout.split("\n").filter(Boolean);

const approvedId = async (push: Record<string, unknown>) => {
  const reply = await ask(KEYRING.control, { op: "approved", ...push });
  return reply.ok === true ? String(reply.id) : null;
};

const pushOne = async (spec: string): Promise<string> => {
  const forced = spec.startsWith("+");
  const [source, target] = spec.replace(/^\+/, "").split(":");
  const branch = (target ?? "").replace(/^refs\/heads\//, "");
  if (!target?.startsWith("refs/heads/") || !isBranch(branch)) return `error ${target} desolate pushes branches`;
  if (!source) return `error ${target} deleting a branch on the remote is not something desolate does: delete it on the forge`;
  const commit = (await here(["rev-parse", "--verify", "--quiet", `${source}^{commit}`])).stdout.trim();
  if (!commit) return `error ${target} no such commit`;
  if (registry().repos[name]?.defaultBranch === branch) return `error ${target} ${branch} is the default branch: push a branch; or, on the host: desolate push <domain> ${name} ${branch} --expect ${commit} --allow-default`;
  const push = { repo: name, ref: branch, commit };
  let approval = await approvedId(push);
  if (!approval) {
    const challenge = await ask(KEYRING.control, { op: "challenge", ...push });
    const nonce = parseApproval(challenge.message)?.nonce;
    if (challenge.ok !== true || !nonce) return `error ${target} ${String(challenge.error ?? "the keyring gave no challenge")}`;
    const request = path.join(APPROVALS, `${nonce}.json`);
    fs.writeFileSync(request, JSON.stringify({ message: challenge.message, summary: "a raw git push from the root's terminal", at: new Date().toISOString() }), { mode: 0o600 });
    process.stderr.write(`desolate: this push needs your approval, given on the host, outside this VM.\n  ${name}  ${branch}  ${commit}\n  In a terminal on the host, run:  desolate approve\n  waiting up to ${Math.round(WAIT_MS / 1000)} s ...\n`);
    try {
      for (const until = Date.now() + WAIT_MS; Date.now() < until && !approval; ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        approval = await approvedId(push);
      }
    } finally {
      fs.rmSync(request, { force: true });
    }
    if (!approval) return `error ${target} no person approved the push on the host, so nothing was pushed`;
  }
  try {
    // A forced update goes only if the remote's branch is still what the mirror last saw.
    const lease = forced ? ((await remoteRefs()).find((line) => line.endsWith(` refs/heads/${branch}`))?.split(" ")[0] ?? "") : undefined;
    const failed = await send(repo, branch, commit, { lease });
    if (failed) return `error ${target} ${failed.error.replace(/\n/g, " ")}`;
  } finally {
    await ask(KEYRING.control, { op: "revoke", id: approval }).catch(() => {});
  }
  await repos.fetch(repo).catch(() => {});
  return `ok ${target}`;
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
