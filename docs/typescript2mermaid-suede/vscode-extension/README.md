# typescript2mermaid for VSCode

Hover any exported `<Family>.Diagram<...>` type alias (or anywhere on its declaration line) to see the generated Mermaid source, and click **Preview rendered diagram** — or the code lens above the alias — to open the fully drawn diagram in a side panel.

An open preview **updates as you type**. A diagram's nodes are usually types declared in other modules, so the panel watches the previewed file *plus its transitive imports*: editing a type two files away re-renders it, and adding an import expands what's watched. Updates are pushed into the running webview rather than reloading it, so your pan/zoom survives — and while code is half-typed the last good diagram stays on screen instead of flashing an error.

## Install (consumers of the vendored library)

The library ships as raw TypeScript source vendored next to this folder (via git-subrepo), so there is nothing to build outside this directory. One command builds and installs the extension:

```bash
cd vscode-extension
./install.sh          # or: node install.mjs (Windows-friendly)
```

This installs build dependencies, bundles the extension (the vendored library source is compiled straight into `dist/extension.js` via esbuild — no parent package or build step exists or is needed), typechecks, packages a `.vsix` with `vsce`, and installs it into whichever VSCode-family CLI is on your PATH (`code`, `code-insiders`, `codium`, or `cursor`). If no CLI is found, it prints the path to the built `.vsix` for manual install via "Extensions: Install from VSIX...".

After installing, run **Developer: Reload Window** in any open VSCode window. The extension activates automatically when a TypeScript file is opened — there is no separate "activate" step. Re-run `./install.sh` whenever the vendored library updates to pick up generator changes.

## Why the hover shows source, not the drawn diagram

VSCode hover tooltips render sanitized markdown only; they cannot run the JavaScript Mermaid needs for layout. So the hover shows the generated Mermaid code (which is what gets committed to your markdown anyway), and rendering happens in a webview panel where Mermaid can execute. The preview loads `media/mermaid.min.js` from the packaged extension — no network access needed.

## Development (F5)

`npm install && npm run build`, open this folder in VSCode, press F5. The launch config rebuilds before starting the Extension Development Host. `npm run typecheck` runs `tsc` (the build itself is esbuild; `tsconfig.json` is typecheck-only).

## How it works

The extension keeps a `GeneratorSession` per workspace: a long-lived ts-morph project seeded from your `tsconfig.json` so cross-file type resolution works, with unsaved editor buffers pushed in before each generation. Results are cached per document version, so hovering repeatedly is free until you edit. The build resolves the library from `../index.ts` (vendored layout) or `../src/index.ts` (development repo layout), whichever exists.
