/**
 * Bundles a DSL VSCode extension into a single self-contained dist/extension.js.
 *
 * A vendored library ships as raw TypeScript source, so there is no parent
 * package to build: esbuild compiles and inlines it, along with the harness,
 * ts-morph, and everything else. Only `vscode` stays external (the editor
 * provides it at runtime).
 *
 * Import from your extension's build.mjs:
 *
 *   import { buildExtension } from "../typescript-dsl-suede/vscode-extension/builder.mjs";
 *   await buildExtension({
 *     root: path.dirname(fileURLToPath(import.meta.url)),
 *     alias: { "my-dsl-lib": ["../index.ts", "../src/index.ts"] },
 *     assets: [{ from: "node_modules/mermaid/dist/mermaid.min.js", to: "media/mermaid.min.js" }],
 *   });
 */
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** This file's directory — `<suede>/vscode-extension`. */
export const suedeVscodeDir = path.dirname(fileURLToPath(import.meta.url));
/** The vendored library root. */
export const suedeDir = path.dirname(suedeVscodeDir);

/** Aliases every DSL extension gets for free. */
export const suedeAliases = {
  "@typescript-dsl-suede/vscode": path.join(suedeVscodeDir, "extension.ts"),
  "@typescript-dsl-suede/webview": path.join(suedeVscodeDir, "webview.ts"),
  "@typescript-dsl-suede": path.join(suedeDir, "index.ts"),
};

/**
 * Resolve an alias target: a single path, or a list of candidates of which the
 * first existing one wins (so a repo layout and a flattened vendored layout can
 * both be supported).
 */
function resolveAlias(root, name, candidates) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  const resolved = list
    .map((c) => (path.isAbsolute(c) ? c : path.join(root, c)))
    .find(existsSync);
  if (!resolved)
    throw new Error(
      `buildExtension: could not resolve alias "${name}" — tried:\n  ${list.join("\n  ")}`,
    );
  return resolved;
}

/**
 * Load esbuild from the *extension's* node_modules first.
 *
 * A vendored library lives outside the extension folder, so Node resolves this
 * file's own imports by walking up from here — a path that never reaches the
 * extension's dependencies. Resolving from the extension root is what makes the
 * builder work in a genuinely vendored layout, rather than only when esbuild
 * happens to be hoisted somewhere above the library.
 */
async function loadEsbuild(root) {
  try {
    const require = createRequire(path.join(root, "package.json"));
    return await import(pathToFileURL(require.resolve("esbuild")).href);
  } catch {
    return await import("esbuild"); // fall back to our own resolution
  }
}

/**
 * Copy an asset into the extension package and prove it is readable.
 *
 * cpSync carries the source mode across, and some mounts (e.g. the Docker
 * Desktop `fakeowner` bind used by devcontainers) hand back a mode with no read
 * bit. vsce stores whatever mode it finds directly in the .vsix, so an
 * unreadable asset here becomes an unreadable asset on every consumer machine
 * whose filesystem actually enforces permissions — the webview's <script> then
 * 404s and the preview silently degrades to raw text. Pin the mode, then prove
 * the file is readable before letting the build pass.
 */
export function copyAsset(root, { from, to }) {
  const src = path.isAbsolute(from) ? from : path.join(root, from);
  const dest = path.isAbsolute(to) ? to : path.join(root, to);
  if (!existsSync(src))
    throw new Error(`buildExtension: asset not found: ${src}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest);
  chmodSync(dest, 0o644);
  accessSync(dest, constants.R_OK);
  return dest;
}

/**
 * Rewrite `import.meta.url` in our own sources to the file's real path.
 *
 * The extension bundle is CJS, where `import.meta` does not exist — esbuild
 * substitutes `{}`, so `fileURLToPath(import.meta.url)` throws *at module load*
 * and the extension dies before `activate()` runs. A vendored library is
 * expected to define its root that way (see the DSL README's `LIBRARY_ROOT`), so
 * without this every such extension silently ships broken.
 *
 * The literal we inject is the *source* file's URL, not the bundle's. That is
 * both the honest answer for inlined source and the necessary one: `LIBRARY_ROOT`
 * feeds `declaredWithin`, which compares it against declaration paths in the
 * user's project — the vendored source tree, not `dist/`.
 *
 * Scoped to first-party sources; dependencies keep esbuild's default handling.
 */
const importMetaUrlPlugin = {
  name: "source-import-meta-url",
  setup(build) {
    build.onLoad({ filter: /\.(m?ts|m?js)$/ }, async (args) => {
      if (args.path.includes("node_modules")) return undefined;
      const source = await readFile(args.path, "utf8");
      if (!source.includes("import.meta.url")) return undefined;
      return {
        contents: source.replaceAll(
          "import.meta.url",
          JSON.stringify(pathToFileURL(args.path).href),
        ),
        loader: path.extname(args.path).slice(1),
      };
    });
  },
};

export async function buildExtension({
  root,
  entry = "src/extension.ts",
  outfile = "dist/extension.js",
  alias = {},
  assets = [],
  external = [],
  platform = "node",
  format = "cjs",
  target = "node18",
  minify = false,
  sourcemap = false,
  logLevel = "info",
  plugins = [],
  esbuildOptions = {},
}) {
  if (!root) throw new Error("buildExtension: `root` is required");

  const resolved = { ...suedeAliases };
  for (const [name, candidates] of Object.entries(alias))
    resolved[name] = resolveAlias(root, name, candidates);

  const { build } = await loadEsbuild(root);

  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform,
    format,
    target,
    minify,
    sourcemap,
    // Provided by the editor at runtime; bundling it would break activation.
    external: ["vscode", ...external],
    alias: resolved,
    // Vendored sources sit *outside* the extension folder; Node-style resolution
    // walks upward from each importing file and would never find our
    // node_modules, so add it as an explicit fallback.
    nodePaths: [path.join(root, "node_modules")],
    outfile: path.join(root, outfile),
    logLevel,
    plugins: [importMetaUrlPlugin, ...plugins],
    ...esbuildOptions,
  });

  const copied = assets.map((asset) => copyAsset(root, asset));

  console.log(
    `bundled ${outfile}${copied.length ? ` and copied ${copied.length} asset(s)` : ""}`,
  );
  return { outfile: path.join(root, outfile), assets: copied };
}
