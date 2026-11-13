#!/usr/bin/env node
import ts from "@typescript/typescript6";
import path from "node:path";
import fs from "node:fs";
import { cacheKey, read, write } from "./cache.mts";
import { SUFFIX, collected, collectorLines, idFor } from "./collector.mts";
import { fork } from "./fork.mts";
import { answersTo } from "../test-names.mts";
import {
  allNeeds,
  namesIn,
  emitTests,
  headerLines,
  namespaces,
} from "./emit/index.mts";

import type { Emitted, EmitInput } from "./emit/index.mts";

import type { Expect, Invoke, Throws } from "../dsl.import.meta.vitest.ts";
import type { minimalForFixture } from "../_internal/harness.mts";

export type Options = {
  /** Only reproduce tests written under this namespace. */
  root?: string | undefined;
  tsconfig?: string | undefined;
  /** A program that already holds the file, lent instead of building one. */
  input?: EmitInput | undefined;
};

type EmittedTest = Emitted["tests"][number];

const configs = new Map<string, ts.ParsedCommandLine>();

export function configFor(tsconfig: string, cwd = process.cwd()): ts.ParsedCommandLine {
  const file = ts.findConfigFile(cwd, ts.sys.fileExists, tsconfig);
  if (!file) throw new Error(`namespace-tests: cannot find ${tsconfig} from ${cwd}`);
  if (!configs.has(file))
    configs.set(
      file,
      ts.parseJsonConfigFileContent(
        ts.readConfigFile(file, ts.sys.readFile).config,
        ts.sys,
        path.dirname(file),
      ),
    );
  return configs.get(file)!;
}

// one program grown to hold every file asked about, not a whole compiler per file
const roots = new Set<string>();
let program: ts.Program | undefined;

function programFor(abs: string, config: ts.ParsedCommandLine): ts.Program {
  if (program && roots.has(abs)) return program;
  if (!roots.size) for (const f of config.fileNames) roots.add(f);
  roots.add(abs);
  program = ts.createProgram([...roots], config.options, undefined, program);
  return program;
}

function loaded(file: string, { input, tsconfig = "tsconfig.json" }: Options): EmitInput {
  if (input) return input;
  const abs = path.resolve(file);
  const program = programFor(abs, configFor(tsconfig));
  const source = program.getSourceFile(abs);
  if (!source) throw new Error(`cannot load ${file}`);
  return { program, source };
}

// the compiler hands out a new `SourceFile` when the text changes, so this keys on the text
const printed = new WeakMap<ts.SourceFile, Map<string, Emitted>>();

export function emittedFor(input: EmitInput, root?: string): Emitted {
  const key = root ?? "";
  const byRoot = printed.get(input.source) ?? new Map<string, Emitted>();
  printed.set(input.source, byRoot);
  let emitted = byRoot.get(key);
  if (!emitted) byRoot.set(key, (emitted = emitTests(input, root)));
  return emitted;
}

const isNamed = (test: EmittedTest, name: string) =>
  test.alias === name || answersTo(test.name, name);

function testsNamed(tests: EmittedTest[], name: string, file: string) {
  const named = tests.filter((test) => isNamed(test, name));
  if (!named.length) throw new Error(`no test named ${name} in ${file}`);
  return named as [EmittedTest, ...EmittedTest[]];
}

function* identifiersIn(node: ts.Node): Generator<ts.Identifier> {
  if (ts.isIdentifier(node)) yield node;
  const children: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    children.push(child);
  });
  for (const child of children) yield* identifiersIn(child);
}

const leadingTrivia = (statement: ts.Statement) =>
  statement.getFullText().slice(0, statement.getStart() - statement.getFullStart());

function trimmedImport(
  statement: ts.ImportDeclaration,
  used: Set<string>,
): string {
  const clause = statement.importClause;
  const bindings = clause?.namedBindings;
  if (!clause) return statement.getFullText();
  if (bindings && ts.isNamespaceImport(bindings))
    return used.has(bindings.name.text) ? statement.getFullText() : "";

  const named =
    bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
  const wanted = named.filter((e) => used.has(e.name.text));
  const byDefault = clause.name && used.has(clause.name.text) ? clause.name : null;
  if (!byDefault && !wanted.length) return "";
  if (wanted.length === named.length && (!clause.name || byDefault))
    return statement.getFullText();

  const parts = [
    byDefault?.text,
    wanted.length ? `{ ${wanted.map((e) => e.getText()).join(", ")} }` : null,
  ].filter(Boolean);
  return `${leadingTrivia(statement)}import ${parts.join(", ")} from ${statement.moduleSpecifier.getText()};`;
}

