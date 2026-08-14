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
  SERVER_BIN,
  editorCustomizations,
  editorStartScript,
  isValidExtensionId,
  isValidToken,
  mintToken,
} from "../../../release/vscode-image/editor.ts";

const TOKEN = "a".repeat(48);
const script = (
  extensions: string[] = [],
  token = TOKEN,
  settings: Record<string, any> = {},
) => editorStartScript("/vscode-server", { extensions, settings }, token);

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
      editorStartScript(
        "/somewhere-else",
        { extensions: [], settings: {} },
        TOKEN,
      ),
      new RegExp(`SRV=/somewhere-else/bin/${SERVER_BIN}`),
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

describe("customizations.*.settings, applied", () => {
  const settings = { "editor.tabSize": 2, "[svelte]": { a: true } };
  const applied = script([], TOKEN, settings);

  test("they land in MACHINE scope, under the server data dir", () => {
    // The scope decides the precedence, and Machine is the one VS Code's own
    // Dev Containers extension writes devcontainer.json settings into: above
    // the user's settings, below the workspace's. User scope would clobber a
    // file that belongs to the user and lose to nothing.
    assert.match(applied, /mkdir -p "\$DATA"\/data\/Machine/);
    assert.match(applied, /cat > "\$DATA"\/data\/Machine\/settings\.json/);
  });

  test("...before the server starts, not after", () => {
    // The server reads them at boot. Written afterwards they would apply to
    // whatever start came next, which reads as intermittent rather than broken.
    assert.ok(
      applied.indexOf("data/Machine/settings.json") < applied.indexOf("--connection-token"),
      "settings are written after the server is launched",
    );
  });

  test("the JSON is data, never shell", () => {
    // Settings are arbitrary values from a file the editor can write. A quoted
    // heredoc is what makes them inert -- no expansion happens between the
    // markers, so `$(...)`, backticks and a stray quote are all just text.
    const hostile = script([], TOKEN, {
      "x": "$(touch /tmp/pwned); `id`; '; touch /tmp/pwned2; '",
    });
    assert.match(hostile, /<<'__DESOLATE_SETTINGS_EOF__'/);
    // ...and it survives verbatim rather than being escaped into something else.
    assert.ok(hostile.includes("$(touch /tmp/pwned); `id`;"));
  });

  test("a value cannot close the heredoc", () => {
    // The quoting is safe only while no LINE of the JSON equals the delimiter.
    // JSON.stringify escapes newlines inside strings, so a value carrying one
    // stays on a single line -- proven here rather than asserted in a comment.
    const sneaky = script([], TOKEN, { x: "\n__DESOLATE_SETTINGS_EOF__\n" });
    const body = sneaky.split("<<'__DESOLATE_SETTINGS_EOF__'")[1];
    const closes = body.split("\n").filter((l) => l === "__DESOLATE_SETTINGS_EOF__");
    assert.equal(closes.length, 1, "the heredoc is closed more than once");
  });

  test("declaring none REMOVES the file, so deleting the key is visible", () => {
    // A project that drops the key would otherwise keep the settings it no
    // longer declares, forever, with nothing to point at.
    const none = script();
    assert.match(none, /grep -q 'Managed by desolate'/);
    assert.match(none, /rm -f "\$DATA"\/data\/Machine\/settings\.json/);
    assert.doesNotMatch(none, /cat > "\$DATA"\/data\/Machine/);
  });

  test("...and only a file desolate wrote is removed", () => {
    // The removal is guarded by the marker desolate puts IN the file, so a
    // Machine settings file somebody else created is never deleted.
    assert.ok(script([], TOKEN, settings).includes("Managed by desolate"));
    assert.match(script(), /if \[ -f .* \] && grep -q 'Managed by desolate'/);
  });
});

describe("reading customizations out of a spec", () => {
  test("both halves come from EVERY namespace, not just 'vscode'", () => {
    // A project carrying a codespaces block alongside a vscode one means both;
    // neither namespace is more this editor's than the other.
    const read = editorCustomizations({
      vscode: { extensions: ["a.one"], settings: { "editor.tabSize": 2 } },
      codespaces: { extensions: ["b.two"], settings: { "files.autoSave": "off" } },
      desolate: { ports: [5173] },
    });
    assert.deepEqual(read.extensions, ["a.one", "b.two"]);
    assert.deepEqual(read.settings, {
      "editor.tabSize": 2,
      "files.autoSave": "off",
    });
  });

  test("a later declaration of the same setting wins", () => {
    // Some rule has to decide, and this is the only one statable in a line.
    const read = editorCustomizations({
      vscode: { settings: { "editor.tabSize": 2 } },
      zzz: { settings: { "editor.tabSize": 4 } },
    });
    assert.equal(read.settings["editor.tabSize"], 4);
  });

  test("nested and language-scoped settings survive whole", () => {
    // These are the shapes people actually write. Anything that flattened or
    // dropped them would apply *some* of a project's settings, which is worse
    // than applying none: nothing would look wrong.
    const settings = {
      "[typescript]": { "editor.defaultFormatter": "esbenp.prettier-vscode" },
      "[markdown]": { "editor.defaultFormatter": null },
      "svelte.plugin.typescript.enable": true,
    };
    assert.deepEqual(editorCustomizations({ vscode: { settings } }).settings, settings);
  });

  test("settings that are not an object are dropped, not spread", () => {
    // Object.assign over a string would splatter its characters in as keys.
    for (const bad of ["nope", 42, ["a"], null])
      assert.deepEqual(
        editorCustomizations({ vscode: { settings: bad } }).settings,
        {},
        `${JSON.stringify(bad)} leaked into the settings`,
      );
  });

  test("a malformed extension id is dropped without taking the good ones", () => {
    const read = editorCustomizations({
      vscode: { extensions: ["a.one", "not-an-id", 7, "b.two"] },
    });
    assert.deepEqual(read.extensions, ["a.one", "b.two"]);
  });

  test("a spec with no customizations at all is not a crash", () => {
    assert.deepEqual(editorCustomizations(), { extensions: [], settings: {} });
    assert.deepEqual(editorCustomizations({}), { extensions: [], settings: {} });
  });
});
