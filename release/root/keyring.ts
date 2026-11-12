// The keyring: the only process that holds private deploy keys (P3). From v2's keyring.ts,
// with v3's two changes: a key per ROLE, and a write key that signs only after a person
// approved that exact push (P2, section 5.3).
//
// THE CONTROL PROTOCOL has no export or read operation, by design. Everything it can do is
// something a root process could do by other means (make a key, read a public key, drop a
// key); nothing it can do yields private key material. Adding one would undo this file.
//
// TWO AGENTS, because fetches must not prompt and pushes must:
//   read-agent   holds each repository's read key. Signs freely.
//   write-agent  holds each pushable repository's write key, added with `ssh-add -c`: for
//                every signature ssh-agent runs keyring-askpass, which allows it only if an
//                unexpired approval for that repository is on file.
//
// AN APPROVAL IS A SIGNATURE MADE OUTSIDE THIS VM. The keyring issues a challenge naming
// the repository, branch and commit (shared/approval.ts); the approver on the HOST shows it
// to the person and signs it (on the host's terminal, or Touch ID if chosen; see host/approver.ts); the keyring files
// the approval only if that signature verifies against the approver's public key, which
// root installed at /etc/desolate/approver.pub. Nothing in this VM holds the approver's
// private key, so nothing in this VM can approve a push: not a script, not a fabricated
// terminal, not the root's own user. Anyone may ASK (challenge, approve); only the host's
// approver can answer.
/// <reference types="node" />
import { execFileSync, spawn } from "node:child_process";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import * as fs from "node:fs";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import * as path from "node:path";
import { formatApproval, parseApproval } from "../shared/approval.ts";
import { parseRepo, repoId, isBranch, isCommit } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { KEYRING } from "./layout.ts";

export type Role = "read" | "write";
const isRole = (value: unknown): value is Role => value === "read" || value === "write";

const log = (message: string) => console.error(`keyring: ${message}`);
const keyFile = (repo: Repo, role: Role) => path.join(KEYRING.keys, repo.owner, repo.name, role);
const pubFile = (repo: Repo, role: Role) => path.join(KEYRING.pub, repo.owner, repo.name, `${role}.pub`);
/** ssh-agent's own socket for a role. Only the keyring's user can open it. */
const agentOf = (role: Role) => path.join(KEYRING.private, `${role}-agent.sock`);
/** The key's comment is how keyring-askpass learns which repository a signature is for. */
export const commentOf = (repo: Repo, role: Role) => `desolate-${role}:${repoId(repo)}`;

const audit = (entry: Record<string, unknown>) => {
  fs.appendFileSync(KEYRING.audit, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n", { mode: 0o640 });
};

const publish = (repo: Repo, role: Role) => {
  const target = pubFile(repo, role);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  fs.copyFileSync(`${keyFile(repo, role)}.pub`, target);
  fs.chmodSync(target, 0o644);
};

const load = (repo: Repo, role: Role) => {
  // -c: confirm before each use. ssh-agent then runs $SSH_ASKPASS for every signature.
  const args = role === "write" ? ["-c", keyFile(repo, role)] : [keyFile(repo, role)];
  execFileSync("ssh-add", args, { env: { ...process.env, SSH_AUTH_SOCK: agentOf(role) }, stdio: ["ignore", "ignore", "pipe"] });
};

const held = (): { repo: Repo; role: Role }[] => {
  const out: { repo: Repo; role: Role }[] = [];
  const dirs = (dir: string) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  };
  for (const owner of dirs(KEYRING.keys))
    for (const name of dirs(path.join(KEYRING.keys, owner))) {
      const repo = parseRepo(`${owner}/${name}`);
      if (!repo) continue;
      for (const role of ["read", "write"] as const) if (fs.existsSync(`${keyFile(repo, role)}.pub`)) out.push({ repo, role });
    }
  return out;
};

const create = (repo: Repo, role: Role): string => {
  const key = keyFile(repo, role);
  fs.mkdirSync(path.dirname(key), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(key)) {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-f", key, "-N", "", "-C", commentOf(repo, role)], { stdio: ["ignore", "ignore", "pipe"] });
    fs.chmodSync(key, 0o600);
    log(`generated the ${role} key for ${repoId(repo)}`);
    audit({ event: "created", repo: repoId(repo), role });
    load(repo, role);
  }
  publish(repo, role);
  return fs.readFileSync(`${key}.pub`, "utf8").trim();
};

