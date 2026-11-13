// `desolate events`: what happens in the stack, as JSON lines, for a script on the Mac to act
// on (open a pull request when a branch is pushed, say). The host daemon gathers them.
//
// Every event says where it comes from, because that is how much it can be believed:
//   "host"    the host itself: a workspace it started or stopped, an approval it signed on
//             the approval page (parsed from the signed text), a push the git VM handed it.
//   "pusher"  the root's pusher (root/pusher.ts), from a log only root writes: what the
//             keyring's record of the approval named, and what the forge answered. A
//             `pushed` from here means the remote has that commit on that branch.
//   "root"    the root's ordinary user (its state service): offers, refusals, statuses,
//             pushes waiting. That user parses what domains send; these are its word, and an
//             agent wrote the text in them (a status message, a branch name). Act on them
//             as you would on an agent's word. Their strings are made safe to print (no
//             control characters, no bidirectional overrides), not true.
//
// One JSON object per line: {"v":1,"at","type","source",...}.
import { printable } from "../shared/text.ts";
import { isBranch, isCommit, isSlug, parseRepo } from "../shared/names.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../.suede/nests/dsl.import.meta.vitest.ts";

export type Event = { v: 1; at: string; type: string; source: "host" | "pusher" | "root" } & Record<string, unknown>;

/** A root-sourced name, only if it is one desolate would make (else null): a script may pass
 *  it on as an argument (`gh --head "$branch"`), and no valid one starts with `-`. */
const repoOrNull = (value: unknown) => (parseRepo(value) ? String(value) : null);
const branchOrNull = (value: unknown) => (isBranch(value) ? value : null);
const commitOrNull = (value: unknown) => (isCommit(value) ? value : null);
const slugOrNull = (value: unknown) => (isSlug(value) ? String(value) : null);
/** At most this many events from one change of the root's state. */
const PER_CHANGE = 200;

// (The fixed keys last: no field can stand in for them.)
const event = (type: string, source: Event["source"], fields: Record<string, unknown>): Event => ({ at: new Date().toISOString(), ...fields, v: 1, type, source });

/** A line of the pusher's log that is an event (`EVENT {...}`), checked field by field. */
export const pusherEvent = (line: string): Event | null => {
  const match = /^EVENT (\{.*\})$/.exec(line);
  if (!match) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!["pushed", "push-failed", "push-uncertain"].includes(String(raw.type))) return null;
  if (!parseRepo(raw.repo) || !isBranch(raw.branch) || !isCommit(raw.commit) || (raw.onto !== null && !isCommit(raw.onto))) return null;
  return { ...event(String(raw.type), "pusher", { repo: raw.repo, branch: raw.branch, commit: raw.commit, onto: raw.onto, ...(raw.type === "pushed" ? {} : { error: printable(raw.error) }) }), at: typeof raw.at === "string" ? printable(raw.at, 40) : new Date().toISOString() };
};

type State = {
  offers?: { domain?: unknown; workspace?: unknown; repo?: unknown; branch?: unknown; commit?: unknown }[];
  refused?: { domain?: unknown; repo?: unknown; why?: unknown }[];
  approvals?: { repo?: unknown; branch?: unknown; commit?: unknown }[];
  domains?: { slug?: unknown; workspaces?: { workspace?: unknown; checkouts?: { repo?: unknown; head?: { branch?: unknown; commit?: unknown } | null }[]; says?: { status?: { color?: unknown; message?: unknown; updated?: unknown } | null } }[] }[];
};

