/// <reference types="node" />
// The rules that keep one daemon per project from becoming a machine that
// fills up -- and, more importantly, that keep the cure from being worse than
// the disease. Evicting a daemon somebody is working in to make room for
// somebody else kills a running build to start a different one.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  admit,
  budget,
  memAvailable,
  reapable,
  DEFAULTS,
  type Budget,
  type ProjectDaemon,
} from "../../../release/vscode-image/capacity.ts";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** A budget where memory is never the constraint, so the count rules can be
 *  read on their own. */
const ceiling = (max: number): Budget => ({ max, available: Infinity, floor: 0, newcomer: 0 });

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
    assert.deepEqual(admit([busy("a"), busy("b")], ceiling(4)), {
      admitted: true,
      evict: [],
    });
  });

  test("at the ceiling, the longest-idle one gives way", () => {
    assert.deepEqual(admit([busy("a"), idle("b", 5), idle("c", 40)], ceiling(3)), {
      admitted: true,
      evict: ["c"],
    });
  });

  // The ceiling counts RUNNING daemons. A stopped one costs no memory, so it
  // is not what a new project is competing with.
  test("stopped daemons do not count against the ceiling", () => {
    assert.deepEqual(admit([busy("a"), stopped("b"), stopped("c")], ceiling(2)), {
      admitted: true,
      evict: [],
    });
  });

  test("several must give way when the ceiling is already exceeded", () => {
    const { evict } = admit(
      [idle("a", 10), idle("b", 50), idle("c", 30)],
      ceiling(2),
    ) as { evict: string[] };
    assert.deepEqual(evict, ["b", "c"]);
  });

  // The refusal is the point: a busy daemon is somebody's running build.
  test("a full set of busy daemons is refused, not evicted", () => {
    assert.deepEqual(admit([busy("a"), busy("b")], ceiling(2)), {
      admitted: false,
      reason: "ceiling",
      blockedBy: ["a", "b"],
    });
  });

  test("the refusal names only what is actually in the way", () => {
    assert.deepEqual(admit([busy("a"), idle("b", 5), busy("c")], ceiling(2)), {
      admitted: false,
      reason: "ceiling",
      blockedBy: ["a", "c"],
    });
  });

  test("a ceiling of one admits the first daemon", () => {
    assert.deepEqual(admit([], ceiling(1)), { admitted: true, evict: [] });
  });
});

describe("admission by headroom", () => {
  const vm = (availableGiB: number): Budget => ({
    max: 16,
    available: availableGiB * GIB,
    floor: 2 * GIB,
    newcomer: 512 * MIB,
  });
  const idleHolding = (name: string, forMinutes: number, gib: number): ProjectDaemon => ({
    ...idle(name, forMinutes),
    memory: gib * GIB,
  });

  test("ten projects fit on a VM with room for them -- a budget, not a ceiling", () => {
    const ten = Array.from({ length: 10 }, (_, i) => busy(`p${i}`));
    assert.deepEqual(admit(ten, vm(8)), { admitted: true, evict: [] });
  });

  test("a start that would leave less than the floor evicts the longest-idle first", () => {
    assert.deepEqual(
      admit([busy("a"), idleHolding("b", 5, 1), idleHolding("c", 60, 1)], vm(2)),
      { admitted: true, evict: ["c"] },
    );
  });

  test("as many give way as the headroom needs, by what each one holds -- and no more", () => {
    // Short by 512 MiB; each frees 256 MiB: two go, longest-idle first, and
    // the third, which nothing needs, stays up.
    const { evict } = admit(
      [idleHolding("a", 10, 0.25), idleHolding("b", 50, 0.25), idleHolding("c", 30, 0.25)],
      vm(2),
    ) as { evict: string[] };
    assert.deepEqual(evict, ["b", "c"]);
  });

  test("when only busy daemons hold the memory, it is a refusal that says memory", () => {
    assert.deepEqual(admit([busy("a"), busy("b")], vm(2)), {
      admitted: false,
      reason: "memory",
      blockedBy: ["a", "b"],
    });
  });

  test("the hard cap still holds when memory is plentiful", () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => busy(`p${i}`));
    const refused = admit(sixteen, vm(64));
    assert.equal(refused.admitted, false);
    assert.equal((refused as { reason: string }).reason, "ceiling");
  });

  test("an unmeasured daemon is credited with the newcomer estimate", () => {
    // 2 GiB available, 2 GiB floor, 512 MiB newcomer: short by 512 MiB, which
    // one unmeasured idle daemon covers.
    assert.deepEqual(admit([idle("a", 5)], vm(2)), { admitted: true, evict: ["a"] });
  });
});

describe("the budget, from the environment and /proc/meminfo", () => {
  const MEMINFO = "MemTotal:       16384000 kB\nMemFree:  100 kB\nMemAvailable:    8388608 kB\n";

  test("reads MemAvailable, in bytes", () => {
    assert.equal(memAvailable(MEMINFO), 8 * GIB);
  });

  test("defaults are the documented ones", () => {
    assert.deepEqual(budget({}, MEMINFO), {
      max: DEFAULTS.maxDinds,
      available: 8 * GIB,
      floor: 2 * GIB,
      newcomer: 512 * MIB,
    });
    assert.equal(DEFAULTS.maxDinds, 16);
  });

  test("the environment overrides them", () => {
    const b = budget({ DESOLATE_MAX_DINDS: "4", DESOLATE_DIND_MEM_FLOOR: "1073741824" }, MEMINFO);
    assert.equal(b.max, 4);
    assert.equal(b.floor, GIB);
  });

  test("no MemAvailable is a refusal, not a zero and not plenty", () => {
    assert.throws(() => budget({}, "MemTotal: 1 kB\n"), /refusing to guess/);
  });

  for (const raw of ["0", "-1", "8G", "1e9", " 4"])
    test(`a malformed DESOLATE_MAX_DINDS (${JSON.stringify(raw)}) is a refusal`, () => {
      assert.throws(() => budget({ DESOLATE_MAX_DINDS: raw }, MEMINFO), /positive integer/);
    });
});
