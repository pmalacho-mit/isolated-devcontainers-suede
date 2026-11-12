// Workspaces, from the host: up, list, stop, rm, exec.
import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT, refuse } from "../shared/exit.ts";
import { devHostname, editorHostname, editorHostPort, parseRepo } from "../shared/names.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { guest, INSTANCE, paths, RELEASE_DIR } from "./paths.ts";
import { backend, ensureProxyUser, rootctl } from "./stack.ts";
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
    // The domain's package caches (section 4.7, C4): npm's, pip's and the rest, shared by
    // the domain's workspaces and nobody else's. Whatever one of them puts there, every
    // workspace of the domain could have done itself (section 2), so sharing it poisons
    // nothing; it is never shown to another domain, the root's git or the host's tools.
    { host: paths.domainCache(plan.domain), guest: guest.cache, writable: true },
    // The mirrors of this domain's repositories, and no others, each read-only and at the
    // same path in every VM (a clone's alternates file names it).
    ...repos.map((id) => {
      const repo = parseRepo(id)!;
      return { host: paths.mirror(repo), guest: guest.mirror(repo), writable: false };
    }),
  ],
  sockets: [{ host: `${paths.link(plan.vm)}/proxy.sock`, guest: guest.linkSocket }],
  // Question 9 (resource limits): fixed for now, with the environment as the one knob.
  cpus: sized("DESOLATE_WORKSPACE_CPUS", 2, 1, 64),
  memoryMiB: sized("DESOLATE_WORKSPACE_MEMORY_MIB", 4096, 1024, 262_144),
  diskGiB: 30,
  labels: { title: `${plan.domain}/${plan.workspace}`, domain: plan.domain, workspace: plan.workspace },
});

const sized = (name: string, fallback: number, min: number, max: number) => {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) refuse(`${name} is '${value}'`, `a whole number from ${min} to ${max}`);
  return number;
};

/** What a workspace VM printed is the workspace's text. On its way to the person's
 *  terminal it is text: nothing in it may move the cursor, retitle the window or write the
 *  clipboard. (`desolate exec` is different: there the person asked for the VM's output.) */
const said = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "?");

