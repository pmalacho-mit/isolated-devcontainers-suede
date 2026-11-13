/// <reference types="node" />
// Development-time scaffolding for the library's own inline tests.
//
// The printer's stages need a `ts.Program` — something no type literal can
// spell. These helpers take *source text* instead and return what one stage
// makes of it, so an inline test stays a plain `Invoke<…>`:
//
//   export type Tuple = Expect<
//     Invoke<typeof printExpression, ['type Subject = [1, "a"];']>,
//     "=",
//     '[1, "a"]'
//   >;
//
// This is test-only code. Modules must import it *as a type only*, so that it
// is erased from any build and can only ever run through the generated tests.
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "@typescript/typescript6";

// the library's own TypeScript, so a test's programs are read by the copy that reads them in the library
export { ts };

import {
  createEmitContext,
  emitTests,
  lowerAlias,
  lowerBody,
  lowerExpr,
  namespaces,
  printBody,
  printExpr,
  printTest,
  render,
} from "../vite-plugin/emit/index.mts";
import { minimalFor } from "../vite-plugin/minimal.mts";

import type { EmitContext, EmitInput } from "../vite-plugin/emit/index.mts";

type Join<
  T extends readonly string[],
  Sep extends string = "",
> = T extends readonly [infer F extends string, ...infer R extends string[]]
  ? R extends []
    ? F
    : `${F}${Sep}${Join<R, Sep>}`
  : "";

const join = <T extends string[], Seperator extends string>(
  items: T,
  seperator: Seperator,
) => items.join(seperator) as Join<T, Seperator>;

export const importFromDsl = <T extends string[]>(...identifiers: T) =>
  `import type { ${join(identifiers, ", ")} } from "../dsl.import.meta.vitest.ts";\n` as const;

/** Prefixed to every snippet, so `Expect`, `Invoke` and friends resolve. */
export const DSL_IMPORT = importFromDsl(
  "Expect",
  "Invoke",
  "Construct",
  "Call",
  "Fixture",
  "Widen",
  "FromFile",
  "Env",
  "Snapshot",
  "Nothing",
  "Given",
  "ExpectGiven",
  "Throws",
  "Table",
  "Skip",
  "Only",
  "Todo",
  "Configure",
  "Mock",
  "Mocked",
  "SkipIfNotFound",
);

/**
 * Snippets name their namespace after whatever they are about, the way a test
 * file does. Nothing hides behind a root: a namespace is looked at for what its
 * exported aliases are, not for what it is called.
 */

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  // snippets are small and never touch the DOM; the default for ES2022 is
  // `lib.es2022.full.d.ts`, which drags in DOM, WebWorker and ScriptHost
  lib: ["lib.es2022.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
};

// One program for every snippet, grown as they arrive. A program per snippet
// would reload TypeScript's lib files each time; adding a file to the existing
// one lets it reuse everything it has already parsed.
//
// Snippets share a program, never a runtime: this is analysis only, and each
// snippet is its own module, so nothing crosses between them. The isolation a
// test gets comes from the module forking the plugin does, not from here.
const snippets = new Map<string, string>();
const named = new Map<string, string>();
let program: ts.Program | undefined;
let host: ts.CompilerHost | undefined;

/** A host that serves the snippets from memory and everything else from disk. */
function compilerHost(): ts.CompilerHost {
  if (host) return host;
  const base = ts.createCompilerHost(OPTIONS, true);
  const { getSourceFile, fileExists, readFile } = base;
  base.getSourceFile = (name, version, onError, shouldCreate) => {
    const text = snippets.get(name);
    return text === undefined
      ? getSourceFile.call(base, name, version, onError, shouldCreate)
      : ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true);
  };
  base.fileExists = (f) => snippets.has(f) || fileExists.call(base, f);
  base.readFile = (f) => snippets.get(f) ?? readFile.call(base, f);
  host = base;
  return base;
}

