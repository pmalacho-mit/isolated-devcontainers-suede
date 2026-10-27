/// <reference types="node" />
// What the desolate extension's views show, and which actions each node
// offers -- decided in model.mts, without VS Code.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  dindsTree, lastJson, projectsTree, redactTokens, targetKey, type Node,
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
  });

  test("each port can be opened: the editor at its URL, a container port at its address", () => {
    const editor = find(tree, "target:acme/widgets@:port:editor")!;
    assert.equal(editor.actions, "port");
    assert.equal(editor.target?.url, "http://127.0.0.1:8092/?tkn=x");
    assert.ok(!editor.label.includes("tkn") && !editor.description!.includes("tkn"), "the token is in the link only");
    const app = find(tree, "target:acme/widgets@:port:5173")!;
    assert.equal(app.actions, "port");
    assert.equal(app.target?.url, "http://127.0.0.1:8093/");
    assert.equal(find(tree, "target:acme/widgets@wip")!.actions, "worktree.stopped");
  });

  test("a status shows as the icon's colour and the message beside the state", () => {
    const statuses = new Map([
      [targetKey({ project: "acme/widgets", worktree: "wip" }), { color: "orange" as const, message: "needs a human", updated: "2026-10-27T12:00:00Z" }],
      [targetKey({ project: "acme/widgets", worktree: null }), { color: "green" as const, message: "", updated: "2026-10-27T12:00:00Z" }],
    ]);
    const shown = projectsTree(known, running, statuses);
    const wip = find(shown, "target:acme/widgets@wip")!;
    assert.equal(wip.iconColor, "charts.orange");
    assert.equal(wip.description, "needs a human · stopped");
    assert.match(wip.tooltip!, /^orange: needs a human -- 2026-10-27T12:00:00Z/);
    // A running row's key (worktree null) finds the same status as a known one's.
    const main = find(shown, "target:acme/widgets@")!;
    assert.equal(main.iconColor, "charts.green");
    assert.equal(main.description, "running · own dind");
    assert.equal(find(shown, "target:solo@")!.iconColor, undefined);
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
