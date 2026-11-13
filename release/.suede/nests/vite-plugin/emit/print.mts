import { fileURLToPath } from "node:url";

import { DISPLAY } from "../codec.mts";
import { importPath } from "../paths.mts";
import { awaits, children, exprsOf } from "./ir.mts";

import type { Assertion as VitestAssertion } from "vitest";
import type { Line } from "./context.mts";
import type {
  Assertion,
  Binding,
  ConditionName,
  Expr,
  ModuleMock,
  Param,
  Replacement,
  Statement,
  TestCase,
} from "./ir.mts";

import type { Table, Expect, Invoke } from "../../dsl.import.meta.vitest.ts";
import type {
  printAlias,
  printMatcher,
  printStatements,
} from "../../_internal/harness.mts";

const quote = (s: string) => JSON.stringify(s);

const isIdentifier = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name);

const propKey = (name: string) => (isIdentifier(name) ? name : quote(name));

// with `await` or `new` in front, a member access needs parentheses
const needsParens = (e: Expr) =>
  e.kind === "construct" ||
  ((e.kind === "call" || e.kind === "method") && e.awaited);

const receiver = (e: Expr) =>
  needsParens(e) ? `(${printExpr(e)})` : printExpr(e);

const list = (args: Expr[]) => args.map(printExpr).join(", ");

export function printExpr(e: Expr): string {
  switch (e.kind) {
    case "string":
      return quote(e.value);
    case "literal":
      return e.source;
    case "array":
      return `[${list(e.elements)}]`;
    case "object":
      return e.entries.length
        ? `{ ${e.entries.map(([k, v]) => `${propKey(k)}: ${printExpr(v)}`).join(", ")} }`
        : "{}";
    case "name":
      return e.name;
    case "call":
      return `${e.awaited ? "await " : ""}${receiver(e.callee)}(${list(e.args)})`;
    case "construct":
      return `new ${receiver(e.callee)}(${list(e.args)})`;
    case "method":
      return `${e.awaited ? "await " : ""}${receiver(e.receiver)}${member(e.method)}(${list(e.args)})`;
    case "index":
      // `!`: type-level X[0] is never undefined; value-level x[0] may be under noUncheckedIndexedAccess
      return typeof e.key === "number"
        ? `${receiver(e.object)}[${e.key}]!`
        : `${receiver(e.object)}${member(e.key)}`;
    case "file": {
      const url = fileUrl(printExpr(e.path));
      return e.format === "bytes"
        ? `new Uint8Array(readFileSync(${url}))`
        : e.format === "json"
          ? `JSON.parse(readFileSync(${url}, "utf8"))`
          : `readFileSync(${url}, "utf8")`;
    }
    case "env":
      return e.fallback
        ? `(process.env[${quote(e.name)}] ?? ${printExpr(e.fallback)})`
        : `nt_env(${quote(e.name)})`;
    case "snapshot":
      return "undefined"; // only `"="` gives a snapshot a meaning; see `matchers`
    case "paren":
      return `(${printExpr(e.inner)})`;
    case "mocked":
      return `vi.mocked(${printExpr(e.inner)})`;
    case "unsupported":
      return `nt_unsupported(${quote(e.source)})`;
  }
}

// a path relative to the test file, wherever the test runs from
const fileUrl = (path: string) => `new URL(${path}, import.meta.url)`;

const member = (key: string) =>
  isIdentifier(key) ? `.${key}` : `[${quote(key)}]`;

declare namespace printExpr {
  type Call = {
    kind: "call";
    callee: { kind: "name"; name: "f" };
    args: [];
    awaited: true;
  };

  type SyncCall = {
    kind: "call";
    callee: { kind: "name"; name: "f" };
    args: [];
    awaited: false;
  };

  /** a member of an awaited call is read from the awaited value, not the promise */
  export type Members = Table<
    typeof printExpr,
    [
      [
        args: [{ kind: "index"; object: Call; key: "x" }],
        expected: "(await f()).x",
      ],
      [
        args: [{ kind: "index"; object: Call; key: 0 }],
        expected: "(await f())[0]!",
      ],
      [
        args: [{ kind: "index"; object: Call; key: "not-a-name" }],
        expected: '(await f())["not-a-name"]',
      ],
      [
        args: [
          {
            kind: "method";
            receiver: Call;
            method: "m";
            args: [];
            awaited: true;
          },
        ],
        expected: "await (await f()).m()",
      ],
    ]
  >;

