// Raw pushes in the root's terminal that wait for a person (root/approver.ts writes one file
// each): read by the dashboard (stated.ts) and by the host's approval page (ops.ts,
// approvals.pending). One rule for both: each file on its own, so one that is malformed, too
// large or not a file hides none of the others; at most two minutes old.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseApproval } from "../shared/approval.ts";
import type { PushApproval } from "../shared/approval.ts";

export const APPROVAL_TTL_MS = 120_000;
const FILE_MOST = 16 * 1024;

export type Pending = { message: string; summary: string; at: string; approval: PushApproval; file: string };

/** The approvals waiting in `dir`, oldest name first. With `prune`, what is not one (or has
 *  expired) is removed. */
export const pendingIn = (dir: string, now = Date.now(), prune = false): Pending[] => {
  const out: Pending[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let entry: { message?: unknown; summary?: unknown; at?: unknown } | null = null;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && stat.size <= FILE_MOST) entry = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      entry = null;
    }
    const approval = entry && typeof entry === "object" ? parseApproval(entry.message) : null;
    const at = typeof entry?.at === "string" ? entry.at : "";
    const age = now - Date.parse(at);
    if (!approval || !(age >= -5_000 && age < APPROVAL_TTL_MS)) {
      if (prune)
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* a directory, say: not this reader's to remove */
        }
      continue;
    }
    out.push({ message: String(entry!.message), summary: String(entry!.summary ?? "").slice(0, 200), at, approval, file });
  }
  return out;
};