const remove = (repo: Repo, role: Role) => {
  try {
    execFileSync("ssh-add", ["-d", `${keyFile(repo, role)}.pub`], { env: { ...process.env, SSH_AUTH_SOCK: agentOf(role) }, stdio: "ignore" });
  } catch {
    /* not loaded */
  }
  for (const file of [keyFile(repo, role), `${keyFile(repo, role)}.pub`, pubFile(repo, role)]) fs.rmSync(file, { force: true });
  audit({ event: "removed", repo: repoId(repo), role });
};

// ---------------------------------------------------------------- approvals (P2)
/** `claimed`: the pusher has begun the push (pusherOps). Only then may the write key sign,
 *  and from then the approval lasts as long as a push may (CLAIMED_MS), for that one push. */
export type Approval = { id: string; repo: string; ref: string; commit: string; onto: string | null; expires: number; uses: number; by: string; claimed: boolean };
const CLAIMED_MS = 35 * 60_000;
const approvals = new Map<string, Approval>();
/** A push opens a few ssh connections (the push itself, LFS's authenticate calls), each one
 *  signature. An approval covers that one push: a short life and a small number of uses. */
export const APPROVAL = { lifeMs: 120_000, uses: 8 } as const;

/** Challenges this keyring issued and nobody has answered yet. Short-lived and few: a
 *  process that asks in a loop gets the oldest ones dropped, not memory. */
const challenges = new Map<string, { message: string; expires: number }>();
const CHALLENGE = { lifeMs: 120_000, outstanding: 32 } as const;

const challenge = (request: Record<string, unknown>): Record<string, unknown> => {
  const repo = parseRepo(request.repo);
  if (!repo || !isBranch(request.ref) || !isCommit(request.commit) || /^0{40}$/.test(request.commit)) return { ok: false, error: "a challenge names a repository, a branch and a 40-hex commit" };
  if (!fs.existsSync(keyFile(repo, "write"))) return { ok: false, error: `${repoId(repo)} has no write key: it is not pushable` };
  for (const [nonce, entry] of challenges) if (entry.expires < Date.now()) challenges.delete(nonce);
  while (challenges.size >= CHALLENGE.outstanding) challenges.delete(challenges.keys().next().value!);
  const onto = request.onto ?? null;
  if (onto !== null && (!isCommit(onto) || /^0{40}$/.test(onto))) return { ok: false, error: "a push names what the remote's branch is now (a commit), or null for a new branch" };
  const nonce = randomBytes(16).toString("hex");
  const message = formatApproval({ repo: repoId(repo), branch: request.ref, commit: request.commit, onto: onto as string | null, nonce });
  challenges.set(nonce, { message, expires: Date.now() + CHALLENGE.lifeMs });
  return { ok: true, message };
};

/** The approver's public key. Trusted only as root installed it: a file this VM's ordinary
 *  users could have replaced is no key at all (P6). */
const approverKey = (): { key: ReturnType<typeof createPublicKey> } | { error: string } => {
  try {
    for (const file of [path.dirname(KEYRING.approver), KEYRING.approver]) {
      const stat = fs.statSync(file);
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) return { error: `${file} is not root's alone to write, so it is not trusted` };
    }
    return { key: createPublicKey(fs.readFileSync(KEYRING.approver, "utf8")) };
  } catch (error) {
    return { error: `no approver key is installed at ${KEYRING.approver} (${(error as Error).message}); run \`desolate bootstrap\` on the host` };
  }
};

