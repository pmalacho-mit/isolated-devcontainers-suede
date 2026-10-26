/**
 * model.mts -- what the desolate extension shows, decided without VS Code.
 *
 * Everything here is a pure function from what the editor's own commands
 * print -- `desolate --list --json`, `desolate --dinds`, `work requests
 * --json`, `work log --json` -- to the nodes of a tree, so the unit tests read
 * the same decisions the views make. extension.mts only draws them and runs
 * the commands a node's actions name.
 *
 * Text that came from a project -- an agent's message, a request's title -- is
 * shown as plain text, never as markdown: a writer chooses every byte of it.
 */

/** One node of a view. `actions` is VS Code's contextValue, the set of
 *  commands this node offers; `command` is what a click runs. */
export interface Node {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  actions?: string;
  children?: Node[];
  /** What the node's actions act on. */
  target?: { project: string; worktree?: string; url?: string; request?: string; from?: string };
}

/** `desolate --list --json`: one row per target that is up. */
export interface Running {
  target: string;
  project: string;
  worktree: string | null;
  daemon?: string;
  url: string | null;
  ports: Record<string, number>;
}

/** A project or one of its worktrees, as /workspaces holds them. */
export interface Known {
  project: string;
  worktree?: string;
}

/** The last JSON value a command printed: the broker relays the runner's
 *  log lines before it, and those are prose. */
export const lastJson = <T,>(output: string): T | undefined => {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^[[{]/.test(lines[i])) continue;
    try {
      return JSON.parse(lines[i]) as T;
    } catch { /* not this one */ }
  }
  return undefined;
};