  /** a call that returns no promise reads as the call it is: no await, no parentheses */
  export type Synchronous = Table<
    typeof printExpr,
    [
      [args: [SyncCall], expected: "f()"],
      [
        args: [{ kind: "index"; object: SyncCall; key: "x" }],
        expected: "f().x",
      ],
      [
        args: [
          {
            kind: "method";
            receiver: SyncCall;
            method: "m";
            args: [];
            awaited: false;
          },
        ],
        expected: "f().m()",
      ],
      /** one awaited step is enough to parenthesise what follows it */
      [
        args: [
          {
            kind: "method";
            receiver: Call;
            method: "m";
            args: [];
            awaited: false;
          },
        ],
        expected: "(await f()).m()",
      ],
    ]
  >;

  /** a string is quoted as JSON would: the printer never sees escapes */
  export type Strings = Table<
    typeof printExpr,
    [
      [args: [{ kind: "string"; value: "a\\d" }], expected: '"a\\\\d"'],
      [
        args: [
          {
            kind: "object";
            entries: [["b-c", { kind: "literal"; source: "1" }]];
          },
        ],
        expected: '{ "b-c": 1 }',
      ],
      [args: [{ kind: "object"; entries: [] }], expected: "{}"],
    ]
  >;
}

type Callable = (...args: never[]) => unknown;

// a typo cannot get past this
type MatcherName = {
  [K in keyof VitestAssertion & string]-?: VitestAssertion[K] extends Callable
    ? K
    : never;
}[keyof VitestAssertion & string];

// homomorphic, so a tuple of parameters stays a tuple
type Printed<P extends readonly unknown[]> = { [I in keyof P]: string };

type PrintedArgs<K extends MatcherName> = Printed<
  Parameters<Extract<VitestAssertion[K], Callable>>
>;

export type Chain = {
  matcher: string;
  args: string[];
  negated?: boolean;
  // the subject is a thunk that must reject
  rejects?: boolean;
  // asserted on instead of the actual: `"~="`, ordering on non-numbers
  subject?: string;
};

// typed so the printer cannot emit `.toEqul(…)` or forget an expected value
const chain = <K extends MatcherName>(
  matcher: K,
  args: PrintedArgs<K>,
  rest: Omit<Chain, "matcher" | "args"> = {},
): Chain => ({ matcher, args: args as string[], ...rest });

type Operands = { actual: string; expected: string; param: string };

// a matcher on numbers, a plain comparison otherwise
const ordering =
  (
    matcher:
      | "toBeGreaterThan"
      | "toBeGreaterThanOrEqual"
      | "toBeLessThan"
      | "toBeLessThanOrEqual",
    operator: string,
  ) =>
  (a: Assertion, { actual, expected }: Operands): Chain =>
    a.shape === "number"
      ? chain(matcher, [expected])
      : chain("toBe", ["true"], {
          subject: `${actual} ${operator} ${expected}`,
        });

// spelled out because `toSatisfy<E>` does not infer `E`
const collection = (method: "some" | "every") => (_: Assertion, p: Operands) =>
  chain("toSatisfy", [
    `(xs: ArrayLike<any>) => Array.from(xs).${method}(${p.expected})`,
  ]);

