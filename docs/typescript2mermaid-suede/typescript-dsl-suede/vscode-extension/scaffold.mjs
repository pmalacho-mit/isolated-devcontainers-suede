#!/usr/bin/env node
/**
 * Writes a complete, buildable VSCode extension for a type-level DSL.
 *
 * Generates package.json, tsconfig.json, .vscodeignore, .gitignore, build.mjs,
 * install.mjs, install.sh and src/extension.ts — all wired to the vendored
 * library next to it. Everything it emits is a thin shim over `builder.mjs`,
 * `installer.mjs` and `@dsl-suede/vscode`, so regenerating after a library
 * update is safe.
 *
 * As a CLI:
 *
 *   node scaffold.mjs ../../my-extension \
 *     --id myDsl --name my-dsl --display "My DSL" \
 *     --gate ".Diagram<" --lib my-dsl-lib --lib-path ../index.ts
 *
 * As a module:
 *
 *   import { scaffold } from "./scaffold.mjs";
 *   scaffold({ root: "...", id: "myDsl", name: "my-dsl", lib: { ... } });
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const suedeVscodeDir = path.dirname(fileURLToPath(import.meta.url));
const suedeDir = path.dirname(suedeVscodeDir);

const json = (value) => JSON.stringify(value, null, 2) + "\n";
const posix = (p) => p.split(path.sep).join("/");

/** Import specifier from the generated extension root back to a suede file. */
function suedeImport(root, file) {
  const rel = posix(path.relative(root, path.join(suedeVscodeDir, file)));
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/* ------------------------------ templates ---------------------------- */

function packageJson(o) {
  const commands = [
    {
      command: `${o.id}.showLog`,
      title: `${o.displayName}: Show Log`,
    },
  ];
  if (o.renderer)
    commands.unshift({
      command: `${o.id}.preview`,
      title: `${o.displayName}: Preview`,
    });

  return json({
    name: o.name,
    displayName: o.displayName,
    description: o.description,
    version: o.version,
    publisher: o.publisher,
    license: o.license,
    ...(o.repository ? { repository: o.repository } : {}),
    engines: { vscode: o.vscodeEngine },
    categories: o.categories,
    activationEvents: o.activationEvents,
    main: "./dist/extension.js",
    contributes: { commands },
    scripts: {
      build: "node build.mjs",
      typecheck: "tsc",
      package: `vsce package --no-dependencies -o ${o.vsix}`,
      "install-extension": "node install.mjs",
    },
    devDependencies: {
      "@types/node": "^22.0.0",
      "@types/vscode": o.vscodeEngine.replace(/^\^/, ""),
      "@vscode/vsce": "^3.0.0",
      esbuild: "^0.24.0",
      "ts-morph": "^27.0.0",
      typescript: "^5.5.0",
      ...(o.renderer?.npm ? { [o.renderer.npm]: o.renderer.npmVersion } : {}),
    },
  });
}

function tsconfigJson(root, o) {
  const rel = (file) => posix(path.relative(root, file));
  return json({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      esModuleInterop: true,
      types: ["node", "vscode"],
      baseUrl: ".",
      // Must mirror the esbuild aliases in build.mjs, or `tsc` and the bundle
      // disagree about what the imports mean.
      paths: {
        [o.lib.alias]: o.lib.candidates.map((c) => posix(c)),
        "@dsl-suede/vscode": [rel(path.join(suedeVscodeDir, "extension.ts"))],
        "@dsl-suede/webview": [rel(path.join(suedeVscodeDir, "webview.ts"))],
        "@dsl-suede": [rel(path.join(suedeDir, "index.ts"))],
        "ts-morph": ["./node_modules/ts-morph"],
      },
    },
    include: ["src"],
  });
}

const vscodeignore = `.vscode/**
src/**
node_modules/**
*.mjs
install.sh
tsconfig.json
**/*.map
**/*.ts
!dist/**
`;

const gitignore = `node_modules/
dist/
media/
*.vsix
`;

function buildMjs(root, o) {
  const assets = o.renderer
    ? `\n  assets: [\n    {\n      from: "node_modules/${o.renderer.npm}/${o.renderer.asset}",\n      to: "media/${path.posix.basename(o.renderer.asset)}",\n    },\n  ],`
    : "";
  return `/**
 * Bundles this extension. All the work lives in the vendored builder — this
 * file only says which library to inline and which assets to ship.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension } from "${suedeImport(root, "builder.mjs")}";

const root = path.dirname(fileURLToPath(import.meta.url));

await buildExtension({
  root,
  // Candidates are tried in order; the first that exists wins, so a flattened
  // vendored layout and a development checkout can both be supported.
  alias: {
    ${JSON.stringify(o.lib.alias)}: ${JSON.stringify(o.lib.candidates)},
  },${assets}
});
`;
}

