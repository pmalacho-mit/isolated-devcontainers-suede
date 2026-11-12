// What a person approves when they approve a push (P2, section 5.3): one text, made by the
// keyring in the root VM, shown and signed by the approver ON THE HOST, checked by the
// keyring again. Both ends parse it with this file, and a text that does not survive
// parse -> format unchanged is not an approval.
//
// The nonce is the keyring's: it makes each approval a single use of a challenge the
// keyring itself issued, so a signature seen once approves nothing later.
import { isBranch, isCommit, parseRepo, repoId } from "./names.ts";

/** `onto`: what the remote's branch is now, as the root last saw it (`null`: the branch is
 *  new). The push is a compare-and-swap on the remote: the branch moves from exactly `onto`
 *  to exactly `commit`, or not at all (root/pusher.ts asks the remote for that, and nothing
 *  else). Whether `commit` builds on `onto` or replaces it is what the reviewer shows the
 *  person (root/reviewer.ts); either way it is this one change of this one branch. */
export type PushApproval = { repo: string; branch: string; commit: string; onto: string | null; nonce: string };

const HEAD = "desolate push approval v2";
const NONCE = /^[0-9a-f]{32}$/;

export const formatApproval = (a: PushApproval): string =>
  [HEAD, `repo: ${a.repo}`, `branch: ${a.branch}`, `commit: ${a.commit}`, `onto: ${a.onto ?? "none"}`, `nonce: ${a.nonce}`, ""].join("\n");

export const parseApproval = (text: unknown): PushApproval | null => {
  if (typeof text !== "string" || text.length > 1024) return null;
  const lines = text.split("\n");
  if (lines.length !== 7 || lines[0] !== HEAD || lines[6] !== "") return null;
  const field = (line: string | undefined, name: string) => (line?.startsWith(`${name}: `) ? line.slice(name.length + 2) : null);
  const repo = parseRepo(field(lines[1], "repo"));
  const branch = field(lines[2], "branch");
  const commit = field(lines[3], "commit");
  const onto = field(lines[4], "onto");
  const nonce = field(lines[5], "nonce");
  if (!repo || !isBranch(branch) || !isCommit(commit) || nonce === null || !NONCE.test(nonce)) return null;
  if (onto !== "none" && !isCommit(onto)) return null;
  // The protocol's "no such ref" is not a commit: a branch is new by `none`, and a push
  // never deletes.
  if (/^0{40}$/.test(commit) || onto === "0".repeat(40)) return null;
  const parsed: PushApproval = { repo: repoId(repo), branch, commit, onto: onto === "none" ? null : onto, nonce };
  return formatApproval(parsed) === text ? parsed : null;
};
