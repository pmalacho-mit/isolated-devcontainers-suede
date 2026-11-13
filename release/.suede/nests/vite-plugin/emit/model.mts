import ts from "@typescript/typescript6";

import { isFirstPartySpecifier } from "../fork.mts";
import { awaits } from "./ir.mts";
import { isCondition } from "./print.mts";

import type { EmitContext } from "./context.mts";
import type {
  Assertion,
  Binding,
  Expr,
  Replacement,
  Shape,
  Statement,
  TestCase,
  TestOptions,
} from "./ir.mts";

import type { Expect, Invoke, Table } from "../../dsl.import.meta.vitest.ts";
import type * as harness from "../../_internal/harness.mts";

// a named tuple member, without its label
const unwrap = (e: ts.TypeNode): ts.TypeNode =>
  ts.isNamedTupleMember(e) ? e.type : e;

const elements = (tuple: ts.TupleTypeNode) => tuple.elements.map(unwrap);

export function lowerExpr(cx: EmitContext, node: ts.TypeNode): Expr {
  if (ts.isImportTypeNode(node))
    return cx.unsupported(node, "is a module's type, and a module is not a value a test can use");
  if (ts.isParenthesizedTypeNode(node))
    return { kind: "paren", inner: lowerExpr(cx, node.type) };
  if (ts.isLiteralTypeNode(node)) {
    const lit = node.literal;
    if (ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit))
      return { kind: "string", value: lit.text };
    if (ts.isPrefixUnaryExpression(lit))
      return { kind: "literal", source: `-${lit.operand.getText()}` };
    return { kind: "literal", source: lit.getText() }; // true, false, null, 1, 10n
  }
  if (node.kind === ts.SyntaxKind.UndefinedKeyword)
    return { kind: "literal", source: "undefined" };
  // only legal as the ignored expected of a nullary table row
  if (node.kind === ts.SyntaxKind.NeverKeyword)
    return { kind: "literal", source: "undefined" };
  if (ts.isTemplateLiteralTypeNode(node))
    return node.templateSpans.length === 0
      ? { kind: "string", value: node.head.text }
      : fold(cx, node); // the checker may reduce it to one string
  if (ts.isTupleTypeNode(node))
    return {
      kind: "array",
      elements: elements(node).map((e) => lowerExpr(cx, e)),
    };
  if (ts.isTypeLiteralNode(node))
    return {
      kind: "object",
      entries: node.members.map((m) => {
        const key =
          m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))
            ? m.name.text
            : (m.name?.getText() ?? "");
        return ts.isPropertySignature(m) && m.type
          ? [key, lowerExpr(cx, m.type)]
          : [key, cx.unsupported(m)];
      }),
    };
  if (ts.isTypeQueryNode(node)) return lowerName(cx, node.exprName); // typeof x.y
  if (ts.isIndexedAccessTypeNode(node)) {
    const index = node.indexType;
    if (ts.isLiteralTypeNode(index) && ts.isStringLiteral(index.literal))
      return {
        kind: "index",
        object: lowerExpr(cx, node.objectType),
        key: index.literal.text,
      };
    if (ts.isLiteralTypeNode(index) && ts.isNumericLiteral(index.literal))
      return {
        kind: "index",
        object: lowerExpr(cx, node.objectType),
        key: Number(index.literal.text),
      };
    return cx.unsupported(node);
  }
  if (ts.isTypeReferenceNode(node)) return lowerReference(cx, node);
  return fold(cx, node);
}

declare namespace lowerExpr {
  /** a type literal prints as the value literal it describes */
  export type Literals = Table<
    typeof harness.printExpression,
    [
      [
        args: [
          source: 'type Subject = [1, "a", true, null, undefined, -2, 10n];',
        ],
        expected: '[1, "a", true, null, undefined, -2, 10n]',
      ],
      [
        args: ['type Subject = { a: 1; "b-c": 2 };'],
        expected: '{ a: 1, "b-c": 2 }',
      ],
      [args: ["type Subject = `plain`;"], expected: '"plain"'],
    ]
  >;

  type Add = `
    const add = (a: number, b: number) => a + b;
  `;

  type AsyncAdd = `
    const add = async (a: number, b: number) => a + b;
  `;

  /** `Invoke` is the call it stands for */
  export type Invocation = Expect<
    Invoke<
      typeof harness.printExpression,
      [`${Add}\ntype Subject = Invoke<typeof add, [4, 5]>;`]
    >,
    "=",
    "add(4, 5)"
  >;

  /** and it is awaited when — and only when — what it returns is thenable */
  export type AwaitedInvocation = Expect<
    Invoke<
      typeof harness.printExpression,
      [`${AsyncAdd}\ntype Subject = Invoke<typeof add, [4, 5]>;`]
    >,
    "=",
    "await add(4, 5)"
  >;

  /** an alias the test references is hoisted into a const, so this is its name */
  export type AliasReference = Expect<
    Invoke<
      typeof harness.printExpression,
      [`${Add}type Sum = Invoke<typeof add, [1, 2]>;\ntype Subject = Sum;`]
    >,
    "=",
    "Sum"
  >;

