// `desolate domain ...`: create, add, show.
import { EXIT, refuse } from "../shared/exit.ts";
import { rootctl } from "./stack.ts";

type Out = (line: string) => void;

export const domainCommand = async (args: string[], values: Record<string, unknown>, out: Out) => {
  const json = values.json === true;
  const [first, second] = args;
  if (first === "create") {
    if (!second) refuse("a domain needs a name", "desolate domain create <slug> [--title \"...\"]", EXIT.usage);
    const made = await rootctl<{ slug: string; title: string }>("domain.create", { slug: second, title: values.title }, { quiet: true });
    return out(json ? JSON.stringify(made) : `created the domain ${made.slug} ("${made.title}").\nnext: desolate domain ${made.slug} add --repo <owner>/<repo>`);
  }
  if (!first) refuse("which domain?", "desolate domain create <slug> | desolate domain <slug> add --repo <owner>/<repo> | desolate domain <slug> show", EXIT.usage);
  if (second === "add") {
    if (typeof values.repo === "string") {
      const added = await rootctl<{ repo: string; added: boolean; note: string }>("domain.add-repo", { slug: first, repo: values.repo }, { quiet: true });
      if (json) return out(JSON.stringify(added));
      out(added.added ? `${added.repo} is now in the domain ${first}: every workspace in it gets a checkout, borrowing the mirror's objects.` : `${added.repo} was already in the domain ${first}.`);
      if (added.note) out(`note: ${added.note}`);
      return out(`next: desolate up ${first}`);
    }
    refuse("add what?", `desolate domain ${first} add --repo <owner>/<repo>`, EXIT.usage);
  }
  if (second === "show" || second === undefined) {
    const d = await rootctl<{ slug: string; title: string; repos: string[]; workspaces: { workspace: string; state: string }[] }>("domain.show", { slug: first }, { quiet: true });
    if (json) return out(JSON.stringify(d));
    out(`${d.slug}  "${d.title}"`);
    out(`  repositories: ${d.repos.join(", ") || "none"}`);
    return out(`  workspaces: ${d.workspaces.map((w) => `${w.workspace} (${w.state})`).join(", ") || "none"}`);
  }
  refuse(`'desolate domain ${first} ${second}' is not a command`, `desolate domain ${first} add --repo <owner>/<repo> | desolate domain ${first} show`, EXIT.usage);
};
