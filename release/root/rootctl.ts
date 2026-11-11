// The CLI channel (section 4.6): the host execs this in the root VM with one JSON request on
// stdin and reads one JSON reply on stdout. Progress goes to stderr. It runs as the root's
// unprivileged user, with no terminal: nothing reachable from here can approve a push.
import { Refusal } from "../shared/exit.ts";
import { isRecord } from "../shared/json.ts";
import { ops } from "./ops.ts";

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
  if (!isRecord(request) || typeof request.op !== "string") {
    process.stdout.write(JSON.stringify({ ok: false, error: "a request is {op, args}", fix: "", code: 64 }) + "\n");
    return;
  }
  const op = ops[request.op];
  if (!op) {
    process.stdout.write(JSON.stringify({ ok: false, error: `the root has no operation '${request.op}'`, fix: "", code: 64 }) + "\n");
    return;
  }
  try {
    const result = await op(isRecord(request.args) ? request.args : {}, (line) => process.stderr.write(`${line}\n`));
    process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
  } catch (error) {
    const refusal = error instanceof Refusal ? error : null;
    process.stdout.write(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      fix: refusal?.fix ?? "",
      code: refusal?.code ?? 1,
    }) + "\n");
  }
};

await main();
