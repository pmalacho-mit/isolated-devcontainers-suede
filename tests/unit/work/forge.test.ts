/// <reference types="node" />
// The `file` adapter: what it reads as a work item, what it names the
// worktree, and that ticking a box touches that box and nothing else.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  fileAdapter, fileItems, forgeStatus, githubAdapter, parseGithubSnapshot, recordPr, tickForge,
  worktreeName, writeGithubSnapshot, WORK_FILE, type Context,
} from "../../../release/vscode-image/work-forge.ts";
import { validWorktree } from "../../../release/vscode-image/projects.ts";
import { DEFAULT_POLICY, parsePolicy, type Policy } from "../../../release/vscode-image/work-policy.ts";
import { ulid } from "../../../release/vscode-image/work-protocol.ts";

/** A context for an adapter that reads only the project's directory. */
const at = (projectDir: string): Context => ({ projectDir, project: "acme", workspaces: os.tmpdir(), policy: DEFAULT_POLICY });

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
    fileAdapter.complete(at(dir), fileItems(before)[0]);
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
    assert.deepEqual(fileAdapter.poll(at(project)), []);
    fileAdapter.complete(at(project), fileItems("- [ ] Victim's secret plan")[0]);
    assert.equal(fs.readFileSync(path.join(victim, WORK_FILE), "utf8"), "- [ ] Victim's secret plan\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("nor through a .desolate that is a link", () => {
    const { dir, project, victim } = setup();
    fs.rmSync(path.join(project, ".desolate"), { recursive: true });
    fs.symlinkSync(path.join(victim, ".desolate"), path.join(project, ".desolate"));
    assert.deepEqual(fileAdapter.poll(at(project)), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("and a FIFO there does not hang it", async () => {
    const { dir, project } = setup();
    execFileSync("mkfifo", [path.join(project, WORK_FILE)]);
    assert.deepEqual(fileAdapter.poll(at(project)), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("the github adapter, fed from the Mac", () => {
  test("a snapshot is held to its shape, and its titles to one printable line", () => {
    const snapshot = parseGithubSnapshot(JSON.stringify({
      open: [{ number: 42, title: "Fix\u001b[31m it\n\tnow" }, { number: 7, title: "   " }],
      finished: [3],
    }));
    assert.deepEqual(snapshot.open, [{ number: 42, title: "Fix [31m it now" }, { number: 7, title: "issue 7" }]);
    for (const bad of [
      { open: [], finished: [], extra: 1 }, { open: [{ number: 1.5, title: "x" }], finished: [] },
      { open: [{ number: -1, title: "x" }], finished: [] }, { open: [], finished: ["1"] },
      { open: Array.from({ length: 501 }, (_, i) => ({ number: i + 1, title: "x" })), finished: [] }, [],
    ])
      assert.throws(() => parseGithubSnapshot(JSON.stringify(bad)), JSON.stringify(bad).slice(0, 60));
  });

  const repository = () => {
    const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), "forge-github-"));
    const projectDir = path.join(workspaces, "acme");
    fs.mkdirSync(projectDir);
    execFileSync("git", ["init", "-q", "-b", "main", projectDir]);
    const policy: Policy = parsePolicy(JSON.stringify({
      ...DEFAULT_POLICY, adapters: ["github"], requesters: ["main", "forge/github"],
      github: { repo: "acme/widgets", label: "desolate:run" },
    }));
    return { workspaces, projectDir, policy, context: { projectDir, project: "acme", workspaces, policy } as Context };
  };
  const refsOf = (dir: string, prefix: string) =>
    execFileSync("git", ["-C", dir, "for-each-ref", "--format=%(refname)", prefix], { encoding: "utf8" }).split("\n").filter(Boolean);

  test("an open issue becomes one open request for issue-<n>, asked once", () => {
    const { workspaces, projectDir, policy, context } = repository();
    writeGithubSnapshot(workspaces, "acme", { open: [{ number: 42, title: "Fix the login" }], finished: [] });
    assert.deepEqual(githubAdapter.poll(context), [{ item: "github:acme/widgets#42", title: "Fix the login", worktree: "issue-42" }]);
    tickForge("acme", workspaces, policy, () => {}, ulid);
    tickForge("acme", workspaces, policy, () => {}, ulid);
    assert.equal(refsOf(projectDir, "refs/desolate/requests/").length, 1);
    assert.deepEqual(forgeStatus(projectDir, "github", policy.branch_prefix), [
      { item: "github:acme/widgets#42", worktree: "issue-42", branch: "factory/issue-42", state: "requested", pr: null },
    ]);
  });

  test("a push does not close it; the forge's word does", () => {
    const { workspaces, projectDir, policy, context } = repository();
    writeGithubSnapshot(workspaces, "acme", { open: [{ number: 42, title: "Fix the login" }], finished: [] });
    tickForge("acme", workspaces, policy, () => {}, ulid);
    recordPr(projectDir, "github", "github:acme/widgets#42", "https://github.com/acme/widgets/pull/43");
    tickForge("acme", workspaces, policy, () => {}, ulid);
    assert.equal(refsOf(projectDir, "refs/desolate/requests/").length, 1, "closed without the forge saying so");
    assert.equal(forgeStatus(projectDir, "github", policy.branch_prefix)[0].pr, "https://github.com/acme/widgets/pull/43");

    writeGithubSnapshot(workspaces, "acme", { open: [], finished: [42] });
    assert.deepEqual([...githubAdapter.finished!(context)], ["github:acme/widgets#42"]);
    tickForge("acme", workspaces, policy, () => {}, ulid);
    tickForge("acme", workspaces, policy, () => {}, ulid);
    assert.equal(refsOf(projectDir, "refs/desolate/requests/").length, 2, "one close, asked once");
    assert.equal(forgeStatus(projectDir, "github", policy.branch_prefix)[0].state, "merged");
  });

  test("a PR URL is GitHub's, or it is not recorded", () => {
    const { projectDir } = repository();
    for (const url of ["https://evil.example/acme/widgets/pull/1", "https://github.com/acme/widgets/pull/1\nx", "javascript:alert(1)"])
      assert.throws(() => recordPr(projectDir, "github", "github:acme/widgets#1", url), url);
  });

  test("the policy holds the adapter to a repository and a label", () => {
    const base = { ...DEFAULT_POLICY, adapters: ["github"] };
    assert.throws(() => parsePolicy(JSON.stringify(base)), /needs github/);
    for (const github of [{ repo: "acme", label: "x" }, { repo: "acme/w", label: "a,b" }, { repo: "acme/w", label: " x" },
                          { repo: "acme/w", label: "x", extra: 1 }, { repo: "-/w", label: "x" }, { repo: "acme/..", label: "x" }])
      assert.throws(() => parsePolicy(JSON.stringify({ ...base, github })), JSON.stringify(github));
    assert.doesNotThrow(() => parsePolicy(JSON.stringify({ ...base, github: { repo: "acme/widgets", label: "desolate:run" } })));
  });
});
