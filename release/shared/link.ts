// A workspace's link, where the backend has to carry it over a TCP port on the host's
// loopback (vz: the guest reaches the host through one port its confinement allows).
//
// A loopback port is open to every process on the machine, and what is behind it is one
// workspace's proxy, which will substitute that domain's secrets. So the first thing on
// such a connection is a token only the host and that workspace's VM were given; a
// connection that does not open with it is closed, having reached nothing.
//
// (Backends whose link is a unix socket in a directory only the VM is shown need none.)
import { timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";

const PREFIX = "DESOLATE-LINK ";
const TOKEN = /^[0-9a-f]{32}$/;

/** `tcp:<address>:<port>#<token>`, or the same without a token, or `unix:<path>`. */
export const parseLink = (link: string): { unix: string } | { host: string; port: number; token: string | null } | null => {
  if (link.startsWith("unix:") && link.length > 5) return { unix: link.slice(5) };
  const match = /^tcp:([0-9.]+):(\d+)(?:#([0-9a-f]{32}))?$/.exec(link);
  return match ? { host: match[1]!, port: Number(match[2]), token: match[3] ?? null } : null;
};

/** What the workspace's end sends first. */
export const hello = (token: string): string => {
  if (!TOKEN.test(token)) throw new Error("a link token is 32 hex characters");
  return `${PREFIX}${token}\n`;
};

/** The host's end: resolves with whatever followed the hello if it was this link's, or null
 *  (and the socket destroyed) if it was not, was too long, or did not come in time. */
export const accept = (socket: Socket, token: string, timeoutMs = 10_000): Promise<Buffer | null> =>
  new Promise((resolve) => {
    const want = Buffer.from(hello(token));
    let got = Buffer.alloc(0);
    const finish = (rest: Buffer | null) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      if (rest === null) socket.destroy();
      else socket.pause();
      resolve(rest);
    };
    const onClose = () => finish(null);
    const onData = (chunk: Buffer) => {
      got = Buffer.concat([got, chunk]);
      if (got.length < want.length) return;
      finish(timingSafeEqual(got.subarray(0, want.length), want) ? got.subarray(want.length) : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", () => {});
  });