  /** reading the environment goes through a helper unless a default is given */
  export type Environment = Table<
    typeof harness.printExpression,
    [
      [args: ['type Subject = Env<"TOKEN">;'], expected: 'nt_env("TOKEN")'],
      [
        args: [source: 'type Subject = Env<"TOKEN", "fallback">;'],
        expected: '(process.env["TOKEN"] ?? "fallback")',
      ],
    ]
  >;

  /** what the compiler works out itself — `Uppercase<…>` and its siblings */
  export type Intrinsics = Table<
    typeof harness.printExpression,
    [
      [args: ['type Subject = Uppercase<"ab">;'], expected: '"AB"'],
      [args: ['type Subject = Capitalize<"ab">;'], expected: '"Ab"'],
      [
        args: ['type Subject = [Lowercase<"AB">, Uncapitalize<"AB">];'],
        expected: '["ab", "aB"]',
      ],
    ]
  >;

  /** what cannot be a value throws when the test runs, and is reported now */
  export type NotAValue = Expect<
    Invoke<typeof harness.printExpression, ["type Subject = number;"]>,
    "=",
    'nt_unsupported("number")'
  >;

  export type NotAValueWarns = Expect<
    Invoke<typeof harness.expressionWarnings, ["type Subject = number;"]>,
    "=",
    ["`number` is a type, not a value"]
  >;

  /** a DSL intrinsic given too few arguments says how many it wants */
  export type Arity = Expect<
    Invoke<
      typeof harness.expressionWarnings,
      [`${Add}type Subject = Call<typeof add>;`]
    >,
    "=",
    ["`Call<typeof add>` expects 2 type arguments"]
  >;

  type NoParameters = `
    const none = () => 1;
    class Cart { total() { return 0; } }
  `;

  /** an argument tuple left out is a call with no arguments */
  export type OmittedArguments = Table<
    typeof harness.printExpression,
    [
      [args: [`${NoParameters}type Subject = Invoke<typeof none>;`], expected: "none()"],
      [args: [`${NoParameters}type Subject = Construct<typeof Cart>;`], expected: "new Cart()"],
      [
        args: [`${NoParameters}type Subject = Call<Construct<typeof Cart>, "total">;`],
        expected: "(new Cart()).total()",
      ],
    ]
  >;

  /** an awaited receiver is parenthesised before its method is called */
  export type AwaitedReceiver = Expect<
    Invoke<
      typeof harness.printExpression,
      [
        `${AsyncAdd}type Subject = Call<Invoke<typeof add, [1, 2]>, "toFixed", [1]>;`,
      ]
    >,
    "=",
    "(await add(1, 2)).toFixed(1)"
  >;

  /** a receiver that was never awaited needs no parentheses either */
  export type SynchronousReceiver = Expect<
    Invoke<
      typeof harness.printExpression,
      [`${Add}type Subject = Call<Invoke<typeof add, [1, 2]>, "toFixed", [1]>;`]
    >,
    "=",
    "add(1, 2).toFixed(1)"
  >;
}

// `a.b.c`, its root resolved as a value
export function lowerName(cx: EmitContext, node: ts.EntityName): Expr {
  if (ts.isIdentifier(node)) {
    const name = cx.valueName(node);
    return typeof name === "string" ? { kind: "name", name } : name;
  }
  const left = lowerName(cx, node.left);
  return left.kind === "name"
    ? { kind: "name", name: `${left.name}.${node.right.text}` }
    : left;
}

// as `await` asks it: is there anything to unwrap? `any` says no promise is coming
const returnsThenable = (cx: EmitContext, type: ts.Type | undefined): boolean =>
  !!type &&
  type.getCallSignatures().some((signature) => {
    const returned = signature.getReturnType();
    return cx.checker.getAwaitedType(returned) !== returned;
  });

const typeOfCallee = (cx: EmitContext, node: ts.TypeNode) =>
  cx.checker.getTypeFromTypeNode(node);

function typeOfMethod(
  cx: EmitContext,
  receiver: ts.TypeNode,
  method: string,
): ts.Type | undefined {
  const property = typeOfCallee(cx, receiver).getProperty(method);
  return property && cx.checker.getTypeOfSymbolAtLocation(property, receiver);
}

// an intrinsic given fewer than `n` type arguments
const arity = (cx: EmitContext, node: ts.TypeReferenceNode, n: number): Expr =>
  cx.unsupported(node, `expects ${n} type argument${n === 1 ? "" : "s"}`);

const callee = (cx: EmitContext, node: ts.TypeNode): Expr =>
  ts.isTypeQueryNode(node) ? lowerName(cx, node.exprName) : lowerExpr(cx, node);

const args = (cx: EmitContext, node: ts.TypeNode | undefined): Expr[] => {
  if (!node) return [];
  return ts.isTupleTypeNode(node)
    ? elements(node).map((e) => lowerExpr(cx, e))
    : [cx.unsupported(node)];
};