export const startServices = async (plan: WorkspacePlan) => {
  const b = backend();
  // The workspace's own proxy, in the root, as its domain's proxies' user; then its link,
  // which leads there and nowhere else.
  await ensureProxyUser(plan.domain);
  const proxy = await rootctl<{ port: number }>("proxy.start", { vm: plan.vm, domain: plan.domain, workspace: plan.workspace }, { quiet: true });
  const { connectWorkspace } = await import("./daemon.ts");
  await connectWorkspace({ ...plan, proxyPort: proxy.port });
  const services = await b.exec(plan.vm, ["bash", `${guest.release}/workspace/start.sh`, String(process.getuid!()), b.link(plan.vm).guest], { root: true, timeoutMs: 300_000 });
  if (services.code !== 0) throw new Error(`the workspace's services did not start: ${said((services.stderr || services.stdout).trim().slice(-600))}`);
  // start.sh puts the user in the docker group; what the host runs next must have it.
  await b.refreshSessions?.(plan.vm);
  const init = await b.exec(plan.vm, [...NODE, `${guest.release}/workspace/init.ts`, plan.workspace], { timeoutMs: 900_000 });
  if (init.code !== 0) throw new Error(`the workspace could not make its checkouts: ${said((init.stderr || init.stdout).trim().slice(-800))}`);
  // A docker daemon only where one is wanted: a checkout with a spec (start.sh says how).
  if (plan.checkouts.some((c) => locateSpec(paths.domainRepos(plan.domain), c))) await b.exec(plan.vm, ["bash", `${guest.release}/workspace/start.sh`, String(process.getuid!()), b.link(plan.vm).guest, "docker"], { root: true, timeoutMs: 300_000 });
  // The project's devcontainer, then the editor (which runs in it when it can). Neither
  // fails the workspace: without them it is the VM itself, and `up` says which it is.
  const dev = await b.exec(plan.vm, [...NODE, `${guest.release}/workspace/devcontainer.ts`, plan.workspace], { timeoutMs: 3_700_000 });
  const devcontainer = said(/^devcontainer: (.*)$/m.exec(dev.stdout)?.[1]?.trim().slice(0, 500) ?? `FAILED: ${(dev.stderr || dev.stdout).trim().slice(-300) || "it said nothing"}`);
  const editor = await b.exec(plan.vm, ["bash", "-lc", `bash ${guest.release}/workspace/editor.sh ${editorHostname(INSTANCE, plan.domain, plan.workspace)}`], { timeoutMs: 300_000 });
  return { editorDown: editor.code === 0 ? null : said((editor.stderr || editor.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300)) || "the editor did not start", devcontainer };
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

/** Whether a checkout carries a devcontainer spec: its existence only, read on the host as
 *  data (P4), where the checkout is a directory in the domain's share. */
const locateSpec = (reposDir: string, c: { repo: string; kind: string; name: string }) => {
  const dir = c.kind === "main" ? path.join(reposDir, c.repo) : path.join(reposDir, c.repo, ".worktrees", c.name);
  return fs.existsSync(path.join(dir, ".devcontainer", "devcontainer.json")) || fs.existsSync(path.join(dir, ".devcontainer.json"));
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
    // For whoever is watching the start as it happens (the dashboard): each phase as it ends.
    if (process.env.DESOLATE_PROGRESS) process.stderr.write(`progress: ${name} (${((Date.now() - mark) / 1000).toFixed(1)} s)\n`);
    phases.push([name, Date.now() - mark]);
    mark = Date.now();
  };
  const started = Date.now();
  const b = backend();
  let editorDown: string | null = null;
  let devcontainer = "";
  const view = await rootctl<DomainView>("domain.show", { slug: domain }, { quiet: true });
  if (options.fetch) for (const repo of view.repos) await rootctl("repo.fetch", { repo }, { quiet: json });
  if (options.fetch) phase("mirrors refreshed");
  // The domain's template (section 4.7, C3), before this workspace takes its checkouts:
  // made once per environment, then cloned. Not on the fake backend, whose clone carries no
  // docker images. DESOLATE_TEMPLATES=0 makes every workspace from the base.
  let template: string | null = null;
  if (b.kind !== "fake" && process.env.DESOLATE_TEMPLATES !== "0") {
    const { ensure } = await import("./templates.ts");
    const say = (line: string) => (json ? process.stderr.write(`${line}\n`) : out(line));
    template = await ensure(domain, view.repos, { specOf, startServices }, say);
    if (template) phase("template");
  }
  const plan = await rootctl<Workspace>("workspace.plan", { instance: INSTANCE, domain, name: options.name, checkouts: options.checkouts, base: options.base, fetch: options.fetch }, { quiet: true });
  phase("planned");
  try {
    if (template) await b.clone(template, specOf(plan, view.repos));
    else await b.create(specOf(plan, view.repos));
    await b.start(plan.vm);
    phase("VM booted");
    ({ editorDown, devcontainer } = await startServices(plan));
    phase("services, checkouts, devcontainer and editor");
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
  if (json) return out(JSON.stringify({ domain, workspace: plan.workspace, vm: plan.vm, isolated: b.isolated, checkouts: plan.checkouts, devcontainer, urls, tookMs: Date.now() - started, phases: Object.fromEntries(phases) }));
  out(`workspace ${domain}/${plan.workspace} is up${b.isolated ? "" : "  [NOT ISOLATED: fake backend]"}`);
  for (const c of plan.checkouts) out(`  ${c.repo}  ${c.kind === "main" ? `main checkout (${c.branch})` : `worktree ${c.branch} from ${c.base}`}  ${c.path}`);
  out(`  devcontainer ${devcontainer}`);
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

/** Every running workspace gets its proxy and its link again. A workspace's proxy lives in
 *  the root VM, so a root VM that was restarted left each running workspace with no way out
 *  at all, while `list` still said "running" (found on the M1). Bootstrap calls this.
 *  Returns how many were reconnected. */
export const reconnectRunning = async (): Promise<number> => {
  const b = backend();
  const running = new Set((await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name));
  const { connectWorkspace } = await import("./daemon.ts");
  let count = 0;
  for (const d of await rootctl<DomainView[]>("domain.list", {}, { quiet: true }))
    for (const w of d.workspaces) {
      if (!running.has(w.vm)) continue;
      await ensureProxyUser(w.domain);
      const proxy = await rootctl<{ port: number }>("proxy.start", { vm: w.vm, domain: w.domain, workspace: w.workspace }, { quiet: true });
      await connectWorkspace({ ...w, proxyPort: proxy.port });
      count += 1;
    }
  return count;
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
  const { devcontainer, editorDown } = await startServices(w);
  await rootctl("workspace.state", { domain: w.domain, name: w.workspace, state: "up" }, { quiet: true });
  out(`workspace ${w.domain}/${w.workspace} is up (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  out(`  devcontainer ${devcontainer}`);
  if (editorDown) out(`  editor       NOT AVAILABLE: ${editorDown}`);
};

export const remove = async (target: string | undefined, out: Out) => {
  if (target && !target.includes("/")) {
    const result = await rootctl<{ domain: string; kept: string }>("domain.remove", { slug: target }, { quiet: true });
    // Its template is its own and goes with it.
    await (await import("./templates.ts")).removeAll(result.domain);
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
export const exec = async (target: string | undefined, command: string[], options: { checkout?: string; vm?: boolean }): Promise<number> => {
  const w = await find(target);
  if (command.length === 0) refuse("exec needs a command", "desolate exec <domain>/<workspace> -- <command> [args...]", EXIT.usage);
  const checkout = options.checkout ? w.checkouts.find((c) => c.repo === options.checkout) : w.checkouts[0];
  if (!checkout) refuse(`${options.checkout} is not checked out in ${w.domain}/${w.workspace}`, `it has: ${w.checkouts.map((c) => c.repo).join(", ")}`);
  const b = backend();
  if ((await b.info(w.vm)).status !== "running") refuse(`${w.domain}/${w.workspace} is not running`, `desolate start ${w.domain}/${w.workspace}`);
  // In the project's devcontainer when the workspace has one that is up, else in the VM
  // itself (enter.sh decides, inside the VM); --vm asks for the VM itself.
  const child = b.spawn(w.vm, ["bash", `${guest.release}/workspace/enter.sh`, ...(options.vm ? ["--vm"] : []), checkout!.path, "--", ...command]);
  process.stdin.pipe(child.stdin!);
  child.stdin!.on("error", () => {});
  child.stdout!.pipe(process.stdout);
  child.stderr!.pipe(process.stderr);
  const code = await new Promise<number>((resolve) => child.on("close", (status) => resolve(status ?? 1)));
  process.stdin.unpipe();
  process.stdin.pause();
  return code;
};
