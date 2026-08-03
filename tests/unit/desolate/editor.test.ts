/// <reference types="node" />
// The editor start script.
//
// This string is executed as root inside the project's container. Both values
// it interpolates arrive from a devcontainer.json the editor can write, so the
// injection cases below are the reason the validators exist -- not hypotheticals.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  EDITOR_INTERNAL_PORT,
  EditorScriptError,
  editorStartScript,
  isValidExtensionId,
  isValidToken,
  mintToken,
} from "../../../release/vscode-image/editor.ts";

const TOKEN = "a".repeat(48);
const script = (extensions: string[] = [], token = TOKEN) =>
  editorStartScript("/vscode-server", extensions, token);

describe("the connection token", () => {
  test("a minted token is accepted by its own validator", () => {
    const bytes = (n: number) => new Uint8Array(n).fill(0xab);
    const token = mintToken(bytes);
    assert.equal(token, "ab".repeat(24));
    assert.equal(token.length, 48);
    assert.ok(isValidToken(token));
  });

  test("low bytes are zero-padded, so the length is always 48", () => {
    assert.equal(mintToken((n) => new Uint8Array(n)).length, 48);
    assert.ok(isValidToken(mintToken((n) => new Uint8Array(n))));
  });

  test("anything but 48 lowercase hex chars is refused", () => {
    for (const bad of [
      "",
      "a".repeat(47),
      "a".repeat(49),
      "A".repeat(48), // uppercase
      "g".repeat(48), // not hex
      `${"a".repeat(47)}'`, // the injection shape
    ])
      assert.equal(isValidToken(bad), false, JSON.stringify(bad));
  });

  test("an invalid token cannot reach the script", () => {
    // A single apostrophe closes --connection-token '...' and the rest runs
    // as root in the container.
    assert.throws(
      () => script([], `${"a".repeat(47)}'; id > /tmp/pwned; echo '`),
      EditorScriptError,
    );
  });

  test("a valid token is interpolated inside single quotes", () => {
    assert.match(script(), new RegExp(`--connection-token '${TOKEN}'`));
  });
});

describe("extension ids", () => {
  test("ordinary marketplace ids are accepted", () => {
    for (const id of [
      "ms-python.python",
      "esbenp.prettier-vscode",
      "ms-python.python@2024.1.0",
      "a.b",
    ])
      assert.ok(isValidExtensionId(id), id);
  });

  test("anything that could break out of the quoting is refused", () => {
    for (const id of [
      "no-dot",
      "'; id #",
      "a.b'; rm -rf / #",
      "a.b c.d", // a space smuggles a second argument
      "$(id).x",
      "`id`.x",
      "a.b\nc.d", // a newline smuggles a whole command
      ".b",
      "a.",
      "",
      42,
      null,
      undefined,
    ])
      assert.equal(isValidExtensionId(id as never), false, JSON.stringify(id));
  });

  test("a malformed id cannot reach the script", () => {
    assert.throws(() => script(["ms-python.python", "'; id #"]), EditorScriptError);
  });

  test("accepted ids are each single-quoted in the install loop", () => {
    const out = script(["ms-python.python", "esbenp.prettier-vscode"]);
    assert.match(out, /for e in 'ms-python\.python' 'esbenp\.prettier-vscode'; do/);
  });

  test("no extensions still yields a runnable loop", () => {
    // `for e in ; do` is valid bash and iterates zero times.
    assert.match(script([]), /for e in ; do/);
  });
});

describe("the script itself", () => {
  test("starts the server on the fixed internal port", () => {
    const out = script();
    assert.match(out, new RegExp(`--port ${EDITOR_INTERNAL_PORT}\\b`));
    assert.match(out, new RegExp(`/dev/tcp/127\\.0\\.0\\.1/${EDITOR_INTERNAL_PORT}`));
  });

  test("binds 0.0.0.0 so the relay can reach it", () => {
    // The relay dials the container's IP, not loopback; a server on 127.0.0.1
    // answers the in-container probe and nothing else.
    assert.match(script(), /--host 0\.0\.0\.0/);
  });

  test("takes the server path it is given rather than assuming one", () => {
    assert.match(
      editorStartScript("/somewhere-else", [], TOKEN),
      /SRV=\/somewhere-else\/bin\/openvscode-server/,
    );
  });

  test("refuses to run if the server binary is absent", () => {
    // The overlay mount is what puts it there; a missing binary means that
    // mount silently did not happen, and starting anyway hides the cause.
    assert.match(script(), /if \[ ! -x "\$SRV" \]; then/);
    assert.match(script(), /exit 1/);
  });

  test("does not start a second server when one already answers", () => {
    assert.match(script(), /editor already listening/);
  });
});