// or whatever the checker folds it to
export const literalText = (cx: EmitContext, node: ts.TypeNode): string =>
  ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)
    ? node.literal.text
    : cx.checker
        .typeToString(cx.checker.getTypeFromTypeNode(node))
        .replace(/^"|"$/g, "");

function lowerIntrinsic(
  cx: EmitContext,
  dsl: string,
  node: ts.TypeReferenceNode,
): Expr {
  const [a0, a1, a2] = node.typeArguments ?? [];
  switch (dsl) {
    case "Invoke":
      return a0
        ? {
            kind: "call",
            callee: callee(cx, a0),
            args: args(cx, a1),
            awaited: returnsThenable(cx, typeOfCallee(cx, a0)),
          }
        : arity(cx, node, 1);
    case "Construct":
      return a0
        ? { kind: "construct", callee: callee(cx, a0), args: args(cx, a1) }
        : arity(cx, node, 1);
    case "Mocked":
      return a0 ? { kind: "mocked", inner: lowerExpr(cx, a0) } : arity(cx, node, 1);
    case "Call": {
      if (!a0 || !a1) return arity(cx, node, 2);
      const method = literalText(cx, a1);
      return {
        kind: "method",
        receiver: lowerExpr(cx, a0),
        method,
        args: args(cx, a2),
        awaited: returnsThenable(cx, typeOfMethod(cx, a0, method)),
      };
    }
    case "Fixture":
      return a1 ? lowerExpr(cx, a1) : arity(cx, node, 2);
    case "Widen":
      return a0 ? lowerExpr(cx, a0) : arity(cx, node, 1);
    case "FromFile": {
      if (!a0) return arity(cx, node, 1);
      const format = a1 ? literalText(cx, a1) : "text";
      return {
        kind: "file",
        path: lowerExpr(cx, a0),
        format: format === "bytes" || format === "json" ? format : "text",
      };
    }
    case "Env":
      return a0
        ? {
            kind: "env",
            name: literalText(cx, a0),
            fallback:
              a1 && a1.kind !== ts.SyntaxKind.UndefinedKeyword
                ? lowerExpr(cx, a1)
                : null,
          }
        : arity(cx, node, 1);
    case "Snapshot":
      return { kind: "snapshot", name: a0 ? lowerExpr(cx, a0) : null };
    case "Nothing":
      return { kind: "literal", source: "undefined" };
    default:
      return cx.unsupported(node, `${dsl} is not a value`);
  }
}

// `Uppercase<S>` and its siblings have no body to inline: the checker folds them
const isIntrinsic = (declaration: ts.TypeAliasDeclaration) =>
  declaration.type.kind === ts.SyntaxKind.IntrinsicKeyword;

function lowerReference(cx: EmitContext, node: ts.TypeReferenceNode): Expr {
  const dsl = cx.dslName(node);
  if (dsl) return lowerIntrinsic(cx, dsl, node);
  const target = cx.target(node.typeName);
  const declaration = target?.declarations?.[0];
  if (
    target &&
    declaration &&
    ts.isTypeAliasDeclaration(declaration) &&
    !isIntrinsic(declaration)
  ) {
    const binding = register(cx, target, declaration);
    const name: Expr = { kind: "name", name: binding.name };
    return binding.params
      ? {
          kind: "call",
          callee: name,
          args: (node.typeArguments ?? []).map((a) => lowerExpr(cx, a)),
          // the alias prints as an arrow, and one is async only if its body
          // awaits — so calling it is awaited on exactly the same terms
          awaited: awaits(binding.value),
        }
      : name;
  }
  if (declaration && ts.isTypeParameterDeclaration(declaration))
    return { kind: "name", name: declaration.name.text }; // inside a generic alias body
  // A class (or lib interface+var pair such as RangeError) written as a type: use the value.
  if (target && target.flags & ts.SymbolFlags.Value)
    return lowerName(cx, node.typeName);
  return fold(cx, node);
}

// dependencies are registered first
function register(
  cx: EmitContext,
  symbol: ts.Symbol,
  decl: ts.TypeAliasDeclaration,
): Binding {
  const existing = cx.test.bindings.get(symbol);
  if (existing) return existing;
  const clashes = cx.checker.resolveName(
    decl.name.text,
    decl,
    ts.SymbolFlags.Value,
    false,
  );
  const binding: Binding = {
    name: clashes ? `${decl.name.text}$` : decl.name.text,
    params:
      decl.typeParameters?.map((p) => ({
        name: p.name.text,
        type: p.constraint?.getText() ?? "unknown",
        // `Key<"a.ts", "T">` leaves a defaulted parameter out, and means the
        // default by doing so; the printed parameter has to stand in for it the
        // same way, or the call arrives one argument short
        fallback: p.default ? lowerExpr(cx, p.default) : null,
      })) ?? null,
    // `Fixture<T, I>` keeps `T` on the const, so the generated code re-checks the DSL's guarantee
    annotation:
      ts.isTypeReferenceNode(decl.type) && cx.dslName(decl.type) === "Fixture"
        ? (decl.type.typeArguments?.[0]?.getText() ?? null)
        : null,
    value: { kind: "literal", source: "" },
    line: cx.lineOf(decl),
  };
  cx.test.bindings.set(symbol, binding);
  binding.value = lowerExpr(cx, decl.type); // may register further aliases first
  cx.test.order.push(binding);
  return binding;
}

