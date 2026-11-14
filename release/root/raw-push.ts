// One push a person asked for with git itself, not with `desolate push`: a raw `git push
// origin` in the root's terminal (git-remote-desolate-push.ts), or a `git push` in the git
// VM, which the host hands to the root (ops.ts, `git.push`). Both end here, and both wait
// for the person's approval on the host (the approval page, or `desolate approve`).
//
// The commit is in the root clone by now. What goes out is decided by the approval
// (pusher.ts); what the person is shown is the reviewer's (reviewer.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import { parseApproval } from "../shared/approval.ts";
import { isBranch, repoId } from "../shared/names.ts";
import { isDownstream } from "../shared/suede.ts";
import type { Repo } from "../shared/names.ts";
import { git } from "./git.ts";
import { ask } from "./keyring-client.ts";
import { APPROVALS, clonePath, KEYRING } from "./layout.ts";
import { allOffers } from "./offers.ts";
import { afterPush } from "./pushed.ts";
import * as repos from "./repos.ts";
import { submitForReview } from "./review-client.ts";
import { send } from "./send.ts";

export const WAIT_MS = Number(process.env.DESOLATE_APPROVAL_WAIT_MS) || 110_000;

const approvedId = async (push: Record<string, unknown>) => {
  const reply = await ask(KEYRING.control, { op: "approved", ...push });
  return reply.ok === true ? String(reply.id) : null;
};

/** Returns null when pushed, or why not (one line). `say` is for the person waiting. */
export const pushCommit = async (repo: Repo, commit: string, branch: string, forced: boolean, from: string, say: (line: string) => void): Promise<string | null> => {
  const name = repoId(repo);
  const clone = clonePath(repo);
  if (!isBranch(branch)) return "desolate pushes branches";
  if (repos.registry().repos[name]?.defaultBranch === branch) return `${branch} is the default branch: push a branch; or, on the host: desolate push <domain> ${name} ${branch} --expect ${commit} --allow-default`;
  if (!repos.recordOf(repo).pushable) return `${name} is not pushable: the root holds no write key for it`;
  // A suede proposal: its own workflows run on the remote when it lands (shared/suede.ts).
  if (isDownstream(branch)) {
    const why = await repos.downstreamCheck(repo, commit);
    if (why) return `${branch} is a suede proposal, and ${why}`;
  }
  // The approval names what the remote's branch is now, as the mirror last saw it: the push
  // moves it from exactly that, or not at all (pusher.ts). Like git, an update that does
  // not build on it needs a `+`; the person approving sees which it is.
  const onto = await repos.remoteTip(repo, branch);
  if (onto && !forced && (await git(clone, ["merge-base", "--is-ancestor", onto, commit])).code !== 0)
    return `the remote's ${branch} has commits this does not (non-fast-forward): fetch and rebase, or push with + to replace it`;
  const push = { repo: name, ref: branch, commit, onto };
  let approval = await approvedId(push);
  if (!approval) {
    // What the approval page shows of this push is the reviewer's (reviewer.ts): it gets the
    // objects first, before the challenge's two minutes start. A reviewer that cannot be
    // reached does not stop the push; the page says it could not say what the push is.
    const unreviewed = await submitForReview(repo, commit);
    if (unreviewed) say(`desolate: the reviewer was not sent this push (${unreviewed}); the approval page will say it cannot describe it`);
    const challenge = await ask(KEYRING.control, { op: "challenge", ...push });
    const nonce = parseApproval(challenge.message)?.nonce;
    if (challenge.ok !== true || !nonce) return String(challenge.error ?? "the keyring gave no challenge");
    const request = path.join(APPROVALS, `${nonce}.json`);
    // Whole or not at all: a half-written request read as broken would be thrown away, and
    // this push would take that for a refusal.
    fs.writeFileSync(`${request}.tmp`, JSON.stringify({ message: challenge.message, summary: from, at: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(`${request}.tmp`, request);
    say(`desolate: this push needs your approval, given on the host, outside every VM.\n  ${name}  ${branch}  ${commit}\n  On the host: the approval page (desolate approve --web prints it), or run  desolate approve\n  waiting up to ${Math.round(WAIT_MS / 1000)} s ...`);
    let refused = false;
    try {
      for (const until = Date.now() + WAIT_MS; Date.now() < until && !approval && !refused; ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        approval = await approvedId(push);
        // Refused on the page: the request is gone, and no approval came.
        refused = !approval && !fs.existsSync(request);
      }
    } finally {
      fs.rmSync(request, { force: true });
    }
    if (refused) return "refused on the host, so nothing was pushed";
    if (!approval) return "no person approved the push on the host, so nothing was pushed";
  }
  try {
    const failed = await send(repo, approval, commit);
    if (failed) return failed.error.replace(/\n/g, " ");
  } finally {
    await ask(KEYRING.control, { op: "revoke", id: approval }).catch(() => {});
  }
  // The base a pull request goes into: what an offer of this commit named, else the default.
  const base = allOffers().find((o) => o.repo === name && o.branch === branch && o.commit === commit)?.base ?? repos.registry().repos[name]?.defaultBranch ?? null;
  const link = afterPush({ repo: name, branch, commit, base }, say);
  await repos.fetch(repo).catch(() => {});
  if (link) say(`desolate: open a pull request into ${base}, in your browser, as yourself: ${link}`);
  return null;
};
