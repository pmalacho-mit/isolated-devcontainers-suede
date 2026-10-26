/**
 * work-protocol.ts -- the factory's messages, and the refs they live on.
 *
 * A factory is one project: an agent in its main tree, one per worktree, all
 * talking over the project's `.git` and nothing else ("Software factory on
 * desolate", Protocol). Every participant owns ONE ref and only appends to it:
 *
 *   refs/desolate/agents/<target>/outbox   the agent in that target
 *   refs/desolate/requests/<id>            whoever asks: one request, immutable
 *   refs/desolate/desolate/outbox          the watcher
 *   refs/desolate/forge/<adapter>/outbox   a forge adapter
 *
 * A message is one commit whose tree holds a single `message.json`, with the
 * subject `<type>: <first line of body>` and the writer as author. This file
 * is what every reader holds a message to -- the watcher, the extension, the
 * tests of the shell helper (`desolate-work`) that writes most of them. A
 * reader keeps what it cannot act on and acts on nothing it did not validate.
 */
import { validWorktree } from "./projects.ts";

export const VERSION = 1;

/** The project's own tree, as a target. A worktree named this is refused
 *  wherever the factory opens one, so the name means one thing. */
export const MAIN = "main";
/** The human's own outbox. Not a worktree name, nor ever one: `@` is how a
 *  worktree is written on a command line, and no directory may carry it. */
export const HUMAN = "@human";

export const AGENT_TYPES = ["status", "ask", "answer", "done", "blocked"] as const;
export const DESOLATE_TYPES = ["state"] as const;
export const FORGE_TYPES = ["item", "pr", "merged"] as const;
export const ACTIONS = ["open", "close", "push"] as const;
export type Action = (typeof ACTIONS)[number];

/** A target: the project's tree (`main`), one of its worktrees, or the human. */
export const isTarget = (name: string) => name === HUMAN || validWorktree(name);
export const isAdapter = (name: string) => /^[a-z][a-z0-9-]{0,30}$/.test(name);

export const refs = {
  outbox: (target: string) => `refs/desolate/agents/${target}/outbox`,
  request: (id: string) => `refs/desolate/requests/${id}`,
  desolate: "refs/desolate/desolate/outbox",
  forge: (adapter: string) => `refs/desolate/forge/${adapter}/outbox`,
  glob: "refs/desolate/",
} as const;

/** The identity a writer commits as, which a reader checks against the ref. */
export const author = (writer: string) => ({
  name: `desolate/${writer}`,
  email: `${writer.replace(/^@/, "")}@desolate.invalid`,
});

/** Which writer a ref belongs to, or undefined for a ref outside the protocol. */
export const writerOf = (ref: string): string | undefined => {
  let match = /^refs\/desolate\/agents\/([^/]+)\/outbox$/.exec(ref);
  if (match) return isTarget(match[1]) ? match[1] : undefined;
  if (ref === refs.desolate) return "desolate";
  match = /^refs\/desolate\/forge\/([^/]+)\/outbox$/.exec(ref);
  if (match) return isAdapter(match[1]) ? `forge/${match[1]}` : undefined;
  return undefined;
};

/** ULIDs: 48 bits of milliseconds, 80 random, Crockford base32 -- they sort by
 *  time, as text, and two writers do not collide. */
export const REQUEST_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ulid = (now = Date.now(), random = (n: number) => crypto.getRandomValues(new Uint8Array(n))) => {
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  return time + [...random(16)].map((byte) => CROCKFORD[byte % 32]).join("");
};

export interface Message {
  v: 1;
  from: string;
  to: string[];
  type: string;
  body: string;
  item: string | null;
  commit: string | null;
  reply_to: string | null;
  [key: string]: unknown;
}

export interface Request extends Message {
  type: "request";
  action: Action;
  worktree: string;
  branch: string | null;
  from_ref: string | null;
  title: string | null;
  brief: string | null;
}

export class MessageError extends Error {}