const matchers: Record<ConditionName, (a: Assertion, p: Operands) => Chain> = {
  "=": (a, p) =>
    a.expected?.kind === "snapshot"
      ? chain(
          "toMatchSnapshot",
          a.expected.name ? [printExpr(a.expected.name)] : [],
        )
      : chain("toEqual", [p.expected]),
  "!=": (_, p) => chain("toEqual", [p.expected], { negated: true }),
  is: (_, p) => chain("toBe", [p.expected]),
  isNot: (_, p) => chain("toBe", [p.expected], { negated: true }),
  satisfies: (_, p) => chain("toSatisfy", [p.expected]),
  instanceOf: (_, p) => chain("toBeInstanceOf", [p.expected]),
  truthy: () => chain("toBeTruthy", []),
  falsy: () => chain("toBeFalsy", []),
  defined: () => chain("toBeDefined", []),
  undefined: () => chain("toBeUndefined", []),
  throws: (a) => ({ ...throwsChain(a.expected), rejects: rejectsFor(a) }),
  ">": ordering("toBeGreaterThan", ">"),
  ">=": ordering("toBeGreaterThanOrEqual", ">="),
  "<": ordering("toBeLessThan", "<"),
  "<=": ordering("toBeLessThanOrEqual", "<="),
  "~=": (_, p) =>
    chain("toBeLessThanOrEqual", [p.param], {
      subject: `Math.abs(${p.actual} - ${p.expected})`,
    }),
  includes: (_, p) => chain("toContain", [p.expected]),
  excludes: (_, p) => chain("toContain", [p.expected], { negated: true }),
  startsWith: (_, p) =>
    chain("toSatisfy", [`(s: string) => s.startsWith(${p.expected})`]),
  endsWith: (_, p) =>
    chain("toSatisfy", [`(s: string) => s.endsWith(${p.expected})`]),
  matches: (a, p) =>
    a.shape === "string" && a.expected
      ? chain("toMatch", [regex(a.expected)])
      : chain("toMatchObject", [p.expected]),
  some: collection("some"),
  every: collection("every"),
  isEmpty: () => chain("toHaveLength", ["0"]),
  isNotEmpty: () => chain("toHaveLength", ["0"], { negated: true }),
  hasKey: (_, p) => chain("toHaveProperty", [p.expected]),
  lacksKey: (_, p) => chain("toHaveProperty", [p.expected], { negated: true }),
  isNaN: () => chain("toBeNaN", []),
  isInteger: () => chain("toSatisfy", ["Number.isInteger"]),
  isFinite: () => chain("toSatisfy", ["Number.isFinite"]),
};

export const isCondition = (op: string): op is ConditionName =>
  Object.hasOwn(matchers, op);

declare namespace printAssertion {
  type Add = "const add = (a: number, b: number) => a + b;";

  /** what is asserted on, and what it is compared against, each get a name */
  export type Locals = Expect<
    Invoke<
      typeof printStatements,
      [`${Add}type Subject = Expect<Invoke<typeof add, [1, 2]>, "=", 3>;`]
    >,
    "=",
    [
      "const actual = add(1, 2);",
      "const expected = 3;",
      "expect(actual).toEqual(expected);",
    ]
  >;

  /** a value that already has a name keeps it: `const actual = add` says nothing */
  export type Named = Expect<
    Invoke<
      typeof printStatements,
      [`${Add}type Subject = Expect<typeof add, "defined">;`]
    >,
    "=",
    ["expect(add).toBeDefined();"]
  >;

  /** several in one body say which goes with which */
  export type Paired = Expect<
    Invoke<
      typeof printAlias,
      [
        `${Add}declare namespace add {
           export type Both = [Expect<Invoke<typeof add, [1, 1]>, "=", 2>, Expect<Invoke<typeof add, [2, 2]>, "=", 4>];
         }`,
        "Both",
      ]
    >,
    "includes",
    "const actual2 = add(2, 2);\n  const expected2 = 4;\n  expect.soft(actual2).toEqual(expected2);"
  >;

  /** a thunk is not a value to name: `throws` reads as it always has */
  export type Thrown = Expect<
    Invoke<
      typeof printStatements,
      [`${Add}type Subject = Throws<Invoke<typeof add, [1, 1]>>;`]
    >,
    "=",
    ["expect(() => (add(1, 1))).toThrow();"]
  >;
}

const printChain = (c: Chain): string =>
  `${c.rejects ? ".rejects" : ""}${c.negated ? ".not" : ""}.${c.matcher}(${c.args.join(", ")})`;

