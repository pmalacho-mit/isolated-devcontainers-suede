// The one program that files a push approval with the keyring (P2, section 5.3).
//
//   sudo -n -u desolate-keyring node keyring-confirm.ts <owner/repo> <branch> <commit> [<summary>]
//
// It runs as the keyring's user (only that user can open the keyring's internal socket), it
// asks on the caller's terminal, and it files the approval only if the person types the
// branch name back. With no terminal it refuses: a harness driving the CLI from the host has
// none, so it cannot approve a push, whatever it calls.
//
// What this does not stop: a program that fabricates a terminal and types the answer. That
// is impersonating the person, on purpose, from inside the root VM, where no workspace code
// runs. docs/v3/decisions.md records this as the residual of a terminal prompt.
import * as fs from "node:fs";
import { isBranch, isCommit, parseRepo, repoId } from "../shared/names.ts";
import { ask } from "./keyring-client.ts";
import { KEYRING } from "./layout.ts";

const [, , repoArg, ref, commit, summary] = process.argv;
const repo = parseRepo(repoArg);
const fail = (message: string): never => {
  console.error(`desolate: ${message}`);
  process.exit(78);
};
if (!repo || !isBranch(ref) || !isCommit(commit)) fail("usage: keyring-confirm <owner/repo> <branch> <commit>");
if (!process.stdin.isTTY) fail("a push needs a person's confirmation, and there is no terminal to ask on. Run the push from the root's terminal (desolate root shell), or use Push in the root editor.");

let tty: number;
try {
  tty = fs.openSync("/dev/tty", "r+");
} catch {
  tty = fail("a push needs a person's confirmation, and there is no terminal to ask on. Run the push from the root's terminal (desolate root shell), or use Push in the root editor.");
}
// Everything shown is a value this program validated: nothing here can carry an escape
// sequence that repaints the prompt.
const clean = (text: string) => text.replace(/[^\x20-\x7e]/g, "?").slice(0, 300);
fs.writeSync(tty, [
  "",
  "desolate: this push needs your confirmation.",
  `  repository  ${repoId(repo!)}`,
  `  branch      ${ref}`,
  `  commit      ${commit}`,
  ...(summary ? [`  sends       ${clean(summary)}`] : []),
  "",
  `Type the branch name (${ref}) to push, or anything else to refuse: `,
].join("\n"));

const answer = await new Promise<string>((resolve) => {
  let text = "";
  const input = fs.createReadStream("", { fd: tty, autoClose: false });
  input.on("data", (chunk) => {
    text += chunk.toString();
    const end = text.indexOf("\n");
    if (end >= 0) {
      input.destroy();
      resolve(text.slice(0, end).trim());
    }
  });
  input.on("end", () => resolve(text.trim()));
  input.on("error", () => resolve(""));
});
if (answer !== ref) fail("not confirmed; nothing was pushed.");
const reply = await ask(KEYRING.internal, { op: "approve", repo: repoId(repo!), ref, commit, by: "terminal" });
if (reply.ok !== true) fail(String(reply.error ?? "the keyring refused the approval"));
process.stdout.write(`${String(reply.id)}\n`);
process.exit(0);
