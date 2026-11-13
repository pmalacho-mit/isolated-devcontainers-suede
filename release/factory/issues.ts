// `desolate factory issues`: GitHub issues labelled for agents become workspaces with an agent
// working in each, in parallel; their branches come back to you to review and push, and a
// draft pull request follows the push.
//
//   desolate factory issues --repo <owner/repo> --domain <domain> [--label desolate:run]
//       [--max 3] [--interval 30] [--secret CLAUDE-OAUTH] [--once] [-- <agent command...>]
//
// Runs on your Mac, with YOUR gh. Per open issue with the label, until --max are working:
//   1. a workspace `issue-<n>` in the domain, its checkout of the repository on `issue/<n>`;
//   2. the agent in it, kept running (`desolate agent`): attach any time with
//      `desolate agent attach <domain>/issue-<n> --name claude` (your terminal's own
//      scrollback and copy; Ctrl-] detaches);
//   3. what the agent says (`desolate status`) shown here as it changes, from `desolate events`;
//   4. when you push `issue/<n>` (the git terminal, or the dashboard), a draft pull request
//      that closes the issue. Nothing an agent wrote is posted: the PR says which issue;
//   5. when the issue is closed, its agent stopped and its workspace removed (its branch stays).
//
// The default agent is Claude Code. Its credential never enters the workspace: you store your
// subscription token as a domain secret, once, and the workspace holds only its name:
//   claude setup-token            # on your Mac: prints a token
//   desolate domain <domain> secret set CLAUDE-OAUTH --hosts api.anthropic.com --headers authorization
// Any other agent: everything after `--` is the command, run with the task as its last word.
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { printable } from "../host/events.ts";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "cli.sh");
// Everything said here is made printable: issue text, gh's and the VM's errors, an agent's words.
const say = (line: string): void => void process.stdout.write(`${new Date().toLocaleTimeString()}  ${printable(line, 600)}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message: string, fix: string): never => {
  process.stderr.write(`desolate factory: ${message}\n  fix: ${fix}\n`);
  process.exit(1);
};

type Issue = { number: number; title: string; body: string; url: string };
type Row = { workspace: string; status: string; checkouts: { repo: string; head?: { branch: string | null } | null }[] };

const desolate = (args: string[], input?: string) => {
  const ran = spawnSync(CLI, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { code: ran.status ?? 1, out: ran.stdout ?? "", err: ran.stderr ?? "" };
};
const gh = (args: string[]) => {
  const ran = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: ran.status ?? 1, out: ran.stdout ?? "", err: ran.stderr ?? "" };
};

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    repo: { type: "string" }, domain: { type: "string" }, label: { type: "string", default: "desolate:run" },
    max: { type: "string", default: "3" }, interval: { type: "string", default: "30" },
    secret: { type: "string", default: "CLAUDE-OAUTH" }, once: { type: "boolean" },
  },
  allowPositionals: true,
});
const repo = values.repo ?? fail("which repository?", "--repo <owner/repo>");
const domain = values.domain ?? fail("which domain?", "--domain <domain> (it must have the repository: desolate domain create <d> --repo <owner/repo>)");
const max = Math.max(1, Number(values.max) || 3);
const interval = Math.max(5, Number(values.interval) || 30) * 1000;
const custom = positionals;

const task = (issue: Issue) => [
  `You are working on GitHub issue #${issue.number} of ${repo}: ${issue.title}`,
  "",
  issue.body.trim() || "(the issue has no description)",
  "",
  `Your branch, issue/${issue.number}, is checked out here. First read /desolate/release/AGENTS.md: this is a desolate workspace.`,
  "Work until it is done and seen to work. Commit as you go. When it is ready: `desolate offer`, then `desolate status set green \"ready: <one line>\"`.",
  "If you need a person (a decision, access, a secret): `desolate status set orange \"<the question>\"`, and wait.",
].join("\n");

/** The agent's command: Claude Code by default, on the domain's secret, in auto mode. */
const agentCommand = (issue: Issue) =>
  custom.length > 0
    ? [...custom, task(issue)]
    : ["env", "-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", `CLAUDE_CODE_OAUTH_TOKEN=${values.secret}`, "claude", "--permission-mode", "auto", task(issue)];

/** Claude Code in the workspace's environment, if it is not there yet (the project's
 *  devcontainer should carry it: ghcr.io/anthropics/devcontainer-features/claude-code). */
const ensureClaude = (where: string) => {
  if (custom.length > 0) return true;
  const has = desolate(["exec", where, "--checkout", repo, "--", "sh", "-c", "command -v claude"]);
  if (has.code === 0) return true;
  say(`${where}: installing Claude Code (add the claude-code devcontainer feature to skip this)`);
  return desolate(["exec", where, "--checkout", repo, "--", "sh", "-c", "npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || curl -fsSL https://claude.ai/install.sh | bash"]).code === 0;
};

const workspaces = (): Row[] => {
  const listed = desolate(["list", domain, "--json"]);
  try {
    return (JSON.parse(listed.out) as { workspaces: Row[] }[])[0]?.workspaces ?? [];
  } catch {
    return [];
  }
};
const agents = (): Map<string, string> => {
  const listed = desolate(["agent", "list", domain, "--json"]);
  try {
    return new Map((JSON.parse(listed.out) as { workspace: string; name: string; state: string }[]).filter((a) => a.name === "claude").map((a) => [a.workspace, a.state]));
  } catch {
    return new Map();
  }
};

