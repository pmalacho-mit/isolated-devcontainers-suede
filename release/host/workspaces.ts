// Workspaces, from the host: up, list, stop, rm, exec.
import * as fs from "node:fs";
import { EXIT, refuse } from "../shared/exit.ts";
import { devHostname, editorHostname, editorHostPort, parseRepo } from "../shared/names.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { guest, INSTANCE, paths, RELEASE_DIR } from "./paths.ts";
import { backend, rootctl } from "./stack.ts";
import type { VmSpec } from "./vm/types.ts";

type Out = (line: string) => void;
type Workspace = WorkspacePlan & { state: string };
type DomainView = { slug: string; title: string; repos: string[]; workspaces: Workspace[] };

const NODE = ["node", "--disable-warning=ExperimentalWarning"];

export const splitTarget = (target: string | undefined): { domain: string; workspace: string } => {
  const parts = (target ?? "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) refuse(`'${target ?? ""}' does not name a workspace`, "name it as <domain>/<workspace> (see `desolate list`)", EXIT.usage);
  return { domain: parts[0]!, workspace: parts[1]! };
};

export const specOf = (plan: WorkspacePlan, repos: string[]): VmSpec => ({
  name: plan.vm,
  role: "workspace",
  egress: "none",
  shares: [
    { host: RELEASE_DIR, guest: guest.release, writable: false },
    { host: paths.domainRepos(plan.domain), guest: guest.workspaces, writable: true },
    { host: paths.outbox(plan.domain), guest: guest.outbox, writable: true },
    // The inbox is the root's to write: a domain cannot forge a delivery or its own plan.
    { host: paths.inbox(plan.domain), guest: guest.inbox, writable: false },
    // The mirrors of this domain's repositories, and no others, each read-only and at the
    // same path in every VM (a clone's alternates file names it).
    ...repos.map((id) => {
      const repo = parseRepo(id)!;
      return { host: paths.mirror(repo), guest: guest.mirror(repo), writable: false };
    }),
  ],
  sockets: [{ host: `${paths.link(plan.vm)}/proxy.sock`, guest: guest.linkSocket }],
  cpus: 2,
  memoryMiB: 4096,
  diskGiB: 30,
  labels: { title: `${plan.domain}/${plan.workspace}`, domain: plan.domain, workspace: plan.workspace },
});

const startServices = async (plan: WorkspacePlan) => {
  const b = backend();
  // The workspace's own proxy, in the root; then its link, which leads there and nowhere else.
  const proxy = await rootctl<{ port: number }>("proxy.start", { vm: plan.vm, domain: plan.domain, workspace: plan.workspace }, { quiet: true });
  const { connectWorkspace } = await import("./daemon.ts");
  await connectWorkspace({ ...plan, proxyPort: proxy.port });
  const services = await b.exec(plan.vm, ["bash", `${guest.release}/workspace/start.sh`, String(process.getuid!()), b.link(plan.vm).guest, editorHostname(INSTANCE, plan.domain, plan.workspace)], { root: true, timeoutMs: 300_000 });
  if (services.code !== 0) throw new Error(`the workspace's services did not start: ${(services.stderr || services.stdout).trim().slice(-600)}`);
  const editorDown = /^editor: NOT RUNNING: (.*)$/m.exec(services.stdout);
  const init = await b.exec(plan.vm, [...NODE, `${guest.release}/workspace/init.ts`, plan.workspace], { timeoutMs: 900_000 });
  if (init.code !== 0) throw new Error(`the workspace could not make its checkouts: ${(init.stderr || init.stdout).trim().slice(-800)}`);
  return { editorDown: editorDown ? editorDown[1]!.trim().slice(0, 300) : null };
};

/** The address a person opens for a workspace's editor: its own hostname, the stack's
 *  editor port, the token the VM made, and the first checkout as the folder. */
export const editorUrl = async (w: Workspace): Promise<{ url: string } | { error: string }> => {
  const token = await backend().exec(w.vm, ["bash", "-lc", "cat ~/.desolate-editor/token"], { timeoutMs: 60_000 });
  if (token.code !== 0 || !/^[0-9a-f]{48}$/.test(token.stdout.trim())) return { error: "the editor is not running in this workspace (its image may have none: desolate doctor)" };
  const { editorPort } = await import("./daemon.ts");
  const { port, error } = await editorPort();
  if (error) return { error: `the editor's port is not available on this machine: ${error}. Free it, or set DESOLATE_EDITOR_PORT, then: desolate bootstrap` };
  const folder = w.checkouts[0]?.path;
  return { url: `http://${editorHostname(INSTANCE, w.domain, w.workspace)}:${port}/?tkn=${token.stdout.trim()}${folder ? `&folder=${encodeURIComponent(folder)}` : ""}` };
};

export const editor = async (target: string | undefined, out: Out, json: boolean) => {
  const w = await find(target);
  if ((await backend().info(w.vm)).status !== "running") refuse(`${w.domain}/${w.workspace} is not running`, `desolate start ${w.domain}/${w.workspace}`);
  const result = await editorUrl(w);
  if ("error" in result) refuse(result.error, `desolate start ${w.domain}/${w.workspace}`);
  out(json ? JSON.stringify(result) : (result as { url: string }).url);
};

export const urlsOf = (plan: { domain: string; workspace: string }) => ({
  editor: `http://${editorHostname(INSTANCE, plan.domain, plan.workspace)}:${editorHostPort()}`,
  dev: `http://${devHostname(INSTANCE, plan.domain, plan.workspace)}`,
});

export const up = async (domain: string | undefined, options: { name?: string; checkouts: string[]; base?: string; fetch: boolean }, out: Out, json: boolean) => {
  if (!domain) refuse("which domain?", "desolate up <domain> [--name <workspace>]", EXIT.usage);
  const phases: [string, number][] = [];
  let mark = Date.now();
  const phase = (name: string) => {
    phases.push([name, Date.now() - mark]);
    mark = Date.now();
  };
  const started = Date.now();
  const b = backend();
  let editorDown: string | null = null;
  const view = await rootctl<DomainView>("domain.show", { slug: domain }, { quiet: true });
  if (options.fetch) for (const repo of view.repos) await rootctl("repo.fetch", { repo }, { quiet: json });
  if (options.fetch) phase("mirrors refreshed");
  const plan = await rootctl<Workspace>("workspace.plan", { instance: INSTANCE, domain, name: options.name, checkouts: options.checkouts, base: options.base, fetch: options.fetch }, { quiet: true });
  phase("planned");
  try {
    await b.create(specOf(plan, view.repos));
    await b.start(plan.vm);
    phase("VM booted");
    editorDown = (await startServices(plan)).editorDown;
    phase("services, editor and checkouts");
  } catch (error) {
    // A workspace that did not come up holds no checkout, and leaves no proxy or link.
    const { disconnectWorkspace } = await import("./daemon.ts");
    await disconnectWorkspace(plan.vm).catch(() => {});
    await rootctl("proxy.stop", { vm: plan.vm }, { quiet: true }).catch(() => {});
    await b.destroy(plan.vm).catch(() => {});
    await rootctl("workspace.remove", { domain, name: plan.workspace }, { quiet: true }).catch(() => {});
    throw error;
  }
  await rootctl("workspace.state", { domain, name: plan.workspace, state: "up" }, { quiet: true });
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  const breakdown = `the start took ${seconds(Date.now() - started)} s: ${phases.map(([name, ms]) => `${name} ${seconds(ms)} s`).join(", ")}`;
  const opened = editorDown ? { error: editorDown } : await editorUrl(plan);
  const urls = { ...urlsOf(plan), ...("url" in opened ? { editorWithToken: opened.url } : { editorError: opened.error }) };
  if (json) return out(JSON.stringify({ domain, workspace: plan.workspace, vm: plan.vm, isolated: b.isolated, checkouts: plan.checkouts, urls, tookMs: Date.now() - started, phases: Object.fromEntries(phases) }));
  out(`workspace ${domain}/${plan.workspace} is up${b.isolated ? "" : "  [NOT ISOLATED: fake backend]"}`);
  for (const c of plan.checkouts) out(`  ${c.repo}  ${c.kind === "main" ? `main checkout (${c.branch})` : `worktree ${c.branch} from ${c.base}`}  ${c.path}`);
  out("url" in opened ? `  editor       ${opened.url}` : `  editor       NOT AVAILABLE: ${opened.error}`);
  out(`  dev servers  ${urls.dev}:<port>   (the port it listens on inside, nothing to declare)`);
  out(breakdown);
};

export const list = async (out: Out, json: boolean, only?: string) => {
  const b = backend();
  const domains = (await rootctl<DomainView[]>("domain.list", {}, { quiet: true })).filter((d) => !only || d.slug === only);
  const vms = new Map((await b.list()).map((vm) => [vm.name, vm.status]));
  const view = domains.map((d) => ({
    domain: d.slug, title: d.title, repos: d.repos,
    workspaces: d.workspaces.map((w) => ({ workspace: w.workspace, vm: w.vm, status: vms.get(w.vm) ?? "missing", isolated: b.isolated, checkouts: w.checkouts, urls: urlsOf(w) })),
  }));
  if (json) return out(JSON.stringify(view));
  if (view.length === 0) return out("no domains yet. Start with: desolate domain create <slug>");
  for (const d of view) {
    out(`${d.domain}  "${d.title}"  ${d.repos.length ? d.repos.join(", ") : "(no repositories: desolate domain " + d.domain + " add --repo <owner>/<repo>)"}`);
    if (d.workspaces.length === 0) out(`  (no workspaces: desolate up ${d.domain})`);
    for (const w of d.workspaces)
      out(`  ${d.domain}/${w.workspace}  ${w.status}${w.isolated ? "" : "  [not isolated]"}  ${w.checkouts.map((c) => `${c.repo}@${c.branch}`).join(", ")}`);
  }
};

const find = async (target: string | undefined) => {
  const { domain, workspace } = splitTarget(target);
  return rootctl<Workspace>("workspace.get", { domain, name: workspace }, { quiet: true });
};

export const stop = async (target: string | undefined, out: Out) => {
  const w = await find(target);
  const b = backend();
  const { disconnectWorkspace } = await import("./daemon.ts");
  await disconnectWorkspace(w.vm);
  await rootctl("proxy.stop", { vm: w.vm }, { quiet: true }).catch(() => {});
  if ((await b.info(w.vm)).status === "running") await b.stop(w.vm);
  await rootctl("workspace.state", { domain: w.domain, name: w.workspace, state: "stopped" }, { quiet: true });
  out(`stopped ${w.domain}/${w.workspace}. Its checkouts stay held; start it again with: desolate start ${w.domain}/${w.workspace}`);
};

export const start = async (target: string | undefined, out: Out) => {
  const w = await find(target);
  const b = backend();
  const started = Date.now();
  const info = await b.info(w.vm);
  if (info.status === "missing") refuse(`the VM of ${w.domain}/${w.workspace} is gone`, `desolate rm ${w.domain}/${w.workspace} && desolate up ${w.domain} --name ${w.workspace}`);
  if (info.status === "suspended") await b.resume(w.vm);
  else if (info.status !== "running") await b.start(w.vm);
  await startServices(w);
  await rootctl("workspace.state", { domain: w.domain, name: w.workspace, state: "up" }, { quiet: true });
  out(`workspace ${w.domain}/${w.workspace} is up (${((Date.now() - started) / 1000).toFixed(1)} s)`);
};

export const remove = async (target: string | undefined, out: Out) => {
  if (target && !target.includes("/")) {
    const result = await rootctl<{ domain: string; kept: string }>("domain.remove", { slug: target }, { quiet: true });
    fs.rmSync(paths.domain(result.domain), { recursive: true, force: true });
    return out(`removed the domain ${result.domain}; ${result.kept}.`);
  }
  const w = await find(target);
  const { disconnectWorkspace } = await import("./daemon.ts");
  await disconnectWorkspace(w.vm);
  await rootctl("proxy.stop", { vm: w.vm }, { quiet: true }).catch(() => {});
  await backend().destroy(w.vm);
  fs.rmSync(paths.link(w.vm), { recursive: true, force: true });
  await rootctl("workspace.remove", { domain: w.domain, name: w.workspace }, { quiet: true });
  out(`removed ${w.domain}/${w.workspace}. Its branches and worktrees stay in the domain's clones.`);
};

/** A command, or an agent, in a workspace. stdin, stdout, stderr and the exit code pass
 *  through. */
export const exec = async (target: string | undefined, command: string[], options: { checkout?: string }): Promise<number> => {
  const w = await find(target);
  if (command.length === 0) refuse("exec needs a command", "desolate exec <domain>/<workspace> -- <command> [args...]", EXIT.usage);
  const checkout = options.checkout ? w.checkouts.find((c) => c.repo === options.checkout) : w.checkouts[0];
  if (!checkout) refuse(`${options.checkout} is not checked out in ${w.domain}/${w.workspace}`, `it has: ${w.checkouts.map((c) => c.repo).join(", ")}`);
  const b = backend();
  if ((await b.info(w.vm)).status !== "running") refuse(`${w.domain}/${w.workspace} is not running`, `desolate start ${w.domain}/${w.workspace}`);
  const child = b.spawn(w.vm, command, { cwd: checkout!.path });
  process.stdin.pipe(child.stdin!);
  child.stdin!.on("error", () => {});
  child.stdout!.pipe(process.stdout);
  child.stderr!.pipe(process.stderr);
  const code = await new Promise<number>((resolve) => child.on("close", (status) => resolve(status ?? 1)));
  process.stdin.unpipe();
  process.stdin.pause();
  return code;
};
