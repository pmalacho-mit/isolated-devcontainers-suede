// broker-client.ts -- one request to the orchestrator's broker, from the editor.
//
// The editor has no Docker access by design; this socket is its only way to
// ask for anything that needs it. Shared by `desolate` (desolate-client.ts)
// and `worktree` (worktrees.ts), which both speak the broker's one-line JSON
// requests and read back its stream of log lines and a final status.

import * as net from "node:net";

const SOCKET = process.env.DESOLATE_BROKER ?? "/run/broker/desolate.sock";

/** Send `request`, print what the broker relays as it arrives, and resolve to
 *  the exit status it reported: 0 when it succeeded. A broker that cannot be
 *  reached is a 1, said so, never a silent success. `onLog` sees each relayed
 *  line first, and prints it only if it returns true. */
export const ask = (
  request: Record<string, unknown>,
  onLog: (line: string) => boolean = () => true,
): Promise<number> =>
  new Promise((resolve) => {
    const conn = net.createConnection(SOCKET);
    let exitCode = 0;
    let buffer = "";

    conn.on("connect", () => conn.write(JSON.stringify(request) + "\n"));

    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { console.log(line); continue; }
        if (msg.log !== undefined) { if (onLog(String(msg.log))) console.log(msg.log); continue; }
        if (msg.error) { console.error(`desolate: ${msg.error}`); }
        if (msg.ok === false) exitCode = typeof msg.exit === "number" ? msg.exit : 1;
      }
    });

    conn.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        console.error("desolate: cannot reach the orchestrator broker.");
        console.error(`         socket: ${SOCKET}`);
        console.error("         Is the stack up?  (on your Mac: ./cli.sh ps)");
      } else {
        console.error(`desolate: ${err.message}`);
      }
      resolve(1);
    });

    conn.on("close", () => resolve(exitCode));
  });
