/// <reference types="node" />
// The outer editor's security settings, held at every start
// (editor-settings.ts, audit M3): seeded when absent, put back when changed,
// and the person's own settings left alone.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HELD, hold, seed } from "../../../release/vscode-image/editor-settings.ts";
import { parse } from "../../../release/vscode-image/jsonc.ts";

describe("what is held", () => {
  test("workspace trust ON, no startup prompt, no automatic tasks, no extension updates", () => {
    assert.equal(HELD["security.workspace.trust.enabled"], true, "false would mean: trust everything");
    assert.equal(HELD["security.workspace.trust.startupPrompt"], "never");
    assert.equal(HELD["task.allowAutomaticTasks"], "off");
    assert.equal(HELD["extensions.autoUpdate"], false);
  });

  test("a terminal that reads no rc file from the home volume", () => {
    const profiles = HELD["terminal.integrated.profiles.linux"] as Record<string, { path: string; args: string[] }>;
    const name = HELD["terminal.integrated.defaultProfile.linux"] as string;
    assert.deepEqual(profiles[name].args, ["--rcfile", "/dev/null"]);
  });
});

describe("holding", () => {
  test("no file: the seed, which parses to the held settings and says what holds them", () => {
    const result = hold(undefined);
    assert.equal(result.text, seed());
    assert.deepEqual(parse(result.text), HELD);
    assert.match(result.text, /put back at every start/);
    assert.equal(result.unreadable, false);
  });

  test("a file with everything in place is left byte for byte -- comments and all", () => {
    const text = `{\n  // mine\n  "editor.fontSize": 13,\n${JSON.stringify(HELD, null, 2).split("\n").slice(1, -1).join("\n")}\n}\n`;
    assert.deepEqual(hold(text), { text, changed: [], unreadable: false });
  });

  test("a changed or missing held setting is put back; the person's own settings stay", () => {
    const text = JSON.stringify({
      "editor.fontSize": 13,
      "security.workspace.trust.enabled": false,
      "terminal.integrated.profiles.linux": { desolate: { path: "/home/workspace/evil", args: [] } },
      "window.zoomLevel": 1,
    });
    const result = hold(text);
    assert.deepEqual(result.changed.sort(), Object.keys(HELD).filter((k) => k !== "x").sort(), "every held key: two changed, the rest missing");
    const after = parse(result.text) as Record<string, unknown>;
    assert.equal(after["editor.fontSize"], 13);
    assert.equal(after["window.zoomLevel"], 1);
    for (const [key, value] of Object.entries(HELD)) assert.deepEqual(after[key], value, key);
  });

  test("a file that does not parse is replaced by the seed, and said to be", () => {
    const result = hold("{ not json");
    assert.equal(result.text, seed());
    assert.equal(result.unreadable, true);
    assert.equal(hold("[1,2]").unreadable, true);
  });
});

describe("as shell-entry runs it", () => {
  const script = new URL("../../../release/vscode-image/editor-settings.ts", import.meta.url).pathname;
  const run = (file: string) => execFileSync("npx", ["tsx", script, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  test("seeds, then holds, then leaves alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "desolate-settings-"));
    const file = join(dir, "data", "User", "settings.json");
    run(file);
    assert.ok(existsSync(file), "seeded, directories made");
    assert.deepEqual(parse(readFileSync(file, "utf8")), HELD);
    writeFileSync(file, JSON.stringify({ "security.workspace.trust.enabled": false, "editor.fontSize": 13 }));
    run(file);
    const after = parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(after["security.workspace.trust.enabled"], true);
    assert.equal(after["editor.fontSize"], 13);
    const before = readFileSync(file, "utf8");
    run(file);
    assert.equal(readFileSync(file, "utf8"), before, "nothing to put back: untouched");
  });
});
