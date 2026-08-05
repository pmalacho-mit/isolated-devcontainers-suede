/// <reference types="node" />
// The program the editor runs in a child to reach the keyring.
//
// It is SOURCE CODE held in a string, which means nothing type-checks it, no
// linter reads it, and node only discovers it is malformed when a user runs
// `repo add`. It was malformed: built with a template literal, `"\n"` inside
// one is a real newline, and the child was handed three unterminated string
// literals. Every failure then surfaced as "cannot reach the keyring" -- so the
// bug survived from the commit that introduced the keyring until someone
// checked why an obviously-running keyring was unreachable.
//
// Parsing it here costs a millisecond and is the check that was missing.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

import { CLIENT } from "../../../release/vscode-image/keyring-client.ts";

describe("the keyring client program", () => {
  test("is syntactically valid JavaScript", () => {
    // `new vm.Script` compiles without running -- the child would not get as
    // far as connecting to anything if this throws.
    assert.doesNotThrow(() => new vm.Script(CLIENT));
  });

  test("carries the newline as an ESCAPE, not as the character it stands for", () => {
    // The bug, stated directly, because the compile check above says only THAT
    // it broke. A real newline inside a string literal is invisible in a diff,
    // so name the two characters that must be there.
    assert.ok(
      CLIENT.includes(String.raw`"\n"`),
      "the newline the protocol frames on is not an escape sequence",
    );
  });

  test("takes its socket and request as ARGUMENTS, not as interpolated source", () => {
    // An alias reaches this from the command line. Interpolating a value into a
    // program is a question about escaping; passing it in argv is not a
    // question at all.
    assert.ok(CLIENT.includes("process.argv"), "inputs are not read from argv");
    assert.equal(
      CLIENT.includes("${"),
      false,
      "the program interpolates something into itself",
    );
  });
});
