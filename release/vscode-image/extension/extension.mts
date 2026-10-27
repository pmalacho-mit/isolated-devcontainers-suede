/**
 * extension.mts -- the desolate extension, built into the OUTER editor (T4.7):
 * Projects and Dinds views, each target's status, and the actions a person
 * takes from them.
 *
 * It holds no new power. Every action runs a command the editor's terminal
 * already has -- `desolate` (the broker client), `worktree` -- with execFile,
 * never a shell, so what it may do is what those commands may do, and they
 * validate their own arguments. It runs no git and no docker itself, and
 * reaches nothing over the network. What it reads directly is the file system
 * the editor already mounts: which projects /workspaces holds, and each
 * target's status in its git dir (status.ts).
 *
 * The decisions -- what a node shows, which actions it offers -- are in
 * model.mts, which the unit tests run without VS Code.
 */
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { readStatus, shownTargets } from "../status.ts";
import {
  dindsTree, lastJson, projectsTree, redactTokens, targetKey,
  type DindStatus, type Node, type Running,
} from "./model.mts";

const WORKSPACES = process.env.DESOLATE_WORKSPACES ?? "/workspaces";
const BIN = process.env.DESOLATE_EXTENSION_BIN ?? "/usr/local/bin";

let log: vscode.OutputChannel;

/** One command, its output to the log as it arrives (tokens redacted), its
 *  exit status and everything it printed back. */
const run = (command: "desolate" | "worktree", args: string[], quiet = false) =>
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

  /** `load`, for once, a cheaper read of the same view. */
  async refresh(load = this.load) {
    try {
      this.roots = await load();
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
    if (node.icon)
      item.iconPath = new vscode.ThemeIcon(node.icon, node.iconColor ? new vscode.ThemeColor(node.iconColor) : undefined);
    return item;
  }
}

const known = () =>
  shownTargets(WORKSPACES).map(({ project, worktree }) => ({ project, ...(worktree ? { worktree } : {}) }));

/** What is running changes when the broker says so; a status, whenever an
 *  agent writes one. So the broker is asked every 10 s, and the statuses --
 *  a file read each, no command -- are read every 3 s against its last answer. */
let lastRunning: Running[] = [];
const statuses = () => new Map(shownTargets(WORKSPACES).flatMap((target) => {
  const status = readStatus(target);
  return status ? [[targetKey({ project: target.project, worktree: target.worktree }), status] as const] : [];
}));

const loadProjects = async (ask = true) => {
  if (ask) {
    const { output } = await run("desolate", ["--list", "--json"], true);
    lastRunning = lastJson<Running[]>(output) ?? [];
  }
  return projectsTree(known(), lastRunning, statuses());
};

const loadDinds = async () => {
  const { code, output } = await run("desolate", ["--dinds"], true);
  const status = lastJson<DindStatus>(output);
  if (code !== 0 || !status) return [{ id: "dind:error", label: "the supervisor did not answer", icon: "warning" }];
  return dindsTree(status);
};

const targetArgs = (node: Node) => [
  ...(node.target?.worktree ? ["--worktree", node.target.worktree] : []),
  node.target!.project,
];

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("desolate");
  const projects = new Tree(() => loadProjects(true)), dinds = new Tree(loadDinds);
  const refreshAll = () => Promise.all([projects.refresh(), dinds.refresh()]);

  /** An action, with its progress shown and every view refreshed after. */
  const act = (title: string, command: "desolate" | "worktree", args: string[]) =>
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
  // Push and pull never run git in the project here: `desolate --push` and
  // `--pull` hand the project's half to its sandbox (transfer.ts).
  register("push", async (node) => {
    const sure = await vscode.window.showInformationMessage(
      `Push the branch checked out in ${node.label} to its GitHub repository? Review it first: an agent may have written it.`,
      { modal: true }, "Push");
    if (sure === "Push") await act(`pushing ${node.label}`, "desolate", ["--push", ...targetArgs(node)]);
  });
  register("pull", (node) => act(`pulling into ${node.label}`, "desolate", ["--pull", ...targetArgs(node)]));
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

  // What runs, every 10 s; statuses, every 3 s, without asking the broker;
  // the dinds' sizes cost a `du` each, so every minute.
  const every = (ms: number, refresh: () => Promise<void>) => {
    const timer = setInterval(() => void refresh(), ms);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  };
  every(10_000, () => projects.refresh());
  every(3_000, () => projects.refresh(() => loadProjects(false)));
  every(60_000, () => dinds.refresh());
  void refreshAll();
}

export function deactivate() {}
