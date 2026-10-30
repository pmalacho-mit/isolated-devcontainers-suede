/**
 * extension.mts -- the desolate extension, built into the OUTER editor (T4.7):
 * Needs you, Projects, Review and Dinds views, each target's status, and the
 * actions a person takes from them.
 *
 * It holds no new power. Every action runs a command the editor's terminal
 * already has -- `desolate` (the broker client), `worktree`, `newrepo` -- with
 * execFile, never a shell, so what it may do is what those commands may do,
 * and they validate their own arguments. It runs no git and no docker itself,
 * and reaches nothing over the network: a GitHub link is opened by the
 * browser. What it reads directly is the file system the editor already
 * mounts: which projects /workspaces holds, and each target's status, note,
 * branch and port labels (status.ts, panel.ts) -- and the review a `desolate
 * --review` kept in the editor's own cache (review.ts).
 *
 * The decisions -- what a node shows, which actions it offers -- are in
 * model.mts, which the unit tests run without VS Code.
 */
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { factsOf } from "../panel.ts";
import { reviewDirectory, type Review } from "../review.ts";
import { readNote, readStatus, shownTargets } from "../status.ts";
import {
  ATTENTION, dindsTree, githubLinks, lastJson, memoryByProject, needsYouTree, pickItems, projectsSummary,
  projectsTree, redactTokens, reviewTree, targetKey,
  type Counts, type Detail, type DindStatus, type Facts, type Known, type Node, type Running, type Status, type TargetRef,
} from "./model.mts";

const WORKSPACES = process.env.DESOLATE_WORKSPACES ?? "/workspaces";
const BIN = process.env.DESOLATE_EXTENSION_BIN ?? "/usr/local/bin";

let log: vscode.OutputChannel;

/** One command, its output to the log as it arrives (tokens redacted), its
 *  exit status and everything it printed back. */
const run = (command: "desolate" | "worktree" | "newrepo", args: string[], quiet = false) =>
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

/** A tooltip from a node's details: our labels as markdown, their text
 *  escaped, line by line -- so a note's `![](https://...)` stays text and is
 *  never fetched. */
const tooltipOf = (details: Detail[]) => {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = false;
  details.forEach((detail, i) => {
    if (i) md.appendMarkdown("\n\n");
    md.appendMarkdown(`**${detail.label}**  \n`);
    detail.text.split("\n").forEach((line, j) => {
      if (j) md.appendMarkdown("  \n");
      md.appendText(line);
    });
  });
  return md;
};

/** A message shown in a notification, which draws `[text](link)` as a link:
 *  an agent's words must not become one. */
const plain = (text: string) => redactTokens(text).replace(/[[\]]/g, "");

/** A tree drawn from model.mts's nodes. */
class Tree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  roots: Node[] = [];
  private parents = new Map<string, Node>();
  private byId = new Map<string, Node>();
  private drawn = "";

  constructor(private readonly load: () => Promise<Node[]> | Node[]) {}

  /** `load`, or for once a cheaper read of the same view. Drawn again only
   *  when something changed: redrawing every few seconds would take the hover,
   *  and the inline actions with it, out from under the pointer. */
  async refresh(load = this.load) {
    let roots: Node[];
    try {
      roots = await load();
    } catch (err: any) {
      roots = [{ id: "error", label: "could not read", description: String(err?.message ?? err), icon: "error" }];
    }
    this.roots = roots;
    this.parents.clear();
    this.byId.clear();
    const walk = (nodes: Node[], parent?: Node) => {
      for (const node of nodes) {
        this.byId.set(node.id, node);
        if (parent) this.parents.set(node.id, parent);
        walk(node.children ?? [], node);
      }
    };
    walk(roots);
    const drawn = JSON.stringify(roots);
    if (drawn === this.drawn) return;
    this.drawn = drawn;
    this.changed.fire(undefined);
  }

  find(id: string) {
    return this.byId.get(id);
  }

  count() {
    return this.roots.length;
  }

  getChildren(node?: Node) {
    return node ? node.children ?? [] : this.roots;
  }

  getParent(node: Node) {
    return this.parents.get(node.id);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.children?.length
        ? node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.details ? tooltipOf(node.details) : node.tooltip;
    item.contextValue = node.actions;
    if (node.icon)
      item.iconPath = new vscode.ThemeIcon(node.icon, node.iconColor ? new vscode.ThemeColor(node.iconColor) : undefined);
    if (node.click) item.command = { command: node.click, title: node.label, arguments: [node] };
    return item;
  }
}

