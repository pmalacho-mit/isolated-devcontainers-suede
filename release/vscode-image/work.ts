/**
 * work.ts -- the human's side of a project's factory (`cli.sh work`, or `work`
 * in the editor's terminal).
 *
 *   work init <project> [--max N] [--on-done push|hold] [--prefix p/] [--requesters a,b] [--allow-hooks]
 *   work policy <project>                      the policy, with the live counts beside it
 *   work log <project> [--target t] [--type t] every message, newest first
 *   work requests <project>                    each request and what became of it
 *   work verify <project>                      every ref an append by its named writer, or exit 1
 *   work approve <project> <request-id>        let the watcher act on a request policy refused
 *   work push <project> <worktree>             push its branch now, whatever on_done says
 *   work close <project> <worktree>            close it now (refused if it holds uncommitted work)
 *   work say <project> <type> <body> [--to t]  a message on the human's own outbox, as @human
 *   work github <project> enable <owner/repo> [--label l]   the github adapter, fed from the Mac
 *   work github <project> sync | status | pr <n> <url>       what release/forge.sh calls
 *   work github-projects                       every project with it: project, repo, label
 *
 * Runs in the editor, where git already runs, hardened as the watcher's is
 * (work-git.ts). What only a human may do -- enable a factory, approve, push
 * on `hold` -- is done here directly or written outside the repository
 * (work-policy.ts), never as a request an agent could have forged. What the
 * human did is said on their own outbox, `refs/desolate/agents/@human/outbox`.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { list as listTargets, target as resolveTarget, validName, worktreesOf } from "./projects.ts";
import { forgeStatus, githubItem, parseGithubSnapshot, recordPr, writeGithubSnapshot } from "./work-forge.ts";
import { isEntryPoint } from "./utils.ts";
import * as workGit from "./work-git.ts";
import {
  approvals,
  DEFAULT_POLICY,
  factoryFiles,
  handled,
  GITHUB_LABEL,
  GITHUB_REPO,
  parsePolicy,
  readPolicy,
  recordApproval,
  REOPENED,
  type Policy,
} from "./work-policy.ts";
import {
  AGENT_TYPES,
  author,
  HUMAN,
  isTarget,
  parseMessage,
  parseRequest,
  REQUEST_ID,
  refs,
  subjectOf,
  writerOf,
  type Message,
} from "./work-protocol.ts";
import { answer, closeWorktree, push } from "./work-watcher.ts";

const WORKSPACES = process.env.DESOLATE_WORKSPACES ?? "/workspaces";

class UsageError extends Error {}
const USAGE = `usage: work init <project> [--max N] [--on-done push|hold] [--prefix p/] [--requesters a,b] [--adapter file] [--remote url] [--allow-hooks] [--force]
       work policy <project> | log <project> [--target t] [--type t] [--limit n] [--json] | requests <project> [--json] | verify <project>
       work approve <project> <request-id> | push <project> <worktree> | close <project> <worktree>
       work say <project> <type> <body> [--to t,...]
       work github <project> enable <owner/repo> [--label l] | sync | status | pr <number> <url>
       work github-projects`;
const usage = (): never => {
  throw new UsageError(USAGE);
};

const projectOf = (name: string | undefined) => {
  if (!name || !validName(name)) throw new UsageError(`'${name ?? ""}' is not a project name`);
  const root = resolveTarget(WORKSPACES, name);
  if (!existsSync(join(root.projectDir, ".git"))) throw new UsageError(`${root.projectDir} is not a git repository`);
  return root;
};

/** `--name value` pairs and bare `--flags`, from the rest of the argv. */
const options = (argv: string[], values: string[], flags: string[] = []) => {
  const found: Record<string, string> = {};
  const set = new Set<string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (values.includes(argv[i])) {
      if (argv[i + 1] === undefined) throw new UsageError(`${argv[i]} takes a value`);
      found[argv[i]] = argv[++i];
    } else if (flags.includes(argv[i])) set.add(argv[i]);
    else if (argv[i].startsWith("--")) throw new UsageError(`unknown option '${argv[i]}'`);
    else rest.push(argv[i]);
  }
  return { found, set, rest };
};

/** What a message says, made safe for a terminal: a writer chooses every byte
 *  of it, escape sequences included. */
const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");

