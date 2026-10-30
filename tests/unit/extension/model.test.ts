/// <reference types="node" />
// What the desolate extension's views show, and which actions each node
// offers -- decided in model.mts, without VS Code.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  dindsTree, githubLinks, lastJson, memoryByProject, needsYouTree, pickItems, projectsSummary, projectsTree,
  redactTokens, reviewTree, shortBranch, targetKey, type Facts, type Node, type Status,
} from "../../../release/vscode-image/extension/model.mts";
import type { Review } from "../../../release/vscode-image/review.ts";

const find = (nodes: Node[], id: string): Node | undefined => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const below = find(node.children ?? [], id);
    if (below) return below;
  }
  return undefined;
};
const NOW = Date.parse("2026-10-29T12:00:00Z");
const status = (color: string, message: string, minutesAgo = 5): Status =>
  ({ color, message, updated: new Date(NOW - minutesAgo * 60_000).toISOString() });

describe("reading what the editor's commands print", () => {
  test("the last JSON line, past the broker's prose", () => {
    assert.deepEqual(lastJson("desolate: driving acme's daemon\n[{\"a\":1}]\n"), [{ a: 1 }]);
    assert.equal(lastJson("no json here\n"), undefined);
  });

  test("an editor token never reaches the log", () => {
    assert.equal(redactTokens("ready: http://127.0.0.1:8092/?tkn=abc123DEF&folder=/w"), "ready: http://127.0.0.1:8092/?tkn=…&folder=/w");
    // Whatever a token is made of: the first version stopped at a `-`, and
    // left the rest of it in the log (seen in the browser test).
    assert.equal(redactTokens("x?tkn=another-secret_token.v2 next"), "x?tkn=… next");
  });
});

