// `desolate status` and `desolate board`: how each checkout says its work is going
// (section 5.1). The status is a small JSON file in the domain clone's git directory, written
// from inside a workspace by /desolate/status. The host reads those files as data and never
// runs git there (P4). What they say is shown, never acted on.
import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT, refuse } from "../shared/exit.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { paths } from "./paths.ts";
import { rootctl } from "./stack.ts";

type Out = (line: string) => void;
type Status = { color: string; message: string; updated: string };
const COLORS = ["gray", "blue", "green", "yellow", "orange", "red"];

/** A status file is written by a workspace, which may be hostile: a known colour, one line
 *  of printable text, a bounded size, and no symlink followed. */
const read = (file: string): Status | null => {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 8192) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Status>;
    if (!COLORS.includes(String(data.color))) return null;
    return { color: String(data.color), message: String(data.message ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 200), updated: String(data.updated ?? "").slice(0, 40) };
  } catch {
    return null;
  }
};
const note = (file: string): string => {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return "";
    return fs.readFileSync(file, "utf8").slice(0, 16384).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ").trimEnd();
  } catch {
    return "";
  }
};
const gitDir = (domain: string, c: { repo: string; kind: string; name: string }) =>
  c.kind === "main" ? path.join(paths.domainRepos(domain), c.repo, ".git") : path.join(paths.domainRepos(domain), c.repo, ".git", "worktrees", c.name);

type View = { workspace: string; checkouts: { repo: string; branch: string; status: Status | null; note: string }[]; status: Status | null };
const viewOf = (w: WorkspacePlan): View => {
  const checkouts = w.checkouts.map((c) => ({ repo: c.repo, branch: c.branch, status: read(path.join(gitDir(w.domain, c), "desolate-status.json")), note: note(path.join(gitDir(w.domain, c), "desolate-note.md")) }));
  // A workspace's status is its most recently set one.
  const latest = checkouts.map((c) => c.status).filter((s): s is Status => s !== null).sort((a, b) => b.updated.localeCompare(a.updated))[0] ?? null;
  return { workspace: `${w.domain}/${w.workspace}`, checkouts, status: latest };
};

export const status = async (target: string | undefined, out: Out, json: boolean) => {
  const [domain, workspace] = (target ?? "").split("/");
  if (!domain) refuse("status of what?", "desolate status <domain>[/<workspace>] [--json]", EXIT.usage);
  const d = await rootctl<{ workspaces: WorkspacePlan[] }>("domain.show", { slug: domain }, { quiet: true });
  const views = d.workspaces.filter((w) => !workspace || w.workspace === workspace).map(viewOf);
  if (workspace && views.length === 0) refuse(`there is no workspace '${target}'`, `desolate list ${domain}`);
  if (json) return out(JSON.stringify(workspace ? views[0] : views));
  for (const view of views) {
    out(`${view.workspace}  ${view.status ? `[${view.status.color}] ${view.status.message}` : "(no status)"}`);
    for (const c of view.checkouts) {
      out(`  ${c.repo}@${c.branch}  ${c.status ? `[${c.status.color}] ${c.status.message}  (${c.status.updated})` : "(no status)"}`);
      if (c.note) for (const line of c.note.split("\n")) out(`    | ${line}`);
    }
  }
};
