/// <reference types="node" />
// How `cli.sh exec` runs a command in a devcontainer (docker.ts LOGIN_EXEC):
// in a login bash when there is bash -- whose login scripts features write
// for bash -- and a login sh otherwise; the command's words as they were.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOGIN_EXEC } from "../../../release/vscode-image/docker.ts";

const home = mkdtempSync(join(tmpdir(), "desolate-login-"));
const noBash = join(home, "bin");
before(() => {
  // A login script only bash can read, as git-subrepo's feature has; and one
  // for sh, which a login sh reads instead.
  writeFileSync(join(home, ".bash_profile"), '[[ -n "$BASH_VERSION" ]] && export VIA=bash\n');
  writeFileSync(join(home, ".profile"), "export VIA=sh\n");
  mkdirSync(noBash);
  for (const tool of ["sh", "printenv"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    symlinkSync(found, join(noBash, tool));
  }
});
after(() => rmSync(home, { recursive: true, force: true }));

const exec = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync("sh", ["-c", LOGIN_EXEC, "desolate-exec", ...argv], { encoding: "utf8", env: { ...process.env, HOME: home, ...env } });

describe("a command run in a devcontainer", () => {
  test("its words arrive as they were: nothing split, globbed or expanded again", () => {
    assert.equal(exec(["printf", "%s|", "a", "b c", "$HOME", "*", "'q'"]).stdout, "a|b c|$HOME|*|'q'|");
  });

  test("with bash there, in a login bash: a login script written for bash works", () => {
    assert.equal(exec(["printenv", "VIA"]).stdout.trim(), "bash");
  });

  test("without bash, in a login sh", () => {
    const run = exec(["printenv", "VIA"], { PATH: noBash });
    assert.equal(run.stdout.trim(), "sh", run.stderr);
  });

  test("its exit status is the command's", () => {
    assert.equal(exec(["sh", "-c", "exit 7"]).status, 7);
  });
});