const humanSays = (projectDir: string, type: string, body: string, to: string[] = ["*"]) => {
  const message: Message = { v: 1, from: HUMAN, to, type, body, item: null, commit: null, reply_to: null };
  return workGit.append(projectDir, refs.outbox(HUMAN), HUMAN, message, subjectOf(message));
};

/** A commit's time, from the object itself. */
const timeOf = (repo: string, commit: string) => {
  const seconds = /^committer .* (\d+) [+-]\d{4}$/m.exec(workGit.git(repo, ["cat-file", "commit", commit]))?.[1];
  return seconds ? new Date(Number(seconds) * 1000).toISOString().replace(".000", "") : "?";
};

// ------------------------------------------------------------------- verify --

/**
 * Every ref under refs/desolate/ an append-only chain by its named writer:
 * single-parent commits, each authored as the ref's writer, each tree exactly
 * one message.json that parses; a request one commit, written once. Where the
 * ref's reflog exists, every move it recorded is an append too -- a rewrite
 * shows there as a new value whose parent is not the old one.
 *
 * What this cannot catch, named so it is not mistaken for an oversight: a
 * writer in the same project forging BOTH the claim and the author field. The
 * project is one trust domain; this is tamper-evidence, not security.
 */
export const verify = (projectDir: string) => {
  const problems: string[] = [];
  let checked = 0;
  for (const { ref } of workGit.refsUnder(projectDir, refs.glob)) {
    const requestId = /^refs\/desolate\/requests\/(.+)$/.exec(ref)?.[1];
    const writer = requestId ? undefined : writerOf(ref);
    if (requestId !== undefined && !REQUEST_ID.test(requestId)) { problems.push(`${ref}: not a request id`); continue; }
    if (requestId === undefined && writer === undefined) { problems.push(`${ref}: not a ref of the protocol`); continue; }
    const commits = workGit.history(projectDir, ref);
    if (requestId !== undefined && commits.length !== 1) problems.push(`${ref}: a request is one commit, this has ${commits.length}`);
    for (const [index, commit] of commits.entries()) {
      checked++;
      try {
        const read = workGit.readCommit(projectDir, commit);
        const expectedParent = commits[index + 1];
        if (read.parents.length > 1) problems.push(`${ref} ${commit.slice(0, 12)}: a merge, not an append`);
        if ((read.parents[0] ?? undefined) !== expectedParent) problems.push(`${ref} ${commit.slice(0, 12)}: not a single chain`);
        const tree = workGit.git(projectDir, ["cat-file", "-p", `${commit}^{tree}`]);
        if (!/^100644 blob [0-9a-f]+\tmessage\.json$/.test(tree)) problems.push(`${ref} ${commit.slice(0, 12)}: its tree is not one message.json`);
        const message = requestId !== undefined ? parseRequest(read.json) : parseMessage(read.json);
        const claimed = writer ?? message.from;
        if (writer !== undefined && message.from !== writer && !(writer === "desolate" && message.from === "desolate"))
          problems.push(`${ref} ${commit.slice(0, 12)}: says it is from ${message.from}`);
        if (read.authorName !== author(claimed).name)
          problems.push(`${ref} ${commit.slice(0, 12)}: authored as '${read.authorName}', not ${author(claimed).name}`);
      } catch (err: any) {
        problems.push(`${ref} ${commit.slice(0, 12)}: ${err?.message ?? err}`);
      }
    }
    problems.push(...reflogProblems(projectDir, ref, requestId !== undefined));
  }
  return { checked, problems };
};

/** The moves a ref's reflog recorded: each one an append (or the creation). */
const reflogProblems = (projectDir: string, ref: string, writtenOnce: boolean) => {
  const logs = workGit.git(projectDir, ["rev-parse", "--path-format=absolute", "--git-path", `logs/${ref}`]);
  // Every writer of the protocol creates its ref's reflog (--create-reflog), so
  // a ref without one was written some other way -- or its log was removed.
  let stat;
  try {
    stat = lstatSync(logs);
  } catch {
    return [`${ref}: has no reflog -- written outside the protocol, or its log was removed`];
  }
  if (!stat.isFile()) return [`${ref}: its reflog is not a regular file`];
  const problems: string[] = [];
  let previous: string | undefined;
  for (const line of readFileSync(logs, "utf8").split("\n").filter(Boolean)) {
    const [oldValue, newValue] = line.split(" ");
    if (previous !== undefined && oldValue !== previous)
      problems.push(`${ref}: its reflog skips from ${previous.slice(0, 12)} to ${oldValue.slice(0, 12)}`);
    if (writtenOnce && previous !== undefined) problems.push(`${ref}: a request was moved after it was written`);
    if (!/^0+$/.test(oldValue)) {
      try {
        if (workGit.readCommit(projectDir, newValue).parents[0] !== oldValue)
          problems.push(`${ref}: moved from ${oldValue.slice(0, 12)} to ${newValue.slice(0, 12)}, which is not an append`);
      } catch {
        problems.push(`${ref}: its reflog names ${newValue.slice(0, 12)}, which is gone`);
      }
    }
    previous = newValue;
  }
  return problems;
};