// one alias can appear under several namespaces, so the test's path picks it
function aliasOf(
  sf: ts.SourceFile,
  test: EmittedTest,
): ts.TypeAliasDeclaration | undefined {
  let fallback: ts.TypeAliasDeclaration | undefined;
  for (const { segs, body } of namespaces(sf))
    for (const statement of body.statements) {
      if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== test.alias)
        continue;
      if (segs.join(" > ") === test.path.join(" > ")) return statement;
      fallback ??= statement;
    }
  return fallback;
}

function topLevelByName(sf: ts.SourceFile): Map<string, ts.Statement> {
  const byName = new Map<string, ts.Statement>();
  for (const statement of sf.statements) {
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    )
      byName.set(statement.name.text, statement);
    else if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name))
          byName.set(declaration.name.text, statement);
  }
  return byName;
}

function* importedNames(statement: ts.ImportDeclaration): Generator<string> {
  const clause = statement.importClause;
  if (clause?.name) yield clause.name.text;
  const bindings = clause?.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) yield bindings.name.text;
  if (bindings && ts.isNamedImports(bindings))
    for (const element of bindings.elements) yield element.name.text;
}

function* declaredNames(block: ts.SourceFile | ts.ModuleBlock): Generator<string> {
  for (const statement of block.statements) {
    if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations)
        if (ts.isIdentifier(d.name)) yield d.name.text;
    if (ts.isImportDeclaration(statement)) yield* importedNames(statement);
    const name = (statement as { name?: ts.Node }).name;
    if (name && ts.isIdentifier(name)) yield name.text;
  }
}

// only a name the file declares can reach a statement worth keeping
const namesDeclaredIn = (sf: ts.SourceFile) =>
  new Set([sf, ...[...namespaces(sf)].map(({ body }) => body)].flatMap((block) => [...declaredNames(block)]));

const statementOf = (sf: ts.SourceFile, node: ts.Node): ts.Statement | undefined => {
  let current: ts.Node = node;
  while (current.parent && current.parent !== sf) current = current.parent;
  return current.parent === sf ? (current as ts.Statement) : undefined;
};

function reachable(
  checker: ts.TypeChecker,
  sf: ts.SourceFile,
  from: ts.TypeAliasDeclaration,
): Set<ts.Statement> {
  const keep = new Set<ts.Statement>();
  const seen = new Set<ts.Node>();
  const queue: ts.Node[] = [from.type];
  const declared = namesDeclaredIn(sf);
  const topLevel = topLevelByName(sf);

  const take = (statement: ts.Statement | undefined) => {
    if (!statement || keep.has(statement)) return;
    keep.add(statement);
    queue.push(statement);
  };

  const follow = (identifier: ts.Identifier) => {
    let resolved = false;
    for (const declaration of checker.getSymbolAtLocation(identifier)?.declarations ?? []) {
      const statement = declaration.getSourceFile() === sf ? statementOf(sf, declaration) : undefined;
      if (!statement) continue;
      // tests live in a namespace: followed through, never kept
      if (ts.isModuleDeclaration(statement)) queue.push(declaration);
      else {
        take(statement);
        resolved = true;
      }
    }
    // inside `declare namespace f`, `f` resolves to the namespace, not to `function f`
    if (!resolved) take(topLevel.get(identifier.text));
  };

  while (queue.length) {
    const node = queue.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const identifier of identifiersIn(node))
      if (declared.has(identifier.text)) follow(identifier);
  }
  return keep;
}

export function collectorFor(file: string, options: Options = {}): string {
  const input = loaded(file, options);
  const { tests } = emittedFor(input, options.root);
  const abs = path.resolve(file);
  const collector = collectorLines(
    tests.map((t) => ({ id: idFor(abs, t.name), line: t.line })),
  );
  return collected(input.source.text, tests.length ? collector : []);
}

declare namespace collectorFor {
  type Counter = Invoke<
    typeof collectorFor,
    [file: "examples/counter.ts"]
  >;

  /** your file, unchanged, is the whole of the top */
  export type KeepsSource = Expect<Counter, "includes", "class Counter">;

  /** and under it, what Vitest collects — guarded, so an importer gets nothing */
  export type Collects = Expect<
    Counter,
    "includes",
    "if (import.meta.vitest) {"
  >;

  /** one import per test, named for the test it runs */
  export type PerTest = Expect<
    Counter,
    "includes",
    "counter.Tests_Counter_Chainable.namespace.test.ts"
  >;
}

// a table is several modules, each printed under the id it is served as
export async function servedFor(
  file: string,
  testName: string,
  options: Options = {},
): Promise<string> {
  const input = loaded(file, options);
  const { tests } = emittedFor(input, options.root);
  const abs = path.resolve(file);
  const modules = await Promise.all(
    testsNamed(tests, testName, file).map(async ({ name }) => {
      const id = idFor(abs, name);
      const code = minimalFor(file, name, { ...options, input });
      return `// ${path.basename(id)}\n${await fork(code, path.basename(id, SUFFIX))}`;
    }),
  );
  return modules.join("\n");
}