function fold(cx: EmitContext, node: ts.TypeNode): Expr {
  return (
    literalOfType(cx, cx.checker.getTypeFromTypeNode(node)) ??
    cx.unsupported(node)
  );
}

export function literalOfType(cx: EmitContext, type: ts.Type): Expr | null {
  const { checker } = cx;
  if (type.flags & ts.TypeFlags.StringLiteral)
    return { kind: "string", value: (type as ts.StringLiteralType).value };
  if (type.flags & ts.TypeFlags.NumberLiteral)
    return {
      kind: "literal",
      source: String((type as ts.NumberLiteralType).value),
    };
  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    const { negative, base10Value } = (type as ts.BigIntLiteralType).value;
    return { kind: "literal", source: `${negative ? "-" : ""}${base10Value}n` };
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral)
    return { kind: "literal", source: checker.typeToString(type) };
  if (type.flags & ts.TypeFlags.Null)
    return { kind: "literal", source: "null" };
  if (type.flags & ts.TypeFlags.Undefined)
    return { kind: "literal", source: "undefined" };
  if (checker.isTupleType(type)) {
    const items = checker
      .getTypeArguments(type as ts.TypeReference)
      .map((arg) => literalOfType(cx, arg));
    return items.every((i) => i !== null)
      ? { kind: "array", elements: items }
      : null;
  }
  if (
    type.flags & ts.TypeFlags.Object &&
    !((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Class)
  ) {
    const entries: [string, Expr][] = [];
    for (const p of type.getProperties()) {
      const value = literalOfType(cx, checker.getTypeOfSymbol(p));
      if (!value) return null;
      entries.push([p.getName(), value]);
    }
    return { kind: "object", entries };
  }
  return null;
}

export function shapeOf(type: ts.Type): Shape {
  if (type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike))
    return "number";
  if (type.flags & ts.TypeFlags.StringLike) return "string";
  if (type.getProperty("BYTES_PER_ELEMENT")) return "typedArray";
  return "other";
}

function lowerCondition(
  cx: EmitContext,
  node: ts.TypeNode,
): { op: string; param: Expr | null } {
  if (ts.isTupleTypeNode(node)) {
    const [op, param] = elements(node);
    if (op && param)
      return { op: literalText(cx, op), param: lowerExpr(cx, param) };
  }
  return { op: literalText(cx, node), param: null };
}

// `"./page.html"`, or a config naming one with `display`
export function lowerDisplay(
  cx: EmitContext,
  node: ts.TypeNode | undefined,
): Assertion["display"] {
  if (!node) return null;
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal))
    return { page: node.literal.text, meta: null };
  if (!ts.isTypeLiteralNode(node)) return null;
  const property = (key: string) =>
    node.members.find(
      (m): m is ts.PropertySignature & { type: ts.TypeNode } =>
        ts.isPropertySignature(m) &&
        ts.isIdentifier(m.name) &&
        m.name.text === key &&
        !!m.type,
    )?.type;
  const page = property("display");
  const meta = property("displayMeta");
  return page
    ? { page: literalText(cx, page), meta: meta ? lowerExpr(cx, meta) : null }
    : null;
}

export type Actual = { expr: Expr; type: ts.Type };

const NOT_A_TEST =
  "is not a test: write Expect, Throws, Given or Table (or a tuple of them)";

const effect = (expr: Expr, line: number): Statement => ({
  kind: "effect",
  expr,
  line,
});

// `condition` is a node, or the condition itself when the syntax implies one
export function assertion(
  cx: EmitContext,
  actual: ts.TypeNode | Actual,
  condition: ts.TypeNode | "=" | "throws",
  expected: ts.TypeNode | undefined,
  soft: boolean,
  config: ts.TypeNode | undefined,
  anchor: ts.Node,
): Statement {
  const line = cx.lineOf(anchor);
  const display = lowerDisplay(cx, config);
  const { op, param } =
    typeof condition === "string"
      ? { op: condition, param: null }
      : lowerCondition(cx, condition);
  const expectedExpr = expected ? lowerExpr(cx, expected) : null;
  const expr = "expr" in actual ? actual.expr : lowerExpr(cx, actual);
  const type =
    "expr" in actual ? actual.type : cx.checker.getTypeFromTypeNode(actual);
  // only a node can name a condition the DSL does not have
  if (!isCondition(op) && typeof condition !== "string")
    return effect(cx.unsupported(condition, "is not a known condition"), line);
  if (!isCondition(op))
    throw new Error(`namespace-tests: no such condition ${op}`);
  return {
    kind: "assert",
    line,
    actual: expr,
    shape: shapeOf(type),
    condition: op,
    param,
    expected: expectedExpr,
    soft,
    display,
  };
}

