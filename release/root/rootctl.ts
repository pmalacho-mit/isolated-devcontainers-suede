// The CLI channel (section 4.6): the host execs this in the root VM with one JSON request on
// stdin and reads one JSON reply on stdout. Progress goes to stderr. It runs as the root's
// unprivileged user, with no terminal: nothing reachable from here can approve a push.
//
// `node rootctl.ts serve`: the same, kept running (start.sh), on a socket only this user can
// open: a request is a line of JSON, progress comes back as {"progress"} lines and the
// answer as one {"reply"} line. It saves loading the root's code for every call (measured on
// the M1: 240 ms a call, 140 of them that). It answers {"stale": true} and ends when the
// root's code changed under it, and the host then asks the old way, with the new code.
import * as fs from "node:fs";
import { createServer } from "node:net";
import * as path from "node:path";
import { Refusal } from "../shared/exit.ts";
import { isRecord } from "../shared/json.ts";
import { ROOT } from "./layout.ts";
import { ops } from "./ops.ts";

export const SOCKET = path.join(ROOT.run, "rootctl", "rootctl.sock");

/** One request, answered: shared by the one-shot and the service. */
const answer = async (request: unknown, progress: (line: string) => void): Promise<Record<string, unknown>> => {
  if (!isRecord(request) || typeof request.op !== "string") return { ok: false, error: "a request is {op, args}", fix: "", code: 64 };
  const op = ops[request.op];
  if (!op) return { ok: false, error: `the root has no operation '${request.op}'`, fix: "", code: 64 };
  try {
    return { ok: true, result: await op(isRecord(request.args) ? request.args : {}, progress) };
  } catch (error) {
    const refusal = error instanceof Refusal ? error : null;
    return { ok: false, error: error instanceof Error ? error.message : String(error), fix: refusal?.fix ?? "", code: refusal?.code ?? 1 };
  }
};

/** The newest change to the root's code: a few dozen stats, every request. */
const HERE = path.dirname(new URL(import.meta.url).pathname);
const codeTime = () => {
  let newest = 0;
  for (const dir of [HERE, path.join(HERE, "proxy"), path.join(HERE, "..", "shared")])
    try {
      for (const name of fs.readdirSync(dir)) if (name.endsWith(".ts")) newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs);
    } catch {
      /* gone: stale */
      return Infinity;
    }
  return newest;
};

const serve = () => {
  const started = codeTime();
  fs.mkdirSync(path.dirname(SOCKET), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(SOCKET), 0o700);
  fs.rmSync(SOCKET, { force: true });
  // Half-open: the host's side ends its request with EOF, and a socket that closed itself on
  // that (node's default) lost the answer of every operation slower than the EOF (found on
  // the M1: doctor's answer never came).
  const server = createServer({ allowHalfOpen: true }, (connection) => {
    connection.on("error", (error) => {
      process.stderr.write(`rootctl serve: a connection failed: ${error.message}\n`);
      connection.destroy();
    });
    let text = "";
    connection.on("data", async (chunk) => {
      text += chunk;
      if (text.length > 1 << 20) return connection.destroy();
      const end = text.indexOf("\n");
      if (end < 0) return;
      connection.removeAllListeners("data");
      if (codeTime() !== started) {
        connection.end(JSON.stringify({ stale: true }) + "\n");
        server.close();
        setTimeout(() => process.exit(0), 100);
        return;
      }
      let request: unknown = null;
      try {
        request = JSON.parse(text.slice(0, end));
      } catch {
        /* not JSON: answered as such */
      }
      // Taken: from here the host never asks again the old way (an operation must not run twice).
      connection.write(JSON.stringify({ accepted: true }) + "\n");
      const reply = await answer(request, (line) => connection.write(JSON.stringify({ progress: line }) + "\n"));
      connection.end(JSON.stringify({ reply }) + "\n");
    });
  });
  server.listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600));
};

const read = async () => {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
};

const main = async () => {
  let request: unknown;
  try {
    request = JSON.parse(await read());
  } catch {
    request = null;
  }
  process.stdout.write(JSON.stringify(await answer(request, (line) => process.stderr.write(`${line}\n`))) + "\n");
};

if (process.argv[2] === "serve") serve();
else await main();
