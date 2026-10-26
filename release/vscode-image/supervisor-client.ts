/**
 * supervisor-client.ts -- one request to the supervisor, and its answer.
 *
 * The supervisor streams `{log}` lines while it works and ends with one answer
 * (`{ok, ...}`). Both callers -- the runner in the orchestrator, and
 * `cli.sh dind` through `supervisor.ts ask` -- need exactly that, so it lives
 * here once.
 */
import * as net from "node:net";

export type Answer = Record<string, any>;

export const ask = (
  socket: string,
  request: Record<string, string>,
  say: (line: string) => void,
): Promise<Answer> =>
  new Promise((resolve) => {
    const connection = net.createConnection(socket);
    let buffer = "";
    let last: Answer = { ok: false, error: "the supervisor closed without an answer" };
    connection.on("connect", () => connection.write(JSON.stringify(request) + "\n"));
    connection.on("data", (chunk) => {
      buffer += chunk.toString();
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (typeof message.log === "string") say(message.log);
        else last = message;
      }
    });
    connection.on("close", () => resolve(last));
    connection.on("error", (err) =>
      resolve({ ok: false, error: `the supervisor is not reachable at ${socket} (${err.message})` }));
  });
