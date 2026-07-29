#!/usr/bin/env node
/**
 * One-shot local install of the typescript2mermaid VSCode extension.
 *
 *   node install.mjs        (or ./install.sh)
 *
 * npm install → bundle (esbuild) → typecheck → package (.vsix) → install into
 * whichever VSCode-family CLI is on PATH. Safe to re-run any time the vendored
 * library updates.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installExtension } from "../typescript-dsl-suede/vscode-extension/installer.mjs";

await installExtension({
  root: path.dirname(fileURLToPath(import.meta.url)),
  vsix: "typescript2mermaid.vsix",
  hint: "hover a `<Family>.Diagram<...>` type alias in a TypeScript file.",
});
