// The pusher: the one process in the root VM that can use a write key, as a user of its own
// (desolate-pusher), and only to move one branch, from the commit a person approved it
// moving from to the commit they approved.
//
// WHY. The root's ordinary user runs everything here that parses what a domain sends: git on
// agent-written packs, outbox files, the dashboard's state. It used to push too, with the
// write agent open to it for the two minutes an approval lasts; a bug in any of those
// parsers could have pushed another branch, or another commit, in that window (the
// independent audit's F6 on the M1).
//
// WHAT THIS DOES NOT DO: PARSE. A first version took a bundle from that user and ran git on
// it, here, with the write agent in reach: a bug in git's pack parsing that compromised the
// root's user could have been sent straight on to this one (the audit of that version said
// so). Now nothing the root's user sends is parsed in this process, beyond one JSON line
// (at most 1 MiB, read by node's own parser) that says how many bytes follow:
//   - the pack is forwarded to the remote as bytes, counted, never read. The forge's git
//     reads it;
//   - an LFS object is hashed as it arrives, and goes up only if it hashes to its name.
//     git-lfs uploads it from a repository of this push's own that holds no git object;
//   - what is pushed is decided by the keyring's record of the approval, not by anything
//     sent: this process speaks git's push protocol itself (receive-pack: a few lines of
//     text with the forge) and asks for exactly one ref update, `<onto> <commit>
//     refs/heads/<branch>`. The forge applies it atomically: the branch is `onto` and
//     becomes `commit`, or nothing changes. A pack without `commit` in it cannot make the
//     branch point at it, and a pack cannot name a ref.
// What it reads besides: the keyring's answers, the forge's ref list and status lines, and
// the forge's address and host key from root's own copy (PINNED_FORGE).
//
//   node pusher.ts          (as desolate-pusher; started and kept by root/start.sh)
//
// ONE PUSH, THEN GONE. After a push (pushed or not) this process exits, and root's supervisor
// kills every process of this user before starting the next one, which empties this user's
// home before it listens.
//
// The socket (PUSHER.control) is in a directory only the root's user and this user enter.
// One request per connection:
//   {"op":"ping"}                                             -> {"ok":true}
//   {"op":"push","approval":id,"pack":N,"lfs":[{"oid","size"}...]}\n
//     then each LFS object's bytes in that order, then N bytes of pack
//                                       -> {"ok":true,...} | {"ok":false,"error","moved"}
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import { isBranch, isCommit, isLfsOid, parseRepo } from "../shared/names.ts";
import { run } from "../shared/run.ts";
import { ask } from "./keyring-client.ts";
import { GITCONFIG, KEYRING, PINNED_FORGE, PUSHER } from "./layout.ts";

const LIMIT = { header: 1024 * 1024, pack: 2 * 1024 ** 3, lfs: 5 * 1024 ** 3, objects: 2000, advertised: 64 * 1024 * 1024, idleMs: 60_000 } as const;
const ZERO = "0".repeat(40);
const log = (message: string) => console.error(`${new Date().toISOString()} pusher: ${message}`);

type Approved = { id: string; repo: string; ref: string; commit: string; onto: string | null; pubkey: string };

/** The forge's address, from root's own copy (the host writes it, as root): the root's user
 *  cannot aim a push elsewhere. */
export const forgeAddress = (): { user: string; host: string; port: number } => {
  const f = JSON.parse(fs.readFileSync(PINNED_FORGE.config, "utf8")) as { ssh?: { user?: string; host?: string; port?: number } };
  const ssh = f.ssh ?? {};
  if (!/^[a-z_][a-z0-9_-]*$/.test(ssh.user ?? "") || !/^[A-Za-z0-9.-]+$/.test(ssh.host ?? "") || !Number.isInteger(ssh.port)) throw new Error("the forge's address is not well formed");
  return ssh as { user: string; host: string; port: number };
};