describe("the Projects view", () => {
  const known = [
    { project: "acme/widgets" }, { project: "acme/widgets", worktree: "wip" }, { project: "acme/widgets", worktree: "issue-42" },
    { project: "acme/gadgets" }, { project: "solo" },
  ];
  const running = [{ target: "acme/widgets", project: "acme/widgets", worktree: null, daemon: "project",
                     url: "http://127.0.0.1:8092/?tkn=x", ports: { editor: 8092, "5173": 8093, "9000": 8094 } }];
  const facts = new Map<string, Facts>([
    [targetKey({ project: "acme/widgets" }), { branch: "main", commit: "a".repeat(40), github: "same", repo: "acme/widgets",
      portLabel: (port) => (port === 5173 ? "vite" : undefined), note: "\nworking on the parser\nsecond line" }],
    [targetKey({ project: "acme/widgets", worktree: "wip" }), { branch: "wip", commit: "b".repeat(40), github: "new", repo: "acme/widgets" }],
    [targetKey({ project: "acme/widgets", worktree: "issue-42" }),
      { branch: "downstream/acme/app-5e0c1d2e3f4a5b6c7d8e9f", commit: "c".repeat(40), github: "differs", repo: "acme/widgets" }],
  ]);
  const memory = new Map([["acme/widgets", { used: 3.1 * 1024 ** 3, limit: 12 * 1024 ** 3 }]]);
  const tree = projectsTree({ known, running, facts, memory, now: NOW });

  test("projects stand under their owners; one with no owner, after them", () => {
    assert.deepEqual(tree.map((n) => n.label), ["acme", "solo"]);
    assert.deepEqual(tree[0].children!.map((n) => n.label), ["widgets", "gadgets"]);
    assert.equal(tree[0].icon, "organization");
  });

  test("a running project: its ports first, labelled from devcontainer.json, then its note, then its worktrees", () => {
    const widgets = find(tree, "target:acme/widgets@")!;
    assert.deepEqual(widgets.children!.map((n) => n.label), ["editor", "vite (5173)", "container :9000", "note", "wip", "issue-42"]);
    assert.equal(widgets.expanded, true, "what runs is drawn open");
    assert.equal(find(tree, "target:acme/gadgets@")!.expanded, false);
  });

  test("its row: the icon's shape says it runs; beside it the branch and memory, and no words for what the icon says", () => {
    const widgets = find(tree, "target:acme/widgets@")!;
    assert.equal(widgets.icon, "vm-running");
    assert.equal(widgets.description, "main · 3.1 / 12.0 GiB");
    assert.ok(!widgets.description!.includes("running") && !widgets.description!.includes("dind"));
    assert.equal(find(tree, "target:solo@")!.icon, "vm-outline");
    assert.equal(find(tree, "target:solo@")!.description, "");
    assert.match(widgets.tooltip!, /State: running · its own dind/);
    assert.match(widgets.tooltip!, /Memory: 3\.1 GiB of 12\.0 GiB/);
  });

  test("whether GitHub has its commit: nothing said when it does; a new branch and a differing one are", () => {
    assert.equal(find(tree, "target:acme/widgets@wip")!.description, "↑ not on GitHub", "on a branch of its own name, the name is not said twice");
    const issue = find(tree, "target:acme/widgets@issue-42")!;
    assert.equal(issue.description, "downstream/acm…e3f4a5b6c7d8e9f ≠ GitHub");
    assert.match(issue.actions!, /\.unpushed/);
    assert.doesNotMatch(find(tree, "target:acme/widgets@")!.actions!, /unpushed/);
  });

  test("once reviewed, the counts -- while the reviewed commit is still what is checked out", () => {
    const counts = new Map([[targetKey({ project: "acme/widgets", worktree: "issue-42" }), { head: "c".repeat(40), ahead: 2, behind: 1 }],
                            [targetKey({ project: "acme/widgets", worktree: "wip" }), { head: "0".repeat(40), ahead: 5, behind: 0 }]]);
    const shown = projectsTree({ known, running, facts, counts, now: NOW });
    assert.match(find(shown, "target:acme/widgets@issue-42")!.description!, /↑2 ↓1$/);
    assert.equal(find(shown, "target:acme/widgets@wip")!.description, "↑ not on GitHub", "a review of another commit says nothing now");
  });

  test("a long branch is shortened in its middle, keeping both ends", () => {
    assert.equal(shortBranch("downstream/pmalacho-mit/suede.sweater-vest-e80217d"), "downstream/pma…er-vest-e80217d");
    assert.equal(shortBranch("main"), "main");
  });

  test("each port can be opened: the editor at its URL, a container port at its address", () => {
    const editor = find(tree, "target:acme/widgets@:port:editor")!;
    assert.equal(editor.actions, "port");
    assert.equal(editor.click, "desolate.openPort");
    assert.equal(editor.target?.url, "http://127.0.0.1:8092/?tkn=x");
    assert.equal(editor.description, ":8092");
    assert.ok(!editor.label.includes("tkn") && !editor.description!.includes("tkn"), "the token is in the link only");
    assert.equal(find(tree, "target:acme/widgets@:port:5173")!.target?.url, "http://127.0.0.1:8093/");
  });

  test("the note: its first line beside it, all of it in its tooltip, opened on a click", () => {
    const note = find(tree, "target:acme/widgets@:note")!;
    assert.equal(note.description, "working on the parser");
    assert.equal(note.details![0].text, "\nworking on the parser\nsecond line");
    assert.equal(note.click, "desolate.openNote");
  });

  test("a status: the icon's colour, the message beside the branch, its age in the tooltip", () => {
    const statuses = new Map([
      [targetKey({ project: "acme/widgets", worktree: "wip" }), status("orange", "needs a human", 4)],
      [targetKey({ project: "acme/widgets" }), status("green", "", 90)],
    ]);
    const shown = projectsTree({ known, running, statuses, facts, now: NOW });
    const wip = find(shown, "target:acme/widgets@wip")!;
    assert.equal(wip.iconColor, "charts.orange");
    assert.equal(wip.description, "↑ not on GitHub · needs a human");
    assert.match(wip.tooltip!, /Status \(orange, 4m ago\): needs a human/);
    assert.equal(find(shown, "target:acme/widgets@")!.iconColor, "charts.green");
    assert.equal(find(shown, "target:solo@")!.iconColor, undefined);
  });

  test("a status's words are kept as they are, for the view to escape -- never read as markdown here", () => {
    const statuses = new Map([[targetKey({ project: "solo" }), status("red", "see ![x](https://evil.example/p.png) **now**")]]);
    const solo = find(projectsTree({ known, running, statuses, now: NOW }), "target:solo@")!;
    assert.equal(solo.details!.find((d) => d.label.startsWith("Status"))!.text, "see ![x](https://evil.example/p.png) **now**");
    assert.ok(solo.details!.every((d) => !d.label.includes("evil")), "a label is never a writer's");
  });

  test("while an action runs: a spinner, what it is doing, and none of its actions", () => {
    const busy = new Map([[targetKey({ project: "solo" }), "starting…"]]);
    const solo = find(projectsTree({ known, running, busy, now: NOW }), "target:solo@")!;
    assert.equal(solo.icon, "loading~spin");
    assert.equal(solo.description, "starting…");
    assert.match(solo.actions!, /\.busy$/);
  });

  test("what a target offers: its state, and GitHub's pages when its repository is known", () => {
    assert.equal(find(tree, "target:acme/widgets@")!.actions, "project.running.github.branch");
    assert.equal(find(tree, "target:acme/widgets@issue-42")!.actions, "worktree.stopped.unpushed.github.branch.issue");
    assert.equal(find(tree, "target:solo@")!.actions, "project.stopped");
  });

  test("running only: what runs, and the projects it is in", () => {
    const worktreeUp = [...running, { target: "acme/gadgets@try", project: "acme/gadgets", worktree: "try", url: null, ports: {} }];
    const shown = projectsTree({ known: [...known, { project: "acme/gadgets", worktree: "try" }], running: worktreeUp, runningOnly: true, now: NOW });
    assert.deepEqual(shown.map((n) => n.label), ["acme"]);
    assert.deepEqual(shown[0].children!.map((n) => n.label), ["widgets", "gadgets"]);
    assert.ok(!find(shown, "target:acme/widgets@wip"), "a stopped worktree is not shown");
    assert.ok(find(shown, "target:acme/gadgets@try"));
    assert.equal(find(shown, "target:acme/gadgets@")!.expanded, true, "its project is drawn open, so it is in sight");
    assert.equal(projectsTree({ known, running: [], runningOnly: true })[0].label, "nothing is running");
  });

  test("no projects at all is no nodes: the view's welcome says what to do", () => {
    assert.deepEqual(projectsTree({ known: [], running: [] }), []);
  });

  test("its title: what runs, and what the VM has left", () => {
    assert.equal(projectsSummary(running, { running: 1, max: 16, available: 9.1 * 1024 ** 3, floor: 0 }), "1 running · 9.1 GiB free");
    assert.equal(projectsSummary([]), "0 running");
  });
});

