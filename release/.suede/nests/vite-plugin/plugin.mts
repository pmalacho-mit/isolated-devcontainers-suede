import ts from "@typescript/typescript6";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import picomatch from "picomatch";
import { encode } from "@jridgewell/sourcemap-codec";
import { DERIVED, ensureDerived } from "./cache.mts";
import { SUFFIX, collected, collectorLines, idFor } from "./collector.mts";
import { SUFFIX as EXTRACTED } from "../extract.mts";
import { FORK, fork, forkOf } from "./fork.mts";
import { configFor, emittedFor, minimalFor } from "./minimal.mts";
import { relativeTo } from "./paths.mts";
import type { Plugin, ViteUserConfig } from "vitest/config";
import type { SourceMapSegment } from "@jridgewell/sourcemap-codec";
import type { Line } from "./emit/context.mts";
import type { Warning } from "./emit/index.mts";
import type { Expect, Invoke } from "../dsl.import.meta.vitest.ts";

export type Options = {
  /** Only collect tests from namespaces with this name; every namespace is read without it. */
  root?: string;
  /** tsconfig file name, found upward from cwd. */
  tsconfig?: string;
  /** Globs discovery skips, relative to the project root. `node_modules` and dot-directories are always skipped. */
  exclude?: string[];
  /** Extra globs to collect tests from, as Vitest's `include`. */
  include?: string[];
  /** Glob for extracted tests, added to Vitest's `include`. `false` leaves them out. */
  extracted?: string | false;
  /** Discover test files by scanning cwd. */
  scan?: boolean;
  /** Also discover the library's own tests, which vendoring it must not add to a suite. */
  _scanSelf?: boolean;
  /** Globs, relative to the project root, of modules every test shares instead of getting its own copy. */
  noIsolateModuleImport?: string[];
};