const isMock = (cx: EmitContext, node: ts.TypeNode): node is ts.TypeReferenceNode =>
  ts.isTypeReferenceNode(node) && cx.dslName(node) === "Mock";

const stringIn = (node: ts.TypeNode | undefined) =>
  node && ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal) ? node.literal.text : null;

const resolves = (cx: EmitContext, path: string) =>
  !!ts.resolveModuleName(path, cx.source.fileName, cx.program.getCompilerOptions(), ts.sys).resolvedModule;

const MOCK_WARNINGS = {
  shared: (path: string) =>
    `\`${path}\` is a package, which every test in this file shares, so its mock applies to all of them`,
  unresolved: (path: string) => `\`${path}\` does not resolve from this file, so nothing would be mocked`,
};

const NOT_IMPORTED =
  "is not imported: vi.mock runs before this module's own code, so a replacement has to come from another module";

function warnAboutPath(cx: EmitContext, node: ts.TypeNode, path: string) {
  if (!isFirstPartySpecifier(path)) cx.warn(node, MOCK_WARNINGS.shared(path));
  else if (!resolves(cx, path)) cx.warn(node, MOCK_WARNINGS.unresolved(path));
}

// where a binding was imported from, and under what name that module exports it
function importOf(cx: EmitContext, identifier: ts.Identifier) {
  const declaration = cx.checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  const statement = declaration && ts.findAncestor(declaration, ts.isImportDeclaration);
  if (!declaration || !statement || !ts.isStringLiteral(statement.moduleSpecifier)) return null;
  const name = ts.isImportSpecifier(declaration)
    ? (declaration.propertyName ?? declaration.name).text
    : ts.isImportClause(declaration)
      ? "default"
      : null;
  return name ? { from: statement.moduleSpecifier.text, name } : null;
}

// a function is a factory, handed `importOriginal`; anything else is the module itself
function replacementOf(cx: EmitContext, node: ts.TypeNode): Replacement | Expr {
  const name = ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName) ? node.exprName : null;
  const imported = name && importOf(cx, name);
  if (!name || !imported) return cx.unsupported(node, NOT_IMPORTED);
  return { ...imported, factory: cx.checker.getTypeAtLocation(name).getCallSignatures().length > 0 };
}

const isReplacement = (value: Replacement | Expr): value is Replacement => !("kind" in value);

// a mock is not a statement of the test: it is printed where vi.mock can take effect
function registerMock(cx: EmitContext, node: ts.TypeReferenceNode): Statement[] {
  const [pathNode, withNode] = node.typeArguments ?? [];
  const path = stringIn(pathNode);
  if (!pathNode || path === null)
    return [effect(cx.unsupported(node, "needs the path of the module it replaces"), cx.lineOf(node))];
  warnAboutPath(cx, pathNode, path);
  const replacement = withNode ? replacementOf(cx, withNode) : null;
  if (replacement && !isReplacement(replacement)) return [effect(replacement, cx.lineOf(node))];
  cx.test.mocks.push({ path, replacement, line: cx.lineOf(node) });
  return [];
}

export function lowerBody(
  cx: EmitContext,
  node: ts.TypeNode,
  soft: boolean,
): Statement[] {
  if (ts.isTupleTypeNode(node))
    return elements(node).flatMap((e) => lowerBody(cx, e, true));
  const notATest = () => [
    effect(cx.unsupported(node, NOT_A_TEST), cx.lineOf(node)),
  ];
  if (!ts.isTypeReferenceNode(node)) return notATest();
  const dsl = cx.dslName(node);
  const [a0, a1, a2, a3, a4] = node.typeArguments ?? [];
  const short = (n: number) => [effect(arity(cx, node, n), cx.lineOf(node))];
  switch (dsl) {
    case "Expect":
      return a0 && a1 ? [assertion(cx, a0, a1, a2, soft, a3, node)] : short(2);
    case "Throws":
      return a0
        ? [assertion(cx, a0, "throws", a1, soft, undefined, node)]
        : short(1);
    case "Given":
    case "ExpectGiven": {
      if (!a0 || !a1) return notATest();
      const effects = (ts.isTupleTypeNode(a0) ? elements(a0) : [a0]).flatMap((e) =>
        isMock(cx, e) ? registerMock(cx, e) : [effect(lowerExpr(cx, e), cx.lineOf(e))],
      );
      const then =
        dsl === "Given"
          ? lowerBody(cx, a1, soft)
          : a2
            ? [assertion(cx, a1, a2, a3, soft, a4, node)]
            : short(3);
      return [...effects, ...then];
    }
    case "Configure":
      return a1 ? lowerBody(cx, a1, soft) : short(2);
    case null: {
      // A reference to another test alias (e.g. `Skip<Simple>`): inline its body.
      const declaration = cx.target(node.typeName)?.declarations?.[0];
      return declaration && ts.isTypeAliasDeclaration(declaration)
        ? lowerBody(cx, declaration.type, soft)
        : notATest();
    }
    default:
      return notATest();
  }
}