describe("GitHub's pages for a target", () => {
  test("its issue, its branch, the pull requests from it -- and nothing without a repository", () => {
    const links = githubLinks({ project: "acme/widgets", worktree: "issue-7", branch: "downstream/acme/app-5e0c", repo: "acme/widgets" });
    assert.equal(links.issue, "https://github.com/acme/widgets/issues/7");
    assert.equal(links.branch, "https://github.com/acme/widgets/tree/downstream/acme/app-5e0c");
    assert.equal(links.pulls, "https://github.com/acme/widgets/pulls?q=is%3Apr%20head%3Adownstream%2Facme%2Fapp-5e0c");
    assert.deepEqual(githubLinks({ project: "solo", branch: "main" }), {});
    assert.deepEqual(githubLinks({ project: "x/y", repo: "x/y/../z" }), {}, "a repository is held to owner/repo");
  });

  test("a worktree that is not issue-<n> has no issue", () => {
    assert.equal(githubLinks({ project: "a/b", worktree: "issue-7x", repo: "a/b" }).issue, undefined);
  });
});

describe("the Needs you view", () => {
  const known = [{ project: "acme/widgets" }, { project: "acme/widgets", worktree: "issue-5" }, { project: "solo" }, { project: "acme/gadgets" }];
  const running = [{ target: "acme/widgets@issue-5", project: "acme/widgets", worktree: "issue-5", url: "http://127.0.0.1:8095/?tkn=y", ports: { editor: 8095 } }];
  const statuses = new Map([
    [targetKey({ project: "acme/widgets", worktree: "issue-5" }), status("orange", "Which formatter wins on conflict?", 4)],
    [targetKey({ project: "solo" }), status("green", "ready: sync widget", 30)],
    [targetKey({ project: "acme/widgets" }), status("blue", "working", 1)],
    [targetKey({ project: "acme/gadgets" }), status("red", "authentication failed", 2)],
  ]);
  const facts = new Map<string, Facts>([[targetKey({ project: "acme/widgets", worktree: "issue-5" }), { branch: "issue/5", github: "unknown", repo: "acme/widgets" }]]);
  const tree = needsYouTree({ known, running, statuses, facts, now: NOW });

  test("what asks something of a person, newest first; working is not that", () => {
    assert.deepEqual(tree.map((n) => n.label), ["gadgets", "widgets · issue-5", "solo"]);
  });

  test("each: its whole message and age, an icon for what it asks, and what can be done from it", () => {
    const issue = tree[1];
    assert.equal(issue.description, "Which formatter wins on conflict? · 4m");
    assert.equal(issue.icon, "question");
    assert.equal(issue.iconColor, "charts.orange");
    assert.equal(issue.actions, "needs.orange.running.issue.branch");
    assert.equal(issue.click, "desolate.reveal");
    assert.equal(tree[2].actions, "needs.green.stopped");
    assert.equal(tree[0].icon, "error");
  });

  test("one marked as seen stays out until its agent says something new", () => {
    const key = targetKey({ project: "solo" });
    const seen = new Map([[key, statuses.get(key)!.updated]]);
    assert.ok(!needsYouTree({ known, running, statuses, seen, now: NOW }).some((n) => n.label === "solo"));
    const newer = new Map(statuses).set(key, status("green", "ready again", 1));
    assert.ok(needsYouTree({ known, running, statuses: newer, seen, now: NOW }).some((n) => n.label === "solo"));
  });
});