function installMjs(root, o) {
  return `#!/usr/bin/env node
/**
 * One-shot local install: npm install → bundle → typecheck → package → install
 * into whichever VSCode-family CLI is on PATH. Safe to re-run any time the
 * vendored library updates.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installExtension } from "${suedeImport(root, "installer.mjs")}";

await installExtension({
  root: path.dirname(fileURLToPath(import.meta.url)),
  vsix: ${JSON.stringify(o.vsix)},
  hint: ${JSON.stringify(o.hint)},
});
`;
}

const installSh = `#!/usr/bin/env sh
exec node "$(dirname "$0")/install.mjs" "$@"
`;

function extensionTs(o) {
  const bootstrap = o.renderer?.bootstrap;
  const preview = o.renderer
    ? `

    preview: {
      // First readable candidate wins: the packaged copy, then a dev checkout.
      assets: [
        "media/${path.posix.basename(o.renderer.asset)}",
        "node_modules/${o.renderer.npm}/${o.renderer.asset}",
      ],
      bootstrap: RENDERER_BOOTSTRAP,
      // The artifact to render for a finding. Return undefined to decline one.
      codeOf: ${o.codeOf},
      title: (f) => \`${o.displayName}: \${f.label ?? f.id}\`,
    },`
    : "";

  const bootstrapConst = bootstrap
    ? `
/**
 * Runs inside the preview webview. Must define \`globalThis.DslRenderer\` with
 * \`init(dark)\` and \`render(code, seq)\`; \`render\` returns (or resolves to) an
 * HTML string, which the host page mounts, sizes, and lets the user pan/zoom.
 */
const RENDERER_BOOTSTRAP = \`
${bootstrap.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}
\`;
`
    : "";

  const fence = o.hoverLanguage ? JSON.stringify(o.hoverLanguage) : '""';
  const previewLink = o.renderer
    ? `\n      md.appendMarkdown(\`\\n\${api.previewLink!(f)}\`);`
    : "";
  const lenses = o.renderer
    ? `\n\n    lenses: () => [{ title: ${JSON.stringify(o.lensTitle)} }],`
    : `\n\n    // Lenses sit on each finding's range. \`command\` names a key in
    // \`commands\` below; omit it to fall back to the preview command.
    // lenses: (f) => [{ title: String(f.label ?? f.id) }],

    // Squiggles. Supplying this also keeps every visible document analyzed and
    // refreshed as its dependencies change — no preview required.
    // diagnostics: (f) => [{ message: "…", severity: "error" }],

    // Commands acting on one finding, registered as \`${o.id}.<key>\`.
    // commands: {
    //   accept: async (f, ctx) => { await ctx.applyEdits([]); await ctx.refresh(); },
    // },`;

  return `import * as vscode from "vscode";
import { activateDslExtension } from "@dsl-suede/vscode";
// The runner carries your analyzer; the harness only ever sees its findings.
import { runner } from ${JSON.stringify(o.lib.alias)};
${bootstrapConst}
export function activate(ctx: vscode.ExtensionContext): void {
  activateDslExtension(ctx, {
    id: ${JSON.stringify(o.id)},
    name: ${JSON.stringify(o.name)},
    // Cheap substring prefilter: a document matching none of these is never
    // parsed. Comes from your analyzer.
    gates: runner.gates,
    createSession: (tsconfig) => runner.createSession(tsconfig),

    hover: (f, api) => {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(\`**${o.displayName}** · \\\`\${f.label ?? f.id}\\\`\\n\\n\`);
      md.appendCodeblock(String(${o.codeOf.replace(/^\(f\)\s*=>\s*/, "")}), ${fence});${previewLink}
      return md;
    },${lenses}${preview}
  });
}

export function deactivate(): void {
  // The harness registers itself in ctx.subscriptions and tears down there.
}
`;
}

/* ------------------------------- scaffold ---------------------------- */

const DEFAULTS = {
  id: "myDsl",
  name: "my-dsl",
  version: "0.1.0",
  publisher: "local",
  license: "MIT",
  vscodeEngine: "^1.85.0",
  categories: ["Visualization", "Programming Languages"],
  activationEvents: ["onLanguage:typescript", "onLanguage:typescriptreact"],
  hoverLanguage: undefined,
  renderer: undefined,
  force: false,
};

