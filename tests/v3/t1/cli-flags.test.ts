// T1. Every verb refuses a flag it does not know, as a usage error (exit 64), before it does
// anything: a misspelt flag (`--dryrun`, `--chekout`) is never quietly ignored or passed on.
// And the verbs the CLI has are the verbs completion offers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const RELEASE = path.resolve(import.meta.dirname, "../../../release");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-flags-"));
after(() => fs.rmSync(home, { recursive: true, force: true }));
// No stack: a verb that went past its flags would fail some other way (or take its time).
const run = (...args: string[]) =>
  spawnSync(path.join(RELEASE, "cli.sh"), args, { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH, HOME: home, DESOLATE_HOME: home, DESOLATE_INSTANCE: "flagtest", DESOLATE_BACKEND: "fake" } });

const completionVerbs = () => /words="(bootstrap [^"]+)"/.exec(fs.readFileSync(path.join(RELEASE, "completion.bash"), "utf8"))![1]!.split(" ");

describe("T1 the CLI's flags", () => {
  // (Verbs whose subcommand comes first are given one.)
  const lines: Record<string, string[]> = {
    domain: ["domain", "dev", "show"], root: ["root", "shell"], net: ["net", "log"], agent: ["agent", "list"],
    factory: ["factory", "issues"], suede: ["suede", "changed", "a/b", "0".repeat(40)],
  };
  for (const verb of completionVerbs().filter((verb) => verb !== "help" && verb !== "completion"))
    it(`${verb}: an unknown flag is a usage error`, () => {
      const result = run(...(lines[verb] ?? [verb]), "--no-such-flag");
      assert.equal(result.status, 64, `${verb} exited ${result.status}: ${result.stderr.slice(0, 300)}`);
      assert.match(result.stderr, /no-such-flag/);
    });
});