const sshOptions = (identity: string) => [
  "-F", "/dev/null", "-o", `IdentityAgent=${KEYRING.writeAgent}`, "-o", `IdentityFile=${identity}`, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${PINNED_FORGE.knownHosts}`, "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15",
];
const env = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: PUSHER.home, LANG: "C.UTF-8",
  GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", ...extra,
});

// ---------------------------------------------------------------- git's pkt-line, by hand
/** One pkt-line: four hex digits of length (the four included), then the text. */
export const pkt = (text: string) => {
  const body = Buffer.from(text, "utf8");
  if (body.length > 65516) throw new Error("a pkt-line is at most 65516 bytes");
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
};
export const FLUSH = Buffer.from("0000");

/** pkt-lines from a stream: `next()` gives a line's text, or null for a flush. */
export const pktReader = (stream: Readable, limit: number) => {
  let buffered = Buffer.alloc(0);
  let total = 0;
  let ended = false;
  let failed: Error | null = null;
  let wake: (() => void) | null = null;
  stream.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total > limit) failed = new Error("the forge said more than desolate reads");
    buffered = Buffer.concat([buffered, chunk]);
    wake?.();
  });
  stream.on("end", () => {
    ended = true;
    wake?.();
  });
  stream.on("error", (error: Error) => {
    failed = error;
    wake?.();
  });
  const need = async (count: number) => {
    while (buffered.length < count) {
      if (failed) throw failed;
      if (ended) throw new Error("the forge ended the conversation early");
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
    if (failed) throw failed;
  };
  return {
    next: async (): Promise<string | null> => {
      await need(4);
      const head = buffered.subarray(0, 4).toString("latin1");
      if (!/^[0-9a-f]{4}$/.test(head)) throw new Error("the forge did not speak git's protocol");
      const length = parseInt(head, 16);
      if (length === 0) {
        buffered = buffered.subarray(4);
        return null;
      }
      if (length < 5) throw new Error("the forge sent a pkt-line desolate does not use");
      await need(length);
      const line = buffered.subarray(4, length).toString("utf8");
      buffered = buffered.subarray(length);
      return line;
    },
  };
};

/** What the forge's ref list says `refs/heads/<branch>` is (ZERO: there is no such branch). */
export const advertised = (lines: string[], branch: string): string => {
  const want = `refs/heads/${branch}`;
  for (const [index, raw] of lines.entries()) {
    const line = (index === 0 ? raw.split("\0")[0]! : raw).replace(/\n$/, "");
    const [id, name, extra] = line.split(" ");
    if (!/^[0-9a-f]{40}$/.test(id ?? "") || !name || extra !== undefined) throw new Error("the forge's ref list is not one desolate reads");
    if (name === want) return id!;
  }
  return ZERO;
};

/** The forge's report: did it take the one update asked for? */
export const reported = (lines: string[], ref: string): { ok: true } | { ok: false; error: string } => {
  const text = lines.map((line) => line.replace(/\n$/, ""));
  if (text[0] !== "unpack ok") return { ok: false, error: `the forge could not unpack what was sent (${(text[0] ?? "no report").slice(0, 200)})` };
  if (text.slice(1).includes(`ok ${ref}`)) return { ok: true };
  const ng = text.find((line) => line.startsWith(`ng ${ref} `));
  return { ok: false, error: `the forge refused the update: ${ng ? ng.slice(ref.length + 4, ref.length + 204) : "no answer for the branch"}` };
};

/** The whole conversation with the forge's receive-pack: read its ref list; if the branch is
 *  not exactly `onto`, stop; else ask for the one update `<onto> <commit> refs/heads/<branch>`,
 *  let `sendPack` put the pack on the wire, and read the forge's report. */
export const updateRef = async (
  forge: { stdin: Writable; stdout: Readable },
  branch: string, onto: string | null, commit: string,
  sendPack: (sink: Writable) => Promise<void>,
): Promise<{ ok: true } | { ok: false; moved: boolean; error: string }> => {
  const from = onto ?? ZERO;
  const ref = `refs/heads/${branch}`;
  const reader = pktReader(forge.stdout, LIMIT.advertised);
  const refs: string[] = [];
  for (let line = await reader.next(); line !== null; line = await reader.next()) refs.push(line);
  if (refs.length === 0) throw new Error("the forge listed no refs, not even an empty repository's");
  const now = advertised(refs, branch);
  // Already there (a push that landed, asked again): nothing to do, and it is done.
  if (now === commit) {
    await write(forge.stdin, FLUSH).catch(() => {});
    return { ok: true };
  }
  if (now !== from) {
    await write(forge.stdin, FLUSH).catch(() => {});
    return { ok: false, moved: true, error: `the remote's ${branch} is ${now === ZERO ? "not there" : `at ${now.slice(0, 12)}`}, not ${onto ? `at the ${onto.slice(0, 12)}` : "absent, as"} the approval names: nothing was pushed` };
  }
  // The pack is made with offset deltas (send.ts); a forge that does not take them is told
  // nothing rather than sent what it cannot read.
  const caps = (refs[0]!.split("\0")[1] ?? "").trim().split(" ");
  if (!caps.includes("report-status") || !caps.includes("ofs-delta")) throw new Error(`the forge does not offer what desolate's push needs (report-status, ofs-delta): ${caps.join(" ").slice(0, 200)}`);
  await write(forge.stdin, Buffer.concat([pkt(`${from} ${commit} ${ref}\0report-status agent=desolate-pusher\n`), FLUSH]));
  // From here the forge may take the update as soon as the pack is whole, whatever happens
  // after: its report is read while the pack goes, and a failure past this point says that
  // the push may have landed, never that nothing was pushed.
  const report = (async () => {
    const lines: string[] = [];
    for (let line = await reader.next(); line !== null; line = await reader.next()) lines.push(line);
    return reported(lines, ref);
  })();
  report.catch(() => {});
  try {
    await sendPack(forge.stdin);
  } catch (error) {
    const said = await Promise.race([report, new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))]).catch(() => null);
    if (said?.ok) return said;
    throw new Uncertain(`sending the pack failed (${(error as Error).message})`);
  }
  let result: Awaited<typeof report>;
  try {
    result = await report;
  } catch (error) {
    throw new Uncertain(`the forge's report did not arrive (${(error as Error).message})`);
  }
  return result.ok ? result : { ok: false, moved: /non-fast-forward|fetch first|stale|lock/.test(result.error), error: result.error };
};