declare namespace matchers {
  /** every condition, as the matcher it prints */
  export type Conditions = Table<
    typeof printMatcher,
    [
      [
        args: ['type Subject = Expect<"a", "=", "b">;'],
        expected: "expect(actual).toEqual(expected);",
      ],
      [
        args: ['type Subject = Expect<"a", "!=", "b">;'],
        expected: "expect(actual).not.toEqual(expected);",
      ],
      [
        args: ['type Subject = Expect<1, "is", 1>;'],
        expected: "expect(actual).toBe(expected);",
      ],
      [
        args: ['type Subject = Expect<"ab", "includes", "b">;'],
        expected: "expect(actual).toContain(expected);",
      ],
      [
        args: ['type Subject = Expect<[], "isEmpty">;'],
        expected: "expect(actual).toHaveLength(0);",
      ],
      [
        args: ['type Subject = Expect<1, "isInteger">;'],
        expected: "expect(actual).toSatisfy(Number.isInteger);",
      ],
      [
        args: ['type Subject = Expect<2, ">", 1>;'],
        expected: "expect(actual).toBeGreaterThan(expected);",
      ],
      [
        args: ['type Subject = Expect<1, ["~=", 0.5], 1.2>;'],
        expected: "expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.5);",
      ],
      [
        args: ['type Subject = Expect<"x", "matches", "/x+/i">;'],
        expected: "expect(actual).toMatch(/x+/i);",
      ],
      [
        args: ['type Subject = Expect<{ a: 1 }, "matches", { a: 1 }>;'],
        expected: "expect(actual).toMatchObject(expected);",
      ],
      [
        args: ['type Subject = Expect<1, "=", Snapshot<"named">>;'],
        expected: 'expect(actual).toMatchSnapshot("named");',
      ],
      [
        args: ['type Subject = Expect<1, "=", Snapshot>;'],
        expected: "expect(actual).toMatchSnapshot();",
      ],
      /** an ordering condition on something that is not a number compares directly */
      [
        args: ['type Subject = Expect<"b", ">", "a">;'],
        expected: "expect(actual > expected).toBe(true);",
      ],
    ]
  >;
}

// `"/x/i"` is written as a regex; anything else is its source
export const regex = (e: Expr) => {
  const m = e.kind === "string" && /^\/(.*)\/([a-z]*)$/.exec(e.value);
  return m ? `/${m[1]}/${m[2]}` : `new RegExp(${printExpr(e)})`;
};

declare namespace regex {
  /** a "/…/" string is a regex literal; anything else is a source string, escaped once */
  export type Cases = Table<
    typeof regex,
    [
      [
        args: [pattern: { kind: "string"; value: "/a+/gi" }],
        expected: "/a+/gi",
      ],
      [
        args: [pattern: { kind: "string"; value: "^\\d+$" }],
        expected: 'new RegExp("^\\\\d+$")',
      ],
      [
        args: [pattern: { kind: "name"; name: "Pattern" }],
        expected: "new RegExp(Pattern)",
      ],
    ]
  >;
}

// an awaited subject throws by rejecting, and only `.rejects` hands an error to a predicate
const rejectsFor = (a: Assertion) =>
  awaits(a.actual) || throwsChain(a.expected).matcher !== "toThrow";

const throwsChain = (expected: Expr | null): Chain => {
  if (!expected || printExpr(expected) === "undefined")
    return chain("toThrow", []);
  if (expected.kind !== "object")
    return chain("toThrow", [printExpr(expected)]);
  const checks = expected.entries.map(([key, value]) => {
    const v = printExpr(value);
    switch (key) {
      case "instanceOf":
        return `err instanceof ${v}`;
      case "name":
        return `err.name === ${v}`;
      case "message":
        return `String(err.message).includes(${v})`;
      case "matches":
        return `${regex(value)}.test(String(err.message))`;
      default:
        return "false";
    }
  });
  return chain("toSatisfy", [`(err) => ${checks.join(" && ")}`]);
};

// seeded with every name the test refers to, so a local never shadows one
export type Names = { take: (base: string) => string };

