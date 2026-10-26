/// <reference types="node" />
// What the desolate extension's views show, and which actions each node
// offers -- decided in model.mts, without VS Code.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  dindsTree, factoryTree, jsonLines, lastJson, needsAnswer, projectsTree, redactTokens,
  type MessageRow, type Node, type RequestRow,
} from "../../../release/vscode-image/extension/model.mts";

const find = (nodes: Node[], id: string): Node | undefined => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const below = find(node.children ?? [], id);
    if (below) return below;
  }
  return undefined;
};

describe("reading what the editor's commands print", () => {
  test("the last JSON line, past the broker's prose", () => {
    assert.deepEqual(lastJson("desolate: driving acme's daemon\n[{\"a\":1}]\n"), [{ a: 1 }]);
    assert.equal(lastJson("no json here\n"), undefined);
    assert.deepEqual(jsonLines('{"a":1}\nprose\n{"b":2}\n{broken\n'), [{ a: 1 }, { b: 2 }]);
  });

  test("an editor token never reaches the log", () => {
    assert.equal(redactTokens("ready: http://127.0.0.1:8092/?tkn=abc123DEF&folder=/w"), "ready: http://127.0.0.1:8092/?tkn=…&folder=/w");
    // Whatever a token is made of: the first version stopped at a `-`, and
    // left the rest of it in the log (seen in the browser test).
    assert.equal(redactTokens("x?tkn=another-secret_token.v2 next"), "x?tkn=… next");
  });
});

describe("the Projects view", () => {
  const known = [{ project: "acme/widgets" }, { project: "acme/widgets", worktree: "wip" }, { project: "solo" }];
  const running = [{ target: "acme/widgets", project: "acme/widgets", worktree: null, daemon: "project",
                     url: "http://127.0.0.1:8092/?tkn=x", ports: { editor: 8092, "5173": 8093 } }];
  const tree = projectsTree(known, running);

  test("every project, with its worktrees under it", () => {
    assert.deepEqual(tree.map((n) => n.label), ["acme/widgets", "solo"]);
    assert.equal(find(tree, "target:acme/widgets@wip")?.label, "wip");
  });

  test("a running target offers open and stop, and lists its ports; a stopped one offers start", () => {
    const up = find(tree, "target:acme/widgets@")!;
    assert.equal(up.actions, "project.running");
    assert.equal(up.target?.url, "http://127.0.0.1:8092/?tkn=x");
    assert.equal(up.description, "running · own dind");
    assert.deepEqual(up.children!.filter((n) => n.id.includes(":port:")).map((n) => n.description), ["127.0.0.1:8092", "127.0.0.1:8093"]);
    assert.equal(find(tree, "target:solo@")!.actions, "project.stopped");
    assert.equal(find(tree, "target:acme/widgets@wip")!.actions, "worktree.stopped");
  });
});

describe("the Dinds view", () => {
  test("health, use, memory and store per dind, and the headroom", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    const tree = dindsTree({
      dinds: [
        { project: "acme/widgets", name: "desolate-dind-acme__widgets", health: "healthy", running: true, inUse: false,
          idleSince: now - 90 * 60_000, memory: 2 * 1024 ** 3, imageStoreKib: 3 * 1024 ** 2 },
        { project: "solo", name: "desolate-dind-solo", health: "stopped", running: false },
      ],
      headroom: { running: 1, max: 16, available: 30 * 1024 ** 3, floor: 2 * 1024 ** 3 },
    }, now);
    assert.equal(tree[0].description, "healthy · idle 1h30m · 2.0 GiB · store 3.0 GiB");
    assert.equal(tree[1].description, "stopped · store ?");
    assert.equal(tree[2].description, "1 of 16 running · 30.0 GiB free, 2.0 GiB kept back");
  });

  test("none is said, not shown as an empty view", () => {
    assert.equal(dindsTree({ dinds: [], headroom: null })[0].label, "no project dinds");
  });
});

describe("the Factory view", () => {
  const requests: RequestRow[] = [
    { id: "01J0", action: "open", worktree: "issue-42", from: "forge/github", outcome: "refused: hooks", approved: false },
    { id: "01J1", action: "open", worktree: "issue-43", from: "main", outcome: "waiting", approved: false },
    { id: "01J2", action: "open", worktree: "issue-44", from: "main", outcome: "opened", approved: false },
    { id: "01J3", action: "open", worktree: "issue-45", from: "main", outcome: "refused: cap", approved: true },
  ];
  const message = (fields: Partial<MessageRow>): MessageRow =>
    ({ commit: "c".repeat(40), time: "2026-10-26T12:00:00Z", from: "issue-42", to: ["*"], type: "status", body: "", ...fields });
  const messages = [
    message({ commit: "a".repeat(40), type: "ask", to: ["main"], body: "Which API version?\u001b[31m" }),
    message({ commit: "b".repeat(40), type: "ask", to: ["issue-43"], body: "not for a person" }),
    message({ commit: "d".repeat(40), type: "done", body: "ready" }),
  ];
  const node = factoryTree("acme", { max_open_worktrees: 2 }, requests, messages, ["issue-44"]);

  test("an ask to the main tree or the human is waiting on you, and can be answered", () => {
    assert.equal(node.description, "1 ask waiting");
    const waiting = find([node], "factory:acme:asks")!;
    assert.equal(waiting.children!.length, 1);
    assert.equal(waiting.children![0].actions, "message.ask");
    assert.equal(waiting.children![0].target?.from, "issue-42");
    assert.ok(needsAnswer(message({ type: "ask", to: ["@human"] })));
    assert.ok(!needsAnswer(message({ type: "ask", to: ["issue-43"] })));
  });

  test("a writer's text is shown as one plain line, its escapes gone", () => {
    const shown = find([node], "factory:acme:asks")!.children![0];
    assert.equal(shown.label, "ask: Which API version? [31m");
  });

  test("only a refused or waiting request, not yet approved, can be approved", () => {
    const actions = (id: string) => find([node], `factory:acme:request:${id}`)!.actions;
    assert.deepEqual(["01J0", "01J1", "01J2", "01J3"].map(actions),
      ["request.approvable", "request.approvable", "request", "request"]);
  });

  test("an open worktree can be pushed or closed from here", () => {
    assert.equal(find([node], "factory:acme:worktree:issue-44")!.actions, "factory.worktree");
  });
});