const optionalString = (value: unknown, field: string) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new MessageError(`'${field}' must be a string or null`);
  return value;
};

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ITEM = /^[a-z][a-z0-9-]{0,30}:\S{1,500}$/;
const MAX_BODY = 64 * 1024;

/** A message.json, held to the schema. Unknown TYPES are kept -- shown, never
 *  acted on -- but a malformed field is a refusal: nothing downstream should
 *  have to wonder what `to` is. */
export const parseMessage = (text: string): Message => {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MessageError("not JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new MessageError("not an object");
  if (value.v !== VERSION) throw new MessageError(`version ${JSON.stringify(value.v)} is not ${VERSION}`);
  if (typeof value.from !== "string" || !value.from) throw new MessageError("'from' must name a writer");
  if (!Array.isArray(value.to) || !value.to.length || !value.to.every((t: unknown) => typeof t === "string" && (t === "*" || isTarget(t))))
    throw new MessageError("'to' must be a non-empty list of targets, or [\"*\"]");
  if (typeof value.type !== "string" || !/^[a-z][a-z-]{0,30}$/.test(value.type)) throw new MessageError("'type' must be a word");
  if (typeof value.body !== "string") throw new MessageError("'body' must be a string");
  if (value.body.length > MAX_BODY) throw new MessageError(`'body' is over ${MAX_BODY} characters`);
  const item = optionalString(value.item, "item");
  if (item !== null && !ITEM.test(item)) throw new MessageError("'item' must be <adapter>:<id>");
  const commit = optionalString(value.commit, "commit");
  if (commit !== null && !SHA.test(commit)) throw new MessageError("'commit' must be a full sha");
  const replyTo = optionalString(value.reply_to, "reply_to");
  if (replyTo !== null && !SHA.test(replyTo)) throw new MessageError("'reply_to' must be a full sha");
  return { ...value, item, commit, reply_to: replyTo };
};

/** A request, held to what the watcher may act on. Whether it is ALLOWED --
 *  its requester, the cap, whether the branch exists -- is policy's question;
 *  this is only whether it is well-formed. */
export const parseRequest = (text: string): Request => {
  const message = parseMessage(text);
  if (message.type !== "request") throw new MessageError(`a request's type is 'request', not '${message.type}'`);
  const action = message.action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action))
    throw new MessageError(`'action' must be one of ${ACTIONS.join(", ")}`);
  const worktree = message.worktree;
  if (typeof worktree !== "string" || !validWorktree(worktree) || worktree === MAIN)
    throw new MessageError(`'worktree' must be a worktree name, and not '${MAIN}'`);
  const branch = optionalString(message.branch, "branch");
  if (action === "open" && !branch) throw new MessageError("an 'open' names its branch");
  // check-ref-format's rules, the ones a name can break in one segment or many.
  if (branch !== null && (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || /(^|\/)\.|\.\.|\/\/|\/$|^\/|\.lock(\/|$)|@\{/.test(branch)))
    throw new MessageError(`'branch' ${JSON.stringify(branch)} is not a branch name desolate will create`);
  const fromRef = optionalString(message.from_ref, "from_ref");
  if (fromRef !== null && !/^[A-Za-z0-9._/-]{1,200}$/.test(fromRef)) throw new MessageError("'from_ref' is not a ref name");
  return {
    ...message,
    type: "request",
    action: action as Action,
    worktree,
    branch,
    from_ref: fromRef,
    title: optionalString(message.title, "title"),
    brief: optionalString(message.brief, "brief"),
  };
};

/** The subject a message's commit carries: `git log --oneline` as a timeline. */
export const subjectOf = (message: Pick<Message, "type" | "body">) =>
  `${message.type}: ${message.body.split("\n")[0].slice(0, 200)}`;

/** Is this message for `target`? */
export const isFor = (message: Pick<Message, "to">, target: string) =>
  message.to.includes("*") || message.to.includes(target);