export const names = (taken: Iterable<string>): Names => {
  const used = new Set(taken);
  return {
    take(base) {
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base}${n}`;
      used.add(name);
      return name;
    },
  };
};

export const namesIn = (t: TestCase): string[] => {
  const found: string[] = [];
  const walk = (e: Expr): void => {
    if (e.kind === "name") found.push(e.name.split(".")[0]!);
    children(e).forEach(walk);
  };
  for (const b of t.bindings) {
    found.push(b.name);
    b.params?.forEach((p) => found.push(p.name));
    walk(b.value);
  }
  for (const s of t.body) exprsOf(s).forEach(walk);
  return found;
};

// `const actual = Counter$;` says nothing `Counter$` did not
const worthBinding = (code: string) =>
  !isIdentifier(code) && code !== "undefined";

const printActual = (a: Assertion) => {
  const printed = printExpr(a.actual);
  if (a.condition === "throws")
    return `${rejectsFor(a) ? "async " : ""}() => (${printed})`;
  return comparesAsArrays(a) ? `Array.from(${printed})` : printed;
};

const comparesAsArrays = (a: Assertion) =>
  (a.condition === "=" || a.condition === "!=") &&
  a.shape === "typedArray" &&
  a.expected?.kind === "array";

type Bound = { pre: string[]; subject: string; expected: string | null };

const bindOperands = (a: Assertion, scope: Names, nth: string): Bound => {
  const actual = printActual(a);
  const expected = a.expected ? printExpr(a.expected) : null;
  if (a.condition === "throws") return { pre: [], subject: actual, expected };
  const pre: string[] = [];
  const bind = (base: string, value: string) => {
    const name = scope.take(`${base}${nth}`);
    pre.push(`const ${name} = ${value};`);
    return name;
  };
  const subject = worthBinding(actual) ? bind("actual", actual) : actual;
  const bindsExpected =
    expected !== null &&
    a.expected?.kind !== "snapshot" &&
    worthBinding(expected);
  return {
    pre,
    subject,
    expected: bindsExpected ? bind("expected", expected) : expected,
  };
};

const encoded = (key: string, value: string) => `${key}: encode(${value})`;

// encoded in the test: Vitest copies an artifact out of it, and a function or a class would not survive that
const displayStatements = (a: Assertion, { subject, expected }: Bound) => {
  if (!a.display) return [];
  const values = [
    `type: ${quote(DISPLAY)}`,
    `page: ${quote(a.display.page)}`,
    encoded("actual", subject),
    ...(expected !== null && a.expected?.kind !== "snapshot" ? [encoded("expected", expected)] : []),
    ...(a.display.meta ? [encoded("meta", printExpr(a.display.meta))] : []),
  ];
  return [`await recordArtifact(task, { ${values.join(", ")} });`];
};

const expectation = (a: Assertion, c: Chain, subject: string) => {
  const statement = `${a.soft ? "expect.soft" : "expect"}(${c.subject ?? subject})${printChain(c)};`;
  return c.rejects ? `await ${statement}` : statement;
};

// `actual2` pairs with `expected2`
export function printAssertion(
  a: Assertion,
  scope = names([]),
  nth = "",
): string[] {
  const operands = bindOperands(a, scope, nth);
  const chain = matchers[a.condition](a, {
    actual: operands.subject,
    expected: operands.expected ?? "undefined",
    param: a.param ? printExpr(a.param) : "undefined",
  });
  return [
    ...operands.pre,
    ...displayStatements(a, operands),
    expectation(a, chain, operands.subject),
  ];
}

export const printStatement = (
  s: Statement,
  scope = names([]),
  nth = "",
): string[] =>
  s.kind === "effect"
    ? [`${printExpr(s.expr)};`]
    : printAssertion(s, scope, nth);

// one scope across the body; ordinals only when there are several to tell apart
export function printBody(body: Statement[], scope = names([])): string[][] {
  const assertions = body.filter((s) => s.kind === "assert").length;
  let asserted = 0;
  return body.map((s) =>
    printStatement(
      s,
      scope,
      // counted over assertions alone: the effects of a `Given` are not ones,
      // and `actual3` for the first thing asserted reads as a bug
      s.kind === "assert" && assertions > 1 ? `${++asserted}` : "",
    ),
  );
}

const printParam = (p: Param) =>
  `${p.name}: ${p.type}${p.fallback ? ` = ${printExpr(p.fallback)}` : ""}`;

const printBinding = (b: Binding) =>
  b.params
    ? // an object literal as an arrow's body reads as a block: parenthesise it
      `const ${b.name} = ${awaits(b.value) ? "async " : ""}(${b.params.map(printParam).join(", ")}) => ${b.value.kind === "object" ? `(${printExpr(b.value)})` : printExpr(b.value)};`
    : `const ${b.name}${b.annotation ? `: ${b.annotation}` : ""} = ${printExpr(b.value)};`;

export type Needs = {
  /** `readFileSync`, for `FromFile`. */
  fs: boolean;
  /** `existsSync`, for `SkipIfNotFound`. */
  exists: boolean;
  /** `nt_env`, for an `Env` with no default. */
  env: boolean;
  /** `recordArtifact`, `encode` and the `{ task }` parameter, for a display page. */
  task: boolean;
  /** `nt_unsupported`, for what could not be materialised. */
  unsupported: boolean;
  /** `vi`, for a `Mock` or a `Mocked`. */
  vi: boolean;
  /** Value re-imports of type-only bindings: specifier → `a as a$`… */
  imports: Map<string, Set<string>>;
};

// a skipped or planned test never runs, so it has nothing to check
const checksFiles = ({ mode, requires }: TestCase) =>
  requires.length > 0 && (mode === "test" || mode === "test.only");

// recording what a page shows is asynchronous, so the test is too
const showsOnPage = (s: Statement) => s.kind === "assert" && !!s.display;

export function needsOf(t: TestCase): Needs {
  const needs: Needs = {
    fs: false,
    exists: checksFiles(t),
    env: false,
    task: t.body.some(showsOnPage),
    unsupported: false,
    vi: t.mocks.length > 0,
    imports: t.imports,
  };
  const visit = (e: Expr): void => {
    if (e.kind === "file") needs.fs = true;
    else if (e.kind === "env" && !e.fallback) needs.env = true;
    else if (e.kind === "unsupported") needs.unsupported = true;
    else if (e.kind === "mocked") needs.vi = true;
    children(e).forEach(visit);
  };
  t.bindings.forEach((b) => {
    b.params?.forEach((p) => p.fallback && visit(p.fallback));
    visit(b.value);
  });
  t.body.flatMap(exprsOf).forEach(visit);
  return needs;
}

export function allNeeds(needs: Needs[]): Needs {
  const imports = new Map<string, Set<string>>();
  for (const n of needs)
    for (const [spec, names] of n.imports)
      imports.set(spec, new Set([...(imports.get(spec) ?? []), ...names]));
  return {
    fs: needs.some((n) => n.fs),
    exists: needs.some((n) => n.exists),
    env: needs.some((n) => n.env),
    task: needs.some((n) => n.task),
    unsupported: needs.some((n) => n.unsupported),
    vi: needs.some((n) => n.vi),
    imports,
  };
}

export type EmittedTest = TestCase & {
  lines: Line[];
  code: string;
  needs: Needs;
};

// `.rejects` is awaited however its subject was written
const statementAwaits = (s: Statement) =>
  exprsOf(s).some(awaits) ||
  showsOnPage(s) ||
  (s.kind === "assert" && s.condition === "throws" && rejectsFor(s));

// a generic alias that awaits is an async arrow of its own, so it does not count
const isAsync = (t: TestCase) =>
  t.bindings.some((b) => !b.params && awaits(b.value)) ||
  t.body.some(statementAwaits);

// a factory is handed importOriginal; a module object is the replacement itself
const replacementFactory = ({ from, name, factory }: Replacement) => {
  const replacement = `(await import(${quote(from)}))${member(name)}`;
  return factory
    ? `async (importOriginal) => ${replacement}(importOriginal)`
    : `async () => ${replacement}`;
};

// `import()` rather than a string, so the plugin gives it the test's own copy of the module
export const printMock = ({ path, replacement }: ModuleMock) =>
  `vi.mock(import(${quote(path)})${replacement ? `, ${replacementFactory(replacement)}` : ""});`;

declare namespace printMock {
  /** a mock with no replacement, one with a module object, and one with a factory */
  export type Shapes = Table<
    typeof printMock,
    [
      [
        args: [{ path: "./rates.ts"; replacement: null; line: 0 }],
        expected: 'vi.mock(import("./rates.ts"));',
      ],
      [
        args: [
          {
            path: "./rates.ts";
            replacement: {
              from: "./fakes.ts";
              name: "fakeRates";
              factory: false;
            };
            line: 0;
          },
        ],
        expected: 'vi.mock(import("./rates.ts"), async () => (await import("./fakes.ts")).fakeRates);',
      ],
      [
        args: [
          {
            path: "./rates.ts";
            replacement: { from: "./fakes.ts"; name: "default"; factory: true };
            line: 0;
          },
        ],
        expected: 'vi.mock(import("./rates.ts"), async (importOriginal) => (await import("./fakes.ts")).default(importOriginal));',
      ],
    ]
  >;
}

const anyMissing = (paths: string[]) =>
  paths.map((path) => `!existsSync(${fileUrl(quote(path))})`).join(" || ");

// a test that needs a missing file is skipped, whatever it would otherwise have been
const testFunction = (t: TestCase) => {
  if (!checksFiles(t)) return t.mode;
  return t.mode === "test"
    ? `test.skipIf(${anyMissing(t.requires)})`
    : `(${anyMissing(t.requires)} ? test.skip : ${t.mode})`;
};

export function printTest(t: TestCase): EmittedTest {
  const needs = needsOf(t);
  const scope = names(namesIn(t));
  const doc: Line[] = t.doc
    ? [{ code: `/** ${t.doc.text.replace(/\n/g, " ")} */`, line: t.doc.line }]
    : [];
  const mocks: Line[] = t.mocks.map((mock) => ({
    code: printMock(mock),
    line: mock.line,
  }));
  const lines: Line[] =
    t.mode === "test.todo"
      ? [...doc, { code: `test.todo(${quote(t.name)});`, line: t.line }]
      : [
          ...mocks,
          ...doc,
          {
            code: `${testFunction(t)}(${quote(t.name)}${Object.keys(t.options).length ? `, ${JSON.stringify(t.options)}` : ""}, ${isAsync(t) ? "async " : ""}(${needs.task ? "{ task }" : ""}) => {`,
            line: t.line,
          },
          ...t.bindings.map((b) => ({
            code: `  ${printBinding(b)}`,
            line: b.line,
          })),
          ...printBody(t.body, scope).flatMap((lines, index) =>
            lines.map((code) => ({
              code: `  ${code}`,
              line: t.body[index]!.line,
            })),
          ),
          { code: `});`, line: t.line },
        ];
  return { ...t, lines, code: lines.map((l) => l.code).join("\n"), needs };
}

const CODEC = fileURLToPath(new URL("../codec.mts", import.meta.url));

const vitestImports = (needs: Needs) =>
  ["test", "expect", needs.vi && "vi", needs.task && "recordArtifact"].filter(Boolean).join(", ");

// `file` is the module the tests are printed from; they are served, and extracted, beside it
export function headerLines(needs: Needs, file: string): string[] {
  const valueImport = (n: string, spec: string) =>
    `import ${n} from ${quote(spec)}; // value import: the original import is type-only`;
  const lines = [
    `// ───────── generated by namespace-tests; not part of your build ─────────`,
    `import { ${vitestImports(needs)} } from "vitest";`,
    needs.task && `import { encode } from ${quote(importPath(file, CODEC))};`,
    (needs.exists || needs.fs) &&
      `import { ${[needs.exists && "existsSync", needs.fs && "readFileSync"].filter(Boolean).join(", ")} } from "node:fs";`,
    ...[...needs.imports].flatMap(([spec, names]) => {
      const namespace = [...names].filter((n) => n.startsWith("* as "));
      const named = [...names].filter((n) => !n.startsWith("* as "));
      return [
        ...namespace.map((n) => valueImport(n, spec)),
        named.length > 0 && valueImport(`{ ${named.join(", ")} }`, spec),
      ];
    }),
    needs.unsupported &&
      "const nt_unsupported = (t: string) => { throw new Error(`namespace-tests: cannot materialize \\`${t}\\``); };",
    needs.env &&
      "const nt_env = (n: string) => { if (process.env[n] === undefined) throw new Error(`namespace-tests: env var ${n} is not set`); return process.env[n]!; };",
  ];
  return lines.filter((l): l is string => typeof l === "string");
}

declare namespace testFunction {
  type Suite = `
    const one = () => 1;
    declare namespace one {
      export type Focused = Only<SkipIfNotFound<"./absent.json", Expect<Invoke<typeof one>, "=", 1>>>;
      export type Rows = SkipIfNotFound<"./absent.json", Table<typeof one, [[args: [], expected: 1]]>>;
      export type Skipped = Skip<SkipIfNotFound<"./absent.json", Expect<Invoke<typeof one>, "=", 1>>>;
    }
  `;

  /** a test that needs a missing file is skipped, and otherwise keeps its mode */
  export type OnlyStaysOnly = Expect<
    Invoke<typeof printAlias, [Suite, "Focused"]>,
    "includes",
    '(!existsSync(new URL("./absent.json", import.meta.url)) ? test.skip : test.only)("one > Focused"'
  >;

  /** every row of a table checks for the file */
  export type EveryRow = Expect<
    Invoke<typeof printAlias, [Suite, "Rows"]>,
    "startsWith",
    'test.skipIf(!existsSync(new URL("./absent.json", import.meta.url)))("one > Rows[0]"'
  >;

  /** a test already skipped checks for nothing */
  export type SkippedChecksNothing = Expect<Invoke<typeof printAlias, [Suite, "Skipped"]>, "startsWith", 'test.skip("one > Skipped"'>;
}