// the file writes its own banner, so the preamble's is left out
const preambleFor = (tests: EmittedTest[], file: string) =>
  headerLines(allNeeds(tests.map((t) => t.needs)), file).filter(
    (line) => !line.startsWith("//"),
  );

function keptStatements({ program, source }: EmitInput, test: EmittedTest) {
  const alias = aliasOf(source, test);
  return alias
    ? reachable(program.getTypeChecker(), source, alias)
    : new Set(source.statements);
}

// an import is kept whole for one binding, so its unused ones are trimmed by name
function namesUsed(tests: EmittedTest[], kept: ts.Statement[]) {
  const used = new Set<string>(tests.flatMap((t) => namesIn(t)));
  for (const statement of kept)
    if (!ts.isImportDeclaration(statement))
      for (const identifier of identifiersIn(statement)) used.add(identifier.text);
  return used;
}

const isTypeOnlyImport = (statement: ts.Statement) =>
  ts.isImportDeclaration(statement) && !!statement.importClause?.isTypeOnly;

const withoutExports = (code: string) =>
  code.replace(
    /^export (?=(const|let|var|function|class|interface|type|enum|abstract) )/gm,
    "",
  );

const withoutShebang = (code: string) => code.trimStart().replace(/^#![^\n]*\n/, "");

function moduleText(kept: ts.Statement[], used: Set<string>) {
  const text = kept
    .filter((statement) => !isTypeOnlyImport(statement))
    .map((statement) =>
      ts.isImportDeclaration(statement)
        ? trimmedImport(statement, used)
        : statement.getFullText(),
    )
    .join("");
  return withoutShebang(withoutExports(text));
}

function printMinimal(file: string, testName: string, options: Options): string {
  const input = loaded(file, options);
  const emitted = emittedFor(input, options.root);
  const tests = testsNamed(emitted.tests, testName, file);
  const reached = keptStatements(input, tests[0]);
  const kept = input.source.statements.filter((statement) => reached.has(statement));
  const text = [
    preambleFor(tests, input.source.fileName).join("\n"),
    "",
    moduleText(kept, namesUsed(tests, kept)).trim(),
    "",
    tests.map((t) => t.code).join("\n\n"),
    "",
  ].join("\n");
  return `${text.replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export function minimalFor(
  file: string,
  testName: string,
  { cache = true, ...options }: Options & { cache?: boolean | undefined } = {},
): string {
  if (!cache) return printMinimal(file, testName, options);
  const source = fs.readFileSync(path.resolve(file), "utf8");
  const key = cacheKey(source, testName, options.root, path.resolve(file));
  const hit = read(key);
  if (hit !== null) return hit;
  const minimal = printMinimal(file, testName, options);
  write(key, minimal);
  return minimal;
}

declare namespace minimalFor {
  /** a name written with the other separator still finds its test */
  export type EitherSeparator = Expect<
    Invoke<
      typeof minimalForFixture,
      [fixture: "counter.ts", test: "Counter \u203a Reset"]
    >,
    "includes",
    "class Counter"
  >;

  type Reset = Invoke<
    typeof minimalForFixture,
    [fixture: "counter.ts", test: "Counter > Reset"]
  >;

  type Formats = Invoke<
    typeof minimalFor,
    [file: "examples/cart.ts", test: "formatCents > Formats"]
  >;

  /** an import brings in only what the test reaches */
  export type TrimsImports = Expect<
    Formats,
    "includes",
    'import { formatCents } from "./lib/money.ts";'
  >;

  /** the binding beside it, which this test never mentions, is left behind */
  export type DropsUnused = Expect<Formats, "excludes", "conversionCount">;

  /** and a test that does reach it keeps it */
  export type KeepsUsed = Expect<
    Invoke<
      typeof minimalFor,
      [file: "examples/cart.ts", test: "Isolation > IsolatedFirst"]
    >,
    "includes",
    'import { conversionCount, formatCents } from "./lib/money.ts";'
  >;

  /** the reproduction keeps the class the test exercises */
  export type KeepsSubject = Expect<Reset, "includes", "class Counter">;

  /** and the body of the test, inside an ordinary `test(…)` */
  export type KeepsBody = Expect<
    Reset,
    "includes",
    "const actual3 = Counter$.history;\n  const expected3 = 12;\n  expect.soft(actual3).not.toContain(expected3);"
  >;

  /** which is an ordinary Vitest file: imports first, test last */
  export type LooksNormal = Expect<
    Reset,
    "startsWith",
    'import { test, expect } from "vitest";'
  >;

  /** the namespace blocks are pruned away */
  export type DropsNamespaces = Expect<Reset, "excludes", "declare namespace">;

  /** an unknown test name is an error, not an empty file */
  export type Unknown = Throws<
    Invoke<typeof minimalForFixture, [fixture: "counter.ts", test: "Nope"]>,
    { message: "no test named Nope" }
  >;
}