export function testNameFilter(pattern: unknown): RegExp | null {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern !== "string" || !pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

declare namespace testNameFilter {
  /** the string `-t` hands over becomes the pattern Vitest matches with */
  export type FromString = Expect<
    Invoke<typeof testNameFilter, [pattern: "Counter"]>,
    "satisfies",
    typeof matchesCounter
  >;

  /** nothing to filter by is not a filter */
  export type Absent = Expect<
    Invoke<typeof testNameFilter, [undefined]>,
    "=",
    null
  >;

  /** it is a pattern, not a literal — `[0]` is a character class, as in Vitest */
  export type Pattern = Expect<
    Invoke<typeof testNameFilter, [pattern: "Rows[0]"]>,
    "satisfies",
    typeof readsAsPattern
  >;

  /** a pattern that will not compile filters nothing, rather than throwing */
  export type Invalid = Expect<
    Invoke<typeof testNameFilter, [pattern: "("]>,
    "=",
    null
  >;
}

const matchesCounter = (filter: RegExp | null) =>
  !!filter?.test("Counter > Chainable");

const readsAsPattern = (filter: RegExp | null) =>
  !!filter?.test("add > Rows0") && !filter.test("add > Rows[0]");

const isTypeScript = (file: string) => /\.[cm]?tsx?$/.test(file);

// line-anchored, so a mention in a comment is not one; the printer decides what is a test
const testNamespaceMarker = (root?: string) =>
  new RegExp(`^\\s*declare\\s+namespace\\s+${root ?? "\\w"}`, "m");

type Versioned = { version: number; snapshot: ts.IScriptSnapshot };

const textOf = (snapshot: ts.IScriptSnapshot) =>
  snapshot.getText(0, snapshot.getLength());

function languageService(cwd: string, tsconfig: string) {
  const config = configFor(tsconfig, cwd);
  const roots = new Set<string>(config.fileNames);
  const versions = new Map<string, number>();
  const snapshots = new Map<string, Versioned>();
  const versionOf = (file: string) => versions.get(file) ?? 0;

  const store = (file: string, text: string) => {
    const snapshot = ts.ScriptSnapshot.fromString(text);
    snapshots.set(file, { version: versionOf(file), snapshot });
    return snapshot;
  };

  const snapshotOf = (file: string) => {
    const cached = snapshots.get(file);
    if (cached?.version === versionOf(file)) return cached.snapshot;
    if (!fs.existsSync(file)) return undefined;
    return store(file, fs.readFileSync(file, "utf8"));
  };

  const service = ts.createLanguageService(
    {
      getScriptFileNames: () => [...roots],
      getScriptVersion: (file) => String(versionOf(file)),
      getScriptSnapshot: snapshotOf,
      getCurrentDirectory: () => cwd,
      getCompilationSettings: () => config.options,
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      ...(ts.sys.realpath ? { realpath: ts.sys.realpath } : {}),
    },
    ts.createDocumentRegistry(),
  );

  const inputFor = (file: string) => {
    const program = service.getProgram();
    const source = program?.getSourceFile(file);
    return program && source ? { program, source } : null;
  };

  return {
    changed(file: string) {
      versions.set(file, versionOf(file) + 1);
    },
    inputFor,
    inputAsWritten(file: string, code: string) {
      roots.add(file);
      const current = snapshots.get(file);
      if (!current || textOf(current.snapshot) !== code) {
        this.changed(file);
        store(file, code);
      }
      return inputFor(file);
    },
  };
}

type Discovery = {
  cwd: string;
  exclude: string[];
  marker: RegExp;
  skip: string | null;
};

// `src/fixtures/**` should stop the walk at `src/fixtures`, not only reject what is under it
const asDirectories = (globs: string[]) =>
  globs.map((glob) => glob.replace(/\/\*\*(\/\*)?$/, ""));

const isHidden = (entry: fs.Dirent) =>
  entry.name === "node_modules" || entry.name.startsWith(".");

function testModuleFinder({ cwd, exclude, marker, skip }: Discovery) {
  const excluded = picomatch(exclude, { dot: true });
  const excludedDir = picomatch(asDirectories(exclude), { dot: true });

  const holdsTests = (file: string) =>
    isTypeScript(file) &&
    !file.endsWith(".d.ts") &&
    !excluded(relativeTo(cwd, file)) &&
    marker.test(fs.readFileSync(file, "utf8"));

  function* under(dir: string): Generator<string> {
    if (path.resolve(dir) === skip) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isHidden(entry)) continue;
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDir(relativeTo(cwd, at))) yield* under(at);
      } else if (holdsTests(at)) yield at;
    }
  }
  return under;
}

const library = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const VITEST_DEFAULT_INCLUDE = ["**/*.{test,spec}.?(c|m)[jt]s?(x)"];

// Vite appends a plugin's `include` to the user's, so it replaces only Vitest's default
const includeFor = (extracted: string | false, userInclude: unknown) => {
  const collectsNothing = Array.isArray(userInclude) && !userInclude.length;
  if (!extracted || collectsNothing) return {};
  return {
    include: userInclude ? [extracted] : [...VITEST_DEFAULT_INCLUDE, extracted],
  };
};

// each collector import maps to the line of the `export type` it runs
const collectorSourceMap = (id: string, code: string, collector: Line[]) => {
  const lines: SourceMapSegment[][] = code
    .split("\n")
    .map((_, line) => [[0, 0, line, 0]]);
  for (const { line } of collector)
    lines.push(line === null ? [] : [[2, 0, line, 0]]);
  return {
    version: 3,
    file: id,
    sources: [id],
    sourcesContent: [code],
    names: [],
    mappings: encode(lines),
  };
};

const writeDiagnostics = (diagnostics: Record<string, Warning[]>) => {
  ensureDerived();
  fs.writeFileSync(
    path.join(DERIVED, "diagnostics.json"),
    JSON.stringify(diagnostics, null, 2),
  );
};

const withoutQuery = (id: string) => id.split("?")[0] ?? id;

