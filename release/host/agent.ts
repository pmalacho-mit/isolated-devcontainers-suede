// `desolate agent`: an agent kept running in a workspace, and your own terminal attached to
// it when you want to watch or talk to it (workspace/agent-holder.py keeps it).
//
//   desolate agent start <domain>/<workspace> [--name <n>] [--checkout <owner/repo>] -- <command...>
//   desolate agent attach <domain>/<workspace> [--name <n>]     Ctrl-] detaches; it keeps running
//   desolate agent list [<domain>[/<workspace>]] [--json]
//   desolate agent log <domain>/<workspace> [--name <n>]        what it printed (its last 2 MiB)
//   desolate agent stop <domain>/<workspace> [--name <n>]
//
// No tmux: your terminal draws the agent's output itself, so its scrollback, selection and
// copy are your terminal's (replayed on attach: what the agent printed recently is there to
// scroll back through). Many agents can run at once, one or more per workspace, each in its
// own VM: `desolate agent list` shows them all.
import { EXIT, refuse } from "../shared/exit.ts";
import { parseRepo } from "../shared/names.ts";
import { terminalFilter } from "../shared/terminal-filter.ts";
import { guest } from "./paths.ts";
import { backend, rootctl } from "./stack.ts";

type Out = (line: string) => void;
type Workspace = { domain: string; workspace: string; vm: string; checkouts: { repo: string; path: string }[] };
type Agent = { name: string; state: string; command: string[]; started: string; lastOutput: string | null; exit: number | null; ended?: string };

const HOLDER = () => [`python3`, "-I", `${guest.release}/workspace/agent-holder.py`];
const DETACH = 0x1d; // Ctrl-]

const target = async (value: string | undefined): Promise<Workspace> => {
  const [domain, workspace] = String(value ?? "").split("/");
  if (!domain || !workspace) refuse("which workspace?", "desolate agent <start|attach|log|stop> <domain>/<workspace>", EXIT.usage);
  const w = await rootctl<Workspace>("workspace.get", { domain, name: workspace }, { quiet: true });
  if ((await backend().info(w.vm)).status !== "running") refuse(`${domain}/${workspace} is not running`, `desolate start ${domain}/${workspace}`);
  return w;
};
const nameOf = (value: unknown) => {
  const name = typeof value === "string" ? value : "agent";
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) refuse(`'${name}' is not an agent name`, "lower-case letters, digits and dashes", EXIT.usage);
  return name;
};

export const start = async (where: string | undefined, options: { name?: string; checkout?: string }, command: string[], out: Out, json: boolean) => {
  if (command.length === 0) refuse("start what?", "desolate agent start <domain>/<workspace> -- <command...>", EXIT.usage);
  const w = await target(where);
  const checkout = options.checkout ? w.checkouts.find((c) => c.repo === options.checkout) : w.checkouts[0];
  if (!checkout || (options.checkout && !parseRepo(options.checkout))) refuse(`${options.checkout} is not checked out in ${w.domain}/${w.workspace}`, `it has: ${w.checkouts.map((c) => c.repo).join(", ")}`, EXIT.usage);
  const name = nameOf(options.name);
  const started = await backend().exec(w.vm, [...HOLDER(), "start", name, checkout!.path, "--", ...command], { timeoutMs: 60_000 });
  if (started.code !== 0) refuse(`the agent did not start: ${(started.stderr || started.stdout).trim().slice(-300)}`, `desolate agent list ${w.domain}/${w.workspace}`);
  if (json) return out(started.stdout.trim());
  out(`agent ${name} is running in ${w.domain}/${w.workspace} (${checkout!.repo})`);
  out(`  attach: desolate agent attach ${w.domain}/${w.workspace}${name === "agent" ? "" : ` --name ${name}`}   (Ctrl-] detaches; it keeps running)`);
};

