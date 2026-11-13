// `desolate factory suede`: when a project's default branch is pushed (through desolate: the
// pusher says so), every suede dependency vendored in it that the push changed is handed to an
// agent, which decides whether the change belongs upstream and, if it does, prepares it as a
// branch of the dependency's own repository. You review that branch and push it; a pull
// request to the dependency follows. All of it on this Mac: nothing is asked of GitHub until
// your push.
//
//   desolate factory suede [--domain suede] [--secret CLAUDE-OAUTH] [-- <agent command...>]
//   desolate factory suede --commit <owner/repo>@<commit> [--from <commit>]   (one push, by hand)
//
// What changed is worked out without an agent: the root compares the pushed commit with the
// one before it, in its own clone, and lists each vendored dependency (a directory with a
// .gitrepo, the record suede's install and sync keep) whose files the push touched, with the
// repository and branch that .gitrepo names. A dependency whose repository desolate has not
// cloned (desolate clone <owner/repo>) is reported and skipped.
//
// For each, a workspace in the domain (made, and given both repositories, if need be): the
// dependency checked out on `upstream/<project>-<commit>`, the project on its default branch.
// The agent's task names the directory, the commits, and the dependency's layout (a suede
// dependency's release branch is its main branch's release/ directory), and asks it to decide.
// The push upstream is never the agent's: it offers the branch; you review and push it.
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { parseArgs } from "node:util";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "cli.sh");
const say = (line: string): void => void process.stdout.write(`${new Date().toLocaleTimeString()}  ${line}\n`);
const desolate = (args: string[]) => {
  const ran = spawnSync(CLI, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: ran.status ?? 1, out: ran.stdout ?? "", err: ran.stderr ?? "" };
};
const gh = (args: string[]) => {
  const ran = spawnSync("gh", args, { encoding: "utf8" });
  return { code: ran.status ?? 1, out: ran.stdout ?? "", err: ran.stderr ?? "" };
};

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { domain: { type: "string", default: "suede" }, secret: { type: "string", default: "CLAUDE-OAUTH" }, commit: { type: "string" }, from: { type: "string" } },
  allowPositionals: true,
});
const domain = String(values.domain);
type Repo = { repo: string; pushable: boolean; defaultBranch: string | null };
type Changed = { dir: string; remote: string | null; branch: string; files: string[] };

const repos = (): Repo[] => {
  try {
    return JSON.parse(desolate(["repos", "--json"]).out) as Repo[];
  } catch {
    return [];
  }
};

const task = (project: string, commit: string, onto: string | null, dep: Changed, depBranch: string) => [
  `The project ${project} has just pushed ${commit.slice(0, 12)} to its default branch${onto ? `, from ${onto.slice(0, 12)}` : ""}.`,
  `It changed the suede dependency vendored at ${dep.dir}/ (${dep.files.length} file(s)), which is ${dep.remote}'s ${dep.branch} branch.`,
  "",
  "Decide whether this change belongs upstream, in the dependency itself, or is the project's own (a local workaround, configuration only the project wants).",
  `You are in the dependency's checkout, on the branch ${depBranch}; the project's clone is /workspaces/${project}. First read /desolate/release/AGENTS.md.`,
  `The change: git -C /workspaces/${project} diff ${onto ?? `${commit}~1`} ${commit} -- ${dep.dir}`,
  `A suede dependency's ${dep.branch} branch is its main branch's release/ directory: the same change, upstream, goes under release/ on main.`,
  "",
  "If it belongs upstream: make it on your branch in the dependency's checkout (adapting it if the vendored copy is behind), run the dependency's own tests, commit with a message that says why, `desolate offer`, then `desolate status set green \"upstream: <one line>\"`.",
  "If it does not: change nothing and `desolate status set gray \"stays in the project: <why>\"`.",
  "If you cannot tell: `desolate status set orange \"<the question>\"`.",
].join("\n");

const agentCommand = (text: string) =>
  positionals.length > 0
    ? [...positionals, text]
    : ["env", "-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", `CLAUDE_CODE_OAUTH_TOKEN=${values.secret}`, "claude", "--permission-mode", "auto", text];

