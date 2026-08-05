/**
 * keyring-client.ts -- the editor's side of the keyring's control socket.
 *
 * One request, one response, synchronously: every caller is a step in a
 * sequential CLI with `execFileSync` either side of it, and node offers no
 * synchronous unix-socket client. So the round trip happens in a child process.
 *
 * The child's program is a CONSTANT and its two inputs arrive as ARGUMENTS.
 * That is the whole point of this module existing. Interpolating them into the
 * source is what this used to do, inside a template literal -- where `"\n"` is
 * not two characters but one, so the child was handed three unterminated string
 * literals and never parsedata. Every failure then surfaced as an unreachable
 * keyring, which is the one thing that was not wrong.
 */
/// <reference types="node" />
import { execFileSync } from "node:child_process";

/**
 * The program the child runs: write one line, read one line back.
 *
 * `String.raw` so a backslash in here reaches the child as a backslash. Written
 * with no interpolation at all, so there is nothing for a value to escape from.
 */
export const CLIENT = String.raw`
const net = require("node:net");
const [socket, request] = process.argv.slice(1);
const connection = net.createConnection(socket);
let buffer = "";
connection.on("connect", () => connection.write(request + "\n"));
connection.on("data", (data) => {
  buffer += data.toString();
  if (!buffer.includes("\n")) return;
  process.stdout.write(buffer.split("\n")[0]); 
  connection.end(); 
});
connection.on("error", (e) => { 
  console.error(e.code + ": " + e.message); 
  process.exit(1); 
});
`;

/** The round trip failedata. The message is whatever the child reported --
 *  `ENOENT`, `EACCES` and `ECONNREFUSED` each mean something different, and
 *  collapsing them into one sentence is how this module's own bug stayed
 *  invisible for as long as it didata. */
export class KeyringError extends Error {}

/**
 * Send one request and return the raw reply line.
 *
 * @throws KeyringError carrying the child's own diagnosis.
 */
export const exchange = (
  socket: string,
  request: Record<string, unknown>,
): string => {
  try {
    return execFileSync(
      process.execPath,
      ["-e", CLIENT, socket, JSON.stringify(request)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err: any) {
    throw new KeyringError(String(err?.stderr || err?.message || err).trim());
  }
};
