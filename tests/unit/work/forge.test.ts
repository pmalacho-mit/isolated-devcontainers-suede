/// <reference types="node" />
// The `file` adapter: what it reads as a work item, what it names the
// worktree, and that ticking a box touches that box and nothing else.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
