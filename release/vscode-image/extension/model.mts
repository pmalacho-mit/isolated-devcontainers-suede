/**
 * model.mts -- what the desolate extension shows, decided without VS Code.
 *
 * Everything here is a pure function from what the editor's own commands
 * print -- `desolate --list --json`, `desolate --dinds` -- and each target's
 * status (status.ts) to the nodes of a tree, so the unit tests read the same
 * decisions the views make. extension.mts only draws them and runs the
 * commands a node's actions name.
 *
 * Text that came from a project -- a status's message -- is shown as plain
 * text, never as markdown: a writer chooses every byte of it.
 */

/** One node of a view. `actions` is VS Code's contextValue, the set of
 *  commands this node offers; `command` is what a click runs. */
export interface Node {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  /** A theme colour id for the icon: a target's status colour. */
  iconColor?: string;
  actions?: string;
  children?: Node[];
  /** What the node's actions act on. */
  target?: { project: string; worktree?: string; url?: string };
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

/** A target's status (status.ts): what its agent said, in a colour. */
export interface Status {
  color: string;
  message: string;
  updated: string;
}

/** A status colour, as the theme names it -- so it reads in light and dark. */
export const STATUS_THEME_COLOR: Record<string, string> = {
  gray: "disabledForeground",
  blue: "charts.blue",
  green: "charts.green",
  yellow: "charts.yellow",
  orange: "charts.orange",
  red: "charts.red",
};

/** The key a target's status is found under. */
export const targetKey = ({ project, worktree }: { project: string; worktree?: string | null }) => `${project}@${worktree ?? ""}`;

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

/** An editor URL carries its connection token; the token belongs in the
 *  link the user opens, never in a log anyone can read over a shoulder. */
export const redactTokens = (text: string) => text.replace(/([?&]tkn=)[^&#\s"'<>]+/g, "$1…");

/** The editor first, then each container port in order -- not in the order
 *  an object happens to keep its keys, which puts "5173" before "editor". */
/** Each one can be opened: the editor at its URL, token and all (it is the
 *  link; it never reaches a label), a container port at its loopback address. */
const portNodes = (row: Running, id: string, at: Known): Node[] =>
  Object.entries(row.ports).sort(([a], [b]) =>
    a === "editor" ? -1 : b === "editor" ? 1 : Number(a) - Number(b)).map(([label, port]) => ({
    id: `${id}:port:${label}`,
    label: label === "editor" ? "editor" : `container :${label}`,
    description: `127.0.0.1:${port}`,
    icon: label === "editor" ? "window" : "plug",
    actions: "port",
    target: { ...at, url: label === "editor" && row.url ? row.url : `http://127.0.0.1:${port}/` },
  }));

/**
 * The Projects view: every project, each with its worktrees, and for what is
 * running its ports and the actions that make sense for it -- and, where its
 * agent set one, its status: the icon in its colour, its message beside it.
 */
export const projectsTree = (known: Known[], running: Running[], statuses = new Map<string, Status>()): Node[] => {
  const up = new Map(running.map((row) => [targetKey(row), row]));
  const node = (target: Known): Node => {
    const key = targetKey(target);
    const row = up.get(key);
    const status = statuses.get(key);
    const id = `target:${key}`;
    const kind = target.worktree ? "worktree" : "project";
    const state = row ? `running${row.daemon === "project" ? " · own dind" : ""}` : "stopped";
    return {
      id,
      label: target.worktree ?? target.project,
      description: status?.message ? `${status.message} · ${state}` : state,
      tooltip: status ? `${status.color}: ${status.message || "(no message)"} -- ${status.updated} (${state})` : undefined,
      icon: row ? "vm-running" : "vm-outline",
      iconColor: status ? STATUS_THEME_COLOR[status.color] ?? STATUS_THEME_COLOR.gray : undefined,
      actions: `${kind}.${row ? "running" : "stopped"}`,
      target: { project: target.project, worktree: target.worktree, url: row?.url ?? undefined },
      children: row ? portNodes(row, id, target) : [],
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