describe("the Review view", () => {
  const sha = (c: string) => c.repeat(40);
  const review: Review = {
    branch: "issue/8", head: sha("a"), base: { ref: "origin/main", commit: sha("b"), from: sha("b") },
    ahead: 2, behind: 0, uncommitted: 1,
    commits: [{ commit: sha("c"), time: NOW / 1000 - 7200, author: "Ada", subject: "a second step" },
              { commit: sha("d"), time: NOW / 1000 - 9000, author: "Ada", subject: "the feature" }],
    files: [
      { index: 1, status: "A", path: "src/added.ts", kind: "text", sizes: [0, 11], sides: { a: false, b: true } },
      { index: 2, status: "R100", path: "new-name.txt", from: "old-name.txt", kind: "text", sizes: [25, 25], sides: { a: true, b: true } },
      { index: 3, status: "A", path: "blob.bin", kind: "binary", sizes: [0, 5], sides: { a: false, b: true } },
    ],
    more: false,
    dir: "/x",
  };
  const target = { project: "acme/app", worktree: "issue-8" };

  test("what it is compared with, then why the push might not do what you think, then commits and files", () => {
    const tree = reviewTree(review, target, NOW);
    assert.deepEqual(tree.map((n) => n.id), ["review:summary", "review:uncommitted", "review:commits", "review:files"]);
    assert.equal(tree[0].label, "issue/8 → origin/main");
    assert.equal(tree[0].description, "2 commits to push · a new branch on GitHub");
    assert.equal(tree[1].label, "1 uncommitted change");
  });

  test("its commits: subject, then short sha, author and age", () => {
    const commits = reviewTree(review, target, NOW).find((n) => n.id === "review:commits")!;
    assert.equal(commits.children![0].label, "a second step");
    assert.equal(commits.children![0].description, "ccccccc · Ada · 2h");
  });

  test("its files: name, folder, a rename's old path, and what cannot be shown says so", () => {
    const files = reviewTree(review, target, NOW).find((n) => n.id === "review:files")!.children!;
    assert.deepEqual(files.map((n) => [n.label, n.description, n.icon]), [
      ["added.ts", "src", "diff-added"],
      ["new-name.txt", "← old-name.txt", "diff-renamed"],
      ["blob.bin", "(binary: not shown)", "diff-added"],
    ]);
    assert.equal(files[0].click, "desolate.openReviewFile");
    assert.equal(files[0].file, 1);
    assert.equal(files[2].actions, "reviewfile.binary");
  });

  test("behind GitHub, it says to pull first; nothing ahead, that there is nothing to push", () => {
    const behind = reviewTree({ ...review, behind: 3, base: { ref: "origin/issue/8", commit: sha("b") } }, target, NOW);
    assert.equal(behind.find((n) => n.id === "review:behind")?.label, "pull first");
    assert.doesNotMatch(behind[0].description!, /new branch/);
    const done = reviewTree({ ...review, ahead: 0, commits: [], files: [] }, target, NOW);
    assert.equal(done.find((n) => n.id === "review:nothing")?.label, "nothing to push");
  });
});