declare namespace lowerBody {
  type Add = `
    const add = (a: number, b: number) => a + b;
  `;

  type AsyncAdd = `
    const add = async (a: number, b: number) => a + b;
  `;

  /** one `Expect` is one statement */
  export type Assertion_ = Expect<
    Invoke<
      typeof harness.printStatements,
      [`${Add}type Subject = Expect<Invoke<typeof add, [1, 1]>, "=", 2>;`]
    >,
    "=",
    ["const actual = add(1, 1);", "const expected = 2;", "expect(actual).toEqual(expected);"]
  >;

  /** the same statement over a promise, which is the only reason to await */
  export type AwaitedAssertion = Expect<
    Invoke<
      typeof harness.printStatements,
      [`${AsyncAdd}type Subject = Expect<Invoke<typeof add, [1, 1]>, "=", 2>;`]
    >,
    "=",
    [
      "const actual = await add(1, 1);",
      "const expected = 2;",
      "expect(actual).toEqual(expected);"
    ]
  >;

  /** `Given` runs its effects first, then the test underneath */
  export type Effects = Expect<
    Invoke<
      typeof harness.printStatements,
      [
        `${Add}type Subject = Given<Invoke<typeof add, [1, 1]>, Expect<1, "truthy">>;`,
      ]
    >,
    "=",
    ["add(1, 1);", "const actual = 1;", "expect(actual).toBeTruthy();"]
  >;

  /** a tuple of expectations is soft, so every one of them reports */
  export type Tuple = Expect<
    Invoke<
      typeof harness.printStatements,
      [`${Add}type Subject = [Expect<1, "=", 1>, Expect<2, "=", 2>];`]
    >,
    "=",
    [
      "const actual1 = 1;",
      "const expected1 = 1;",
      "expect.soft(actual1).toEqual(expected1);",
      "const actual2 = 2;",
      "const expected2 = 2;",
      "expect.soft(actual2).toEqual(expected2);"
    ]
  >;

  /** `Throws` on a synchronous call asserts on the call where it stands */
  export type Rejection = Expect<
    Invoke<
      typeof harness.printStatements,
      [`${Add}type Subject = Throws<Invoke<typeof add, [1, 1]>, RangeError>;`]
    >,
    "=",
    ["expect(() => (add(1, 1))).toThrow(RangeError);"]
  >;

  /** an awaited one throws as a rejection, so that is what is asserted */
  export type AwaitedRejection = Expect<
    Invoke<
      typeof harness.printStatements,
      [
        `${AsyncAdd}type Subject = Throws<Invoke<typeof add, [1, 1]>, RangeError>;`,
      ]
    >,
    "=",
    ["await expect(async () => (await add(1, 1))).rejects.toThrow(RangeError);"]
  >;

  /**
   * …and so does a matcher literal, whatever it is thrown from: it compiles to
   * a predicate over the error, and only `.rejects` hands the error to one
   */
  export type MatcherRejection = Expect<
    Invoke<
      typeof harness.printStatements,
      [
        `${Add}type Subject = Throws<Invoke<typeof add, [1, 1]>, { message: "no" }>;`,
      ]
    >,
    "=",
    [
      'await expect(async () => (add(1, 1))).rejects.toSatisfy((err) => String(err.message).includes("no"));',
    ]
  >;

  /** what is not a test says so where it was written, and fails when run */
  export type NotATest = Expect<
    Invoke<typeof harness.printStatements, ["type Subject = 1;"]>,
    "=",
    ['nt_unsupported("1");']
  >;
}

export const testName = (path: string[], alias: string): string =>
  [...path, alias].join(" > ");

declare namespace testName {
  /** the namespace path a test was written in, then its alias */
  export type Cases = Table<
    typeof testName,
    [
      [
        args: [path: ["parser", "errors"], alias: "Deep"],
        expected: "parser > errors > Deep",
      ],
      [args: [path: [], alias: "AtTheRoot"], expected: "AtTheRoot"],
    ]
  >;
}

// written as one of the DSL's types, or a tuple of them; whether it runs is said where it cannot
export function isTest(cx: EmitContext, type: ts.TypeNode): boolean {
  if (ts.isTupleTypeNode(type))
    return (
      type.elements.length > 0 && elements(type).every((e) => isTest(cx, e))
    );
  return ts.isTypeReferenceNode(type) && !!cx.dslName(type);
}

declare namespace isTest {
  type Suite = `
    const add = (a: number, b: number) => a + b;
    declare namespace anything {
      export type Assertion = Expect<Invoke<typeof add, [1, 1]>, "=", 2>;
      export type Skipped = Skip<Expect<1, "=", 1>>;
      export type Pending = Todo<"later">;
      export type Rows = Table<typeof add, [[[1, 1], "=", 2]]>;
      export type Helper = { a: 1 };
      export type Value = Invoke<typeof add, [1, 1]>;
    }
  `;

