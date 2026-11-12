// The one place a root clone's commits leave for the remote. Both ways a person pushes come
// here: `desolate push` on the host (push.ts) and a raw `git push origin` in the root's
// terminal (git-remote-desolate-push.ts). By the time this runs, the keyring holds an
// approval the person gave ON THE HOST for exactly this repository, branch and commit, and
// for what the remote's branch is now (`onto`).
//
// This user does not push. It cannot reach a write key at all (the independent audit's F6:
// it is the user that parses what domains send). It hands the pusher (root/pusher.ts, a user
// of its own) the approval's id, a pack, and the LFS objects the remote lacks. The pusher
// asks the keyring what that id names, and asks the forge for that one ref update and no
// other; it reads nothing of what this sends (the pack goes to the forge as bytes).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { connect } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Repo } from "../shared/names.ts";
import { git, gitInvocation } from "./git.ts";
import { clonePath, PUSHER } from "./layout.ts";
import { lfsOf } from "./offers.ts";

type Failed = { error: string; moved: boolean };

/** One push handed over: the header line, then each file's bytes; the pusher's answer. */
const handOver = (header: Record<string, unknown>, files: string[]): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const socket = connect(PUSHER.control);
    let answer = "";
    let failure: NodeJS.ErrnoException | null = null;
    let connected = false;
    let done = false;
    const finish = (value: Record<string, unknown> | Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (value instanceof Error) reject(Object.assign(value, { connected }));
      else resolve(value);
    };
    // An early answer (a refusal) can come while the pack is still going, and the write
    // then fails: the answer is what counts, so the failure waits for the close.
    socket.on("error", (error: NodeJS.ErrnoException) => (failure = error));
    socket.on("data", (chunk) => {
      answer += chunk.toString();
      const end = answer.indexOf("\n");
      if (end < 0) return;
      try {
        finish(JSON.parse(answer.slice(0, end)) as Record<string, unknown>);
      } catch {
        finish(new Error("the pusher's answer was not JSON"));
      }
    });
    socket.on("close", () => finish(failure ?? new Error("the pusher closed the connection without an answer")));
    socket.on("connect", async () => {
      connected = true;
      socket.write(JSON.stringify(header) + "\n");
      for (const file of files)
        for await (const chunk of fs.createReadStream(file)) {
          if (done || socket.destroyed) return;
          if (!socket.write(chunk)) await new Promise((resolve) => (socket.once("drain", resolve), socket.once("close", resolve)));
        }
    });
  });

/** The pusher is one push per process (pusher.ts): a moment between pushes, it is starting.
 *  Asked again only when the push never reached it: one that did may have claimed the
 *  approval (and each approval is pushed once). */
const RETRY = new Set(["ENOENT", "ECONNREFUSED"]);
const withPusher = async <T>(attempt: () => Promise<T & { busy?: unknown }>): Promise<T> => {
  for (const until = Date.now() + 60_000; ; ) {
    try {
      const result = await attempt();
      if (result.busy !== true || Date.now() > until) return result;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRY.has(code) || (error as { connected?: boolean }).connected || Date.now() > until) throw new Error(`the pusher: ${(error as Error).message}; desolate doctor`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

/** Returns null when the remote took it, or why it did not. The pusher pushes what the
 *  approval names, whatever this sends; what this sends is what makes that possible: a pack
 *  with the commit and what the remote lacks of its history (as the mirror last saw the
 *  remote), and the LFS objects that history adds. */
export const send = async (repo: Repo, approval: string, commit: string): Promise<Failed | null> => {
  const clone = clonePath(repo);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-send-"));
  try {
    const pack = path.join(work, "push.pack");
    // What the remote has, as the mirror saw it, is left out (the clone's origin/* are the
    // mirror's branches). Not thin: the forge resolves every delta from the pack itself.
    const have = (await git(clone, ["for-each-ref", "--format=%(objectname)", "refs/remotes/origin"])).stdout.split("\n").filter((id) => /^[0-9a-f]{40}$/.test(id));
    const out = fs.openSync(pack, "w", 0o600);
    const packed = await new Promise<{ code: number; stderr: string }>((resolve) => {
      const how = gitInvocation(clone);
      const child = spawn("git", [...how.args, "pack-objects", "--stdout", "--revs", "--delta-base-offset", "--quiet"], { env: how.env, stdio: ["pipe", out, "pipe"] });
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
      child.stdin!.end([commit, ...have.map((id) => `^${id}`), ""].join("\n"));
    });
    fs.closeSync(out);
    if (packed.code !== 0) return { error: `cannot pack the commit for the pusher: ${packed.stderr.trim().split("\n").slice(-2).join(" | ")}`, moved: false };
    // LFS objects the remote lacks and this clone holds (what came with offers).
    const files: string[] = [];
    const lfs: { oid: string; size: number }[] = [];
    for (const oid of await lfsOf(repo, commit)) {
      const file = path.join(clone, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
      if (!fs.existsSync(file)) continue;
      lfs.push({ oid, size: fs.statSync(file).size });
      files.push(file);
    }
    if (lfs.length > 0) process.stderr.write(`uploading ${lfs.length} LFS object(s)\n`);
    files.push(pack);
    const reply = await withPusher(() => handOver({ op: "push", approval, pack: fs.statSync(pack).size, lfs }, files));
    if (reply.ok === true) return null;
    return { error: String(reply.error ?? "the pusher refused the push"), moved: reply.moved === true };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};
