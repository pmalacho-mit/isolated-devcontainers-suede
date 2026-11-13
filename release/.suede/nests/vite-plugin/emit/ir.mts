import type { Internal } from "../../dsl.import.meta.vitest.ts";

export type Expr =
  // by value: the printer quotes it
  | { kind: "string"; value: string }
  // as printed: `1`, `-2`, `10n`, `true`, `null`, `undefined`
  | { kind: "literal"; source: string }
  | { kind: "array"; elements: Expr[] }
  | { kind: "object"; entries: [key: string, value: Expr][] }
  | { kind: "name"; name: string }
  // awaited only when what it returns is thenable
  | { kind: "call"; callee: Expr; args: Expr[]; awaited: boolean }
  // a constructor cannot be async, so it is never awaited
  | { kind: "construct"; callee: Expr; args: Expr[] }
  | {
      kind: "method";
      receiver: Expr;
      method: string;
      args: Expr[];
      awaited: boolean;
    }
  | { kind: "index"; object: Expr; key: string | number }
  | { kind: "file"; path: Expr; format: Internal.FileFormat }
  // a `null` fallback means the variable must be set
  | { kind: "env"; name: string; fallback: Expr | null }
  // only meaningful as the expected value of `"="`
  | { kind: "snapshot"; name: Expr | null }
  // kept so the printed code reads as the type did
  | { kind: "paren"; inner: Expr }
  | { kind: "mocked"; inner: Expr }
  // prints a call that fails at run time
  | { kind: "unsupported"; source: string };

export type ConditionName =
  | Internal.UniversalCondition
  | Internal.OrderingCondition
  | Internal.StringCondition
  | Internal.ArrayCondition
  | Internal.ObjectCondition
  | Internal.NumberCondition
  | Internal.ApproxCondition[0];

// what the checker knows of an actual that changes the matcher printed
export type Shape = "number" | "string" | "typedArray" | "other";

export type Assertion = {
  kind: "assert";
  actual: Expr;
  shape: Shape;
  condition: ConditionName;
  // the tolerance of `["~=", tolerance]`
  param: Expr | null;
  expected: Expr | null;
  // inside a tuple every expectation reports, so each is soft
  soft: boolean;
  display: { page: string; meta: Expr | null } | null;
};

// the `Given` half of a test
export type Effect = { kind: "effect"; expr: Expr };

export type Statement = (Assertion | Effect) & { line: number | null };

export type Param = {
  name: string;
  // from the type parameter's constraint
  type: string;
  // the type parameter's default
  fallback: Expr | null;
};

// a user alias the test reaches: a `const`, or an arrow when generic
export type Binding = {
  name: string;
  params: Param[] | null;
  // `Fixture<T, …>` keeps `T`
  annotation: string | null;
  value: Expr;
  line: number;
};

export type TestOptions = { timeout?: number; retry?: number };

// imported from another module: `vi.mock` runs before the test module's own code
export type Replacement = { from: string; name: string; factory: boolean };

export type ModuleMock = { path: string; replacement: Replacement | null; line: number };

export type TestCase = {
  name: string;
  path: string[];
  alias: string;
  row: number | null;
  line: number;
  // anchored to the alias, even for a table row
  doc: { text: string; line: number } | null;
  mode: "test" | "test.skip" | "test.only" | "test.todo";
  // files the test needs, relative to it: when one is missing, the test is skipped
  requires: string[];
  options: TestOptions;
  bindings: Binding[];
  body: Statement[];
  // value re-imports of type-only bindings: specifier → `a as a$`…
  imports: Map<string, Set<string>>;
  mocks: ModuleMock[];
};

export const children = (e: Expr): Expr[] => {
  switch (e.kind) {
    case "array":
      return e.elements;
    case "object":
      return e.entries.map(([, value]) => value);
    case "call":
    case "construct":
      return [e.callee, ...e.args];
    case "method":
      return [e.receiver, ...e.args];
    case "index":
      return [e.object];
    case "file":
      return [e.path];
    case "env":
      return e.fallback ? [e.fallback] : [];
    case "snapshot":
      return e.name ? [e.name] : [];
    case "paren":
    case "mocked":
      return [e.inner];
    default:
      return [];
  }
};

export const some = (e: Expr, test: (e: Expr) => boolean): boolean =>
  test(e) || children(e).some((c) => some(c, test));

export const awaits = (e: Expr): boolean =>
  some(e, (n) => (n.kind === "call" || n.kind === "method") && n.awaited);

export const exprsOf = (s: Statement): Expr[] =>
  s.kind === "effect"
    ? [s.expr]
    : [
        s.actual,
        ...(s.expected ? [s.expected] : []),
        ...(s.param ? [s.param] : []),
        ...(s.display?.meta ? [s.display.meta] : []),
      ];