const approve = (request: Record<string, unknown>): Record<string, unknown> => {
  const parsed = parseApproval(request.message);
  if (!parsed) return { ok: false, error: "that is not an approval message" };
  const refused = (reason: string) => {
    audit({ event: "refused", repo: parsed.repo, ref: parsed.branch, commit: parsed.commit, reason });
    return { ok: false, error: reason };
  };
  const issued = challenges.get(parsed.nonce);
  if (!issued || issued.expires < Date.now() || issued.message !== request.message) return refused("that challenge is not outstanding: each lasts two minutes and approves once");
  const approver = approverKey();
  if ("error" in approver) return refused(approver.error);
  let valid = false;
  try {
    valid = typeof request.signature === "string" && verify("sha256", Buffer.from(issued.message), approver.key, Buffer.from(request.signature, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) return refused("the approval's signature is not the host approver's");
  challenges.delete(parsed.nonce);
  const repo = parseRepo(parsed.repo)!;
  if (!fs.existsSync(keyFile(repo, "write"))) return refused(`${parsed.repo} has no write key: it is not pushable`);
  const id = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  const approval: Approval = { id, repo: parsed.repo, ref: parsed.branch, commit: parsed.commit, onto: parsed.onto, expires: Date.now() + APPROVAL.lifeMs, uses: APPROVAL.uses, by: "host approver", claimed: false };
  approvals.set(id, approval);
  audit({ event: "approved", ...approval, expires: new Date(approval.expires).toISOString() });
  return { ok: true, id };
};

/** Whether a live approval names exactly this push. The pre-push hook's question. */
const approved = (request: Record<string, unknown>): Record<string, unknown> => {
  for (const approval of approvals.values())
    if (approval.expires >= Date.now() && approval.uses > 0 && approval.repo === request.repo && approval.ref === request.ref && approval.commit === request.commit && approval.onto === (request.onto ?? null)) return { ok: true, id: approval.id };
  return { ok: false, error: "no approval on file for that push" };
};

/** ssh-agent is about to sign with a write key. Allowed only against a live approval. */
const consume = (request: Record<string, unknown>): Record<string, unknown> => {
  const repo = String(request.repo ?? "");
  for (const approval of approvals.values()) {
    if (approval.expires < Date.now() || approval.uses <= 0) {
      approvals.delete(approval.id);
      continue;
    }
    if (approval.repo !== repo || !approval.claimed) continue;
    approval.uses -= 1;
    audit({ event: "signed", repo, approval: approval.id, ref: approval.ref, commit: approval.commit });
    return { ok: true, approval: approval.id };
  }
  audit({ event: "refused", repo, reason: "no approval on file" });
  return { ok: false, error: `no person has approved a push to ${repo}` };
};

const revoke = (request: Record<string, unknown>) => {
  const existed = approvals.delete(String(request.id ?? ""));
  if (existed) audit({ event: "revoked", approval: request.id });
  return { ok: true, existed };
};

// ---------------------------------------------------------------- the sockets
const publicOps = (request: Record<string, unknown>): Record<string, unknown> => {
  const { op } = request;
  if (op === "list") return { ok: true, keys: held().map(({ repo, role }) => ({ repo: repoId(repo), role })) };
  if (op === "audit") {
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(KEYRING.audit, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      /* nothing audited yet */
    }
    const last = Math.min(Number(request.last) || 50, 500);
    return { ok: true, entries: lines.slice(-last).map((line) => JSON.parse(line)) };
  }
  // Asking for an approval is open to every root process; granting one takes the host
  // approver's signature. Revoking only ever takes capability away.
  if (op === "challenge") return challenge(request);
  if (op === "approve") return approve(request);
  if (op === "approved") return approved(request);
  if (op === "revoke") return revoke(request);
  if (op === "create" || op === "pubkey" || op === "remove") {
    const repo = parseRepo(request.repo);
    if (!repo) return { ok: false, error: `not a repository: ${String(request.repo)}` };
    if (!isRole(request.role)) return { ok: false, error: "role is 'read' or 'write'" };
    if (op === "create") return { ok: true, pubkey: create(repo, request.role), identity: pubFile(repo, request.role) };
    if (op === "pubkey") {
      if (!fs.existsSync(`${keyFile(repo, request.role)}.pub`)) return { ok: false, error: `no ${request.role} key for ${repoId(repo)}` };
      publish(repo, request.role);
      return { ok: true, pubkey: fs.readFileSync(`${keyFile(repo, request.role)}.pub`, "utf8").trim(), identity: pubFile(repo, request.role) };
    }
    remove(repo, request.role);
    return { ok: true };
  }
  return { ok: false, error: `unknown op '${String(op)}': this socket has no operation that returns private key material, by design (see keyring.ts)` };
};

/** The pusher's questions (root/pusher.ts), on a socket only it reaches: what approval <id>
 *  names, exactly as the person approved it, and revoking it once the push is done. Asking
 *  claims it: one pusher process makes the push it names, once (an approval is claimed at
 *  most once), and only a claimed approval lets the write key sign. A claim lasts as long as
 *  a push may take (LFS objects first can take a while); the pusher revokes it when done. */
const pusherOps = (request: Record<string, unknown>): Record<string, unknown> => {
  if (request.op === "approval") {
    const approval = approvals.get(String(request.id ?? ""));
    if (!approval || approval.expires < Date.now() || approval.uses <= 0) return { ok: false, error: "no live approval with that id" };
    if (approval.claimed) return { ok: false, error: "that approval's push was begun already: each approval is pushed once" };
    const repo = parseRepo(approval.repo)!;
    // The write key's public half, which names the key in the agent: the pusher cannot read
    // KEYRING.pub (the root's user's), and needs nothing else of the keyring's.
    let pubkey = "";
    try {
      pubkey = fs.readFileSync(`${keyFile(repo, "write")}.pub`, "utf8").trim();
    } catch {
      return { ok: false, error: `${approval.repo} has no write key` };
    }
    approval.claimed = true;
    approval.expires = Date.now() + CLAIMED_MS;
    audit({ event: "claimed", approval: approval.id, repo: approval.repo, ref: approval.ref, commit: approval.commit });
    return { ok: true, approval: { id: approval.id, repo: approval.repo, ref: approval.ref, commit: approval.commit, onto: approval.onto, pubkey } };
  }
  if (request.op === "revoke") return revoke(request);
  return { ok: false, error: `unknown op '${String(request.op)}'` };
};

/** The reviewer's one question (root/reviewer.ts), on a socket only it reaches: a read key's
 *  public half, which names the key in the read agent. */
const reviewerOps = (request: Record<string, unknown>): Record<string, unknown> => {
  if (request.op !== "readkey") return { ok: false, error: `unknown op '${String(request.op)}'` };
  const repo = parseRepo(request.repo);
  if (!repo) return { ok: false, error: "not a repository" };
  try {
    return { ok: true, pubkey: fs.readFileSync(`${keyFile(repo, "read")}.pub`, "utf8").trim() };
  } catch {
    return { ok: false, error: `${repoId(repo)} has no read key` };
  }
};

const internalOps = (request: Record<string, unknown>): Record<string, unknown> => {
  // The askpass's question, and nothing else: ssh-agent runs it as this user.
  if (request.op === "consume") return consume(request);
  return { ok: false, error: `unknown op '${String(request.op)}'` };
};

const LIMIT = { bytes: 4096, concurrent: 16 } as const;

const serve = (socketPath: string, mode: number, handle: (request: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
  let open = 0;
  const reply = (connection: Socket, value: unknown) => connection.write(JSON.stringify(value) + "\n");
  const server = createServer((connection) => {
    if (open >= LIMIT.concurrent) {
      reply(connection, { ok: false, error: "too many connections" });
      return connection.destroy();
    }
    open++;
    connection.on("close", () => open--);
    connection.on("error", () => connection.destroy());
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > LIMIT.bytes) {
        reply(connection, { ok: false, error: "request too large" });
        return connection.destroy();
      }
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          reply(connection, handle(JSON.parse(line)));
        } catch (error) {
          reply(connection, { ok: false, error: `bad request: ${String(error)}` });
        }
      }
    });
  });
  // The mode is set by umask AT bind, not by a chmod after it: a chmod leaves a moment in
  // which the internal socket is connectable by anyone. One socket at a time: the umask is
  // process-wide, so the caller awaits this before anything else creates a file.
  return new Promise((resolve, reject) => {
    const before = process.umask(0o777 & ~mode);
    server.once("error", (error) => {
      process.umask(before);
      reject(error);
    });
    server.listen(socketPath, () => {
      process.umask(before);
      resolve();
    });
  });
};

