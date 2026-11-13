// Claude Code as desolate's agents run it: shared by `desolate task` and the factories.
//
// Its credential never enters a workspace: the person stores a subscription token as a domain
// secret (`claude setup-token`, then `desolate domain <d> secret set CLAUDE-OAUTH --hosts
// api.anthropic.com --headers authorization`), and the agent's environment holds only that
// secret's NAME, which the workspace's proxy replaces on the way to api.anthropic.com.
// Variables that would outrank the token are unset.
import { spawnSync } from "node:child_process";
import * as path from "node:path";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../.suede/nests/dsl.import.meta.vitest.ts";

export const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "cli.sh");

export const desolate = (args: string[], input?: string) => {
  const ran = spawnSync(CLI, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { code: ran.status ?? 1, out: ran.stdout ?? "", err: ran.stderr ?? "" };
};

/** The command that starts Claude on a task, or the person's own agent (`-- <command...>`,
 *  given the task as its last word). */
export const agentCommand = (custom: string[], secret: string, task: string): string[] =>
  custom.length > 0
    ? [...custom, task]
    : ["env", "-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", `CLAUDE_CODE_OAUTH_TOKEN=${secret}`, "claude", "--permission-mode", "auto", task];

/** Claude Code in the workspace's environment, installed if it is not there (the project's
 *  devcontainer should carry it: ghcr.io/anthropics/devcontainer-features/claude-code:1). */
export const ensureClaude = (where: string, checkout: string | undefined, say: (line: string) => void): boolean => {
  const at = checkout ? ["--checkout", checkout] : [];
  if (desolate(["exec", where, ...at, "--", "sh", "-c", "command -v claude"]).code === 0) return true;
  say(`${where}: installing Claude Code (the devcontainer feature ghcr.io/anthropics/devcontainer-features/claude-code:1 would carry it)`);
  return desolate(["exec", where, ...at, "--", "sh", "-c", "npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || curl -fsSL https://claude.ai/install.sh | bash"]).code === 0;
};

/** How every agent desolate starts is told where it is and how to finish. */
export const standingOrders = (branch: string) => [
  `Your branch, ${branch}, is checked out here. First read /desolate/release/AGENTS.md: this is a desolate workspace.`,
  "Work until it is done and seen to work. Commit as you go. When it is ready: `desolate offer`, then `desolate status set green \"ready: <one line>\"`.",
  "If you need a person (a decision, access, a secret): `desolate status set orange \"<the question>\"`, and wait.",
].join("\n");

/** A workspace name from a sentence: its first words, lower case, dashed, at most 30. */
export const nameFor = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "") || "task";

declare namespace nameFor {
  export type Names = Table<typeof nameFor, [
    [args: [text: "Add a shout() greeting"], expected: "add-a-shout-greeting"],
    [args: [text: "Fix #12: the login page's 500 on Safari, again"], expected: "fix-12-the-login-page-s-500-on"],
    [args: [text: "¿Qué?"], expected: "qu"],
    [args: [text: "!!!"], expected: "task"],
  ]>;
}

declare namespace agentCommand {
  /** Claude, with the secret's name only; or the person's own command, the task last */
  export type Claude = Expect<Invoke<typeof agentCommand, [custom: [], secret: "CLAUDE-OAUTH", task: "do it"]>, "=", ["env", "-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN=CLAUDE-OAUTH", "claude", "--permission-mode", "auto", "do it"]>;
  export type Own = Expect<Invoke<typeof agentCommand, [custom: ["aider", "--yes"], secret: "CLAUDE-OAUTH", task: "do it"]>, "=", ["aider", "--yes", "do it"]>;
}
