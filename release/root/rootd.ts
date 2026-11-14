// The root's daemon. For now it has one job: the request channel (section 6.4). A workspace
// may ask the root for a fixed set of things, by writing a request file into its domain's
// outbox; the root answers in the inbox, which the domain cannot write. Each request is
// validated against the workspace's DOMAIN (which outbox it arrived in: a path the host
// decides, not a field the workspace fills in), and rate-limited. The answer is whether it
// was done. Nothing on this channel can name a key, a host or a path.
//
//   fetch <repo>            refresh the mirror
//   offer <repo> <branch>   a bundle is waiting in the outbox
//
// And it imports each domain's branches into the root clones as the domain writes them out.
//
// virtiofs delivers no file events across VMs, so outboxes are polled.
import * as fs from "node:fs";
import * as path from "node:path";
import { writeJson } from "../shared/json.ts";
import { parseRepo } from "../shared/names.ts";
import { sleep } from "../shared/run.ts";
import { domains } from "./domains.ts";
import { fetchDomain, take } from "./offers.ts";
import { drain, inbox, outbox } from "./outbox.ts";
import { waiting } from "./pushed.ts";
import * as repos from "./repos.ts";

const RATE = { perMinute: 30 } as const;
const recent = new Map<string, number[]>();
const allowed = (domain: string) => {
  const now = Date.now();
  const times = (recent.get(domain) ?? []).filter((time) => now - time < 60_000);
  if (times.length >= RATE.perMinute) return false;
  times.push(now);
  recent.set(domain, times);
  return true;
};

const handle = async (domain: string, repoList: string[], request: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const repo = parseRepo(request.repo);
  // Only its own domain's repositories.
  if (!repo || !repoList.includes(String(request.repo))) return { ok: false, error: "that repository is not in this domain" };
  if (request.op === "fetch") {
    await repos.fetch(repo);
    return { ok: true };
  }
  if (request.op === "offer") return take(domain, request);
  return { ok: false, error: "the root takes 'fetch' and 'offer' from a workspace, and nothing else" };
};

const log = (line: string) => process.stderr.write(`${new Date().toISOString()} rootd: ${line}\n`);

/** A domain's branches, brought into the root clone as the domain writes them out (its list
 *  beside each bundle changes), not only when one is reviewed or offered: so `git fetch
 *  root` in the git VM, and the dashboard's review, have every branch. The import is the
 *  one a review does (offers.ts fetchDomain: git-remote-desolate, every object checked). At
 *  most one every few seconds per repository, whatever the domain writes. */
const IMPORT_GAP_MS = 3000;
const imported = new Map<string, { mtime: number; at: number }>();
const importChanged = async (slug: string, repoList: string[]) => {
  for (const id of repoList) {
    const repo = parseRepo(id);
    if (!repo) continue;
    let mtime = 0;
    try {
      // (A stat of the domain's file, read for its time only: what it says is not used.)
      mtime = fs.lstatSync(path.join(outbox(slug), "sync", id, "refs.json")).mtimeMs;
    } catch {
      continue;
    }
    const key = `${slug}\0${id}`;
    const last = imported.get(key);
    if (last && (last.mtime === mtime || Date.now() - last.at < IMPORT_GAP_MS)) continue;
    imported.set(key, { mtime, at: Date.now() });
    await fetchDomain(slug, repo).catch((error: Error) => log(`${slug} ${id}: not imported: ${error.message.slice(0, 300)}`));
  }
};

/** A pushed branch's pull request is merged on the forge, not here: so a repository with a
 *  push still waiting to land is fetched now and then (pushed.ts), and its mirror shows the
 *  merge without anyone asking. The same fetch as `desolate fetch`, with the read key. */
const LANDED_EVERY_MS = Number(process.env.DESOLATE_LANDED_CHECK_MS) || 15 * 60_000;
let landedAt = Date.now();
let checking = false;
// Beside the loop, not in it: a fetch can take minutes, and requests keep being answered.
const checkLanded = () => {
  if (checking || Date.now() - landedAt < LANDED_EVERY_MS) return;
  checking = true;
  landedAt = Date.now();
  void (async () => {
    for (const id of waiting()) {
      const repo = parseRepo(id);
      if (repo) await repos.fetch(repo).catch((error: Error) => log(`${id}: not fetched to look for merges: ${error.message.slice(0, 300)}`));
    }
  })().finally(() => {
    checking = false;
  });
};

log("up");
for (;;) {
  checkLanded();
  for (const d of domains()) {
    await importChanged(d.slug, d.repos);
    // Each request is read once and removed, by name, in a directory that was checked to be
    // the outbox's own (outbox.ts): never through a path a workspace could have redirected.
    for (const { name, data: request } of drain<Record<string, unknown>>(path.join(outbox(d.slug), "requests"), /^[0-9a-z-]{1,60}\.json$/, 50)) {
      let reply: Record<string, unknown>;
      if (!request || typeof request.op !== "string") reply = { ok: false, error: "not a request" };
      else if (!allowed(d.slug)) reply = { ok: false, error: `this domain has made ${RATE.perMinute} requests in a minute; wait and ask again` };
      else
        try {
          reply = await handle(d.slug, d.repos, request);
        } catch (error) {
          reply = { ok: false, error: error instanceof Error ? error.message.slice(0, 500) : "the root failed" };
        }
      log(`${d.slug} ${String(request?.op)} ${String(request?.repo)} -> ${reply.ok === true ? "ok" : `refused: ${String(reply.error)}`}`);
      writeJson(path.join(inbox(d.slug), "replies", name), reply);
    }
    // Replies are read within moments; old ones are swept.
    try {
      for (const name of fs.readdirSync(path.join(inbox(d.slug), "replies")))
        if (Date.now() - fs.statSync(path.join(inbox(d.slug), "replies", name)).mtimeMs > 600_000) fs.rmSync(path.join(inbox(d.slug), "replies", name), { force: true });
    } catch {
      /* no replies yet */
    }
  }
  await sleep(250);
}