export default function namespaceTests({
  root,
  tsconfig = "tsconfig.json",
  exclude = ["scratch"],
  include = [],
  extracted = `**/*${EXTRACTED}`,
  scan = true,
  _scanSelf: scanSelf = false,
  noIsolateModuleImport = [],
}: Options = {}): Plugin {
  const cwd = process.cwd();
  const marker = testNamespaceMarker(root);
  const diagnostics: Record<string, Warning[]> = {};
  // a `vite.config.ts` builds this for `vite dev` and `vite build` too, which never read a program
  let service: ReturnType<typeof languageService> | undefined;
  const theService = () => (service ??= languageService(cwd, tsconfig));
  const testModulesUnder = testModuleFinder({
    cwd,
    exclude,
    marker,
    skip: scanSelf ? null : library,
  });
  const shared = picomatch(noIsolateModuleImport);
  const isShared = (file: string) => shared(relativeTo(cwd, file));
  const generated = new Map<string, { source: string; test: string }>();
  let only: RegExp | null = null;

  const report = (
    id: string,
    warnings: Warning[],
    warn: (message: string) => void,
  ) => {
    const rel = path.relative(cwd, id);
    diagnostics[rel] = warnings;
    writeDiagnostics(diagnostics);
    for (const w of warnings)
      warn(`${rel}:${w.line + 1}:${w.column + 1} ${w.message}`);
  };

  const register = (source: string, tests: { name: string; line: number }[]) =>
    tests
      .filter((t) => !only || only.test(t.name))
      .map((t) => {
        const id = idFor(source, t.name);
        generated.set(id, { source, test: t.name });
        return { id, line: t.line };
      });

  return {
    name: "namespace-tests",
    // only under Vitest, which sets VITEST before it loads the config: `vite dev`
    // has no use for the collector, and a build must never receive it
    apply: () => !!process.env.VITEST,
    // before vite:esbuild/oxc strips the namespaces
    enforce: "pre",
    config(userConfig: ViteUserConfig): ViteUserConfig {
      const files = scan
        ? [...testModulesUnder(cwd)].map((f) => path.relative(cwd, f))
        : [];
      return {
        test: {
          includeSource: [...files, ...include],
          includeTaskLocation: true,
          ...includeFor(extracted, userConfig.test?.include),
        },
      };
    },

    configResolved(config) {
      const pattern = (config as { test?: { testNamePattern?: unknown } }).test
        ?.testNamePattern;
      only = testNameFilter(pattern);
    },

    async resolveId(id, importer) {
      if (generated.has(id)) return id;
      const forked = forkOf(id);
      if (!forked) return null;
      const resolved = await this.resolve(forked.file, importer, {
        skipSelf: true,
      });
      if (!resolved) return null;
      const file = withoutQuery(resolved.id);
      if (isShared(file)) return resolved.id;
      // `lang.<ext>` tells Vite how to parse an id whose query hides its extension
      return `${resolved.id}?${FORK}=${forked.tag}&lang${path.extname(file)}`;
    },

    load(id) {
      const entry = generated.get(id);
      if (!entry) return null;
      const input = theService().inputFor(entry.source);
      return fork(
        minimalFor(entry.source, entry.test, {
          root,
          tsconfig,
          ...(input ? { input } : {}),
        }),
        path.basename(id, SUFFIX),
      );
    },

    watchChange(id) {
      service?.changed(id);
      for (const [generatedId, entry] of generated)
        if (entry.source === id) generated.delete(generatedId);
    },

    async transform(code, rawId) {
      const forked = forkOf(rawId);
      if (forked) return { code: await fork(code, forked.tag), map: null };

      const id = withoutQuery(rawId);
      if (!isTypeScript(id) || !marker.test(code)) return null;
      const input = theService().inputAsWritten(id, code);
      if (!input) return null;
      const { warnings, tests } = emittedFor(input, root);
      report(id, warnings, (message) => this.warn(message));

      const imports = register(id, tests);
      if (!imports.length) return null;
      const collector = collectorLines(imports);
      return {
        code: collected(code, collector),
        map: collectorSourceMap(id, code, collector),
      };
    },
  };
}