// ------------------------------------------------------------------ what the stack says, as it happens
const statuses = new Map<string, string>();
const issueOf = (branch: unknown) => /^issue\/(\d+)$/.exec(String(branch))?.[1];
const titles = new Map<number, string>();
const events = spawn(CLI, ["events"], { stdio: ["ignore", "pipe", "ignore"] });
let pending = "";
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
    if (e.source === "root" && e.type === "status" && e.domain === domain && /^issue-\d+$/.test(String(e.workspace))) {
      const now = `${String(e.color)}: ${String(e.message)}`;
      if (statuses.get(String(e.workspace)) !== now) say(`${domain}/${String(e.workspace)} says ${now}${e.color === "green" ? "  (review it: desolate ui; push it from the git terminal)" : ""}`);
      statuses.set(String(e.workspace), now);
    }
    // Your push of an issue's branch: a draft pull request that closes the issue. Its text is
    // the issue's number, never the agent's words.
    if (e.source === "pusher" && e.type === "pushed" && e.repo === repo && issueOf(e.branch)) {
      const n = Number(issueOf(e.branch));
      const exists = gh(["pr", "list", "--repo", repo, "--head", String(e.branch), "--json", "url", "--jq", ".[0].url"]).out.trim();
      if (exists) {
        say(`issue #${n}: pushed; its pull request is ${exists}`);
        continue;
      }
      // The title is the issue's number, not its title: an issue's author can edit its text after
      // the label went on, and this is posted under your login.
      const made = gh(["pr", "create", "--repo", repo, "--draft", "--head", String(e.branch), "--title", `Issue #${n}`, "--body", `Closes #${n}. Pushed through desolate at ${String(e.commit)}.`]);
      say(made.code === 0 ? `issue #${n}: draft pull request ${made.out.trim()}` : `issue #${n}: pushed, but the pull request was not opened: ${made.err.trim().split("\n").pop()}`);
    }
  }
});
process.on("exit", () => events.kill());
process.on("SIGINT", () => process.exit(130));

// ------------------------------------------------------------------ the loop
const tick = async () => {
  const LIMIT = 200;
  const listed = gh(["issue", "list", "--repo", repo, "--label", String(values.label), "--state", "open", "--limit", String(LIMIT), "--json", "number,title,body,url"]);
  if (listed.code !== 0) return say(`gh could not list ${repo}'s issues: ${listed.err.trim().split("\n").pop()}`);
  const issues = JSON.parse(listed.out) as Issue[];
  for (const issue of issues) titles.set(issue.number, issue.title);
  const open = new Set(issues.map((i) => `issue-${i.number}`));
  const rows = workspaces();
  const running = agents();
  const working = [...running.values()].filter((state) => state === "running").length;

  // Closed: the agent stopped, the workspace removed (the branch stays in the domain).
  const removed = new Set<string>();
  // Only workspaces this factory made (their checkout of this repository on issue/<n>), and
  // only from a list that was whole: a list cut at its limit says nothing of the rest.
  const ours = (r: Row) => /^issue-\d+$/.test(r.workspace) && r.checkouts.some((c) => c.repo === repo && (c as { branch?: string }).branch === `issue/${r.workspace.slice(6)}`);
  for (const row of issues.length >= LIMIT ? [] : rows.filter((r) => ours(r) && !open.has(r.workspace))) {
    removed.add(`${domain}/${row.workspace}`);
    say(`${row.workspace}: its issue is closed; stopping its agent and removing the workspace (its branch stays)`);
    desolate(["agent", "stop", `${domain}/${row.workspace}`, "--name", "claude"]);
    desolate(["rm", `${domain}/${row.workspace}`]);
  }

  // New: up to --max at once, made side by side.
  const fresh = issues.filter((i) => !rows.some((r) => r.workspace === `issue-${i.number}`)).slice(0, Math.max(0, max - working));
  await Promise.all(fresh.map(async (issue) => {
    const where = `${domain}/issue-${issue.number}`;
    say(`issue #${issue.number}: ${issue.title}: starting ${where}`);
    const up = await new Promise<number>((resolve) => spawn(CLI, ["up", domain, "--name", `issue-${issue.number}`, "--checkout", `${repo}=worktree:issue/${issue.number}`], { stdio: "ignore" }).on("close", (code) => resolve(code ?? 1)));
    if (up !== 0) return say(`${where}: did not start (desolate up said ${up}); it is tried again next round`);
    if (!ensureClaude(where)) return say(`${where}: Claude Code could not be installed in it`);
    const started = desolate(["agent", "start", where, "--name", "claude", "--checkout", repo, "--", ...agentCommand(issue)]);
    say(started.code === 0 ? `${where}: agent working. Watch it: desolate agent attach ${where} --name claude` : `${where}: the agent did not start: ${started.err.trim()}`);
  }));

  // Ended agents, and workspaces stopped by hand, are left for you: said once.
  for (const [where, state] of running) if (state !== "running" && !removed.has(where) && !statuses.has(`${where}:ended`)) {
    statuses.set(`${where}:ended`, state);
    say(`${where}: its agent ${state === "exited" ? "has ended" : "is gone"}. desolate agent log ${where} --name claude; or start it again`);
  }
};

say(`watching ${repo}'s open issues labelled ${values.label}; at most ${max} agents at once, in the domain ${domain}`);
for (;;) {
  await tick();
  if (values.once) break;
  await sleep(interval);
}
events.kill();
