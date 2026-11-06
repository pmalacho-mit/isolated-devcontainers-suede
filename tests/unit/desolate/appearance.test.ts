/// <reference types="node" />
// The outer editor's colour theme, kept for the editors it starts (appearance.ts, #59).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appearanceOf, keepAppearance, savedAppearance } from "../../../release/vscode-image/appearance.ts";

const dir = () => mkdtempSync(join(tmpdir(), "desolate-appearance-"));

describe("what the extension keeps", () => {
  test("takes the theme settings out of the editor's configuration, and nothing else", () => {
    const settings: Record<string, unknown> = {
      "workbench.colorTheme": "Default Dark Modern",
      "window.autoDetectColorScheme": true,
      "editor.fontSize": 15,
      "security.workspace.trust.enabled": true,
    };
    assert.deepEqual(appearanceOf((key) => settings[key]), {
      "workbench.colorTheme": "Default Dark Modern",
      "window.autoDetectColorScheme": true,
    });
  });

  test("is written, whole, in a directory made for it -- and only when it changed", () => {
    const file = join(dir(), "cache", "desolate", "appearance.json");
    assert.equal(keepAppearance({ "workbench.colorTheme": "Dark 2026" }, file), true);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "workbench.colorTheme": "Dark 2026" });
    assert.equal(keepAppearance({ "workbench.colorTheme": "Dark 2026" }, file), false, "same again: not rewritten");
    assert.equal(keepAppearance({ "workbench.colorTheme": "Light 2026" }, file), true);
    assert.equal(savedAppearance(file)["workbench.colorTheme"], "Light 2026");
    assert.deepEqual(readdirSync(join(file, "..")), ["appearance.json"], "no temporary file is left");
  });
});

describe("what `desolate` reads back", () => {
  test("nothing, for a file that is absent, empty, not JSON, or not an object", () => {
    const d = dir();
    assert.deepEqual(savedAppearance(join(d, "none.json")), {});
    for (const [name, body] of [["empty", ""], ["junk", "{ not json"], ["list", "[1]"], ["string", '"dark"']]) {
      writeFileSync(join(d, name), body);
      assert.deepEqual(savedAppearance(join(d, name)), {}, name);
    }
    assert.ok(!existsSync(join(d, "none.json")), "reading creates nothing");
  });

  test("a file anyone with the editor's home can write is never more than a theme", () => {
    const file = join(dir(), "appearance.json");
    writeFileSync(file, JSON.stringify({
      "workbench.colorTheme": "Default Light Modern",
      "terminal.integrated.profiles.linux": { x: { path: "/tmp/evil" } },
      "window.autoDetectHighContrast": "maybe",
    }));
    assert.deepEqual(savedAppearance(file), { "workbench.colorTheme": "Default Light Modern" });
  });
});
