/// <reference types="node" />
// The rules that keep one daemon per project from becoming a machine that
// fills up -- and, more importantly, that keep the cure from being worse than
// the disease. Evicting a daemon somebody is working in to make room for
// somebody else kills a running build to start a different one.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  admit,
  reapable,
  type ProjectDaemon,
} from "../../../release/vscode-image/capacity.ts";

const MINUTE = 60_000;
const NOW = 1_000 * MINUTE;

const busy = (name: string): ProjectDaemon => ({
  name,
  running: true,
  inUse: true,
});

const idle = (name: string, forMinutes: number): ProjectDaemon => ({
  name,
  running: true,
  inUse: false,
  idleSince: NOW - forMinutes * MINUTE,
});

const stopped = (name: string): ProjectDaemon => ({
  name,
  running: false,
  inUse: false,
  idleSince: NOW - 999 * MINUTE,
});

describe("reaping idle daemons", () => {
  test("takes the ones idle for longer than the timeout", () => {
    assert.deepEqual(
      reapable([idle("a", 45), idle("b", 5)], NOW, 30 * MINUTE),
      ["a"],
    );
  });

  test("takes one idle for exactly the timeout", () => {
    assert.deepEqual(reapable([idle("a", 30)], NOW, 30 * MINUTE), ["a"]);
  });

  test("never takes one somebody is inside, however long it has run", () => {
    assert.deepEqual(reapable([busy("a")], NOW, 30 * MINUTE), []);
  });

  test("does not re-stop what is already stopped", () => {
    assert.deepEqual(reapable([stopped("a")], NOW, 30 * MINUTE), []);
  });
});

describe("admitting one more daemon", () => {
  test("under the ceiling, nothing has to stop", () => {
    assert.deepEqual(admit([busy("a"), busy("b")], 4), {
      admitted: true,
      evict: [],
    });
  });

  test("at the ceiling, the longest-idle one gives way", () => {
    assert.deepEqual(admit([busy("a"), idle("b", 5), idle("c", 40)], 3), {
      admitted: true,
      evict: ["c"],
    });
  });

  // The ceiling counts RUNNING daemons. A stopped one costs no memory, so it
  // is not what a new project is competing with.
  test("stopped daemons do not count against the ceiling", () => {
    assert.deepEqual(admit([busy("a"), stopped("b"), stopped("c")], 2), {
      admitted: true,
      evict: [],
    });
  });

  test("several must give way when the ceiling is already exceeded", () => {
    const { evict } = admit(
      [idle("a", 10), idle("b", 50), idle("c", 30)],
      2,
    ) as { evict: string[] };
    assert.deepEqual(evict, ["b", "c"]);
  });

  // The refusal is the point: a busy daemon is somebody's running build.
  test("a full set of busy daemons is refused, not evicted", () => {
    assert.deepEqual(admit([busy("a"), busy("b")], 2), {
      admitted: false,
      blockedBy: ["a", "b"],
    });
  });

  test("the refusal names only what is actually in the way", () => {
    assert.deepEqual(admit([busy("a"), idle("b", 5), busy("c")], 2), {
      admitted: false,
      blockedBy: ["a", "c"],
    });
  });

  test("a ceiling of one admits the first daemon", () => {
    assert.deepEqual(admit([], 1), { admitted: true, evict: [] });
  });
});