/** What /workspaces holds, read as files: every target, its status, and what
 *  the panel shows of it beyond that. Cheap enough to read every few seconds. */
const readWorkspaces = () => {
  const targets = shownTargets(WORKSPACES);
  const known: Known[] = targets.map(({ project, worktree }) => ({ project, ...(worktree ? { worktree } : {}) }));
  const statuses = new Map<string, Status>();
  const facts = new Map<string, Facts>();
  for (const target of targets) {
    const key = targetKey({ project: target.project, worktree: target.worktree });
    const status = readStatus(target);
    if (status) statuses.set(key, status);
    const read = factsOf(target);
    facts.set(key, { branch: read.head.branch, commit: read.head.commit, github: read.github, note: read.note,
                     portLabel: read.portLabel, repo: read.repo });
  }
  return { known, statuses, facts };
};

const targetArgs = (target: TargetRef) => [...(target.worktree ? ["--worktree", target.worktree] : []), target.project];
/** `desolate --push`'s status for the repository's default branch, refused
 *  without --allow-default (transfer.ts DEFAULT_BRANCH_EXIT). */
const DEFAULT_BRANCH_EXIT = 77;
const nameOf = (target: TargetRef) => `${target.project}${target.worktree ? ` · ${target.worktree}` : ""}`;

