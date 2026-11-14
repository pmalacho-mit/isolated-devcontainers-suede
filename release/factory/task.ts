// `desolate task`: from a sentence to an agent at work on it, in one command.
//
//   desolate task <domain> "<what to do>" [--name <workspace>] [--branch <branch>]
//       [--checkout <owner/repo>] [--secret CLAUDE-OAUTH] [--attach] [-- <agent command...>]
//
// A workspace named for the task (`add-a-shout-greeting`; --name), every repository of the
// domain on one branch (`task/<name>`; --branch), Claude Code started in it with the sentence
// as its task and kept running (`desolate agent`), and how to watch it. With --attach, your
// terminal is attached at once (Ctrl-] detaches; it keeps running).
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { printable } from "../shared/text.ts";
import { agentCommand, CLI, desolate, ensureClaude, nameFor, standingOrders } from "./claude.ts";

const say = (line: string): void => void process.stdout.write(`${printable(line, 600)}\n`);
const fail = (message: string, fix: string): never => {
  process.stderr.write(`desolate task: ${message}\n  fix: ${fix}\n`);
  process.exit(64);
};

const dash = process.argv.indexOf("--", 2);
const own = dash >= 0 ? process.argv.slice(2, dash) : process.argv.slice(2);
const custom = dash >= 0 ? process.argv.slice(dash + 1) : [];
const { values, positionals } = (() => {
  try {
    return parseArgs({
      args: own,
      options: { name: { type: "string" }, branch: { type: "string" }, checkout: { type: "string" }, secret: { type: "string", default: "CLAUDE-OAUTH" }, attach: { type: "boolean" } },
      allowPositionals: true,
    });
  } catch (error) {
    return fail((error as Error).message, 'desolate task <domain> "<what to do>" [--name <w>] [--branch <b>] [--attach] [-- <agent...>]');
  }
})();
const [domain, ...words] = positionals;
const sentence = words.join(" ").trim();
if (!domain || !sentence) fail("a task is a domain and what to do", 'desolate task acme "Add a shout() greeting"');

const taken = new Set<string>();
let listed: { domain: string; workspaces: { workspace: string }[] }[] = [];
try {
  listed = JSON.parse(desolate(["list", domain!, "--json"]).out);
} catch {
  listed = [];
}
const mine = listed.find((d) => d.domain === domain);
if (!mine) fail(`there is no domain '${domain}'`, `desolate domain create ${domain} --repo <owner/repo>`);
for (const w of mine!.workspaces) taken.add(w.workspace);
let name = values.name ?? nameFor(sentence);
for (let n = 2; !values.name && taken.has(name); n++) name = `${nameFor(sentence).slice(0, 27)}-${n}`;
const branch = values.branch ?? `task/${name}`;
const where = `${domain}/${name}`;

// Claude's credential, before a workspace is made for nothing: the domain holds it, or it is
// copied (inside the root: the value goes nowhere) from a domain that does. One token for
// every domain is the usual case; `secret rm` in a domain undoes the copy.
if (custom.length === 0) {
  const secret = String(values.secret);
  const holds = (d: string) => {
    try {
      return (JSON.parse(desolate(["domain", d, "secret", "list", "--json"]).out) as { name: string }[]).some((s) => s.name === secret);
    } catch {
      return false;
    }
  };
  if (!holds(domain!)) {
    let all: { domain: string }[] = [];
    try {
      all = JSON.parse(desolate(["list", "--json"]).out);
    } catch {
      all = [];
    }
    const source = all.map((d) => d.domain).find((d) => d !== domain && holds(d));
    if (!source)
      fail(`no domain holds ${secret}, Claude's token`,
        `once, on this Mac: claude setup-token, then: desolate domain ${domain} secret set ${secret} --hosts api.anthropic.com --headers authorization   (paste the token)`);
    const copied = desolate(["domain", domain!, "secret", "copy", secret, "--from", source!]);
    if (copied.code !== 0) fail(`${secret} could not be copied from ${source}: ${printable(copied.err.trim(), 300)}`, `desolate domain ${domain} secret copy ${secret} --from ${source}`);
    say(`${domain}: ${secret} copied from the domain ${source}, inside the root (to undo: desolate domain ${domain} secret rm ${secret})`);
  }
}

say(`${where}: starting, every repository on ${branch}`);
const up = await new Promise<number>((resolve) => spawn(CLI, ["up", domain!, "--name", name, "--branch", branch], { stdio: ["ignore", "ignore", "inherit"] }).on("close", (code) => resolve(code ?? 1)));
if (up !== 0) fail(`the workspace did not start (desolate up said ${up})`, `desolate up ${domain} --name ${name} --branch ${branch}`);
if (custom.length === 0 && !ensureClaude(where, values.checkout, say)) fail("Claude Code could not be installed in the workspace", "add the devcontainer feature ghcr.io/anthropics/devcontainer-features/claude-code:1");
const task = `${sentence}\n\n${standingOrders(branch)}`;
const started = desolate(["agent", "start", where, "--name", "agent", ...(values.checkout ? ["--checkout", values.checkout] : []), "--", ...agentCommand(custom, String(values.secret), task)]);
if (started.code !== 0) fail(`the agent did not start: ${printable(started.err.trim(), 300)}`, `desolate agent list ${where}`);
say(`${where}: the agent is working on it.`);
say(`  watch it:   desolate agent attach ${where}     (Ctrl-] detaches; it keeps running)`);
say(`  its work:   desolate ui --open   (it offers its branch when it is done; desolate notify tells you)`);
if (values.attach) {
  const attached = spawn(CLI, ["agent", "attach", where], { stdio: "inherit" });
  await new Promise((resolve) => attached.on("close", resolve));
}
