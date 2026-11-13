import { build } from "esbuild";

// a webview is handed JSON, and decodes it with the codec the reporter encoded with
await build({
  entryPoints: ["../vite-plugin/codec.mts"],
  bundle: true,
  outfile: "dist/codec.js",
  platform: "browser",
  target: "es2022",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
});

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  // parse with the workspace's own TypeScript, the one the plugin runs
  alias: { "@typescript/typescript6": "./src/typescript.ts" },
  sourcemap: true,
  minify: process.argv.includes("--minify"),
  logLevel: "info",
});
