// `desolate status` and `desolate board`: how each checkout says its work is going
// (section 5.1). The status is a small JSON file in the domain clone's git directory, written
// from inside a workspace by /desolate/status. The host reads those files as data and never
// runs git there (P4). What they say is shown, never acted on.
import { EXIT, refuse } from "../shared/exit.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { statusView } from "../shared/status.ts";
import type { StatusView as View } from "../shared/status.ts";
import { paths } from "./paths.ts";
import { rootctl } from "./stack.ts";

type Out = (line: string) => void;
const viewOf = (w: WorkspacePlan): View => statusView(paths.domainRepos(w.domain), w);

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
