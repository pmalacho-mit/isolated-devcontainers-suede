/**
 * extension.mts -- the desolate extension, built into the OUTER editor (T4.7,
 * F6): Projects, Dinds and Factory views, and the actions a person takes from
 * them.
 *
 * It holds no new power. Every action runs a command the editor's terminal
 * already has -- `desolate` (the broker client), `worktree`, `work` -- with
 * execFile, never a shell, so what it may do is what those commands may do,
 * and they validate their own arguments. It runs no git and no docker itself,
 * and reaches nothing over the network. What it reads directly is the file
 * system the editor already mounts: which projects /workspaces holds
 * (projects.ts), and which have a factory (work-policy.ts).
 *
 * The decisions -- what a node shows, which actions it offers -- are in
 * model.mts, which the unit tests run without VS Code.
 */
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { list as listTargets } from "../projects.ts";
import { readPolicy } from "../work-policy.ts";
import {
  dindsTree, factoryTree, jsonLines, lastJson, projectsTree, redactTokens,
  type DindStatus, type MessageRow, type Node, type RequestRow, type Running,
} from "./model.mts";

const WORKSPACES = process.env.DESOLATE_WORKSPACES ?? "/workspaces";
const BIN = process.env.DESOLATE_EXTENSION_BIN ?? "/usr/local/bin";

let log: vscode.OutputChannel;

/** One command, its output to the log as it arrives (tokens redacted), its
 *  exit status and everything it printed back. */
const run = (command: "desolate" | "worktree" | "work", args: string[], quiet = false) =>
  new Promise<{ code: number; output: string }>((resolve) => {
    if (!quiet) log.appendLine(`$ ${command} ${args.join(" ")}`);
    const child = execFile(`${BIN}/${command}`, args, { maxBuffer: 16 * 1024 * 1024, timeout: 60 * 60_000 });
    let output = "";
    const take = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (!quiet) log.append(redactTokens(chunk.toString()));
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (err) => { output += String(err); resolve({ code: 1, output }); });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });

/** A tree drawn from model.mts's nodes, refreshed on demand. */
class Tree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: Node[] = [];

  constructor(private readonly load: () => Promise<Node[]>) {}

  async refresh() {
    try {
      this.roots = await this.load();
    } catch (err: any) {
      this.roots = [{ id: "error", label: "could not read", description: String(err?.message ?? err), icon: "error" }];
    }
    this.changed.fire(undefined);
  }

  getChildren(node?: Node) {
    return node ? node.children ?? [] : this.roots;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip;                 // a string: plain text, never markdown
    item.contextValue = node.actions;
    if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
    return item;
  }
}

/** Projects that can be started -- not an owner directory, which `list` keeps
 *  for namespace claims -- and every worktree of theirs, spec or not: a new
 *  worktree has none until its first checkout. */
const known = () => {
  const all = listTargets(WORKSPACES);
  const projects = new Set(listTargets.startable(WORKSPACES).filter((t) => !t.worktree).map((t) => t.project));
  return all
    .filter(({ project }) => projects.has(project))
    .map(({ project, worktree }) => ({ project, ...(worktree ? { worktree } : {}) }));
};

const loadProjects = async () => {
  const { output } = await run("desolate", ["--list", "--json"], true);
  return projectsTree(known(), lastJson<Running[]>(output) ?? []);
};

const loadDinds = async () => {
  const { code, output } = await run("desolate", ["--dinds"], true);
  const status = lastJson<DindStatus>(output);
  if (code !== 0 || !status) return [{ id: "dind:error", label: "the supervisor did not answer", icon: "warning" }];
  return dindsTree(status);
};

const loadFactory = async () => {
  const projects = known().filter((target) => !target.worktree).map(({ project }) => project);
  const nodes: Node[] = [];
  for (const project of projects) {
    let policy;
    try { policy = readPolicy(WORKSPACES, project); } catch { continue; }
    if (!policy) continue;
    const [requests, messages] = await Promise.all([
      run("work", ["requests", project, "--json"], true),
      run("work", ["log", project, "--json", "--limit", "50"], true),
    ]);
    const open = known().filter((target) => target.project === project && target.worktree).map((t) => t.worktree!);
    nodes.push(factoryTree(project, policy as unknown as Record<string, unknown>,
      jsonLines<RequestRow>(requests.output), jsonLines<MessageRow>(messages.output), open));
  }
  return nodes.length ? nodes : [{ id: "factory:none", label: "no project has a factory (work init <project>)", icon: "info" }];
};

