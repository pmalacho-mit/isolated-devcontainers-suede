/// <reference types="node" />
// A runner serving the Mac prints no control character (plain-output.ts):
// what its children print -- a project's lifecycle commands, its builds --
// lands in a terminal on the Mac, which acts on escape sequences.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { plainWriter, wantsPlain, PLAIN_VARIABLE } from "../../../release/vscode-image/plain-output.ts";

describe("which runs run themselves again, plainly", () => {
  test("the Mac's, once, and never an --exec: that one is a terminal on purpose", () => {
    assert.equal(wantsPlain({ DESOLATE_PLANE: "mac" }, ["acme/widgets"]), true);
    assert.equal(wantsPlain({ DESOLATE_PLANE: "mac", [PLAIN_VARIABLE]: "1" }, ["acme/widgets"]), false);
    assert.equal(wantsPlain({ DESOLATE_PLANE: "mac" }, ["--exec", "acme/widgets", "--", "bash"]), false);
    assert.equal(wantsPlain({ DESOLATE_PLANE: "editor" }, ["acme/widgets"]), false, "the broker relays through plainText already");
    assert.equal(wantsPlain({}, ["acme/widgets"]), false);
  });
});

describe("what it prints", () => {
  const through = (...chunks: Buffer[]) => {
    let said = "";
    const write = plainWriter((text) => (said += text));
    for (const chunk of chunks) write(chunk);
    write.end();
    return said;
  };

  test("no escape sequence reaches the terminal: a title, iTerm2's OSC 1337, a status request, a C1 control", () => {
    const hostile = "\x1b]0;evil title\x07\x1b]1337;SetUserVar=x=eA==\x07\x1b[6n\x1b[21t\u009b6n";
    const said = through(Buffer.from(`npm install\n${hostile}done\n`));
    assert.doesNotMatch(said, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    assert.match(said, /^npm install\n.*done\n$/s);
  });

  test("text, tabs and newlines are as they were, a character split across chunks too", () => {
    const text = Buffer.from("café\tok\n");
    assert.equal(through(text.subarray(0, 4), text.subarray(4)), "café\tok\n");
  });
});
