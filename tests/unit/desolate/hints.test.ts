/// <reference types="node" />
// The follow-up commands desolate prints, per terminal (#9).
//
// The same process serves the editor's terminal (through the broker) and the
// Mac's (through `cli.sh desolate`), and a hint pasted into the wrong one is a
// command that does not exist there. Unset means "do not guess".

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { createHints, planeFrom } from "../../../release/vscode-image/hints.ts";

describe("one hint, two terminals", () => {
  test("the editor is told `desolate`, the Mac `./cli.sh desolate`", () => {
    assert.equal(
      createHints("editor").desolate("--stop acme"),
      "desolate --stop acme   (in the editor terminal)",
    );
    assert.equal(
      createHints("mac").desolate("--stop acme"),
      "./cli.sh desolate --stop acme   (on your Mac)",
    );
  });

  test("with no plane set it names both rather than guessing one", () => {
    const both = createHints(undefined).desolate("--stop acme");
    assert.match(both, /desolate --stop acme {3}\(in the editor terminal\)/);
    assert.match(both, /\.\/cli\.sh desolate --stop acme {3}\(on your Mac\)/);
  });

  test("an unknown plane is no plane", () => {
    assert.equal(planeFrom("Mac"), undefined);
    assert.equal(planeFrom(""), undefined);
    assert.equal(planeFrom("editor"), "editor");
  });

  test("a Mac-only command says Mac even to the editor", () => {
    for (const plane of ["editor", "mac", undefined] as const)
      assert.equal(
        createHints(plane).mac("worktree remove acme wip"),
        "./cli.sh worktree remove acme wip   (on your Mac)",
      );
  });
});

describe("every printed follow-up goes through the helper", () => {
  // A raw `desolate --...` in a string is a hint that ignores the plane.
  // Comments are exempt; they are read by people who know where they are.
  for (const file of ["desolate.ts", "ports.ts", "worktrees.ts"]) {
    test(file, () => {
      const source = fs.readFileSync(
        fileURLToPath(new URL(`../../../release/vscode-image/${file}`, import.meta.url)),
        "utf8",
      );
      const offenders = source
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
        .filter(({ line }) => /[`"'][^`"']*(\bdesolate --|\.\/cli\.sh )/.test(line))
        .filter(({ line }) => !/hint\.(anywhere|desolate|mac)\(/.test(line));
      assert.deepEqual(offenders, []);
    });
  }
});