/** A one-file program over `code`, which any stage of the printer can be pointed at. */
export function inputFor(code: string): EmitInput {
  const text = DSL_IMPORT + code;
  let fileName = named.get(text);
  if (!fileName) {
    // beside this file, so a snippet reaches the DSL by the same relative path
    fileName = path.join(
      import.meta.dirname,
      `__snippet__.${createHash("sha256").update(text).digest("hex").slice(0, 12)}.ts`,
    );
    named.set(text, fileName);
    snippets.set(fileName, text);
    program = ts.createProgram(
      [...snippets.keys()],
      OPTIONS,
      compilerHost(),
      program,
    );
  }
  const source = program?.getSourceFile(fileName);
  if (!program || !source)
    throw new Error("bootstrap: the snippet did not load");
  return { program, source };
}

/** The declaration of `type <alias> = …`, wherever it sits in the snippet. */
export function aliasIn(code: string, alias: string): ts.TypeAliasDeclaration {
  const { source } = inputFor(code);
  let found: ts.TypeAliasDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isTypeAliasDeclaration(node) && node.name.text === alias)
      found = node;
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  if (!found) throw new Error(`bootstrap: no type alias named ${alias}`);
  return found;
}

/** The right-hand side of `type <alias> = …`. */
export const typeIn = (code: string, alias = "Subject"): ts.TypeNode =>
  aliasIn(code, alias).type;

/** A fresh context over the snippet. */
export const contextFor = (code: string): EmitContext => {
  const { program, source } = inputFor(code);
  return createEmitContext(program, source);
};

// ── one helper per stage ───────────────────────────────────────────────────

/** What `type Subject = …` prints as, as an expression. */
export const printExpression = (code: string, alias = "Subject"): string =>
  printExpr(lowerExpr(contextFor(code), typeIn(code, alias)));

/** The problems lowering `type Subject = …` reports, as messages. */
export function expressionWarnings(code: string, alias = "Subject"): string[] {
  const cx = contextFor(code);
  lowerExpr(cx, typeIn(code, alias));
  return cx.warnings.map((w) => w.message);
}

/** The problems printing a whole file reports, as messages. */
export const moduleWarnings = (code: string, root?: string): string[] =>
  emitTests(inputFor(code), root).warnings.map((w) => w.message);

/** The statements `type Subject = …` compiles to, read as a Test node. */
export const printStatements = (code: string, alias = "Subject"): string[] =>
  printBody(lowerBody(contextFor(code), typeIn(code, alias), false)).flat();

/**
 * The `expect` statement alone, for tests about which matcher a condition
 * prints: what a test takes on beforehand is bound to locals, and those say
 * nothing about the matcher.
 */
export const printMatcher = (code: string, alias = "Subject"): string =>
  printStatements(code, alias).at(-1)!;

/** The generated test(s) for `export type <alias>`, as source. */
export const printAlias = (code: string, alias: string): string =>
  lowerAlias(contextFor(code), aliasIn(code, alias), pathOf(code, alias))
    .map((t) => printTest(t).code)
    .join("\n\n");

/** The namespace path an alias is written in, as written. */
function pathOf(code: string, alias: string): string[] {
  const { source } = inputFor(code);
  for (const { segs, body } of namespaces(source))
    for (const statement of body.statements)
      if (ts.isTypeAliasDeclaration(statement) && statement.name.text === alias)
        return segs;
  return [];
}

/** Every test name the file emits, in order. */
export const testNames = (code: string, root?: string): string[] =>
  emitTests(inputFor(code), root).tests.map((t) => t.name);

/** The generated module's preamble. */
export const printHeader = (code: string, root?: string): string[] =>
  emitTests(inputFor(code), root).header;

/**
 * `minimalFor` over a fixture that ships beside this harness, so the library's
 * own tests never reach for a file outside `release/`.
 */
export const minimalForFixture = (fixture: string, testName: string): string =>
  minimalFor(path.join(import.meta.dirname, "fixtures", fixture), testName);

/** The whole generated module: preamble, then every test. */
export const printModule = (code: string, root?: string): string =>
  render(emitTests(inputFor(code), root)).code;