export const list = async (only: string | undefined, out: Out, json: boolean) => {
  const [domain, workspace] = String(only ?? "").split("/");
  const all = await rootctl<{ slug: string; workspaces: Workspace[] }[]>("domain.list", {}, { quiet: true });
  const b = backend();
  const running = new Set((await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name));
  const rows: (Agent & { workspace: string })[] = [];
  await Promise.all(all.filter((d) => !domain || d.slug === domain).flatMap((d) => d.workspaces.filter((w) => (!workspace || w.workspace === workspace) && running.has(w.vm)).map(async (w) => {
    const listed = await b.exec(w.vm, [...HOLDER(), "list"], { timeoutMs: 30_000 });
    try {
      for (const agent of JSON.parse(listed.stdout.trim() || "[]") as Agent[]) rows.push({ ...agent, workspace: `${d.slug}/${w.workspace}` });
    } catch {
      /* no agents there */
    }
  })));
  rows.sort((a, b2) => a.workspace.localeCompare(b2.workspace) || a.name.localeCompare(b2.name));
  if (json) return out(JSON.stringify(rows));
  if (rows.length === 0) return out("no agents. Start one: desolate agent start <domain>/<workspace> -- <command...>");
  const ago = (when: string | null) => (when ? `${Math.max(0, Math.round((Date.now() - Date.parse(when)) / 1000))} s ago` : "never");
  for (const a of rows)
    out(`  ${a.workspace}  ${a.name}  ${a.state}${a.exit !== null && a.exit !== undefined ? ` (exit ${a.exit})` : ""}  started ${ago(a.started)}, last output ${ago(a.lastOutput)}  ${a.command.join(" ").slice(0, 60)}`);
};

export const stop = async (where: string | undefined, options: { name?: string }, out: Out) => {
  const w = await target(where);
  const name = nameOf(options.name);
  const stopped = await backend().exec(w.vm, [...HOLDER(), "stop", name], { timeoutMs: 30_000 });
  if (stopped.code !== 0) refuse((stopped.stderr || stopped.stdout).trim().replace(/^agent-holder: /, ""), `desolate agent list ${w.domain}/${w.workspace}`);
  out(`asked agent ${name} in ${w.domain}/${w.workspace} to stop`);
};

export const log = async (where: string | undefined, options: { name?: string }) => {
  const w = await target(where);
  const name = nameOf(options.name);
  const shown = await backend().exec(w.vm, ["bash", "-c", 'tail -c 2097152 "$HOME/.desolate-agents/$1.log"', "_", name], { timeoutMs: 30_000 });
  if (shown.code !== 0) refuse(`no agent '${name}' in ${w.domain}/${w.workspace}`, `desolate agent list ${w.domain}/${w.workspace}`);
  process.stdout.write(shown.stdout);
};

/** Your terminal, attached: raw, its size passed on, Ctrl-] to let go. */
export const attach = async (where: string | undefined, options: { name?: string }): Promise<number> => {
  const w = await target(where);
  const name = nameOf(options.name);
  if (!process.stdin.isTTY) refuse("attach needs a terminal", "run it in your terminal; for a script: desolate agent log", EXIT.usage);
  const child = backend().spawn(w.vm, [...HOLDER(), "attach", name]);
  const send = (line: string) => child.stdin!.write(`${line}\n`);
  const size = () => send(`r ${process.stdout.columns || 120} ${process.stdout.rows || 40}`);
  process.stderr.write(`desolate: attached to ${name} in ${w.domain}/${w.workspace}. Ctrl-] detaches; it keeps running.\r\n`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  size();
  process.stdout.on("resize", size);
  const done = new Promise<number>((resolve) => {
    let over = false;
    const finish = (code: number) => {
      if (over) return;
      over = true;
      process.stdin.removeAllListeners("data");
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.off("resize", size);
      child.kill();
      process.stderr.write(`\r\ndesolate: detached from ${name}; it is still running (desolate agent list).\r\n`);
      resolve(code);
    };
    process.stdin.on("data", (chunk: Buffer) => {
      const at = chunk.indexOf(DETACH);
      if (at >= 0) {
        if (at > 0) send(`i ${chunk.subarray(0, at).toString("base64")}`);
        return finish(0);
      }
      send(`i ${chunk.toString("base64")}`);
    });
    // What the agent prints, kept to what a screen needs (shared/terminal-filter.ts): your
    // terminal emulator is outside every boundary.
    const filter = terminalFilter();
    child.stdout!.on("data", (chunk: Buffer) => process.stdout.write(filter(chunk)));
    child.on("close", () => finish(0));
  });
  return done;
};