/** The public face of an agent. Two reasons it exists:
 *   - ssh-agent refuses any peer whose uid is not its own, and the root's git runs as
 *     another user, so something owned by the keyring must carry the connection;
 *   - that something can filter. A client may LIST identities and ask for a SIGNATURE, and
 *     nothing else: it cannot add a key of its own, remove or lock the keys held, or (the
 *     point of the write agent) add a key that skips confirmation.
 *  The agent protocol frames each message as a uint32 length and a type byte. */
const AGENT = { requestIdentities: 11, signRequest: 13, failure: 5, maxFrame: 256 * 1024 } as const;
const relay = (publicPath: string, agentPath: string, mode = 0o660): Promise<void> => {
  const server = createServer((client) => {
    const agent = connect(agentPath);
    let pending = Buffer.alloc(0);
    const close = () => {
      client.destroy();
      agent.destroy();
    };
    client.on("error", close);
    agent.on("error", close);
    client.on("close", close);
    agent.on("close", close);
    agent.on("data", (chunk) => client.write(chunk));
    client.on("data", (chunk) => {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(0);
        if (length < 1 || length > AGENT.maxFrame) return close();
        if (pending.length < 4 + length) return;
        const frame = pending.subarray(0, 4 + length);
        pending = pending.subarray(4 + length);
        if (frame[4] === AGENT.requestIdentities || frame[4] === AGENT.signRequest) agent.write(frame);
        else client.write(Buffer.from([0, 0, 0, 1, AGENT.failure]));
      }
    });
  });
  return new Promise((resolve, reject) => {
    const before = process.umask(0o777 & ~mode);
    server.once("error", (error) => {
      process.umask(before);
      reject(error);
    });
    server.listen(publicPath, () => {
      process.umask(before);
      resolve();
    });
  });
};

