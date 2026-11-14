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
    : ["env", "-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", `CLAUDE_CODE_OAUTH_TOKEN=${secret}`, ...CLAUDE, "--permission-mode", "auto", task];

/** Where desolate installs Claude Code when the project's environment has none: the domain's
 *  cache, which every workspace of the domain mounts and a rebuild of a container keeps. */
export const CACHED = "/desolate/cache/claude-code/bin/claude";
/** Claude: the environment's own if it has one, else the domain's copy. */
const CLAUDE = ["sh", "-c", `exec "$(command -v claude || echo ${CACHED})" "$@"`, "claude"];

/** Claude Code in the workspace's environment, installed if it is not there (the project's
 *  devcontainer should carry it: ghcr.io/anthropics/devcontainer-features/claude-code:1). */
export const ensureClaude = (where: string, checkout: string | undefined, say: (line: string) => void): boolean => {
  const at = checkout ? ["--checkout", checkout] : [];
  if (desolate(["exec", where, ...at, "--", "sh", "-c", `command -v claude || test -x ${CACHED}`]).code !== 0 && !installClaude(where, at, say)) return false;
  return desolate(["exec", where, ...at, "--", "/desolate/bin/node", "-e", FIRST_RUN]).code === 0;
};

/** What Claude Code asks a person on its first run, answered: its onboarding (a theme
 *  picker) and whether to trust the folder. Left unanswered, an agent started with no one
 *  attached waits at the first question, never reaching its task. Merged into the
 *  container's ~/.claude.json; the theme is only the default (/theme changes it). */
export const FIRST_RUN = `const fs = require("fs"), path = require("path"), file = path.join(require("os").homedir(), ".claude.json");
let c = {}; try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
c.hasCompletedOnboarding = true; c.theme = c.theme || "dark";
c.projects = c.projects || {}; const p = c.projects[process.cwd()] = c.projects[process.cwd()] || {};
p.hasTrustDialogAccepted = true; p.hasCompletedProjectOnboarding = true;
fs.writeFileSync(file, JSON.stringify(c, null, 2));`;

const installClaude = (where: string, at: string[], say: (line: string) => void): boolean => {
  say(`${where}: installing Claude Code into the domain's cache, once for all its workspaces (or the project's devcontainer can carry it: the feature ghcr.io/anthropics/devcontainer-features/claude-code:1)`);
  // With npm: into the cache by prefix. Without (a Python or Rust image): Anthropic's own
  // installer, whose binary is then copied into the cache.
  const prefix = CACHED.replace(/\/bin\/claude$/, "");
  const install = `if command -v npm >/dev/null; then npm install -g --prefix ${prefix} @anthropic-ai/claude-code >/dev/null 2>&1; else curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 && mkdir -p ${prefix}/bin && cp "$(readlink -f "$HOME/.local/bin/claude")" ${CACHED}; fi; test -x ${CACHED}`;
  return desolate(["exec", where, ...at, "--", "sh", "-c", install]).code === 0;
};

/** How every agent desolate starts is told where it is and how to finish. */
export const standingOrders = (branch: string) => [
  `Your branch, ${branch}, is checked out here. First read /desolate/release/AGENTS.md: this is a desolate workspace.`,
  "Work until it is done and seen to work. Commit as you go. When it is ready: `desolate offer`, then `desolate status set green \"ready: <one line>\"`.",
  "If you need a person (a decision, access, a secret): `desolate status set orange \"<the question>\"`, and wait.",
].join("\n");

/** A workspace name from a sentence: its first words, lower case, dashed, at most 30
 *  characters, and whole words where it can (a word cut short is dropped). */
export const nameFor = (text: string) => {
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (words.length <= 30) return words || "task";
  const cut = words.slice(0, 31);
  const whole = cut.slice(0, cut.lastIndexOf("-"));
  return whole.length >= 12 ? whole : words.slice(0, 30).replace(/-+$/, "");
};

declare namespace nameFor {
  export type Names = Table<typeof nameFor, [
    [args: [text: "Add a shout() greeting"], expected: "add-a-shout-greeting"],
    [args: [text: "Fix #12: the login page's 500 on Safari, again"], expected: "fix-12-the-login-page-s-500-on"],
    [args: [text: "Add a wave() greeting, with a test"], expected: "add-a-wave-greeting-with-a"],
    [args: [text: "Internationalisation-of-everything-everywhere"], expected: "internationalisation-of"],
    [args: [text: "Supercalifragilisticexpialidocious-and-more"], expected: "supercalifragilisticexpialidoc"],
    [args: [text: "¿Qué?"], expected: "qu"],
    [args: [text: "!!!"], expected: "task"],
  ]>;
}

declare namespace agentCommand {
  /** Claude, with the secret's name only; or the person's own command, the task last */
  export type Claude = Expect<Invoke<typeof agentCommand, [custom: [], secret: "CLAUDE-OAUTH", task: "do it"]>, "=", ["env", "-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN=CLAUDE-OAUTH", "sh", "-c", "exec \"$(command -v claude || echo /desolate/cache/claude-code/bin/claude)\" \"$@\"", "claude", "--permission-mode", "auto", "do it"]>;
  export type Own = Expect<Invoke<typeof agentCommand, [custom: ["aider", "--yes"], secret: "CLAUDE-OAUTH", task: "do it"]>, "=", ["aider", "--yes", "do it"]>;
}