/** What changed between two of the root's states, as events (source "root"). */
export const stateEvents = (before: State | null, after: State): Event[] => {
  const out: Event[] = [];
  const key = (...parts: unknown[]) => parts.map((p) => String(p)).join("\0");
  const offerKey = (o: NonNullable<State["offers"]>[number]) => key(o.domain, o.repo, o.branch, o.commit);
  const was = new Map((before?.offers ?? []).map((o) => [offerKey(o), o]));
  const now = new Map((after.offers ?? []).map((o) => [offerKey(o), o]));
  for (const [k, o] of now) if (!was.has(k)) out.push(event("offered", "root", { domain: slugOrNull(o.domain), workspace: slugOrNull(o.workspace), repo: repoOrNull(o.repo), branch: branchOrNull(o.branch), commit: commitOrNull(o.commit) }));
  for (const [k, o] of was) if (!now.has(k)) out.push(event("offer-gone", "root", { domain: slugOrNull(o.domain), repo: repoOrNull(o.repo), branch: branchOrNull(o.branch), commit: commitOrNull(o.commit) }));
  const refusedKey = (r: NonNullable<State["refused"]>[number]) => key(r.domain, r.repo, r.why);
  const refusedBefore = new Set((before?.refused ?? []).map(refusedKey));
  for (const r of after.refused ?? []) if (!refusedBefore.has(refusedKey(r))) out.push(event("bundle-refused", "root", { domain: slugOrNull(r.domain), repo: repoOrNull(r.repo), why: printable(r.why) }));
  const waitingKey = (a: NonNullable<State["approvals"]>[number]) => key(a.repo, a.branch, a.commit);
  const waitingBefore = new Set((before?.approvals ?? []).map(waitingKey));
  for (const a of after.approvals ?? []) if (!waitingBefore.has(waitingKey(a))) out.push(event("approval-waiting", "root", { repo: repoOrNull(a.repo), branch: branchOrNull(a.branch), commit: commitOrNull(a.commit) }));
  const says = (state: State | null) => {
    const map = new Map<string, { domain: unknown; workspace: unknown; color?: unknown; message?: unknown; updated?: unknown }>();
    for (const d of state?.domains ?? []) for (const w of d.workspaces ?? []) if (w.says?.status) map.set(key(d.slug, w.workspace), { domain: d.slug, workspace: w.workspace, ...w.says.status });
    return map;
  };
  const saidBefore = says(before);
  for (const [k, s] of says(after)) {
    const old = saidBefore.get(k);
    if (!old || old.updated !== s.updated || old.color !== s.color || old.message !== s.message)
      out.push(event("status", "root", { domain: slugOrNull(s.domain), workspace: slugOrNull(s.workspace), color: /^(gray|blue|green|yellow|orange|red)$/.test(String(s.color)) ? s.color : null, message: printable(s.message, 200) }));
  }
  // What each checkout has checked out: a `git switch`, or a commit moving its branch.
  const heads = (state: State | null) => {
    const map = new Map<string, { domain: unknown; workspace: unknown; repo: unknown; branch: unknown; commit: unknown }>();
    for (const d of state?.domains ?? []) for (const w of d.workspaces ?? []) for (const c of w.checkouts ?? []) if (c.head) map.set(key(d.slug, w.workspace, c.repo), { domain: d.slug, workspace: w.workspace, repo: c.repo, branch: c.head.branch, commit: c.head.commit });
    return map;
  };
  const headsBefore = heads(before);
  for (const [k, h] of heads(after)) {
    const old = headsBefore.get(k);
    if (!old || old.branch !== h.branch || old.commit !== h.commit)
      out.push(event("head", "root", { domain: slugOrNull(h.domain), workspace: slugOrNull(h.workspace), repo: repoOrNull(h.repo), branch: branchOrNull(h.branch), commit: commitOrNull(h.commit), was: old ? { branch: branchOrNull(old.branch), commit: commitOrNull(old.commit) } : null }));
  }
  return out.slice(0, PER_CHANGE);
};

/** The daemon's hub: the last events, and whoever listens. */
export const hub = (keep = 500) => {
  const recent: Event[] = [];
  const listeners = new Set<(line: string) => void>();
  return {
    listening: () => listeners.size > 0,
    publish: (e: Event) => {
      recent.push(e);
      if (recent.length > keep) recent.shift();
      const line = JSON.stringify(e);
      for (const listen of listeners) listen(line);
    },
    host: (type: string, fields: Record<string, unknown>) => event(type, "host", fields),
    listen: (replay: number, listen: (line: string) => void) => {
      // (Nothing for 0: slice(-0) would be all of it.)
      if (replay > 0) for (const e of recent.slice(-Math.min(replay, keep))) listen(JSON.stringify(e));
      listeners.add(listen);
      return () => listeners.delete(listen);
    },
  };
};