// --------------------------------------------------------------- the verbs --

export const main = (
  argv: string[],
  out: (line: string) => void = console.log,
  input: () => string = () => readFileSync(0, "utf8"),
): number => {
  const [verb, name, ...rest] = argv;
  if (!verb || verb === "--help" || verb === "-h") {
    out(USAGE);
    return verb ? 0 : 2;
  }
  // Every project with the github adapter, for the Mac's forge agent: one
  // line each, tab-separated, every field a name the policy already checked.
  if (verb === "github-projects") {
    for (const target of listTargets(WORKSPACES)) {
      if (target.worktree) continue;
      let policy: Policy | undefined;
      try { policy = readPolicy(WORKSPACES, target.project); } catch { continue; }
      if (policy?.github && policy.adapters.includes("github"))
        out(`${target.project}\t${policy.github.repo}\t${policy.github.label}`);
    }
    return 0;
  }
  const root = projectOf(name);
  const say = (line: string) => out(line);

  switch (verb) {
    case "init": {
      const { found, set, rest: extra } = options(rest, ["--max", "--on-done", "--prefix", "--requesters", "--adapter", "--remote"], ["--allow-hooks", "--force"]);
      if (extra.length) throw new UsageError(`unexpected '${extra.join(" ")}'`);
      const files = factoryFiles(WORKSPACES, root.project);
      if (existsSync(files.policy) && !set.has("--force")) throw new UsageError(`${root.project} already has a factory (${files.policy}); --force replaces its policy`);
      const policy: Policy = parsePolicy(JSON.stringify({
        ...DEFAULT_POLICY,
        ...(found["--max"] ? { max_open_worktrees: Number(found["--max"]) } : {}),
        ...(found["--on-done"] ? { on_done: found["--on-done"] } : {}),
        ...(found["--prefix"] !== undefined ? { branch_prefix: found["--prefix"] } : {}),
        ...(found["--requesters"] ? { requesters: found["--requesters"].split(",") } : {}),
        ...(set.has("--allow-hooks") ? { allow_hooks: true } : {}),
        ...(found["--remote"] ? { remote: found["--remote"] } : {}),
      }));
      // An adapter's opens are honoured only from a requester it is among.
      if (found["--adapter"]) {
        policy.adapters = [found["--adapter"]];
        if (!policy.requesters.includes(`forge/${found["--adapter"]}`)) policy.requesters.push(`forge/${found["--adapter"]}`);
        parsePolicy(JSON.stringify(policy));
      }
      mkdirSync(dirname(files.policy), { recursive: true });
      writeFileSync(files.policy, `${JSON.stringify(policy, null, 2)}\n`);
      humanSays(root.projectDir, "status", `factory enabled: ${JSON.stringify(policy)}`);
      out(`work: ${root.project} has a factory: ${files.policy}`);
      return 0;
    }
    case "policy": {
      const policy = readPolicy(WORKSPACES, root.project);
      if (!policy) { out(`work: ${root.project} has no factory (work init ${root.project})`); return 1; }
      const open = worktreesOf(root).length;
      out(JSON.stringify(policy, null, 2));
      out(`open worktrees: ${open} of ${policy.max_open_worktrees}`);
      return 0;
    }
    case "log": {
      const { found, set } = options(rest, ["--target", "--type", "--limit"], ["--json"]);
      const rows: { time: string; line: string; json: Record<string, unknown> }[] = [];
      for (const { ref } of workGit.refsUnder(root.projectDir, refs.glob))
        for (const commit of workGit.history(root.projectDir, ref)) {
          const read = workGit.readCommit(root.projectDir, commit);
          let message: Message;
          try { message = parseMessage(read.json); } catch { continue; }
          if (found["--target"] && message.from !== found["--target"]) continue;
          if (found["--type"] && message.type !== found["--type"]) continue;
          const time = timeOf(root.projectDir, commit);
          rows.push({
            time,
            line: `${commit.slice(0, 12)}  ${time}  ${printable(message.from).padEnd(16)} ${printable(subjectOf(message))}`,
            // For a program (the editor's extension): one object per line, the
            // fields a view shows. JSON escapes what printable() replaces.
            json: {
              commit, time, ref, from: message.from, to: message.to, type: message.type, body: message.body,
              item: message.item, reply_to: message.reply_to,
              ...(typeof message.worktree === "string" ? { worktree: message.worktree } : {}),
              ...(typeof message.state === "string" ? { state: message.state } : {}),
            },
          });
        }
      // Newest first; a stable sort keeps a ref's own order within a second.
      const limit = found["--limit"] ? Number(found["--limit"]) : Infinity;
      if (!(limit > 0)) throw new UsageError("--limit takes a positive number");
      const sorted = rows.sort((a, b) => (a.time === b.time ? 0 : a.time < b.time ? 1 : -1)).slice(0, limit);
      for (const row of sorted) out(set.has("--json") ? JSON.stringify(row.json) : row.line);
      return 0;
    }
    case "requests": {
      const { set } = options(rest, [], ["--json"]);
      const outcomes = handled(WORKSPACES, root.project);
      const approved = approvals(WORKSPACES, root.project);
      for (const { ref, commit } of workGit.refsUnder(root.projectDir, "refs/desolate/requests/")) {
        const id = ref.slice("refs/desolate/requests/".length);
        let what: string;
        let fields: Record<string, unknown> = {};
        try {
          const request = parseRequest(workGit.readCommit(root.projectDir, commit).json);
          what = `${request.action} ${request.worktree}${request.branch ? ` (${request.branch})` : ""} from ${request.from}`;
          fields = { action: request.action, worktree: request.worktree, branch: request.branch, from: request.from, item: request.item, title: request.title };
        } catch (err: any) {
          what = `unreadable: ${err?.message ?? err}`;
          fields = { unreadable: String(err?.message ?? err) };
        }
        const recorded = outcomes.get(id);
        const outcome = recorded && recorded !== REOPENED ? recorded : outcomes.has(`wait:${id}`) ? "waiting" : "pending";
        if (set.has("--json")) out(JSON.stringify({ id, ...fields, outcome, approved: approved.has(id) }));
        else out(printable(`${id}  ${what}  -- ${outcome}${approved.has(id) ? " (approved)" : ""}`));
      }
      return 0;
    }
    case "verify": {
      const { checked, problems } = verify(root.projectDir);
      for (const problem of problems) out(`  ${printable(problem)}`);
      out(problems.length ? `work: ${problems.length} problem(s) in ${checked} message(s)` : `work: ${checked} message(s), every one an append by its writer`);
      return problems.length ? 1 : 0;
    }
    case "approve": {
      const [id] = rest;
      if (!id || !REQUEST_ID.test(id)) throw new UsageError("approve takes a request id (work requests <project>)");
      if (!workGit.resolve(root.projectDir, refs.request(id))) throw new UsageError(`there is no request ${id}`);
      recordApproval(WORKSPACES, root.project, id);
      humanSays(root.projectDir, "status", `approved request ${id}`);
      out(`work: approved ${id}; the watcher looks at it again at its next tick`);
      return 0;
    }
    case "push":
    case "close": {
      const [worktree] = rest;
      if (!worktree || !worktreesOf(root).some((t) => t.worktree === worktree)) throw new UsageError(`${root.project} has no worktree '${worktree ?? ""}'`);
      const policy = readPolicy(WORKSPACES, root.project) ?? DEFAULT_POLICY;
      humanSays(root.projectDir, "status", `${verb} ${worktree}`, [worktree]);
      if (verb === "push") {
        const pushed = push(resolveTarget(WORKSPACES, root.project, worktree), policy, say);
        answer(root.projectDir, worktree, pushed.ok ? `pushed ${pushed.branch} (by hand)` : pushed.reason,
          { state: pushed.ok ? "pushed" : "refused", worktree, by: HUMAN });
        out(pushed.ok ? `work: pushed ${pushed.branch}` : `work: ${pushed.reason}`);
        return pushed.ok ? 0 : 1;
      }
      const closed = closeWorktree(root.project, worktree, say);
      answer(root.projectDir, "*", `${closed.body} (by hand)`, { state: closed.state, worktree, by: HUMAN });
      out(`work: ${closed.body}`);
      return closed.state === "closed" ? 0 : 1;
    }
    case "say": {
      const { found, rest: words } = options(rest, ["--to"]);
      const [type, body] = words;
      if (!type || !(AGENT_TYPES as readonly string[]).includes(type) || body === undefined)
        throw new UsageError(`say takes a type (${AGENT_TYPES.join(", ")}) and a body`);
      const to = found["--to"] ? found["--to"].split(",") : ["*"];
      if (!to.every((t) => t === "*" || isTarget(t))) throw new UsageError(`--to names targets`);
      out(humanSays(root.projectDir, type, body, to).slice(0, 12));
      return 0;
    }
    case "github":
      return github(root, rest, out, input);
    default:
      return usage();
  }
};

