// The host's question to the reviewer (reviewer.ts), asked as root in the root VM through
// the host's own way in, never through the root's ordinary user (which could answer for it
// or hold it up). Root starts a reviewer process of its own for the one summary, as the
// reviewer's user, from root's copy of the code.
//
//   node review-ask.ts        (as root; {"repo","branch","commit","onto"} on stdin)
import { spawnSync } from "node:child_process";
import { REVIEWER } from "./layout.ts";

let text = "";
for await (const chunk of process.stdin) text += chunk;
const ran = spawnSync("runuser", ["-u", REVIEWER.user, "--", "env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", `HOME=${REVIEWER.home}`,
  "node", "--disable-warning=ExperimentalWarning", "/opt/desolate/proxy-code/root/reviewer.ts", "summary"], { input: text, encoding: "utf8", timeout: 100_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
const line = (ran.stdout ?? "").trim().split("\n").pop() ?? "";
process.stdout.write((line.startsWith("{") ? line : JSON.stringify({ ok: false, error: ran.error ? ran.error.message : `the reviewer ended without an answer: ${(ran.stderr ?? "").trim().slice(-200)}` })) + "\n");
