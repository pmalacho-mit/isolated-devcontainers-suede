/// <reference types="node" />
// The `file` adapter: what it reads as a work item, what it names the
// worktree, and that ticking a box touches that box and nothing else.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { fileAdapter, fileItems, worktreeName, WORK_FILE } from "../../../release/vscode-image/work-forge.ts";
import { validWorktree } from "../../../release/vscode-image/projects.ts";

describe("work items from .desolate/work.md", () => {
  const text = "# work\n- [ ] Add rate-limit headers\n* [x] Done already\n- [ ]   Trailing spaces   \nnot an item\n- [] not one either\n";

  test("checkbox lines are items; ticked ones are done", () => {
    const items = fileItems(text);
    assert.deepEqual(items.map((i) => [i.title, i.done]), [
      ["Add rate-limit headers", false], ["Done already", true], ["Trailing spaces", false],
    ]);
  });

  test("an item's id is stable, and the same title is the same item", () => {
    assert.equal(fileItems("- [ ] A")[0].item, fileItems("x\n- [x] A\n")[0].item);
    assert.match(fileItems("- [ ] A")[0].item, /^file:[0-9a-f]{12}$/);
  });

  test("every title becomes a valid worktree name, never main", () => {
    for (const title of ["Add rate-limit headers", "!!!", "../../etc/passwd", "日本語", "main", "a".repeat(300)])
      assert.ok(validWorktree(worktreeName(title, "abcdef123456")), title);
    assert.notEqual(worktreeName("main", "abcdef"), "main");
  });
});

describe("marking an item done", () => {
  test("ticks that line in the working copy, and only that line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-"));
    fs.mkdirSync(path.join(dir, ".desolate"));
    const before = "- [ ] One\n- [ ] Two\n- [ ] One more\n";
    fs.writeFileSync(path.join(dir, WORK_FILE), before);
    fileAdapter.complete(dir, fileItems(before)[0]);
    assert.equal(fs.readFileSync(path.join(dir, WORK_FILE), "utf8"), "- [x] One\n- [ ] Two\n- [ ] One more\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("the file adapter touches the project's own file and nothing else", () => {
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-contained-"));
    const project = path.join(dir, "acme"), victim = path.join(dir, "victim");
    for (const d of [project, victim]) fs.mkdirSync(path.join(d, ".desolate"), { recursive: true });
    fs.writeFileSync(path.join(victim, WORK_FILE), "- [ ] Victim's secret plan\n");
    return { dir, project, victim };
  };

  test("a work.md that is a link to another project's is neither read nor ticked", () => {
    const { dir, project, victim } = setup();
    fs.symlinkSync(path.join(victim, WORK_FILE), path.join(project, WORK_FILE));
    assert.deepEqual(fileAdapter.poll(project), []);
    fileAdapter.complete(project, fileItems("- [ ] Victim's secret plan")[0]);
    assert.equal(fs.readFileSync(path.join(victim, WORK_FILE), "utf8"), "- [ ] Victim's secret plan\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("nor through a .desolate that is a link", () => {
    const { dir, project, victim } = setup();
    fs.rmSync(path.join(project, ".desolate"), { recursive: true });
    fs.symlinkSync(path.join(victim, ".desolate"), path.join(project, ".desolate"));
    assert.deepEqual(fileAdapter.poll(project), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("and a FIFO there does not hang it", async () => {
    const { dir, project } = setup();
    execFileSync("mkfifo", [path.join(project, WORK_FILE)]);
    assert.deepEqual(fileAdapter.poll(project), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