  /** what the namespace is called does not decide; where the type came from does */
  export type Collected = Expect<
    Invoke<typeof harness.testNames, [Suite]>,
    "=",
    [
      "anything > Assertion",
      "anything > Skipped",
      "anything > Pending",
      "anything > Rows[0]",
      "anything > Value",
    ]
  >;

  /** an exported alias that is not the DSL's at all is not a test */
  export type NotOurs = Expect<
    Invoke<typeof harness.testNames, [Suite]>,
    "excludes",
    "anything > Helper"
  >;

  /**
   * `Value` is the DSL's, so it is collected — and the model is the one that
   * says it cannot be run, reported where it is written.
   */
  export type SaysWhy = Expect<
    Invoke<typeof harness.moduleWarnings, [Suite]>,
    "=",
    [
      "`Invoke<typeof add, [1, 1]>` is not a test: write Expect, Throws, Given or Table (or a tuple of them)",
    ]
  >;
}

type Peeled = {
  mode: TestCase["mode"];
  options: TestOptions;
  requires: string[];
  node: ts.TypeNode | null;
};

export function peelModifiers(cx: EmitContext, type: ts.TypeNode): Peeled {
  let node: ts.TypeNode | null = type;
  let mode: TestCase["mode"] = "test";
  const options: TestOptions = {};
  const requires: string[] = [];
  while (node && ts.isTypeReferenceNode(node)) {
    const dsl = cx.dslName(node);
    const m0: ts.TypeNode | undefined = node.typeArguments?.[0];
    const m1: ts.TypeNode | undefined = node.typeArguments?.[1];
    if (dsl === "Skip" && m0) [mode, node] = ["test.skip", m0];
    else if (dsl === "Only" && m0) [mode, node] = ["test.only", m0];
    else if (dsl === "Todo") [mode, node] = ["test.todo", null];
    else if (dsl === "SkipIfNotFound" && m0 && m1) {
      const path = stringIn(m0);
      if (path === null) cx.warn(m0, "`SkipIfNotFound` needs the path as a string, relative to the test file");
      else requires.push(path);
      node = m1;
    }
    else if (dsl === "Configure" && m0 && m1) {
      if (ts.isTypeLiteralNode(m0))
        for (const m of m0.members) {
          if (!ts.isPropertySignature(m) || !ts.isIdentifier(m.name) || !m.type)
            continue;
          const value = Number(m.type.getText().replace(/_/g, ""));
          if (m.name.text === "timeout") options.timeout = value;
          if (m.name.text === "retries") options.retry = value;
        }
      node = m1;
    } else break;
  }
  return { mode, options, requires, node };
}

export function docTextOf(decl: ts.TypeAliasDeclaration): string | null {
  const doc = ts.getJSDocCommentsAndTags(decl).find(ts.isJSDoc)?.comment;
  return doc === undefined
    ? null
    : typeof doc === "string"
      ? doc
      : doc.map((c) => c.text).join("");
}

// awaited: what a table row compares
function returnTypeOf(cx: EmitContext, fnNode: ts.TypeNode): ts.Type {
  const { checker } = cx;
  const t = checker.getTypeFromTypeNode(fnNode);
  const sig = t.getCallSignatures()[0];
  return sig
    ? (checker.getAwaitedType(sig.getReturnType()) ?? sig.getReturnType())
    : t;
}

function tableCases(
  cx: EmitContext,
  node: ts.TypeReferenceNode,
  meta: Omit<TestCase, "bindings" | "body" | "imports" | "mocks">,
): TestCase[] {
  const [fnNode, rowsNode] = node.typeArguments ?? [];
  const failing = (at: ts.Node, why: string, row = meta): TestCase => ({
    ...row,
    mode: "test",
    bindings: [],
    imports: new Map(),
    mocks: [],
    body: [effect(cx.unsupported(at, why), cx.lineOf(at))],
  });
  if (!fnNode || !rowsNode || !ts.isTupleTypeNode(rowsNode))
    return [failing(node, "expects a function and a tuple of rows")];
  return elements(rowsNode).map((row, i) => {
    cx.resetTest();
    const rowMeta = {
      ...meta,
      name: testName(meta.path, `${meta.alias}[${i}]`),
      row: i,
      line: cx.lineOf(row),
    };
    if (!ts.isTupleTypeNode(row))
      return failing(row, "is not a table row", rowMeta);
    const cells = elements(row);
    const [argsNode, condition, expected] =
      cells.length === 2 ? [cells[0], null, cells[1]] : cells;
    if (!argsNode) return failing(row, "is not a table row", rowMeta);
    const call: Actual = {
      expr: {
        kind: "call",
        callee: callee(cx, fnNode),
        args: args(cx, argsNode),
        awaited: returnsThenable(cx, typeOfCallee(cx, fnNode)),
      },
      type: returnTypeOf(cx, fnNode),
    };
    const body = [
      assertion(cx, call, condition ?? "=", expected, false, undefined, row),
    ];
    return {
      ...rowMeta,
      bindings: cx.test.order,
      imports: cx.test.imports,
      mocks: cx.test.mocks,
      body,
    };
  });
}