/** A review, and the target it is of. */
interface Reviewing {
  id: number;
  target: TargetRef;
  review: Review;
}

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("desolate");

  // --- what the views are drawn from ---------------------------------------
  let lastRunning: Running[] = [];
  let lastDinds: DindStatus | undefined;
  let workspaces: ReturnType<typeof readWorkspaces> = { known: [], statuses: new Map(), facts: new Map() };
  /** By target key: what an action is doing to it right now. */
  const busy = new Map<string, string>();
  /** By target key: its last review's counts. */
  const counts = new Map<string, Counts>();
  const reviews = new Map<number, Reviewing>();
  let reviewing: Reviewing | undefined;
  let reviewNumber = 0;
  const memento = context.globalState;
  const runningOnly = () => memento.get<boolean>("desolate.runningOnly", false);
  /** By target key: the `updated` of the status you marked as seen. */
  const seen = () => new Map(Object.entries(memento.get<Record<string, string>>("desolate.seen", {})));

  const projects = new Tree(() => projectsTree({
    ...workspaces, running: lastRunning, memory: memoryByProject(lastDinds), busy, counts, runningOnly: runningOnly(),
  }));
  const needsYou = new Tree(() => needsYouTree({ ...workspaces, running: lastRunning, seen: seen() }));
  const review = new Tree(() => reviewing ? reviewTree(reviewing.review, reviewing.target) : []);
  const dinds = new Tree(() => lastDinds ? dindsTree(lastDinds) : [{ id: "dind:error", label: "the supervisor did not answer", icon: "warning" }]);

  const projectsView = vscode.window.createTreeView("desolate.projects", { treeDataProvider: projects, showCollapseAll: true });
  const needsYouView = vscode.window.createTreeView("desolate.needsYou", { treeDataProvider: needsYou });
  const reviewView = vscode.window.createTreeView("desolate.review", { treeDataProvider: review, showCollapseAll: true });
  const dindsView = vscode.window.createTreeView("desolate.dinds", { treeDataProvider: dinds });
  const bell = vscode.window.createStatusBarItem("desolate.needsYou", vscode.StatusBarAlignment.Left, 50);
  bell.name = "desolate: needs you";
  bell.command = "desolate.needsYou.focus";
  context.subscriptions.push(log, projectsView, needsYouView, reviewView, dindsView, bell);

  /** Statuses already announced, so each is said once: unset until the first
   *  read, which announces nothing -- what was there before is not news. */
  let announced: Map<string, string> | undefined;
  const announce = (statuses: Map<string, Status>) => {
    const before = announced;
    announced = new Map([...statuses].map(([key, status]) => [key, status.updated]));
    if (!before || !vscode.workspace.getConfiguration("desolate").get<boolean>("notifications", true)) return;
    const hidden = seen();
    for (const [key, status] of statuses) {
      if (!(ATTENTION as readonly string[]).includes(status.color) || before.get(key) === status.updated || hidden.get(key) === status.updated) continue;
      const node = needsYou.find(`needs:${key}`);
      if (!node?.target) continue;
      const target = node.target;
      const said = `${nameOf(target)}: ${plain(status.message || status.color)}`;
      const buttons = [
        ...(status.color === "green" ? ["Review & Push"] : []),
        ...(target.running ? ["Open editor"] : []),
        "Show",
      ];
      const show = status.color === "red" ? vscode.window.showErrorMessage
        : status.color === "orange" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      void show(said, ...buttons).then((button) => {
        if (button === "Review & Push") void vscode.commands.executeCommand("desolate.review", node);
        else if (button === "Open editor") void vscode.commands.executeCommand("desolate.openEditor", node);
        else if (button === "Show") void vscode.commands.executeCommand("desolate.reveal", node);
      });
    }
  };

  /** Open note documents, by their uri, with the text they were last given. */
  const notes = new vscode.EventEmitter<vscode.Uri>();
  const noteShown = new Map<string, string>();

  /** The files again (every 3 s), the broker too when `ask` (every 10 s). */
  const refreshViews = async (ask = true) => {
    if (ask) {
      const { output } = await run("desolate", ["--list", "--json"], true);
      lastRunning = lastJson<Running[]>(output) ?? [];
    }
    workspaces = readWorkspaces();
    await Promise.all([projects.refresh(), needsYou.refresh()]);
    projectsView.description = projectsSummary(lastRunning, lastDinds?.headroom ?? undefined);
    const waiting = needsYou.count();
    needsYouView.badge = waiting ? { value: waiting, tooltip: `${waiting} need${waiting === 1 ? "s" : ""} you` } : undefined;
    bell.text = `$(bell-dot) ${waiting}`;
    bell.tooltip = `desolate: ${waiting} target${waiting === 1 ? " needs" : "s need"} you`;
    if (waiting) bell.show(); else bell.hide();
    announce(workspaces.statuses);
    for (const [uri, text] of noteShown) {
      const now = noteText(vscode.Uri.parse(uri));
      if (now !== text) notes.fire(vscode.Uri.parse(uri));
    }
  };
  const refreshDinds = async () => {
    const { code, output } = await run("desolate", ["--dinds"], true);
    const status = lastJson<DindStatus>(output);
    lastDinds = code === 0 && status ? status : undefined;
    await dinds.refresh();
  };
  const refreshAll = () => Promise.all([refreshViews(), refreshDinds()]);

  // --- documents: a review's two sides, and a note ---------------------------
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("desolate-review", {
    // /<review>/<a|b|none>/<file index>/<path, for its language>
    provideTextDocumentContent: async (uri) => {
      const [, id, side, index] = uri.path.split("/");
      const kept = reviews.get(Number(id));
      if (!kept || (side !== "a" && side !== "b") || !/^\d+$/.test(index)) return "";
      // Only where `desolate --review` keeps this target's: never a path a
      // command's output named.
      const dir = reviewDirectory(kept.target.project, kept.target.worktree);
      if (kept.review.dir !== dir) return "";
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(`${dir}/${Number(index)}.${side}`)));
      } catch {
        return "";
      }
    },
  }));
  const noteText = (uri: vscode.Uri) => {
    const key = decodeURIComponent(uri.path.split("/")[1] ?? "");
    const target = shownTargets(WORKSPACES).find((t) => targetKey({ project: t.project, worktree: t.worktree }) === key);
    return target ? readNote(target) ?? "(no note)" : "(no such target)";
  };
  context.subscriptions.push(notes, vscode.workspace.registerTextDocumentContentProvider("desolate-note", {
    onDidChange: notes.event,
    provideTextDocumentContent: (uri) => {
      const text = noteText(uri);
      noteShown.set(uri.toString(), text);
      return text;
    },
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => noteShown.delete(doc.uri.toString())));

  // --- acting on a target -----------------------------------------------------
  /** The target a command acts on: the node's, or one picked from the palette. */
  const targetOf = async (node: Node | undefined, verb: string, fits: (target: TargetRef) => boolean = () => true) => {
    if (node?.target) return node.target;
    const items = pickItems({ ...workspaces, running: lastRunning }).filter((item) => fits(item.target));
    if (!items.length) {
      void vscode.window.showInformationMessage(`desolate: nothing to ${verb}`);
      return undefined;
    }
    const chosen = await vscode.window.showQuickPick(items, { placeHolder: `desolate: ${verb} which?`, matchOnDescription: true, matchOnDetail: true });
    return chosen?.target;
  };

  /** A command for a target: its row spins and says what is happening, the
   *  status bar shows progress, and a failure says what it said last -- but
   *  for the exit statuses the caller says it handles itself (`handled`). */
  const act = async (target: TargetRef | undefined, doing: string, command: "desolate" | "worktree" | "newrepo", args: string[],
                     handled: number[] = []) => {
    const key = target ? targetKey(target) : undefined;
    if (key) {
      busy.set(key, doing);
      void refreshViews(false);
    }
    const what = `${doing.replace(/…$/, "")}${target ? ` ${nameOf(target)}` : ""}`;
    try {
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `desolate: ${what}` }, async () => {
        const result = await run(command, args);
        const last = result.output.trim().split("\n").filter(Boolean).pop() ?? "";
        if (handled.includes(result.code)) {
          // The caller's to say.
        } else if (result.code === 75) {
          // Busy, not broken (locks.ts): something else is doing this target now.
          const why = result.output.split("\n").find((line) => line.includes(" is in use: ")) ?? last;
          void vscode.window.showWarningMessage(`desolate: not now -- ${plain(why).replace(/^desolate: /, "").slice(0, 300)}`);
        } else if (result.code !== 0) {
          void vscode.window.showErrorMessage(`desolate: ${what} failed${last ? ` -- ${plain(last).slice(0, 300)}` : ` (exit ${result.code})`}`, "Show log")
            .then((button) => button && log.show(true));
        }
        return result;
      });
    } finally {
      if (key) busy.delete(key);
      await refreshAll();
    }
  };

  const register = (name: string, handler: (node?: Node) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`desolate.${name}`, handler));

  const open = (url: string | undefined) => url && vscode.env.openExternal(vscode.Uri.parse(url));

  register("refresh", () => refreshAll());
  register("showLog", () => log.show(true));
  register("start", async (node) => {
    const target = await targetOf(node, "start", (t) => !t.running);
    if (target) await act(target, "starting…", "desolate", targetArgs(target));
  });
  register("stop", async (node) => {
    const target = await targetOf(node, "stop", (t) => Boolean(t.running));
    if (target) await act(target, "stopping…", "desolate", ["--stop", ...targetArgs(target)]);
  });
  register("rebuild", async (node) => {
    const target = await targetOf(node, "rebuild");
    if (!target) return;
    // A rebuild recreates the container: what lives in it outside /workspaces
    // -- installed packages, shell history, anything in $HOME -- is gone.
    const sure = await vscode.window.showWarningMessage(
      `Rebuild ${nameOf(target)}? Its container is recreated from devcontainer.json, and anything in it outside /workspaces is lost.`,
      { modal: true }, "Rebuild");
    if (sure === "Rebuild") await act(target, "rebuilding…", "desolate", ["--rebuild", ...targetArgs(target)]);
  });

  // Push, pull and review never run git in the project here: `desolate` hands
  // the project's half to its sandbox (transfer.ts, review.ts).
  const push = async (target: TargetRef, review?: Review) => {
    const what = review
      ? `Push ${review.ahead} commit${review.ahead === 1 ? "" : "s"} of ${review.branch} to ${target.repo ?? "its GitHub repository"}?`
      : `Push the branch checked out in ${nameOf(target)} to its GitHub repository? Review it first: an agent may have written it.`;
    const sure = await vscode.window.showInformationMessage(what, {
      modal: true,
      ...(review?.uncommitted ? { detail: `${review.uncommitted} uncommitted change${review.uncommitted === 1 ? " is" : "s are"} not sent.` } : {}),
    }, "Push");
    if (sure !== "Push") return;
    let { code } = await act(target, "pushing…", "desolate", ["--push", ...targetArgs(target)], [DEFAULT_BRANCH_EXIT]);
    if (code === DEFAULT_BRANCH_EXIT) {
      // Refused for being the repository's default branch (transfer.ts): the
      // person may mean it, so they are asked -- once more, and plainly.
      const branch = review?.branch ?? target.branch ?? "this branch";
      const anyway = await vscode.window.showWarningMessage(
        `${branch} is ${target.repo ?? "its repository"}'s default branch. Push to it anyway?`,
        { modal: true, detail: `This updates ${branch} on GitHub directly, with no pull request to review it in. It is never a force-push: GitHub refuses it if ${branch} moved there since your last pull.` },
        `Push to ${branch}`);
      if (anyway !== `Push to ${branch}`) return;
      ({ code } = await act(target, "pushing…", "desolate", ["--push", "--allow-default", ...targetArgs(target)]));
    }
    if (code === 0 && reviewing && targetKey(reviewing.target) === targetKey(target)) await startReview(target);
  };
  register("push", async (node) => {
    const target = await targetOf(node, "push");
    if (target) await push(target);
  });
  register("pull", async (node) => {
    const target = await targetOf(node, "pull");
    if (target) await act(target, "pulling…", "desolate", ["--pull", ...targetArgs(target)]);
  });

  /** `desolate --review`, shown in the Review view. */
  const startReview = async (target: TargetRef) => {
    const { code, output } = await act(target, "reviewing…", "desolate", ["--review", "--json", ...targetArgs(target)]);
    const said = code === 0 ? lastJson<Review>(output) : undefined;
    if (!said?.head) return;
    counts.set(targetKey(target), { head: said.head, ahead: said.ahead, behind: said.behind });
    reviewing = { id: ++reviewNumber, target, review: said };
    reviews.set(reviewing.id, reviewing);
    for (const id of reviews.keys()) if (id < reviewNumber - 4) reviews.delete(id);
    await vscode.commands.executeCommand("setContext", "desolate.reviewing", true);
    reviewView.title = `Review: ${nameOf(target)}`;
    reviewView.description = said.branch;
    await Promise.all([review.refresh(), projects.refresh()]);
    await vscode.commands.executeCommand("desolate.review.focus");
  };
  register("review", async (node) => {
    const target = await targetOf(node, "review", (t) => Boolean(t.branch));
    if (target) await startReview(target);
  });
  register("reviewPush", async () => {
    if (reviewing) await push(reviewing.target, reviewing.review);
  });
  register("reviewRefresh", async () => {
    if (reviewing) await startReview(reviewing.target);
  });
  register("reviewClose", async () => {
    reviewing = undefined;
    await vscode.commands.executeCommand("setContext", "desolate.reviewing", false);
    await review.refresh();
  });
  register("openReviewFile", async (node) => {
    const kept = reviewing;
    const file = kept?.review.files.find((f) => f.index === node?.file);
    if (!kept || !file) return;
    if (file.kind !== "text") {
      void vscode.window.showInformationMessage(`${file.path}: ${file.kind === "module" ? "a submodule" : `${file.kind}, not sent for review`} -- look at it in the devcontainer.`);
      return;
    }
    const side = (which: "a" | "b") =>
      vscode.Uri.from({ scheme: "desolate-review", path: `/${kept.id}/${file.sides[which] ? which : "none"}/${file.index}/${file.path}` });
    await vscode.commands.executeCommand("vscode.diff", side("a"), side("b"),
      `${file.path} (${kept.review.base?.ref ?? "nothing"} ↔ ${kept.review.branch ?? "HEAD"})`, { preview: true });
  });

  register("openEditor", async (node) => {
    const target = await targetOf(node, "open", (t) => Boolean(t.running && t.url));
    open(target?.url);
  });
  register("openPort", (node) => open(node?.target?.url));
  register("copyUrl", async (node) => {
    const target = await targetOf(node, "copy the editor URL of", (t) => Boolean(t.running && t.url));
    if (!target?.url) return;
    await vscode.env.clipboard.writeText(target.url);
    void vscode.window.showInformationMessage(`desolate: copied ${nameOf(target)}'s editor URL`);
  });
  register("openIssue", async (node) => open(githubLinks((await targetOf(node, "open the issue of", (t) => Boolean(githubLinks(t).issue))) ?? { project: "" }).issue));
  register("openPullRequests", async (node) => open(githubLinks((await targetOf(node, "open the pull requests of", (t) => Boolean(githubLinks(t).pulls))) ?? { project: "" }).pulls));
  register("openBranch", async (node) => open(githubLinks((await targetOf(node, "open on GitHub", (t) => Boolean(githubLinks(t).branch))) ?? { project: "" }).branch));
  register("openRepository", async (node) => open(githubLinks((await targetOf(node, "open the repository of", (t) => Boolean(githubLinks(t).repository))) ?? { project: "" }).repository));

  register("openNote", async (node) => {
    if (!node?.target) return;
    const uri = vscode.Uri.from({ scheme: "desolate-note", path: `/${encodeURIComponent(targetKey(node.target))}/note` });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  });

  register("worktreeAdd", async (node) => {
    const target = await targetOf(node, "add a worktree to", (t) => !t.worktree);
    if (!target) return;
    const name = await vscode.window.showInputBox({ prompt: `a worktree of ${target.project}: its directory name` });
    if (!name) return;
    const branch = await vscode.window.showInputBox({ prompt: "its branch", value: name });
    if (branch === undefined) return;
    await act(target, `adding ${name}…`, "worktree", ["add", target.project, name, ...(branch ? [branch] : [])]);
  });
  register("worktreeRemove", async (node) => {
    const target = await targetOf(node, "remove", (t) => Boolean(t.worktree && !t.running));
    if (!target?.worktree) return;
    const sure = await vscode.window.showWarningMessage(
      `Remove worktree ${target.worktree} of ${target.project}? It is refused if it holds uncommitted work.`,
      { modal: true }, "Remove");
    if (sure === "Remove") await act(target, "removing…", "worktree", ["remove", target.project, target.worktree]);
  });

  // --- Needs you --------------------------------------------------------------
  register("dismiss", async (node) => {
    if (!node?.target) return;
    const key = targetKey(node.target);
    const status = workspaces.statuses.get(key);
    if (!status) return;
    await memento.update("desolate.seen", { ...memento.get<Record<string, string>>("desolate.seen", {}), [key]: status.updated });
    await refreshViews(false);
  });
  register("undismiss", async () => {
    await memento.update("desolate.seen", {});
    await refreshViews(false);
  });
  register("reveal", async (node) => {
    if (!node?.target) return;
    let shown = projects.find(`target:${targetKey(node.target)}`);
    if (!shown && runningOnly()) {
      await vscode.commands.executeCommand("desolate.showAll");
      shown = projects.find(`target:${targetKey(node.target)}`);
    }
    if (shown) await projectsView.reveal(shown, { select: true, focus: true, expand: true });
  });

  // --- the Projects view's filter, and the palette's way in --------------------
  const filter = async (on: boolean) => {
    await memento.update("desolate.runningOnly", on);
    await vscode.commands.executeCommand("setContext", "desolate.runningOnly", on);
    await projects.refresh();
  };
  register("filterRunning", () => filter(true));
  register("showAll", () => filter(false));
  void vscode.commands.executeCommand("setContext", "desolate.runningOnly", runningOnly());

  const ACTIONS: [string, string, (t: TargetRef) => boolean][] = [
    ["$(link-external) Open editor", "openEditor", (t) => Boolean(t.running && t.url)],
    ["$(play) Start", "start", (t) => !t.running],
    ["$(debug-stop) Stop", "stop", (t) => Boolean(t.running)],
    ["$(repo-push) Review & Push…", "review", (t) => Boolean(t.branch)],
    ["$(cloud-upload) Push without review…", "push", () => true],
    ["$(cloud-download) Pull", "pull", () => true],
    ["$(issues) Open its issue", "openIssue", (t) => Boolean(githubLinks(t).issue)],
    ["$(git-pull-request) Open its pull requests", "openPullRequests", (t) => Boolean(githubLinks(t).pulls)],
    ["$(github) Open its branch on GitHub", "openBranch", (t) => Boolean(githubLinks(t).branch)],
    ["$(debug-restart) Rebuild…", "rebuild", () => true],
    ["$(add) Add worktree…", "worktreeAdd", (t) => !t.worktree],
    ["$(trash) Remove worktree…", "worktreeRemove", (t) => Boolean(t.worktree && !t.running)],
  ];
  register("quickOpen", async () => {
    const target = await targetOf(undefined, "act on");
    if (!target) return;
    const chosen = await vscode.window.showQuickPick(
      ACTIONS.filter(([, , fits]) => fits(target)).map(([label, command]) => ({ label, command })),
      { placeHolder: nameOf(target) });
    if (chosen) await vscode.commands.executeCommand(`desolate.${chosen.command}`, { id: "picked", label: nameOf(target), target });
  });

  // --- a first project: a deploy key, then the clone (newrepo.ts) ---------------
  register("clone", async () => {
    const repo = await vscode.window.showInputBox({
      prompt: "The GitHub repository to clone into /workspaces, as owner/repo",
      validateInput: (value) => /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? undefined : "owner/repo",
    });
    if (!repo) return;
    const { code, output } = await act(undefined, `making a deploy key for ${repo}…`, "newrepo", ["key", repo]);
    const key = output.match(/^PUBKEY (ssh-\S+ \S+.*)$/m)?.[1];
    if (code !== 0 || !key) return;
    const step = await vscode.window.showInformationMessage(
      `Add this deploy key to ${repo} on GitHub, with write access -- then clone.`,
      { modal: true, detail: key }, "Copy key and open GitHub", "Clone");
    if (step === "Copy key and open GitHub") {
      await vscode.env.clipboard.writeText(key);
      open(`https://github.com/${repo}/settings/keys/new`);
      const added = await vscode.window.showInformationMessage(`desolate: once the key is on ${repo}, clone it.`, "Clone");
      if (added !== "Clone") return;
    } else if (step !== "Clone") {
      return;
    }
    await act(undefined, `cloning ${repo}…`, "newrepo", ["clone", repo]);
  });

  // What runs, every 10 s; the files -- statuses, notes, branches -- every
  // 3 s, without asking the broker; the dinds' sizes cost a `du` each, so
  // every minute.
  const every = (ms: number, refresh: () => Promise<unknown>) => {
    const timer = setInterval(() => void refresh(), ms);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  };
  every(10_000, () => refreshViews());
  every(3_000, () => refreshViews(false));
  every(60_000, () => refreshDinds());
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((change) => {
    if (change.affectsConfiguration("desolate")) void refreshViews(false);
  }));
  void refreshAll();
}

export function deactivate() {}