/**
 * @param {object} options
 * @param {string} options.root      target directory (created if missing)
 * @param {string} [options.id]      command namespace, e.g. "myDsl"
 * @param {string} [options.name]    package name / output channel
 * @param {object} [options.lib]     { alias, candidates } for the vendored DSL library
 * @param {object} [options.renderer] { npm, npmVersion, asset, bootstrap } for previews
 * @param {boolean} [options.force]  overwrite existing files
 */
export function scaffold(options) {
  if (!options?.root) throw new Error("scaffold: `root` is required");
  const root = path.resolve(options.root);

  const o = {
    ...DEFAULTS,
    ...options,
    root,
    displayName: options.displayName ?? options.name ?? DEFAULTS.name,
    description:
      options.description ??
      `Hover previews and live rendering for ${options.displayName ?? options.name ?? "a type-level DSL"}`,
    vsix: options.vsix ?? `${options.name ?? DEFAULTS.name}.vsix`,
    lensTitle: options.lensTitle ?? "Preview",
    // How to get displayable text out of a finding. The library has no opinion
    // about what `data` holds, so this is the one line every DSL must edit.
    codeOf: options.codeOf ?? '(f) => (f.data as { code?: string }).code ?? ""',
    hint:
      options.hint ??
      "hover a DSL type alias in a TypeScript file to see its compiled output.",
    lib: {
      alias: options.lib?.alias ?? `${options.name ?? DEFAULTS.name}-lib`,
      candidates: options.lib?.candidates ?? ["../index.ts", "../src/index.ts"],
    },
  };

  mkdirSync(path.join(root, "src"), { recursive: true });

  const files = [
    ["package.json", packageJson(o)],
    ["tsconfig.json", tsconfigJson(root, o)],
    [".vscodeignore", vscodeignore],
    [".gitignore", gitignore],
    ["build.mjs", buildMjs(root, o)],
    ["install.mjs", installMjs(root, o)],
    ["install.sh", installSh, 0o755],
    [path.join("src", "extension.ts"), extensionTs(o)],
  ];

  const written = [];
  const skipped = [];
  for (const [rel, content, mode] of files) {
    const dest = path.join(root, rel);
    if (existsSync(dest) && !o.force) {
      skipped.push(rel);
      continue;
    }
    writeFileSync(dest, content);
    if (mode) chmodSync(dest, mode);
    written.push(rel);
  }

  console.log(`scaffolded ${o.name} in ${root}`);
  for (const f of written) console.log(`  + ${f}`);
  for (const f of skipped)
    console.log(`  · ${f} (exists — pass force to overwrite)`);
  console.log(
    `\nNext: cd ${posix(path.relative(process.cwd(), root)) || "."} && ./install.sh`,
  );

  return { root, written, skipped };
}

/* --------------------------------- CLI ------------------------------- */

const FLAGS = {
  "--id": "id",
  "--name": "name",
  "--display": "displayName",
  "--description": "description",
  "--publisher": "publisher",
  "--version": "version",
  "--license": "license",
  "--lib": "libAlias",
  "--lib-path": "libPath",
  "--hover-language": "hoverLanguage",
  "--lens-title": "lensTitle",
};

function cli(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") flags.force = true;
    else if (arg === "-h" || arg === "--help") return usage();
    else if (FLAGS[arg]) flags[FLAGS[arg]] = argv[++i];
    else positional.push(arg);
  }
  if (positional.length === 0) return usage(1);

  const { libAlias, libPath, ...rest } = flags;
  scaffold({
    ...rest,
    root: positional[0],
    ...(libAlias || libPath
      ? {
          lib: {
            ...(libAlias ? { alias: libAlias } : {}),
            ...(libPath ? { candidates: [libPath] } : {}),
          },
        }
      : {}),
  });
}

function usage(code = 0) {
  console.error(
    [
      "usage: node scaffold.mjs <target-dir> [options]",
      "",
      "  --id <ns>             command namespace (default: myDsl)",
      "  --name <name>         package name / output channel (default: my-dsl)",
      "  --display <text>      display name",
      "  --description <text>  marketplace description",
      "  --publisher <name>    publisher id (default: local)",
      "  --lib <specifier>     import specifier for the vendored DSL library",
      "  --lib-path <path>     path to the library entry, relative to the extension",
      "  --hover-language <id> fence language for the hover code block",
      "  --lens-title <text>   code lens label (default: Preview)",
      "  --force               overwrite existing files",
    ].join("\n"),
  );
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  cli(process.argv.slice(2));