export function lowerAlias(
  cx: EmitContext,
  decl: ts.TypeAliasDeclaration,
  path: string[] = [],
): TestCase[] {
  cx.resetTest();
  const alias = decl.name.text;
  const line = cx.lineOf(decl);
  const { mode, options, requires, node } = peelModifiers(cx, decl.type);
  const text = docTextOf(decl);
  const meta = {
    name: testName(path, alias),
    path,
    alias,
    row: null,
    line,
    doc: text === null ? null : { text, line },
    mode,
    options,
    requires,
  };
  if (!node) return [{ ...meta, bindings: [], imports: new Map(), mocks: [], body: [] }];
  if (ts.isTypeReferenceNode(node) && cx.dslName(node) === "Table")
    return tableCases(cx, node, meta);
  const body = lowerBody(cx, node, false);
  return [{ ...meta, bindings: cx.test.order, imports: cx.test.imports, mocks: cx.test.mocks, body }];
}

// `declare namespace A.B {}` is `["A", "B"]`; only statements can hold a namespace
export function* namespaces(
  node: ts.SourceFile | ts.ModuleBlock,
  prefix: string[] = [],
): Generator<{ segs: string[]; body: ts.ModuleBlock }> {
  for (const statement of node.statements) {
    if (!ts.isModuleDeclaration(statement) || !ts.isIdentifier(statement.name))
      continue;
    const segs = [...prefix, statement.name.text];
    let body = statement.body;
    while (body && ts.isModuleDeclaration(body) && ts.isIdentifier(body.name)) {
      segs.push(body.name.text);
      body = body.body;
    }
    if (body && ts.isModuleBlock(body)) {
      yield { segs, body };
      yield* namespaces(body, segs);
    }
  }
}

export const isExportedTypeAlias = (
  node: ts.Statement,
): node is ts.TypeAliasDeclaration =>
  ts.isTypeAliasDeclaration(node) &&
  !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

declare namespace lowerAlias {
  type Suite = `
    const add = (a: number, b: number) => a + b;
    declare namespace add {
      /** four plus five */
      export type Simple = Expect<Invoke<typeof add, [4, 5]>, "=", 9>;
      export type Rows = Table<typeof add, [[[1, 1], "=", 2]]>;
      export type Later = Todo<"soon">;
      export type Skipped = Skip<Expect<1, "=", 1>>;
      export type SkippedRows = Skip<Table<typeof add, [[[1, 1], "=", 2]]>>;
      export type Slow = Configure<{ timeout: 50; retries: 2 }, Expect<1, "=", 1>>;
    }
  `;

  /** a test alias becomes one top-level test, its JSDoc kept as the description */
  export type Simple = Expect<
    Invoke<typeof harness.printAlias, [Suite, "Simple"]>,
    "=",
    '/** four plus five */\ntest("add > Simple", () => {\n  const actual = add(4, 5);\n  const expected = 9;\n  expect(actual).toEqual(expected);\n});'
  >;

  type AsyncSuite = `
    const load = async (id: string) => id;
    declare namespace load {
      export type One = Expect<Invoke<typeof load, ["a"]>, "=", "a">;
    }
  `;

  /**
   * …and it is an async function only when something in it is awaited, which
   * `Simple` above shows is not the usual case
   */
  export type Awaited_ = Expect<
    Invoke<typeof harness.printAlias, [AsyncSuite, "One"]>,
    "=",
    'test("load > One", async () => {\n  const actual = await load("a");\n  const expected = "a";\n  expect(actual).toEqual(expected);\n});'
  >;

  /** a table row is a test of its own, indexed by row */
  export type TableRow = Expect<
    Invoke<typeof harness.printAlias, [Suite, "Rows"]>,
    "=",
    'test("add > Rows[0]", () => {\n  const actual = add(1, 1);\n  const expected = 2;\n  expect(actual).toEqual(expected);\n});'
  >;

  /** `Todo` has no body at all */
  export type Pending = Expect<
    Invoke<typeof harness.printAlias, [Suite, "Later"]>,
    "=",
    'test.todo("add > Later");'
  >;

  /** `Skip` picks the Vitest function, and keeps the test underneath — rows included */
  export type Skipped = [
    Expect<
      Invoke<typeof harness.printAlias, [Suite, "Skipped"]>,
      "startsWith",
      'test.skip("add > Skipped"'
    >,
    Expect<
      Invoke<typeof harness.printAlias, [Suite, "SkippedRows"]>,
      "startsWith",
      'test.skip("add > SkippedRows[0]"'
    >,
  ];

  /** `Configure` becomes Vitest's own options */
  export type Configured = Expect<
    Invoke<typeof harness.printAlias, [Suite, "Slow"]>,
    "startsWith",
    'test("add > Slow", {"timeout":50,"retry":2}, () => {'
  >;
}