const targetArgs = (node: Node) => [
  ...(node.target?.worktree ? ["--worktree", node.target.worktree] : []),
  node.target!.project,
];

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("desolate");
  const projects = new Tree(loadProjects), dinds = new Tree(loadDinds), factory = new Tree(loadFactory);
  const refreshAll = () => Promise.all([projects.refresh(), dinds.refresh(), factory.refresh()]);

  /** An action, with its progress shown and every view refreshed after. */
  const act = (title: string, command: "desolate" | "worktree" | "work", args: string[]) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
      log.show(true);
      const { code } = await run(command, args);
      if (code !== 0) vscode.window.showErrorMessage(`${title}: failed (exit ${code}); see the desolate log`);
      await refreshAll();
    });

  const register = (name: string, handler: (node: Node) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`desolate.${name}`, handler));

  context.subscriptions.push(
    log,
    vscode.window.registerTreeDataProvider("desolate.projects", projects),
    vscode.window.registerTreeDataProvider("desolate.dinds", dinds),
    vscode.window.registerTreeDataProvider("desolate.factory", factory),
  );
  register("refresh", () => refreshAll());
  register("start", (node) => act(`starting ${node.label}`, "desolate", targetArgs(node)));
  register("stop", (node) => act(`stopping ${node.label}`, "desolate", ["--stop", ...targetArgs(node)]));
  register("rebuild", async (node) => {
    // A rebuild recreates the container: what lives in it outside /workspaces
    // -- installed packages, shell history, anything in $HOME -- is gone.
    const sure = await vscode.window.showWarningMessage(
      `Rebuild ${node.label}? Its container is recreated from devcontainer.json, and anything in it outside /workspaces is lost.`,
      { modal: true }, "Rebuild");
    if (sure === "Rebuild") await act(`rebuilding ${node.label}`, "desolate", ["--rebuild", ...targetArgs(node)]);
  });
  register("openEditor", (node) => node.target?.url && vscode.env.openExternal(vscode.Uri.parse(node.target.url)));
  register("openPort", (node) => node.target?.url && vscode.env.openExternal(vscode.Uri.parse(node.target.url)));
  register("copyUrl", async (node) => {
    if (!node.target?.url) return;
    await vscode.env.clipboard.writeText(node.target.url);
    vscode.window.showInformationMessage(`copied ${node.label}'s editor URL`);
  });
  register("worktreeAdd", async (node) => {
    const name = await vscode.window.showInputBox({ prompt: `a worktree of ${node.target!.project}: its directory name` });
    if (!name) return;
    const branch = await vscode.window.showInputBox({ prompt: "its branch", value: name });
    if (branch === undefined) return;
    await act(`adding ${name}`, "worktree", ["add", node.target!.project, name, ...(branch ? [branch] : [])]);
  });
  register("worktreeRemove", async (node) => {
    const sure = await vscode.window.showWarningMessage(
      `Remove worktree ${node.target!.worktree} of ${node.target!.project}? It is refused if it holds uncommitted work.`,
      { modal: true }, "Remove");
    if (sure === "Remove") await act(`removing ${node.label}`, "worktree", ["remove", node.target!.project, node.target!.worktree!]);
  });
  register("approve", (node) => act(`approving ${node.label}`, "work", ["approve", node.target!.project, node.target!.request!]));
  register("push", (node) => act(`pushing ${node.label}`, "work", ["push", node.target!.project, node.target!.worktree!]));
  register("close", (node) => act(`closing ${node.label}`, "work", ["close", node.target!.project, node.target!.worktree!]));
  register("reply", async (node) => {
    const from = node.target!.from!;
    const body = await vscode.window.showInputBox({ prompt: `your answer to ${from}` });
    if (body) await act(`answering ${from}`, "work", ["say", node.target!.project, "answer", body, "--to", from]);
  });

  // Projects and the factory move on their own; the dinds' sizes cost a `du`
  // each, so they are read less often.
  const every = (ms: number, tree: Tree) => {
    const timer = setInterval(() => void tree.refresh(), ms);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  };
  every(10_000, projects);
  every(15_000, factory);
  every(60_000, dinds);
  void refreshAll();
}

export function deactivate() {}
