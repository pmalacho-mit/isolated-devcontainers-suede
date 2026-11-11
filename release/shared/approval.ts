// What a person approves when they approve a push (P2, section 5.3): one text, made by the
// keyring in the root VM, shown and signed by the approver ON THE HOST, checked by the
// keyring again. Both ends parse it with this file, and a text that does not survive
// parse -> format unchanged is not an approval.
//
// The nonce is the keyring's: it makes each approval a single use of a challenge the
// keyring itself issued, so a signature seen once approves nothing later.
import { isBranch, isCommit, parseRepo, repoId } from "./names.ts";

export type PushApproval = { repo: string; branch: string; commit: string; nonce: string };

const HEAD = "desolate push approval v1";
const NONCE = /^[0-9a-f]{32}$/;

export const formatApproval = (a: PushApproval): string => [HEAD, `repo: ${a.repo}`, `branch: ${a.branch}`, `commit: ${a.commit}`, `nonce: ${a.nonce}`, ""].join("\n");

export const parseApproval = (text: unknown): PushApproval | null => {
  if (typeof text !== "string" || text.length > 1024) return null;
  const lines = text.split("\n");
  if (lines.length !== 6 || lines[0] !== HEAD || lines[5] !== "") return null;
  const field = (line: string | undefined, name: string) => (line?.startsWith(`${name}: `) ? line.slice(name.length + 2) : null);
  const repo = parseRepo(field(lines[1], "repo"));
  const branch = field(lines[2], "branch");
  const commit = field(lines[3], "commit");
  const nonce = field(lines[4], "nonce");
  if (!repo || !isBranch(branch) || !isCommit(commit) || nonce === null || !NONCE.test(nonce)) return null;
  const parsed = { repo: repoId(repo), branch, commit, nonce };
  return formatApproval(parsed) === text ? parsed : null;
};
