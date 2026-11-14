// The push (section 6.4): root clone -> remote, approved by a person ON THE HOST, pinned to
// the commit they reviewed. The host's `desolate push` runs this twice:
//
//   node push.ts prepare <domain> <owner/repo> <branch> --expect <commit> [--allow-default]
//       every refusal that needs no person (not pushable, no --expect, the commit moved,
//       the default branch, nothing to send), then the keyring's challenge for exactly
//       this push. Prints one JSON object.
//   node push.ts run <same arguments> --message <base64> --signature <base64>
//       the challenge, signed by the host's approver. The keyring files the approval if
//       the signature verifies; then LFS objects go up, then the commit; then the approval
//       is revoked. The write key signs none of it without that approval.
//
// Nothing here can make the signature: the approver's key is not in this VM (P2).
import * as fs from "node:fs";
import * as path from "node:path";
import { parseApproval } from "../shared/approval.ts";
import { EXIT, Refusal, refuse } from "../shared/exit.ts";
import { isCommit, parseRepo } from "../shared/names.ts";
import { isDownstream } from "../shared/suede.ts";
import { ask } from "./keyring-client.ts";
import { KEYRING, ROOT } from "./layout.ts";
import { offersOf, review, withdraw } from "./offers.ts";
import { afterPush } from "./pushed.ts";
import * as repos from "./repos.ts";
import { remoteTip } from "./repos.ts";
import { submitForReview } from "./review-client.ts";
import { send } from "./send.ts";

const main = async () => {
  const [mode, ...args] = process.argv.slice(2);
  const valued = ["--expect", "--message", "--signature"];
  const positional = args.filter((arg, index) => !arg.startsWith("--") && !valued.includes(args[index - 1] ?? ""));
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const [domain, repoArg, branch] = positional;
  const expect = value("--expect");
  const allowDefault = args.includes("--allow-default");
  if ((mode !== "prepare" && mode !== "run") || !domain || !repoArg || !branch) refuse("push what?", "desolate push <domain> <owner/repo> <branch> --expect <commit>", EXIT.usage);
  const r = await review(domain!, repoArg, branch);
  const repo = parseRepo(r.repo)!;
  const again = `desolate review ${domain} ${r.repo} ${branch}`;
  if (!r.pushable) refuse(`${r.repo} is not pushable: the root holds no write key for it`, `it was cloned --no-push. To make it pushable: desolate clone ${r.repo}`);
  if (!isCommit(expect)) refuse("a push names the commit you reviewed", `${again}, then: desolate push ${domain} ${r.repo} ${branch} --expect ${r.commit}`, EXIT.usage);
  if (expect !== r.commit) refuse(`${branch} is at ${r.commit.slice(0, 12)}, not the ${expect!.slice(0, 12)} that was reviewed: it moved since`, `review it again (${again}), then push with --expect ${r.commit}`, EXIT.expectMismatch);
  if (r.isDefault && !allowDefault) refuse(`${branch} is ${r.repo}'s default branch`, "push a branch and open a pull request; or, to push the default branch itself, add --allow-default", EXIT.defaultBranch);
  if (r.commits.length === 0) refuse(`${branch} has nothing the remote lacks`, again);
  // A suede proposal: its own workflows run on the remote when it lands (shared/suede.ts).
  if (isDownstream(branch!)) {
    const why = await repos.downstreamCheck(repo, r.commit);
    if (why) refuse(`${branch} is a suede proposal, and ${why}`, "change it in the workspace and offer it again");
  }

  if (mode === "prepare") {
    // What the person is shown at the prompt is the reviewer's account (host/push.ts): it is
    // sent the commit first, as a raw push sends it (raw-push.ts). Until this, a branch never
    // pushed raw was described as "the reviewer could not say" (found by T2 04).
    const unreviewed = await submitForReview(repo, r.commit);
    if (unreviewed) process.stderr.write(`desolate: the reviewer was not sent this push (${unreviewed}); the prompt will say it cannot describe it\n`);
    // What the remote's branch is now, as the mirror last saw it: the push moves it from
    // exactly this (pusher.ts). If the remote moved since, the push is refused, not forced.
    const reply = await ask(KEYRING.control, { op: "challenge", repo: r.repo, ref: branch, commit: r.commit, onto: await remoteTip(repo, branch!) });
    if (reply.ok !== true) refuse(String(reply.error ?? "the keyring gave no challenge"), "desolate doctor");
    const summary = `${r.commits.length} commit(s), ${r.stat || "no file changes"}${r.lfsObjects ? `, ${r.lfsObjects} LFS object(s)` : ""}`;
    process.stdout.write(JSON.stringify({ repo: r.repo, branch, commit: r.commit, summary, warnings: r.warnings, message: reply.message }) + "\n");
    return;
  }

  const message = Buffer.from(value("--message") ?? "", "base64").toString("utf8");
  const named = parseApproval(message);
  // The signature is over the keyring's text; this is the check that the text is about the
  // push this command is about to make.
  if (!named || named.repo !== r.repo || named.branch !== branch || named.commit !== r.commit) refuse("the approval is not for this push", `run it again: desolate push ${domain} ${r.repo} ${branch} --expect ${r.commit}`, EXIT.unconfirmed);

  const lock = path.join(ROOT.state, "push-locks", r.repo.replace("/", "--"));
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.mkdirSync(lock);
  } catch {
    if (Date.now() - fs.statSync(lock).mtimeMs < 300_000) refuse(`another push to ${r.repo} is in progress`, "try again in a moment", EXIT.busy);
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock);
  }
  let approval: string | null = null;
  try {
    const filed = await ask(KEYRING.control, { op: "approve", message, signature: value("--signature") ?? "" });
    if (filed.ok !== true) throw new Refusal(`the keyring did not accept the approval (${String(filed.error)}), so nothing was pushed`, "desolate doctor, then push again", EXIT.unconfirmed);
    approval = String(filed.id);
    const failed = await send(repo, approval, r.commit);
    if (failed) throw new Refusal(failed.error, failed.moved ? `the remote's ${branch} has moved: desolate fetch ${r.repo}, then rebase in the workspace and offer again` : "try the push again; desolate doctor");
  } finally {
    if (approval) await ask(KEYRING.control, { op: "revoke", id: approval }).catch(() => {});
    fs.rmSync(lock, { recursive: true, force: true });
  }
  const base = offersOf(domain!).find((o) => o.repo === r.repo && o.branch === branch)?.base ?? r.defaultBranch;
  const link = afterPush({ repo: r.repo, branch: branch!, commit: r.commit, base }, (line) => process.stderr.write(`${line}\n`));
  withdraw(domain!, r.repo, branch!);
  // What the remote now has, the mirror has: origin/* in every clone follows.
  await repos.fetch(repo).catch(() => {});
  process.stdout.write(`pushed ${r.repo} ${branch} at ${r.commit} (${r.commits.length} commit(s)${r.lfsObjects ? `, ${r.lfsObjects} LFS object(s) first` : ""}).\n`);
  if (link) process.stdout.write(`open a pull request into ${base}, in your browser, as yourself: ${link}\n`);
};

try {
  await main();
} catch (error) {
  if (error instanceof Refusal) {
    process.stderr.write(`desolate: ${error.message}\n${error.fix ? `  fix: ${error.fix}\n` : ""}`);
    process.exit(error.code);
  }
  process.stderr.write(`desolate: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
