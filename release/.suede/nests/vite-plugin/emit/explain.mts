// TypeScript judges a test; this says where, and in the test's own words.
import ts from "@typescript/typescript6";

import type { EmitContext, Warning } from "./context.mts";
import type { Expect, Invoke } from "../../dsl.import.meta.vitest.ts";
import type { moduleWarnings } from "../../_internal/harness.mts";

const DOES_NOT_SATISFY = 2344;
const AT_POSITION = 2626;

type Mistake = { reference: ts.TypeReferenceNode; dsl: string; argument: number; diagnostic: ts.Diagnostic };

function* typeReferencesIn(node: ts.Node): Generator<ts.TypeReferenceNode> {
  if (ts.isTypeReferenceNode(node)) yield node;
  const children: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    children.push(child);
  });
  for (const child of children) yield* typeReferencesIn(child);
}

const contains = (node: ts.Node, offset: number) => node.getStart() <= offset && offset < node.end;

const widthOf = (node: ts.Node) => node.end - node.getStart();

// the innermost reference to the DSL whose type argument the error sits in
function mistakeAt(cx: EmitContext, references: ts.TypeReferenceNode[], diagnostic: ts.Diagnostic): Mistake | null {
  const start = diagnostic.start ?? -1;
  const reference = references
    .filter((r) => cx.dslName(r) && (r.typeArguments ?? []).some((a) => contains(a, start)))
    .sort((a, b) => widthOf(a) - widthOf(b))[0];
  if (!reference) return null;
  const argument = reference.typeArguments!.findIndex((a) => contains(a, start));
  return { reference, dsl: cx.dslName(reference)!, argument, diagnostic };
}

function* chainOf(message: string | ts.DiagnosticMessageChain): Generator<ts.DiagnosticMessageChain | string> {
  for (let link: typeof message | undefined = message; link; link = typeof link === "string" ? undefined : link.next?.[0])
    yield link;
}

const textOf = (link: ts.DiagnosticMessageChain | string) => (typeof link === "string" ? link : link.messageText);

const leafOf = (message: string | ts.DiagnosticMessageChain) => textOf([...chainOf(message)].at(-1)!);

// the cell as a whole, not whatever part of it TypeScript elaborated down to
const cellMismatchIn = (message: string | ts.DiagnosticMessageChain) => {
  const links = [...chainOf(message)];
  const position = links.findIndex((l) => typeof l !== "string" && l.code === AT_POSITION);
  return textOf(links[position + 1] ?? links.at(-1)!);
};

const positionIn = (message: string | ts.DiagnosticMessageChain) => {
  const link = [...chainOf(message)].find((l) => typeof l !== "string" && l.code === AT_POSITION);
  const position = link && /position (\d+) in source/.exec(textOf(link));
  return position ? Number(position[1]) : null;
};

type Mismatch = { source: string; target: string };

// `Snapshot<any>` is accepted everywhere an expected value is, so it only adds noise
const withoutSnapshot = (type: string) =>
  type
    .split(" | ")
    .filter((part) => !part.startsWith("Snapshot<"))
    .join(" | ");

const mismatchIn = (leaf: string): Mismatch | null => {
  const found = /^Type '(.*)' (?:is not assignable to type|does not satisfy the constraint) '(.*)'\.$/s.exec(leaf);
  return found ? { source: found[1]!, target: withoutSnapshot(found[2]!) } : null;
};

const warningAt = (cx: EmitContext, node: ts.Node, message: string): Warning => {
  const { line, character } = cx.source.getLineAndCharacterOfPosition(node.getStart());
  return { line, column: character, length: widthOf(node), message };
};

const calledName = (fn: ts.TypeNode) => fn.getText().replace(/^typeof\s+/, "");

const ROW_MESSAGES: Record<string, (fn: string, found: Mismatch) => string> = {
  args: (fn, { source, target }) => `${fn} takes ${target}, not ${source}`,
  expected: (fn, { source, target }) => `expected ${source}, but ${fn} returns ${target}`,
  condition: (fn, { source }) => `${source} is not a condition ${fn}'s result can be checked with`,
};