const startAgent = (socketPath: string, env: NodeJS.ProcessEnv) => {
  const agent = spawn("ssh-agent", ["-D", "-a", socketPath], { stdio: ["ignore", "ignore", "inherit"], env });
  agent.on("error", (error) => {
    log(`could not start ssh-agent: ${error.message} (the image must provide openssh-client)`);
    process.exit(1);
  });
  agent.on("exit", (code) => {
    log(`ssh-agent for ${path.basename(socketPath)} exited (${code}); stopping, so the keyring is restarted whole`);
    process.exit(1);
  });
  process.once("exit", () => agent.kill("SIGTERM"));
  return agent;
};

/** Where the keys are must be the keyring's alone, all the way up: a directory of its own
 *  (not a link), mode 0700, in directories only root can change. Otherwise whoever could
 *  rename an entry on the way could have put a directory of theirs there before a key was
 *  made, and read the key. (start.sh makes it so; this does not take that on trust.) */
export const keysDirRefusal = (dir: string, uid: number): string | null => {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) return `${dir} is not a directory`;
  if (stat.uid !== uid) return `${dir} is not the keyring's (owner ${stat.uid})`;
  if ((stat.mode & 0o077) !== 0) return `${dir} is open to others (mode ${(stat.mode & 0o777).toString(8)})`;
  for (let up = path.dirname(dir); ; up = path.dirname(up)) {
    const parent = fs.lstatSync(up);
    if (parent.isSymbolicLink() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) return `${up} could be changed by someone other than root`;
    if (up === path.dirname(up)) return null;
  }
};

const main = async () => {
  fs.mkdirSync(KEYRING.keys, { recursive: true, mode: 0o700 });
  fs.chmodSync(KEYRING.keys, 0o700);
  const unsafe = keysDirRefusal(KEYRING.keys, process.getuid!());
  if (unsafe) {
    log(`refusing to start: ${unsafe}`);
    process.exit(1);
  }
  fs.mkdirSync(KEYRING.run, { recursive: true, mode: 0o755 });
  fs.mkdirSync(KEYRING.pub, { recursive: true, mode: 0o755 });
  fs.mkdirSync(KEYRING.private, { recursive: true, mode: 0o700 });
  fs.chmodSync(KEYRING.private, 0o700);
  for (const stale of [KEYRING.readAgent, KEYRING.writeAgent, KEYRING.pusher, KEYRING.reviewerReadAgent, KEYRING.reviewer, KEYRING.control, KEYRING.internal, agentOf("read"), agentOf("write")]) fs.rmSync(stale, { force: true });

  const here = path.dirname(new URL(import.meta.url).pathname);
  startAgent(agentOf("read"), { ...process.env });
  startAgent(agentOf("write"), {
    ...process.env,
    SSH_ASKPASS: path.join(here, "keyring-askpass"),
    // Without this ssh-agent asks only when DISPLAY is set, and otherwise REFUSES. Both are
    // wrong here: the askpass is the approval check, with or without a display.
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: "desolate:0",
  });
  for (let waited = 0; ; waited += 50) {
    if (fs.existsSync(agentOf("read")) && fs.existsSync(agentOf("write"))) break;
    if (waited > 10_000) throw new Error("ssh-agent never created its socket");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await relay(KEYRING.readAgent, agentOf("read"));
  // The write agent's relay is in a directory only the keyring and the pusher can enter
  // (root/start.sh): the directory is the gate, so the socket itself is open within it.
  await relay(KEYRING.writeAgent, agentOf("write"), 0o666);
  await serve(KEYRING.pusher, 0o666, pusherOps);
  // The reviewer's: in a directory only it and the keyring enter, like the pusher's.
  await relay(KEYRING.reviewerReadAgent, agentOf("read"), 0o666);
  await serve(KEYRING.reviewer, 0o666, reviewerOps);
  for (const { repo, role } of held())
    try {
      publish(repo, role);
      load(repo, role);
    } catch (error) {
      log(`could not load the ${role} key for ${repoId(repo)}: ${String(error)}`);
    }
  await serve(KEYRING.control, 0o660, publicOps);
  await serve(KEYRING.internal, 0o600, internalOps);
  log(`holding ${held().length} key(s); control at ${KEYRING.control}`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => process.exit(0));
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname) void main();