describe("the palette", () => {
  test("each target, with what it is and what it says", () => {
    const items = pickItems({
      known: [{ project: "acme/widgets" }, { project: "acme/widgets", worktree: "wip" }],
      running: [{ target: "acme/widgets", project: "acme/widgets", worktree: null, url: "u", ports: {} }],
      statuses: new Map([[targetKey({ project: "acme/widgets", worktree: "wip" }), status("orange", "a question")]]),
      facts: new Map([[targetKey({ project: "acme/widgets" }), { branch: "main", github: "same" as const }]]),
    });
    assert.deepEqual(items.map((i) => [i.label, i.description, i.detail]), [
      ["$(vm-running) acme/widgets", "main · running", undefined],
      ["$(vm-outline) acme/widgets · wip", "stopped", "orange: a question"],
    ]);
    assert.equal(items[0].target.running, true);
  });
});

describe("the Dinds view", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const status = {
    dinds: [
      { project: "acme/widgets", name: "desolate-dind-acme__widgets", health: "healthy", running: true, inUse: false,
        idleSince: now - 90 * 60_000, memory: 2 * 1024 ** 3, memoryLimit: 6 * 1024 ** 3, imageStoreKib: 3 * 1024 ** 2 },
      { project: "solo", name: "desolate-dind-solo", health: "stopped", running: false },
    ],
    headroom: { running: 1, max: 16, available: 30 * 1024 ** 3, floor: 2 * 1024 ** 3 },
  };

  test("health, use, memory of its ceiling and store per dind, and the headroom", () => {
    const tree = dindsTree(status, now);
    assert.equal(tree[0].description, "healthy · idle 1h30m · 2.0 GiB of 6.0 GiB · store 3.0 GiB");
    assert.equal(tree[1].description, "stopped · store ?");
    assert.equal(tree[2].description, "1 of 16 running · 30.0 GiB free, 2.0 GiB kept back");
  });

  test("each running project's memory, for its row in Projects", () => {
    assert.deepEqual([...memoryByProject(status)], [["acme/widgets", { used: 2 * 1024 ** 3, limit: 6 * 1024 ** 3 }]]);
  });

  test("none is said, not shown as an empty view", () => {
    assert.equal(dindsTree({ dinds: [], headroom: null })[0].label, "no project dinds");
  });
});
