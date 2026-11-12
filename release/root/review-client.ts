// The root's user's side of the reviewer (reviewer.ts): before it asks a person to approve a
// push, it sends the reviewer what the reviewer needs to say what the push is. That is
// all it can do there: what the summary says, the reviewer works out from commit ids the
// host gives it.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { connect } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { repoId } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { git } from "./git.ts";
import { ask } from "./keyring-client.ts";
import { clonePath, REVIEWER } from "./layout.ts";

const RETRY = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]);
/** The reviewer is one request per process: between two, it is starting. */
export const withReviewer = async <T>(attempt: () => Promise<T>): Promise<T> => {
  for (const until = Date.now() + 30_000; ; ) {
    try {
      return await attempt();
    } catch (error) {
      if (!RETRY.has((error as NodeJS.ErrnoException).code ?? "") || Date.now() > until) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};

const handOver = (header: Record<string, unknown>, file: string): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const socket = connect(REVIEWER.control);
    let answer = "";
    let done = false;
    const finish = (value: Record<string, unknown> | Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    socket.on("error", finish);
    socket.on("data", (chunk) => {
      answer += chunk.toString();
      const end = answer.indexOf("\n");
      if (end >= 0)
        try {
          finish(JSON.parse(answer.slice(0, end)) as Record<string, unknown>);
        } catch {
          finish(new Error("the reviewer's answer was not JSON"));
        }
    });
    socket.on("close", () => finish(new Error("the reviewer closed the connection without an answer")));
    socket.on("connect", async () => {
      socket.write(JSON.stringify(header) + "\n");
      for await (const chunk of fs.createReadStream(file)) if (!socket.write(chunk)) await new Promise((r) => socket.once("drain", r));
    });
  });

/** Send the reviewer the commit and what the remote has (as the mirror saw it), less what it
 *  holds already. Returns why not, or null. A reviewer that is down is not a reason to stop
 *  a push: the page says it could not say what the push is. */
export const submitForReview = async (repo: Repo, commit: string): Promise<string | null> => {
  const clone = clonePath(repo);
  try {
    const held = await withReviewer(() => ask(REVIEWER.control, { op: "tips", repo: repoId(repo) }, 30_000));
    const have: string[] = [];
    for (const tip of Array.isArray(held.tips) ? (held.tips as string[]) : []) if ((await git(clone, ["cat-file", "-e", `${tip}^{commit}`])).code === 0) have.push(tip);
    const ref = `refs/desolate/review/${randomBytes(8).toString("hex")}`;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-review-"));
    try {
      await git(clone, ["update-ref", ref, commit]);
      const bundle = path.join(work, "review.bundle");
      const made = await git(clone, ["bundle", "create", "--quiet", bundle, ref, "--remotes=origin", ...have.map((id) => `^${id}`)], { timeoutMs: 1_800_000 });
      if (made.code !== 0) return /empty bundle/i.test(made.stderr) ? null : `cannot bundle for the reviewer: ${made.stderr.trim().split("\n").pop()}`;
      const reply = await withReviewer(() => handOver({ op: "submit", repo: repoId(repo), bundle: fs.statSync(bundle).size }, bundle));
      return reply.ok === true ? null : String(reply.error);
    } finally {
      await git(clone, ["update-ref", "-d", ref]).catch(() => {});
      fs.rmSync(work, { recursive: true, force: true });
    }
  } catch (error) {
    return (error as Error).message;
  }
};