const handle = async (project: string, commit: string, onto: string | null) => {
  const asked = desolate(["suede", "changed", project, commit, ...(onto ? ["--from", onto] : []), "--json"]);
  if (asked.code !== 0) return say(`${project}: could not tell what the push changed: ${asked.err.trim().split("\n").pop()}`);
  const changed = (JSON.parse(asked.out) as Changed[]).filter((c) => c.files.length > 0);
  if (changed.length === 0) return say(`${project} ${commit.slice(0, 12)}: no vendored suede dependency changed`);
  const known = repos();
  for (const dep of changed) {
    if (!dep.remote || !known.some((r) => r.repo === dep.remote)) {
      say(`${project}: ${dep.dir} changed, but its repository (${dep.remote ?? "unknown"}) is not cloned in desolate: desolate clone ${dep.remote ?? "<owner/repo>"}`);
      continue;
    }
    const short = commit.slice(0, 8);
    const name = `up-${dep.remote.split("/")[1]!.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 20)}-${short}`.replace(/-+/g, "-");
    const branch = `upstream/${project.split("/")[1]}-${short}`;
    // The domain, with both repositories (made or given them on first use).
    if (desolate(["domain", domain, "show", "--json"]).code !== 0) desolate(["domain", "create", domain, "--title", "suede upstreaming"]);
    desolate(["domain", domain, "add", "--repo", project, "--repo", dep.remote]);
    // The project's commit is on the remote now: the mirror is brought up to it first.
    desolate(["fetch", project]);
    say(`${project}: ${dep.dir} changed: ${domain}/${name}, an agent deciding whether it goes to ${dep.remote}`);
    const up = await new Promise<number>((resolve) => spawn(CLI, ["up", domain, "--name", name, "--fetch", "--checkout", `${dep.remote}=worktree:${branch}`, "--checkout", `${project}=worktree:suede/${short}`], { stdio: "ignore" }).on("close", (code) => resolve(code ?? 1)));
    if (up !== 0) {
      say(`${domain}/${name}: did not start (desolate up said ${up})`);
      continue;
    }
    const started = desolate(["agent", "start", `${domain}/${name}`, "--name", "claude", "--checkout", dep.remote, "--", ...agentCommand(task(project, commit, onto, dep, branch))]);
    say(started.code === 0 ? `${domain}/${name}: working. Watch: desolate agent attach ${domain}/${name} --name claude` : `${domain}/${name}: the agent did not start: ${started.err.trim()}`);
  }
};

// ------------------------------------------------------------------ one commit, by hand
// `--commit <owner/repo>@<commit> [--from <commit>]`: the same, for a push already made.
if (values.commit) {
  const [project, commit] = String(values.commit).split("@");
  if (!project || !/^[0-9a-f]{40}$/.test(commit ?? "")) {
    process.stderr.write("desolate factory suede: --commit <owner/repo>@<full commit>\n");
    process.exit(64);
  }
  await handle(project, commit!, values.from ?? null);
  process.exit(0);
}

// ------------------------------------------------------------------ listening
const events = spawn(CLI, ["events"], { stdio: ["ignore", "pipe", "ignore"] });
let pending = "";
const queue: Promise<void>[] = [];
events.stdout.on("data", (chunk: Buffer) => {
  pending += chunk.toString("utf8");
  for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.source !== "pusher" || e.type !== "pushed") continue;
    const repo = String(e.repo);
    const known = repos().find((r) => r.repo === repo);
    // A project's default branch: the upstreaming question.
    if (known && known.defaultBranch === e.branch) queue.push(handle(repo, String(e.commit), typeof e.onto === "string" ? e.onto : null));
    // A dependency's upstream branch, pushed by you: its pull request.
    if (/^upstream\//.test(String(e.branch))) {
      const made = gh(["pr", "create", "--repo", repo, "--head", String(e.branch), "--title", `Upstream from ${String(e.branch).slice(9)}`, "--body", `Prepared in desolate from a project's vendored copy; pushed at ${String(e.commit)}.`]);
      say(made.code === 0 ? `${repo}: pull request ${made.out.trim()}` : `${repo}: pushed ${String(e.branch)}, but no pull request: ${made.err.trim().split("\n").pop()}`);
    }
  }
});
process.on("SIGINT", () => {
  events.kill();
  process.exit(130);
});
say(`listening for pushes to default branches (desolate events); agents work in the domain ${domain}`);