const rowMessage = (row: number, label: string, fn: string, mismatch: string) => {
  const found = mismatchIn(mismatch);
  const explain = ROW_MESSAGES[label];
  return `Row ${row + 1}: ${found && explain ? explain(fn, found) : mismatch}`;
};

const EXPECT_MESSAGES: Record<number, (actual: string, found: Mismatch) => string> = {
  1: (actual, { source }) => `${source} is not a condition for ${actual}`,
  2: (actual, { source }) => `expected ${source}, but the actual is ${actual}`,
};

function explainExpect(cx: EmitContext, { reference, argument, diagnostic }: Mistake): Warning | null {
  const explain = EXPECT_MESSAGES[argument];
  const found = mismatchIn(leafOf(diagnostic.messageText));
  const [actual] = reference.typeArguments ?? [];
  if (!explain || !found || !actual) return null;
  const actualType = cx.checker.typeToString(cx.checker.getTypeFromTypeNode(actual), undefined, ts.TypeFormatFlags.InTypeAlias);
  return warningAt(cx, reference.typeArguments![argument]!, explain(actualType, found));
}

type RowCheck = { table: ts.TypeReferenceNode; row: ts.TypeNode; index: number; start: number; end: number };

const rowsOf = (table: ts.TypeReferenceNode) => {
  const rows = table.typeArguments?.[1];
  return rows && ts.isTupleTypeNode(rows) ? [...rows.elements] : [];
};

const unlabelled = (node: ts.TypeNode) => (ts.isNamedTupleMember(node) ? node.type : node);

const cellsOf = (row: ts.TypeNode) => {
  const tuple = unlabelled(row);
  return ts.isTupleTypeNode(tuple) ? [...tuple.elements] : [];
};

const POSITIONAL_LABELS: Record<number, string[]> = { 2: ["args", "expected"], 3: ["args", "condition", "expected"] };

const labelOf = (cells: ts.TypeNode[], position: number) => {
  const cell = cells[position];
  return cell && ts.isNamedTupleMember(cell) ? cell.name.text : (POSITIONAL_LABELS[cells.length]?.[position] ?? "row");
};

const ROW_CHECK = "__namespaceTestsRow";

const checkingAlias = (table: ts.TypeReferenceNode, row: ts.TypeNode, n: number) =>
  `\ntype ${ROW_CHECK}${n} = ${table.typeName.getText()}<${table.typeArguments![0]!.getText()}, [${row.getText()}]>;`;

const statementOf = (node: ts.Node): ts.Node =>
  ts.isTypeAliasDeclaration(node) || !node.parent ? node : statementOf(node.parent);

// every row as a one-row table of its own, beside the table it came from
function withRowChecks(text: string, tables: ts.TypeReferenceNode[]) {
  const checks: RowCheck[] = [];
  const insertions = tables.map((table) => ({ at: statementOf(table).end, table })).sort((a, b) => a.at - b.at);
  let out = "";
  let last = 0;
  for (const { at, table } of insertions) {
    out += text.slice(last, at);
    for (const [index, row] of rowsOf(table).entries()) {
      const alias = checkingAlias(table, row, checks.length);
      checks.push({ table, row, index, start: out.length, end: out.length + alias.length });
      out += alias;
    }
    last = at;
  }
  return { text: out + text.slice(last), checks };
}

// a copy of a package TypeScript has already seen is a redirect to the first, which a new program must read afresh
const reusable = (program: ts.Program, name: string) => {
  const source = program.getSourceFile(name);
  return source && !(source as { redirectInfo?: unknown }).redirectInfo ? source : undefined;
};

const hostServing = (program: ts.Program, file: string, text: string): ts.CompilerHost => {
  const host = ts.createCompilerHost(program.getCompilerOptions(), true);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, version, onError, create) =>
    name === file
      ? ts.createSourceFile(name, text, version, true)
      : (reusable(program, name) ?? getSourceFile.call(host, name, version, onError, create));
  host.fileExists = (name) => !!program.getSourceFile(name) || fileExists.call(host, name);
  host.readFile = (name) => program.getSourceFile(name)?.text ?? readFile.call(host, name);
  return host;
};