/** The `github` adapter's verbs (work-forge.ts): what the Mac's agent,
 *  release/forge.sh, calls with what it saw on GitHub. */
const github = (root: ReturnType<typeof resolveTarget>, argv: string[], out: (line: string) => void, input: () => string) => {
  const [sub, ...rest] = argv;
  const files = factoryFiles(WORKSPACES, root.project);
  const policy = readPolicy(WORKSPACES, root.project);
  if (!policy) throw new UsageError(`${root.project} has no factory (work init ${root.project})`);

  if (sub === "enable") {
    const { found, rest: words } = options(rest, ["--label"]);
    const [repo] = words;
    if (!repo || !GITHUB_REPO.test(repo) || words.length !== 1) throw new UsageError("enable takes owner/repo");
    const label = found["--label"] ?? "desolate:run";
    if (!GITHUB_LABEL.test(label)) throw new UsageError(`'${label}' is not a usable label`);
    const next: Policy = parsePolicy(JSON.stringify({
      ...policy,
      github: { repo, label },
      adapters: [...new Set([...policy.adapters, "github"])],
      requesters: [...new Set([...policy.requesters, "forge/github"])],
    }));
    writeFileSync(files.policy, `${JSON.stringify(next, null, 2)}\n`);
    humanSays(root.projectDir, "status", `github adapter enabled: ${repo}, label '${label}'`);
    out(`work: ${root.project} takes issues labelled '${label}' in ${repo}, once release/forge.sh runs on the Mac`);
    return 0;
  }
  if (!policy.github || !policy.adapters.includes("github"))
    throw new UsageError(`${root.project} has no github adapter (work github ${root.project} enable <owner/repo>)`);
  const repo = policy.github.repo;

  switch (sub) {
    case "sync": {
      const snapshot = parseGithubSnapshot(input());
      writeGithubSnapshot(WORKSPACES, root.project, snapshot);
      out(`work: ${snapshot.open.length} open, ${snapshot.finished.length} finished`);
      return 0;
    }
    case "status": {
      // Tab-separated for a shell on the Mac: number, worktree, branch, state,
      // PR (or -). Every field is a name the protocol validated.
      const prefix = `github:${repo}#`;
      for (const row of forgeStatus(root.projectDir, "github", policy.branch_prefix)) {
        if (!row.item.startsWith(prefix)) continue;
        out([row.item.slice(prefix.length), row.worktree, row.branch, row.state, row.pr ?? "-"].join("\t"));
      }
      return 0;
    }
    case "pr": {
      const [number, url] = rest;
      if (!/^[1-9][0-9]{0,8}$/.test(number ?? "") || !url) throw new UsageError("pr takes an issue number and the PR's URL");
      const item = githubItem(repo, Number(number));
      if (!forgeStatus(root.projectDir, "github", policy.branch_prefix).some((row) => row.item === item))
        throw new UsageError(`${item} was never requested`);
      if (!url.startsWith(`https://github.com/${repo}/pull/`)) throw new UsageError(`'${url}' is not a pull request of ${repo}`);
      recordPr(root.projectDir, "github", item, url);
      out(`work: ${item} -> ${url}`);
      return 0;
    }
    default:
      throw new UsageError("github takes enable, sync, status or pr");
  }
};

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err: any) {
    console.error(`work: ${err?.message ?? err}`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  }
}
