/// <reference types="node" />
// One operation on a target at a time (locks.ts): the second is refused and
// told who holds it; a holder that died is taken over; a holder's exit lets
// go -- with real processes, as the orchestrator's runners are.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUSY_EXIT, hold, holderOf } from "../../../release/vscode-image/locks.ts";

const dir = mkdtempSync(join(tmpdir(), "desolate-locks-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const LOCKS = new URL("../../../release/vscode-image/locks.ts", import.meta.url).pathname;

/** Another process: holds `key` for `what`, says what it got, and exits. */
const elsewhere = (key: string, what: string) => spawnSync(process.execPath, ["--input-type=module", "-e", `
  const { hold } = await import(${JSON.stringify(LOCKS)});
  const got = hold(${JSON.stringify(key)}, ${JSON.stringify(what)}, ${JSON.stringify(dir)});
  console.log(JSON.stringify(got.held ? { held: true } : got));
`], { encoding: "utf8" });

describe("one operation on a target at a time", () => {
  test("the second is refused, and told who holds it and since when", () => {
    const now = new Date("2026-10-29T14:28:47Z");
    const mine = hold("acme__app--wt--issue-3", "starting", dir, now);
    assert.equal(mine.held, true);
    const other = JSON.parse(elsewhere("acme__app--wt--issue-3", "reviewing").stdout);
    assert.deepEqual(other, { held: false, holder: { pid: process.pid, what: "starting", since: "2026-10-29T14:28:47.000Z" } });
    assert.deepEqual(holderOf("acme__app--wt--issue-3", dir)?.what, "starting");
    if (mine.held) mine.release();
    assert.equal(holderOf("acme__app--wt--issue-3", dir), undefined);
  });

  test("another target is not held by it", () => {
    const mine = hold("acme__app", "starting", dir);
    assert.equal(JSON.parse(elsewhere("acme__app--wt--issue-3", "starting").stdout).held, true);
    if (mine.held) mine.release();
  });

  test("a holder's exit lets go: the next one gets it", () => {
    assert.equal(JSON.parse(elsewhere("acme__solo", "starting").stdout).held, true);
    assert.equal(existsSync(join(dir, "acme__solo.lock")), false, "released on exit");
    assert.equal(JSON.parse(elsewhere("acme__solo", "stopping").stdout).held, true);
  });

  test("a holder that died without letting go is taken over", () => {
    // A pid no process has: what a killed runner leaves.
    writeFileSync(join(dir, "acme__gone.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, what: "starting", since: "x" }));
    assert.equal(holderOf("acme__gone", dir), undefined);
    const mine = hold("acme__gone", "starting", dir);
    assert.equal(mine.held, true);
    if (mine.held) mine.release();
  });

  test("a lock that says nothing usable holds nothing", () => {
    writeFileSync(join(dir, "acme__junk.lock"), "not json");
    assert.equal(holderOf("acme__junk", dir), undefined);
    assert.equal(hold("acme__junk", "starting", dir).held, true);
  });

  test("busy is its own exit status: EX_TEMPFAIL", () => assert.equal(BUSY_EXIT, 75));
});