// TypeScript stops at a table's first bad row; checked one by one, every bad row is found
function explainRows(cx: EmitContext, tables: ts.TypeReferenceNode[]): Warning[] {
  const file = cx.source.fileName;
  const { text, checks } = withRowChecks(cx.source.text, tables);
  const program = ts.createProgram({
    rootNames: cx.program.getRootFileNames().includes(file) ? cx.program.getRootFileNames() : [...cx.program.getRootFileNames(), file],
    options: cx.program.getCompilerOptions(),
    host: hostServing(cx.program, file, text),
    oldProgram: cx.program,
  });
  const source = program.getSourceFile(file);
  if (!source) return [];
  return program
    .getSemanticDiagnostics(source)
    .filter((d) => d.code === DOES_NOT_SATISFY)
    .flatMap((diagnostic) => {
      const check = checks.find((c) => c.start <= diagnostic.start! && diagnostic.start! < c.end);
      if (!check) return [];
      const cells = cellsOf(check.row);
      const position = positionIn(diagnostic.messageText);
      const at = position === null ? check.row : (cells[position] ?? check.row);
      const fn = calledName(check.table.typeArguments![0]!);
      return [warningAt(cx, at, rowMessage(check.index, labelOf(cells, position ?? -1), fn, cellMismatchIn(diagnostic.messageText)))];
    });
}

const isTableRows = (mistake: Mistake) => mistake.dsl === "Table" && mistake.argument === 1;

export function explainedMistakes(cx: EmitContext, tests: readonly ts.TypeAliasDeclaration[]): Warning[] {
  const diagnostics = cx.program.getSemanticDiagnostics(cx.source).filter((d) => d.code === DOES_NOT_SATISFY);
  if (!diagnostics.length) return [];
  const references = tests.flatMap((test) => [...typeReferencesIn(test.type)]);
  const mistakes = diagnostics.map((d) => mistakeAt(cx, references, d)).filter((m): m is Mistake => m !== null);
  const tables = [...new Set(mistakes.filter(isTableRows).map((m) => m.reference))];
  const expects = mistakes.filter((m) => m.dsl === "Expect").map((m) => explainExpect(cx, m));
  return [...(tables.length ? explainRows(cx, tables) : []), ...expects.filter((w): w is Warning => w !== null)];
}

declare namespace explainedMistakes {
  type Suite = `
    export const scrubsTests = (define: Record<string, unknown> | undefined) =>
      typeof define?.["import.meta.vitest"] === "string";

    declare namespace scrubsTests {
      export type Spellings = Table<
        typeof scrubsTests,
        [
          [args: [{ "import.meta.vitest": "undefined" }], expected: true],
          [args: [{}], expected: "no"],
          [args: ["wrong"], expected: false],
          [args: [undefined], expected: false],
        ]
      >;

      export type Single = Expect<Invoke<typeof scrubsTests, [{}]>, "=", "no">;
    }
  `;

  /** every bad row is named, not just the first TypeScript stops at, and each in the test's own words */
  export type EveryRow = Expect<
    Invoke<typeof moduleWarnings, [Suite]>,
    "=",
    [
      'Row 2: expected "no", but scrubsTests returns boolean',
      'Row 3: scrubsTests takes [define: Record<string, unknown> | undefined], not ["wrong"]',
      'expected "no", but the actual is boolean',
    ]
  >;

  /** a table TypeScript accepts says nothing more */
  export type Quiet = Expect<
    Invoke<
      typeof moduleWarnings,
      [
        `
          export const double = (n: number) => n * 2;
          declare namespace double {
            export type Rows = Table<typeof double, [[args: [2], expected: 4]]>;
          }
        `,
      ]
    >,
    "=",
    []
  >;
}