/** A failure after the ref update was asked for: the forge may have applied it. */
export class Uncertain extends Error {}

// ---------------------------------------------------------------- what arrives
/** Exactly `count` bytes from a socket, each chunk to `sink` (a file, the forge), hashed on
 *  the way. Gives up when nothing arrives for a minute. */
const receive = (socket: Socket, first: Buffer, count: number, sink: (chunk: Buffer) => Promise<void> | void): Promise<{ rest: Buffer; sha256: string }> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let left = count;
    let idle: NodeJS.Timeout | undefined;
    const stop = () => {
      clearTimeout(idle);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("end", onClose);
      socket.pause();
    };
    const fail = (error: Error) => {
      stop();
      reject(error);
    };
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail(new Error("nothing arrived for a minute")), LIMIT.idleMs);
    };
    const take = async (chunk: Buffer) => {
      const part = chunk.subarray(0, left);
      left -= part.length;
      if (part.length > 0) {
        hash.update(part);
        await sink(part);
      }
      return chunk.subarray(part.length);
    };
    const finish = (rest: Buffer) => {
      stop();
      resolve({ rest, sha256: hash.digest("hex") });
    };
    // The minute is the sender's: it runs while waiting for bytes, not while the forge (or
    // the disk) takes the last chunk.
    const onData = (chunk: Buffer) => {
      socket.pause();
      clearTimeout(idle);
      void take(chunk).then((rest) => {
        if (left === 0) return finish(rest);
        arm();
        socket.resume();
      }, fail);
    };
    const onClose = () => fail(new Error("the connection ended before everything arrived"));
    void take(first).then((rest) => {
      if (left === 0) return finish(rest);
      socket.on("data", onData);
      socket.on("close", onClose);
      socket.on("end", onClose);
      arm();
      socket.resume();
    }, fail);
  });

