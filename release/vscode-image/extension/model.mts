/**
 * model.mts -- what the desolate extension shows, decided without VS Code.
 *
 * Everything here is a pure function from what the editor's own commands
 * print -- `desolate --list --json`, `desolate --dinds`, `desolate --review
 * --json` -- and what the panel reads as files (status.ts, panel.ts) to the
 * nodes of a tree, so the unit tests read the same decisions the views make.
 * extension.mts only draws them and runs the commands a node's actions name.
 *
 * Text that came from a project -- a status's message, a note, a commit's
 * subject, a path -- is plain text, never markdown: a writer chooses every
 * byte of it. A node says it as `details`, whose labels are ours and whose
 * text is theirs, and extension.mts escapes the text.
 */
import type { Review } from "../review.ts";

/** One line of a tooltip: our label, and text that may be anyone's. */
export interface Detail {
  label: string;
  text: string;
}

/** One node of a view. `actions` is VS Code's contextValue, the set of
 *  commands this node offers; `click` is what clicking it runs. */
export interface Node {
  id: string;
  label: string;
  description?: string;
  /** The same as `details`, as one plain string: for tests, and the fallback. */
  tooltip?: string;
  details?: Detail[];
  icon?: string;
  /** A theme colour id for the icon: a target's status colour. */
  iconColor?: string;
  actions?: string;
  children?: Node[];
  /** Drawn open the first time it is seen (VS Code remembers it after). */
  expanded?: boolean;
  click?: string;
  /** What the node's actions act on. */
  target?: TargetRef;
  /** A review file's index, for opening its two sides. */
  file?: number;
}