/** Every JSON line a command printed (`work ... --json` prints one per row). */
export const jsonLines = <T,>(output: string): T[] =>
  output.split("\n").flatMap((line) => {
    if (!line.trim().startsWith("{")) return [];
    try {
      return [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });

/** An editor URL carries its connection token; the token belongs in the
 *  link the user opens, never in a log anyone can read over a shoulder. */
export const redactTokens = (text: string) => text.replace(/([?&]tkn=)[^&#\s"'<>]+/g, "$1…");

/** The editor first, then each container port in order -- not in the order
 *  an object happens to keep its keys, which puts "5173" before "editor". */
const portNodes = (row: Running, id: string): Node[] =>
  Object.entries(row.ports).sort(([a], [b]) =>
    a === "editor" ? -1 : b === "editor" ? 1 : Number(a) - Number(b)).map(([label, port]) => ({
    id: `${id}:port:${label}`,
    label: label === "editor" ? "editor" : `container :${label}`,
    description: `127.0.0.1:${port}`,
    icon: label === "editor" ? "window" : "plug",
  }));

/**
 * The Projects view: every project, each with its worktrees, and for what is
 * running its ports and the actions that make sense for it.
 */
export const projectsTree = (known: Known[], running: Running[]): Node[] => {
  const up = new Map(running.map((row) => [`${row.project}@${row.worktree ?? ""}`, row]));
  const node = (target: Known): Node => {
    const key = `${target.project}@${target.worktree ?? ""}`;
    const row = up.get(key);
    const id = `target:${key}`;
    const kind = target.worktree ? "worktree" : "project";
    return {
      id,
      label: target.worktree ?? target.project,
      description: row ? `running${row.daemon === "project" ? " · own dind" : ""}` : "stopped",
      icon: row ? "vm-running" : "vm-outline",
      actions: `${kind}.${row ? "running" : "stopped"}`,
      target: { project: target.project, worktree: target.worktree, url: row?.url ?? undefined },
      children: row ? portNodes(row, id) : [],
    };
  };
  const projects = known.filter((target) => !target.worktree);
  return projects.map((project) => {
    const parent = node(project);
    const worktrees = known.filter((target) => target.worktree && target.project === project.project).map(node);
    return { ...parent, children: [...worktrees, ...(parent.children ?? [])] };
  });
};

/** `desolate --dinds`: the supervisor's `status`. */
export interface DindStatus {
  dinds: { project?: string; name: string; health: string; running: boolean; inUse?: boolean;
           idleSince?: number; memory?: number; imageStoreKib?: number }[];
  headroom: { running: number; max: number; available: number; floor: number } | null;
}

const gib = (bytes: number | undefined) => (bytes === undefined ? "?" : `${(bytes / 1024 ** 3).toFixed(1)} GiB`);
const ago = (since: number | undefined, now: number) => {
  if (!since) return "?";
  const minutes = Math.max(0, Math.round((now - since) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
};

/** The Dinds view: one row per project dind, and the VM's headroom. */
export const dindsTree = (status: DindStatus, now = Date.now()): Node[] => {
  const rows: Node[] = status.dinds.map((dind) => ({
    id: `dind:${dind.name}`,
    label: dind.project || dind.name,
    description: [
      dind.health,
      dind.running ? (dind.inUse ? "in use" : `idle ${ago(dind.idleSince, now)}`) : undefined,
      dind.running ? gib(dind.memory) : undefined,
      `store ${dind.imageStoreKib === undefined ? "?" : gib(dind.imageStoreKib * 1024)}`,
    ].filter(Boolean).join(" · "),
    icon: dind.health === "healthy" ? "pass" : dind.running ? "warning" : "circle-slash",
  }));
  if (status.headroom) {
    const { running, max, available, floor } = status.headroom;
    rows.push({ id: "dind:headroom", label: "headroom", icon: "dashboard",
                description: `${running} of ${max} running · ${gib(available)} free, ${gib(floor)} kept back` });
  }
  return rows.length ? rows : [{ id: "dind:none", label: "no project dinds", icon: "info" }];
};

/** `work requests --json`: one row per request. */
export interface RequestRow {
  id: string;
  action?: string;
  worktree?: string;
  branch?: string | null;
  from?: string;
  title?: string | null;
  outcome: string;
  approved: boolean;
  unreadable?: string;
}

/** `work log --json`: one row per message, newest first. */
export interface MessageRow {
  commit: string;
  time: string;
  from: string;
  to: string[];
  type: string;
  body: string;
  worktree?: string;
  state?: string;
}

/** Whether a message is waiting on a person: an `ask` to the main tree, the
 *  human, or everyone. */
export const needsAnswer = (message: MessageRow) =>
  message.type === "ask" && message.to.some((to) => to === "main" || to === "@human" || to === "*");

const oneLine = (text: string, max = 120) => {
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * The Factory view, for one project with a factory: its policy, its requests
 * (a refused or waiting one can be approved), its open worktrees (pushed or
 * closed by hand), and its messages -- asks to a person first, and marked.
 */
export const factoryTree = (
  project: string,
  policy: Record<string, unknown>,
  requests: RequestRow[],
  messages: MessageRow[],
  openWorktrees: string[],
): Node => {
  const id = `factory:${project}`;
  const asks = messages.filter(needsAnswer);
  const policyNodes: Node[] = Object.entries(policy).map(([key, value]) => ({
    id: `${id}:policy:${key}`, label: key, description: oneLine(JSON.stringify(value)), icon: "settings",
  }));
  const requestNodes: Node[] = requests.map((request) => {
    const approvable = !request.approved && (/^refused/.test(request.outcome) || request.outcome === "waiting");
    return {
      id: `${id}:request:${request.id}`,
      label: request.unreadable ? `unreadable request` : `${request.action} ${request.worktree}`,
      description: oneLine(`${request.outcome}${request.approved ? " (approved)" : ""} · from ${request.from ?? "?"}`),
      tooltip: oneLine(request.unreadable ?? request.title ?? request.branch ?? "", 400),
      icon: /^refused/.test(request.outcome) ? "error" : request.outcome === "pending" ? "clock" : "check",
      actions: approvable ? "request.approvable" : "request",
      target: { project, request: request.id },
    };
  });
  const worktreeNodes: Node[] = openWorktrees.map((worktree) => ({
    id: `${id}:worktree:${worktree}`, label: worktree, icon: "git-branch", actions: "factory.worktree",
    target: { project, worktree },
  }));
  const messageNode = (message: MessageRow): Node => ({
    id: `${id}:message:${message.commit}`,
    label: `${message.type}: ${oneLine(message.body, 80)}`,
    description: `${oneLine(message.from, 40)} → ${oneLine(message.to.join(","), 40)} · ${message.time}`,
    tooltip: oneLine(message.body, 2000),
    icon: needsAnswer(message) ? "question" : message.type === "done" ? "pass" : message.type === "blocked" ? "error" : "comment",
    actions: needsAnswer(message) ? "message.ask" : "message",
    target: { project, from: message.from },
  });
  return {
    id,
    label: project,
    description: asks.length ? `${asks.length} ask${asks.length === 1 ? "" : "s"} waiting` : `${requests.length} requests`,
    icon: asks.length ? "bell-dot" : "organization",
    actions: "factory.project",
    target: { project },
    children: [
      ...(asks.length ? [{ id: `${id}:asks`, label: "waiting on you", icon: "bell-dot", children: asks.map(messageNode) }] : []),
      { id: `${id}:worktrees`, label: "worktrees", icon: "git-branch", children: worktreeNodes },
      { id: `${id}:requests`, label: "requests", icon: "inbox", children: requestNodes },
      { id: `${id}:messages`, label: "messages", icon: "comment-discussion", children: messages.map(messageNode) },
      { id: `${id}:policy`, label: "policy", icon: "settings", children: policyNodes },
    ],
  };
};