const write = (stream: Writable, chunk: Buffer) =>
  new Promise<void>((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) return reject(new Error("the forge stopped listening"));
    if (stream.write(chunk)) return resolve();
    const onError = (error: Error) => reject(error);
    stream.once("error", onError);
    stream.once("drain", () => {
      stream.off("error", onError);
      resolve();
    });
  });

// ---------------------------------------------------------------- one push
const lfsPath = (dir: string, oid: string) => path.join(dir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);

const push = async (socket: Socket, request: Record<string, unknown>, rest: Buffer): Promise<Record<string, unknown>> => {
  const id = String(request.approval ?? "");
  const reply = await ask(KEYRING.pusher, { op: "approval", id });
  if (reply.ok !== true) return { ok: false, error: `the keyring holds no live approval ${id.slice(0, 40)}: nothing was pushed` };
  const approved = reply.approval as Approved;
  const repo = parseRepo(approved.repo);
  if (!repo || !isBranch(approved.ref) || !isCommit(approved.commit) || (approved.onto !== null && !isCommit(approved.onto)) || typeof approved.pubkey !== "string")
    return { ok: false, error: "the keyring's approval is not well formed" };
  const packSize = Number(request.pack);
  const lfs = Array.isArray(request.lfs) ? (request.lfs as { oid?: unknown; size?: unknown }[]) : [];
  if (!Number.isInteger(packSize) || packSize < 32 || packSize > LIMIT.pack) return { ok: false, error: "a pack is a whole number of bytes, at most 2 GiB" };
  if (lfs.length > LIMIT.objects || lfs.some((o) => !isLfsOid(o.oid) || !Number.isInteger(o.size) || (o.size as number) < 0 || (o.size as number) > LIMIT.lfs))
    return { ok: false, error: "LFS objects are named by sha256, with a size of at most 5 GiB" };
  const ref = `refs/heads/${approved.ref}`;
  const onto = approved.onto ?? ZERO;
  const forge = forgeAddress();
  const work = fs.mkdtempSync(path.join(PUSHER.home, "push-"));
  const identity = path.join(work, "write.pub");
  fs.writeFileSync(identity, `${approved.pubkey.trim()}\n`, { mode: 0o600 });
  try {
    // LFS first: the remote never has a pointer without its object. Each object is the
    // bytes that hash to its name, or nothing goes up.
    let left = rest;
    if (lfs.length > 0) {
      const dir = path.join(work, "lfs.git");
      const made = await run("git", ["init", "--bare", "--quiet", dir], { env: env() });
      if (made.code !== 0) return { ok: false, error: `cannot make the pusher's LFS repository: ${made.stderr.trim()}` };
      fs.rmSync(path.join(dir, "hooks"), { recursive: true, force: true });
      for (const object of lfs) {
        const file = lfsPath(dir, object.oid as string);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const out = fs.openSync(`${file}.part`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
        let got: { rest: Buffer; sha256: string };
        try {
          got = await receive(socket, left, object.size as number, (chunk) => void fs.writeSync(out, chunk));
        } finally {
          fs.closeSync(out);
        }
        left = got.rest;
        if (got.sha256 !== object.oid) return { ok: false, error: `an LFS object did not hash to its name (${String(object.oid).slice(0, 12)}): nothing was pushed` };
        fs.renameSync(`${file}.part`, file);
      }
      const url = `ssh://${forge.user}@${forge.host}:${forge.port}/${repo.owner}/${repo.name}.git`;
      log(`${approved.repo}: uploading ${lfs.length} LFS object(s)`);
      const up = await run("git", ["--git-dir", dir, "-c", `safe.directory=${dir}`, "-c", "core.hooksPath=/dev/null", "-c", `remote.origin.url=${url}`, "-c", `lfs.url=${url}`, "-c", `lfs.pushurl=${url}`, "-c", "lfs.locksverify=false",
        "lfs", "push", "origin", "--object-id", ...lfs.map((o) => o.oid as string)], { env: env({ GIT_DIR: dir, GIT_SSH_COMMAND: ["ssh", ...sshOptions(identity)].join(" ") }), timeoutMs: 1_800_000 });
      if (up.code !== 0) return { ok: false, error: `the LFS objects did not upload, so the commit was not pushed: ${up.stderr.trim().split("\n").slice(-2).join(" | ")}` };
    }

    // The one ref update, and the pack as it came.
    const ssh = spawn("ssh", [...sshOptions(identity), "-p", String(forge.port), `${forge.user}@${forge.host}`, `git-receive-pack '${repo.owner}/${repo.name}.git'`], { env: env(), stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    ssh.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
    ssh.stdin.on("error", () => {});
    const exited = new Promise<number>((resolve) => ssh.on("close", (code) => resolve(code ?? 1)));
    const timer = setTimeout(() => ssh.kill("SIGKILL"), 1_800_000);
    try {
      const result = await updateRef(ssh, approved.ref, approved.onto, approved.commit, async (sink) => {
        left = (await receive(socket, left, packSize, (chunk) => write(sink, chunk))).rest;
      });
      ssh.stdin.end();
      await exited;
      if (!result.ok) return { ok: false, moved: result.moved, error: result.error };
      log(`${approved.repo}: ${approved.ref} ${onto.slice(0, 12)} -> ${approved.commit}`);
      return { ok: true, repo: approved.repo, branch: approved.ref, commit: approved.commit };
    } catch (error) {
      ssh.kill("SIGKILL");
      const said = stderr.trim() ? ` (ssh: ${stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 300)})` : "";
      if (error instanceof Uncertain) return { ok: false, uncertain: true, error: `${error.message}${said}: the push may have reached the remote; \`desolate fetch ${approved.repo}\` shows whether ${approved.ref} is at ${approved.commit.slice(0, 12)}` };
      return { ok: false, error: `${(error as Error).message}${said}: nothing was pushed` };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await ask(KEYRING.pusher, { op: "revoke", id }).catch(() => {});
    fs.rmSync(work, { recursive: true, force: true });
  }
};

let pushing = false;
let server: ReturnType<typeof createServer>;
const handle = (socket: Socket) => {
  socket.on("error", () => socket.destroy());
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf(10);
    if (end < 0) return head.length > LIMIT.header ? socket.destroy() : undefined;
    socket.off("data", onData);
    socket.pause();
    const rest = head.subarray(end + 1);
    const answer = (value: Record<string, unknown>) => socket.end(JSON.stringify(value) + "\n");
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(head.subarray(0, end).toString("utf8")) as Record<string, unknown>;
    } catch {
      return answer({ ok: false, error: "not a request" });
    }
    if (request.op === "ping") return answer({ ok: true });
    if (request.op !== "push") return answer({ ok: false, error: `unknown op '${String(request.op).slice(0, 40)}'` });
    // One push per process: the next waits for the next process (root/send.ts retries).
    if (pushing) return answer({ ok: false, busy: true, error: "another push is under way" });
    pushing = true;
    server.close();
    const exit = () => process.exit(0);
    void push(socket, request, rest)
      .then(answer, (error: Error) => answer({ ok: false, error: error.message }))
      .finally(() => {
        socket.once("close", exit);
        setTimeout(exit, 5000).unref();
      });
  };
  socket.on("data", onData);
};

const main = async () => {
  // Whatever an earlier push's process left in this user's home: gone, before anything.
  for (const name of fs.readdirSync(PUSHER.home)) fs.rmSync(path.join(PUSHER.home, name), { recursive: true, force: true });
  fs.rmSync(PUSHER.control, { force: true });
  // The directory (root/start.sh: this user's, the root's user's group, 0750) is the gate.
  const before = process.umask(0o111);
  server = createServer({ allowHalfOpen: true }, handle);
  await new Promise<void>((resolve) => server.listen(PUSHER.control, resolve));
  process.umask(before);
  log(`listening at ${PUSHER.control}`);
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname) void main();
