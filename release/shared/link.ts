// A workspace's link, where the backend has to carry it over a TCP port on the host's
// loopback (vz: the guest reaches the host through one port its confinement allows).
//
// A loopback port is open to every process on the machine, and what is behind it is one
// workspace's proxy, which will substitute that domain's secrets. And a port is only the
// host daemon's while it holds it: another user of the Mac can take it when it is free (a
// workspace stopping, the daemon restarting) and wait for the guest. So each side proves
// to the other that it knows the token the host made for this workspace, and the token
// itself never crosses (found by an audit on the M1; the first version sent it first, to
// whatever held the port):
//
//   guest -> host   DESOLATE-LINK2 <guest nonce>\n
//   host  -> guest  <host nonce> HMAC(token, "host" gn hn)\n
//   guest -> host   HMAC(token, "guest" gn hn)\n             then the guest's own bytes
//
// The host proves itself first, so a program holding the port learns nothing from the guest
// (not even the names it asks for); a program connecting to the host's port gets a proof it
// cannot turn into the token or into the guest's answer.
//
// (Backends whose link is a unix socket in a directory only the VM is shown need none.)
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";

const PREFIX = "DESOLATE-LINK2 ";
const TOKEN = /^[0-9a-f]{32}$/;
const NONCE = /^[0-9a-f]{32}$/;
const proof = (token: string, side: "host" | "guest", guestNonce: string, hostNonce: string) =>
  createHmac("sha256", Buffer.from(token, "hex")).update(`${side} ${guestNonce} ${hostNonce}`).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Read one line (without its newline) of at most `max` bytes; what follows it is `rest`. */
const line = (socket: Socket, max: number, timeoutMs: number): Promise<{ text: string; rest: Buffer } | null> =>
  new Promise((resolve) => {
    let got = Buffer.alloc(0);
    const finish = (value: { text: string; rest: Buffer } | null) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.pause();
      resolve(value);
    };
    const onClose = () => finish(null);
    const onData = (chunk: Buffer) => {
      got = Buffer.concat([got, chunk]);
      const end = got.indexOf(10);
      if (end >= 0) return finish({ text: got.subarray(0, end).toString("latin1"), rest: got.subarray(end + 1) });
      if (got.length > max) finish(null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", () => {});
    socket.resume();
  });

/** `tcp:<address>:<port>#<token>`, or the same without a token, or `unix:<path>`. */
export const parseLink = (link: string): { unix: string } | { host: string; port: number; token: string | null } | null => {
  if (link.startsWith("unix:") && link.length > 5) return { unix: link.slice(5) };
  const match = /^tcp:([0-9.]+):(\d+)(?:#([0-9a-f]{32}))?$/.exec(link);
  return match ? { host: match[1]!, port: Number(match[2]), token: match[3] ?? null } : null;
};

/** The guest's end, on a connected socket: true once the host has proved itself and the
 *  guest has answered; the socket is then the link. false (and the socket destroyed) for
 *  anything else: the token is never sent. */
export const open = async (socket: Socket, token: string, timeoutMs = 10_000): Promise<boolean> => {
  if (!TOKEN.test(token)) throw new Error("a link token is 32 hex characters");
  const guestNonce = randomBytes(16).toString("hex");
  socket.write(`${PREFIX}${guestNonce}\n`);
  const answer = await line(socket, 200, timeoutMs);
  const match = answer && /^([0-9a-f]{32}) ([0-9a-f]{64})$/.exec(answer.text);
  if (!answer || !match || answer.rest.length > 0 || !same(match[2]!, proof(token, "host", guestNonce, match[1]!))) {
    socket.destroy();
    return false;
  }
  socket.write(`${proof(token, "guest", guestNonce, match[1]!)}\n`);
  socket.resume();
  return true;
};

/** The host's end: resolves with whatever followed the guest's answer if this was this
 *  link's guest, or null (and the socket destroyed) if it was not, said too much, or did
 *  not finish in time. */
export const accept = async (socket: Socket, token: string, timeoutMs = 10_000): Promise<Buffer | null> => {
  const fail = () => {
    socket.destroy();
    return null;
  };
  if (!TOKEN.test(token)) return fail();
  const deadline = Date.now() + timeoutMs;
  const first = await line(socket, PREFIX.length + 40, timeoutMs);
  if (!first || !first.text.startsWith(PREFIX) || first.rest.length > 0) return fail();
  const guestNonce = first.text.slice(PREFIX.length);
  if (!NONCE.test(guestNonce)) return fail();
  const hostNonce = randomBytes(16).toString("hex");
  socket.write(`${hostNonce} ${proof(token, "host", guestNonce, hostNonce)}\n`);
  const second = await line(socket, 100, Math.max(1, deadline - Date.now()));
  if (!second || !same(second.text, proof(token, "guest", guestNonce, hostNonce))) return fail();
  return second.rest;
};
