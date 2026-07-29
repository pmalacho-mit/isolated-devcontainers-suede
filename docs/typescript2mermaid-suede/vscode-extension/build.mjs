/**
 * Bundles this extension. All the work lives in the vendored builder — this file
 * only says which library to inline and which assets to ship.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension } from "../typescript-dsl-suede/vscode-extension/builder.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

await buildExtension({
  root,
  // The preview webview loads Mermaid from a local asset (no network, and the
  // packaged .vsix contains no node_modules).
  assets: [
    {
      from: "node_modules/mermaid/dist/mermaid.min.js",
      to: "media/mermaid.min.js",
    },
  ],
});