/** A target, as a node's actions need it. */
export interface TargetRef {
  project: string;
  worktree?: string;
  url?: string;
  branch?: string;
  /** Its GitHub repository, for links. */
  repo?: string;
  running?: boolean;
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

/** What the panel reads of a target as files (panel.ts), labels resolved. */
export interface Facts {
  branch?: string;
  commit?: string;
  github: "same" | "differs" | "new" | "unknown";
  note?: string;
  portLabel?: (port: number) => string | undefined;
  repo?: string;
}

/** A review's counts, for the commit it reviewed: shown while that is still
 *  what is checked out. */
export interface Counts {
  head: string;
  ahead: number;
  behind: number;
}

/** A project dind's memory, from `desolate --dinds`. */
export interface Memory {
  used?: number;
  limit?: number;
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

/** The colours that ask something of a person: a question, a failure, work
 *  to review, a withdrawal to agree with. */
export const ATTENTION = ["orange", "red", "green", "gray"] as const;
const ATTENTION_ICON: Record<string, string> = { orange: "question", red: "error", green: "pass-filled", gray: "circle-slash" };
const ATTENTION_WORD: Record<string, string> = { orange: "asks", red: "is stuck", green: "is ready", gray: "withdrew" };

/** The key a target is found under. */
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

export const gib = (bytes: number | undefined) => (bytes === undefined ? "?" : `${(bytes / 1024 ** 3).toFixed(1)} GiB`);

/** How long ago, short: 4m, 3h, 2d. */
export const ago = (then: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
};

/** A long branch, shortened in its middle -- its start says what kind, its
 *  end which one: downstream/acme/app-5e0c… keeps both. */
export const shortBranch = (branch: string, max = 30) =>
  branch.length <= max ? branch : `${branch.slice(0, Math.ceil(max / 2) - 1)}…${branch.slice(-(Math.floor(max / 2)))}`;

/** `issue-<n>`, as the dispatcher names a worktree for an issue. */
export const issueOf = (worktree?: string) => {
  const match = (worktree ?? "").match(/^issue-(\d{1,9})$/);
  return match ? Number(match[1]) : undefined;
};

const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The GitHub pages a target has: its issue, its branch, the PRs from its
 *  branch. Built from names this side holds to their shape, and opened by
 *  the browser -- the extension itself reaches nothing. */
export interface Links {
  repository?: string;
  issue?: string;
  branch?: string;
  pulls?: string;
}
export const githubLinks = (target: TargetRef): Links => {
  if (!target.repo || !GITHUB_REPO.test(target.repo)) return {};
  const base = `https://github.com/${target.repo}`;
  const issue = issueOf(target.worktree);
  return {
    repository: base,
    ...(issue !== undefined ? { issue: `${base}/issues/${issue}` } : {}),
    ...(target.branch ? {
      branch: `${base}/tree/${target.branch.split("/").map(encodeURIComponent).join("/")}`,
      pulls: `${base}/pulls?q=${encodeURIComponent(`is:pr head:${target.branch}`)}`,
    } : {}),
  };
};

/** The sync marker beside a branch: what a push would do, as far as the
 *  panel can tell without git -- and exactly, once a review has counted it. */
const syncText = (facts: Facts | undefined, counts: Counts | undefined) => {
  if (!facts || facts.github === "same" || facts.github === "unknown") return "";
  if (counts && counts.head === facts.commit) {
    const parts = [counts.ahead ? `↑${counts.ahead}` : "", counts.behind ? `↓${counts.behind}` : ""].filter(Boolean);
    return parts.join(" ") || "≠ GitHub";
  }
  return facts.github === "new" ? "↑ not on GitHub" : "≠ GitHub";
};
const GITHUB_SAYS: Record<Facts["github"], string> = {
  same: "has this commit",
  differs: "has this branch at another commit",
  new: "has no such branch yet",
  unknown: "not seen yet: push or pull once through desolate",
};

/** The editor first, then each container port in order -- not in the order
 *  an object happens to keep its keys, which puts "5173" before "editor".
 *  Each one can be opened: the editor at its URL, token and all (it is the
 *  link; it never reaches a label), a container port at its loopback address. */
const portNodes = (row: Running, id: string, at: TargetRef, facts?: Facts): Node[] =>
  Object.entries(row.ports).sort(([a], [b]) =>
    a === "editor" ? -1 : b === "editor" ? 1 : Number(a) - Number(b)).map(([label, port]) => {
    const named = label === "editor" ? undefined : facts?.portLabel?.(Number(label));
    return {
      id: `${id}:port:${label}`,
      label: label === "editor" ? "editor" : named ? `${named} (${label})` : `container :${label}`,
      description: `:${port}`,
      tooltip: `127.0.0.1:${port}`,
      icon: label === "editor" ? "window" : "plug",
      actions: "port",
      click: "desolate.openPort",
      target: { ...at, url: label === "editor" && row.url ? row.url : `http://127.0.0.1:${port}/` },
    };
  });

export interface ProjectsInput {
  known: Known[];
  running: Running[];
  statuses?: Map<string, Status>;
  facts?: Map<string, Facts>;
  /** By project: its dind's memory. */
  memory?: Map<string, Memory>;
  /** By target key: what is being done to it right now ("starting…"). */
  busy?: Map<string, string>;
  counts?: Map<string, Counts>;
  /** Show only what is running (and the projects it is in). */
  runningOnly?: boolean;
  now?: number;
}

/**
 * The Projects view: every project under its owner, each with its ports when
 * it runs, the note its agent left, and its worktrees. A target's icon says
 * whether it runs (its shape) and what its agent said (its colour); beside it,
 * its branch, whether GitHub has it, its message, and its dind's memory.
 */
export const projectsTree = (input: ProjectsInput): Node[] => {
  const { known, running, runningOnly = false, now = Date.now() } = input;
  const statuses = input.statuses ?? new Map<string, Status>(), facts = input.facts ?? new Map<string, Facts>();
  const memory = input.memory ?? new Map<string, Memory>(), busy = input.busy ?? new Map<string, string>();
  const counts = input.counts ?? new Map<string, Counts>();
  const up = new Map(running.map((row) => [targetKey(row), row]));

  const node = (target: Known): Node => {
    const key = targetKey(target);
    const row = up.get(key);
    const status = statuses.get(key);
    const fact = facts.get(key);
    const doing = busy.get(key);
    const id = `target:${key}`;
    const kind = target.worktree ? "worktree" : "project";
    const name = target.worktree ?? target.project.split("/").pop()!;
    const ref: TargetRef = {
      project: target.project,
      ...(target.worktree ? { worktree: target.worktree } : {}),
      ...(row?.url ? { url: row.url } : {}),
      ...(fact?.branch ? { branch: fact.branch } : {}),
      ...(fact?.repo ? { repo: fact.repo } : {}),
      running: Boolean(row),
    };
    const sync = syncText(fact, counts.get(key));
    // A worktree is usually on a branch of its own name: said once, not twice.
    const branch = fact?.branch && !(target.worktree && fact.branch === target.worktree) ? shortBranch(fact.branch) : "";
    const mem = !target.worktree && row ? memory.get(target.project) : undefined;
    const description = [
      doing,
      [branch, sync].filter(Boolean).join(" "),
      status?.message,
      mem?.used !== undefined ? (mem.limit ? `${(mem.used / 1024 ** 3).toFixed(1)} / ${gib(mem.limit)}` : gib(mem.used)) : undefined,
    ].filter(Boolean).join(" · ");
    const state = row ? `running${row.daemon === "project" ? " · its own dind" : ""}` : "stopped";
    const details: Detail[] = [
      { label: kind === "project" ? "Project" : "Worktree", text: kind === "project" ? target.project : `${target.worktree} of ${target.project}` },
      ...(status ? [{ label: `Status (${status.color}, ${status.updated ? `${ago(Date.parse(status.updated), now)} ago` : "?"})`, text: status.message || "(no message)" }] : []),
      { label: "State", text: doing ?? state },
      ...(fact?.branch || fact?.commit ? [{ label: "Branch", text: `${fact.branch ?? "(detached)"}${fact.commit ? ` at ${fact.commit.slice(0, 12)}` : ""}` }] : []),
      ...(fact?.branch ? [{ label: "GitHub", text: `${GITHUB_SAYS[fact.github]}${sync && !sync.startsWith("≠") && !sync.includes("not on") ? ` (${sync}, as last reviewed)` : ""}` }] : []),
      ...(mem?.used !== undefined ? [{ label: "Memory", text: `${gib(mem.used)}${mem.limit ? ` of ${gib(mem.limit)}` : ""}` }] : []),
      ...(row?.ports.editor ? [{ label: "Editor", text: `127.0.0.1:${row.ports.editor}` }] : []),
    ];
    const issue = issueOf(target.worktree);
    const links = githubLinks(ref);
    const actions = [
      `${kind}.${row ? "running" : "stopped"}`,
      ...(fact?.github === "new" || fact?.github === "differs" ? ["unpushed"] : []),
      ...(links.repository ? ["github"] : []),
      ...(links.branch ? ["branch"] : []),
      ...(issue !== undefined && links.issue ? ["issue"] : []),
      ...(doing ? ["busy"] : []),
    ].join(".");
    const children: Node[] = [
      ...(row ? portNodes(row, id, ref, fact) : []),
      ...(fact?.note ? [{
        id: `${id}:note`,
        label: "note",
        description: fact.note.split("\n").find((line) => line.trim())?.trim().slice(0, 120),
        tooltip: fact.note,
        details: [{ label: "Note", text: fact.note }],
        icon: "note",
        actions: "note",
        click: "desolate.openNote",
        target: ref,
      }] : []),
    ];
    return {
      id,
      label: name,
      description,
      tooltip: details.map((d) => `${d.label}: ${d.text}`).join("\n"),
      details,
      icon: doing ? "loading~spin" : row ? "vm-running" : "vm-outline",
      ...(!doing && status ? { iconColor: STATUS_THEME_COLOR[status.color] ?? STATUS_THEME_COLOR.gray } : {}),
      actions,
      target: ref,
      children,
      expanded: Boolean(row),
    };
  };

  const projects = known.filter((target) => !target.worktree)
    .map((project) => {
      const parent = node(project);
      const worktrees = known.filter((target) => target.worktree && target.project === project.project)
        .filter((target) => !runningOnly || up.has(targetKey(target)))
        .map(node);
      const shown = !runningOnly || up.has(targetKey(project)) || worktrees.length > 0;
      // Opened when anything in it runs, so a running worktree is in sight.
      const expanded = parent.expanded || worktrees.some((w) => w.target?.running);
      return shown ? { ...parent, expanded, children: [...(parent.children ?? []), ...worktrees] } : undefined;
    })
    .filter((node): node is NonNullable<typeof node> => node !== undefined);

  if (!projects.length)
    return runningOnly && known.length
      ? [{ id: "projects:none-running", label: "nothing is running", description: "show stopped ones too: the filter above", icon: "info" }]
      : [];

  // Under their owners; a project with no owner stands on its own, after them.
  const owners = [...new Set(projects.map((p) => p.target!.project).filter((p) => p.includes("/")).map((p) => p.split("/")[0]))].sort();
  return [
    ...owners.map((owner): Node => ({
      id: `owner:${owner}`,
      label: owner,
      icon: "organization",
      expanded: true,
      children: projects.filter((p) => p.target!.project.startsWith(`${owner}/`)),
    })),
    ...projects.filter((p) => !p.target!.project.includes("/")),
  ];
};

/** How many targets run, and what the VM has left, for the Projects view's
 *  title: "2 running · 9.1 GiB free". */
export const projectsSummary = (running: Running[], headroom?: DindStatus["headroom"]) =>
  [`${running.length} running`, headroom ? `${gib(headroom.available)} free` : undefined].filter(Boolean).join(" · ");

/**
 * The Needs you view: every target whose agent asked something of a person
 * -- a question, a failure, work to review, a withdrawal -- newest first,
 * with its whole message. One you have marked as seen stays out of it until
 * its agent says something new (`seen`: the `updated` you saw).
 */
export const needsYouTree = (input: {
  known: Known[];
  running: Running[];
  statuses: Map<string, Status>;
  facts?: Map<string, Facts>;
  seen?: Map<string, string>;
  now?: number;
}): Node[] => {
  const { known, running, statuses, now = Date.now() } = input;
  const facts = input.facts ?? new Map<string, Facts>(), seen = input.seen ?? new Map<string, string>();
  const up = new Map(running.map((row) => [targetKey(row), row]));
  return known
    .map((target) => ({ target, key: targetKey(target), status: statuses.get(targetKey(target)) }))
    .filter(({ key, status }) => status && (ATTENTION as readonly string[]).includes(status.color) && seen.get(key) !== status.updated)
    .sort((a, b) => Date.parse(b.status!.updated || "0") - Date.parse(a.status!.updated || "0"))
    .map(({ target, key, status }): Node => {
      const row = up.get(key);
      const fact = facts.get(key);
      const ref: TargetRef = {
        project: target.project,
        ...(target.worktree ? { worktree: target.worktree } : {}),
        ...(row?.url ? { url: row.url } : {}),
        ...(fact?.branch ? { branch: fact.branch } : {}),
        ...(fact?.repo ? { repo: fact.repo } : {}),
        running: Boolean(row),
      };
      const links = githubLinks(ref);
      const when = status!.updated ? ago(Date.parse(status!.updated), now) : "";
      return {
        id: `needs:${key}`,
        label: `${target.project.split("/").pop()}${target.worktree ? ` · ${target.worktree}` : ""}`,
        description: [status!.message || `(${status!.color}, no message)`, when].filter(Boolean).join(" · "),
        tooltip: `${target.project}${target.worktree ? `@${target.worktree}` : ""} ${ATTENTION_WORD[status!.color]}: ${status!.message}`,
        details: [
          { label: "Target", text: `${target.project}${target.worktree ? ` · ${target.worktree}` : ""}` },
          { label: `Its agent ${ATTENTION_WORD[status!.color]} (${when} ago)`, text: status!.message || "(no message)" },
          ...(fact?.branch ? [{ label: "Branch", text: fact.branch }] : []),
        ],
        icon: ATTENTION_ICON[status!.color],
        iconColor: STATUS_THEME_COLOR[status!.color],
        actions: [`needs.${status!.color}`, row ? "running" : "stopped", ...(links.issue ? ["issue"] : []), ...(links.branch ? ["branch"] : [])].join("."),
        click: "desolate.reveal",
        target: ref,
      };
    });
};

/** A review's file, by its status letter: the icon and its colour. */
const FILE_LOOK: Record<string, [string, string]> = {
  A: ["diff-added", "gitDecoration.addedResourceForeground"],
  M: ["diff-modified", "gitDecoration.modifiedResourceForeground"],
  D: ["diff-removed", "gitDecoration.deletedResourceForeground"],
  R: ["diff-renamed", "gitDecoration.renamedResourceForeground"],
  C: ["diff-added", "gitDecoration.addedResourceForeground"],
  T: ["diff-modified", "gitDecoration.modifiedResourceForeground"],
};

/**
 * The Review view: what a push of a target's branch would send (`desolate
 * --review`), for a person to read first -- what it is compared with, any
 * reason the push would be refused or would leave work behind, the commits,
 * and the files, each of which opens its two sides.
 */
export const reviewTree = (review: Review, target: TargetRef, now = Date.now()): Node[] => {
  const branch = review.branch ?? `detached at ${review.head.slice(0, 12)}`;
  const fresh = review.base && review.base.ref !== `origin/${review.branch}`;
  const nodes: Node[] = [{
    id: "review:summary",
    label: `${branch} → ${review.base?.ref ?? "GitHub"}`,
    description: `${review.ahead} commit${review.ahead === 1 ? "" : "s"} to push${fresh ? " · a new branch on GitHub" : ""}`,
    details: [
      { label: "Target", text: `${target.project}${target.worktree ? ` · ${target.worktree}` : ""}` },
      { label: "Compared with", text: review.base ? `${review.base.ref} (${review.base.commit.slice(0, 12)}), as the last pull or fetch left it` : "nothing: GitHub's branches were never fetched here" },
      ...(fresh ? [{ label: "On GitHub", text: `no ${review.branch} yet: the push creates it` }] : []),
    ],
    icon: "git-compare",
  }];
  if (!review.branch)
    nodes.push({ id: "review:detached", label: "no branch is checked out", description: "a push needs one: check a branch out in the devcontainer", icon: "warning", iconColor: "charts.red" });
  if (review.behind)
    nodes.push({ id: "review:behind", label: "pull first", description: `${review.base?.ref} has ${review.behind} commit${review.behind === 1 ? "" : "s"} this branch lacks; the push would be refused`, icon: "warning", iconColor: "charts.orange" });
  if (!review.ahead)
    nodes.push({ id: "review:nothing", label: "nothing to push", description: `GitHub has every commit of ${branch}`, icon: "check" });
  if (review.uncommitted)
    nodes.push({ id: "review:uncommitted", label: `${review.uncommitted} uncommitted change${review.uncommitted === 1 ? "" : "s"}`, description: "not sent: commit in the devcontainer first", icon: "info", iconColor: "charts.yellow" });
  if (review.commits.length)
    nodes.push({
      id: "review:commits",
      label: "Commits",
      description: `${review.ahead}${review.ahead > review.commits.length ? `, the newest ${review.commits.length} shown` : ""}`,
      icon: "git-commit",
      expanded: true,
      children: review.commits.map((commit) => ({
        id: `review:commit:${commit.commit}`,
        label: commit.subject || "(no subject)",
        description: `${commit.commit.slice(0, 7)} · ${commit.author} · ${ago(commit.time * 1000, now)}`,
        details: [{ label: "Commit", text: commit.commit }, { label: "Author", text: commit.author }, { label: "Subject", text: commit.subject }],
        icon: "circle-small",
      })),
    });
  if (review.files.length)
    nodes.push({
      id: "review:files",
      label: "Files",
      description: `${review.files.length}${review.more ? "+" : ""} changed`,
      icon: "files",
      expanded: true,
      children: review.files.map((file) => {
        const slash = file.path.lastIndexOf("/");
        const [icon, color] = FILE_LOOK[file.status[0]] ?? ["diff-modified", "gitDecoration.modifiedResourceForeground"];
        const note = file.kind === "text" ? "" : ` (${file.kind === "module" ? "submodule" : file.kind}: not shown)`;
        return {
          id: `review:file:${file.index}`,
          label: slash < 0 ? file.path : file.path.slice(slash + 1),
          description: `${slash < 0 ? "" : file.path.slice(0, slash)}${file.from ? ` ← ${file.from}` : ""}${note}`.trim(),
          details: [{ label: file.from ? "Renamed" : "File", text: file.from ? `${file.from} → ${file.path}` : file.path },
                    { label: "Change", text: `${file.status} (${file.sizes[0]} → ${file.sizes[1]} bytes)` }],
          icon,
          iconColor: color,
          actions: `reviewfile.${file.kind}`,
          click: "desolate.openReviewFile",
          file: file.index,
          target,
        };
      }),
    });
  return nodes;
};

/** A target, as the palette offers it: what it is, and what it says. */
export const pickItems = (input: { known: Known[]; running: Running[]; statuses?: Map<string, Status>; facts?: Map<string, Facts> }) => {
  const up = new Map(input.running.map((row) => [targetKey(row), row]));
  return input.known.map((target) => {
    const key = targetKey(target);
    const row = up.get(key);
    const fact = input.facts?.get(key);
    const status = input.statuses?.get(key);
    const ref: TargetRef = {
      project: target.project,
      ...(target.worktree ? { worktree: target.worktree } : {}),
      ...(row?.url ? { url: row.url } : {}),
      ...(fact?.branch ? { branch: fact.branch } : {}),
      ...(fact?.repo ? { repo: fact.repo } : {}),
      running: Boolean(row),
    };
    return {
      label: `${row ? "$(vm-running)" : "$(vm-outline)"} ${target.project}${target.worktree ? ` · ${target.worktree}` : ""}`,
      description: [fact?.branch, row ? "running" : "stopped"].filter(Boolean).join(" · "),
      detail: status?.message ? `${status.color}: ${status.message}` : undefined,
      target: ref,
    };
  });
};

/** `desolate --dinds`: the supervisor's `status`. */
export interface DindStatus {
  dinds: { project?: string; name: string; health: string; running: boolean; inUse?: boolean;
           idleSince?: number; memory?: number; memoryLimit?: number; imageStoreKib?: number }[];
  headroom: { running: number; max: number; available: number; floor: number } | null;
}

/** Each project's dind memory, for the Projects view. */
export const memoryByProject = (status: DindStatus | undefined) =>
  new Map((status?.dinds ?? []).filter((d) => d.project && d.running).map((d) => [d.project!, { used: d.memory, limit: d.memoryLimit }]));

/** How long a dind has been idle, to the minute: 1h30m. */
const idleFor = (since: number | undefined, now: number) => {
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
      dind.running ? (dind.inUse ? "in use" : `idle ${idleFor(dind.idleSince, now)}`) : undefined,
      dind.running ? `${gib(dind.memory)}${dind.memoryLimit ? ` of ${gib(dind.memoryLimit)}` : ""}` : undefined,
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
