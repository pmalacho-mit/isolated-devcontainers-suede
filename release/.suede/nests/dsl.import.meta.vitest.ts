/**
 * authoring DSL
 *
 * Every export in this file is a *type*. Nothing here survives transpilation.
 * Tests are written as type aliases inside `declare namespace Tests { ... }`
 * blocks that live next to the code they exercise:
 *
 * ```ts
 * const add = (a: number, b: number) => a + b;
 *
 * declare namespace add {
 *   /** 4 + 5 is 9 *\/
 *   export type Simple = Expect<Invoke<typeof add, [a: 4, b: 5]>, "=", 9>;
 * }
 * ```
 *
 * The type checker gives you *shape* checking for free (you cannot expect a
 * string from a function that returns a number, or pass three arguments to a
 * two-argument function). The namespace-tests plugin then *evaluates* the
 * type-level program to check the actual *values*.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Conventions
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 1. Use `declare namespace`. It is ambient, so it is erased by tsc, esbuild,
 *    swc, and Node's `--experimental-strip-types`, and it passes
 *    `erasableSyntaxOnly`, `isolatedModules` and `verbatimModuleSyntax`.
 *
 * 2. `export` every test alias. Non-exported aliases trip `noUnusedLocals`.
 *    Because exported members merge across namespace blocks, scope tests to
 *    their subject with a dotted name: `declare namespace add { ... }`.
 *    Each test is emitted on its own, named for the dotted path it was
 *    written in (`add > Simple`).
 *
 * 3. JSDoc on a test alias becomes its human-readable description.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Evaluation model (what the plugin does with these types)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * The plugin is a *printer*: it walks the syntax of each test alias (not its
 * resolved type, so it sees intent — `Invoke<...>` — rather than result —
 * `number`) and prints ordinary Vitest code, which Vitest then runs. Type
 * literals print as the equivalent value literals; DSL nodes print as calls
 * and `expect` matchers. See vite-plugin/emit/. The rules:
 *
 * - **Literals materialize to themselves.** `4`, `"olivia"`, `true`, `null`,
 *   `undefined`, `10n`, `-1`, tuples `[1, 2]` and object literals
 *   `{ name: "parker" }` become the corresponding JavaScript values.
 *   Non-literal types (`number`, `string[]`, unions, interfaces) are not values
 *   and are reported as authoring errors at their source location.
 *
 * - **`typeof x` materializes to the value `x`** — a function, class, const or
 *   `obj.method` (called with `obj` as `this`) from the module under test or
 *   anything it imports. Exported or not.
 *
 * - **A named type alias is a variable; an inline expression is not.**
 *   Within one test run every alias is evaluated at most once and its value is
 *   cached, so two references to `type Container = { name: "parker" }` are the
 *   *same object*. That is what lets you observe a mutation:
 *
 *   ```ts
 *   export type Rename = Given<
 *     Invoke<typeof setName, [container: Container, name: "olivia"]>,   // mutates the object…
 *     Expect<Container["name"], "=", "olivia">         // …that this reads.
 *   >;
 *   ```
 *   An inline `Invoke<...>` written twice runs twice.
 *
 * - **Each test is isolated.** The alias cache is discarded between tests, so
 *   `Container` above is a fresh object for every test that mentions it.
 *
 * - **Only referenced aliases are evaluated, in dependency order.** Each test
 *   becomes an ordinary test function whose first statements are `const`
 *   bindings for the aliases it (transitively) references, followed by the
 *   effects and assertions in source order. Generic aliases
 *   (`type Parsed<S> = Invoke<typeof parse, [source: S]>`) become functions.
 *
 * - **Indexed access reads a property.** `Result["name"]`, `Bytes["length"]`,
 *   `Rows[0]["id"]` read the property from the materialized value.
 *
 * - **Promises are awaited, and nothing else is.** `Invoke` and `Call` await
 *   what they evaluate to when the function or method returns something
 *   thenable — and print the plain call when it does not. So a test over
 *   synchronous code is a synchronous test, and reads as one:
 *
 *   ```ts
 *   test("slugify > Basic", () => {
 *     expect(slugify("Hello, World!")).toEqual("hello-world");
 *   });
 *   ```
 *
 *   A function typed as returning `any` is taken at its word: nothing there
 *   says a promise is coming, so nothing is awaited. Type it as returning a
 *   promise and it will be.
 */

import type { MockedFunction } from "vitest";

// ═══════════════════════════════════════════════════════════════════════════
// Brands
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What the DSL is built from rather than what a test is written with. Every
 * block of it sits beside the public type it serves; hover text shows its
 * names as `Internal.…`.
 */
export declare namespace Internal {
  const NT: unique symbol;

  /** Marker so the printer (and hover text) can identify DSL nodes by name. */
  interface Node<Kind extends string> {
    /** @hidden */
    readonly [NT]: Kind;
  }

  type AnyFn = (...args: any[]) => any;

  type AnyCtor = abstract new (...args: any[]) => any;

  /**
   * `T & never` is eagerly `never`, and `X | never` is `X`, so `X | Phantom<T>` is
   * exactly `X` — but it "uses" `T`, which keeps parameters that exist purely
   * for the printer (`Args`, `Path`, …) from tripping `noUnusedParameters`.
   */
  type Phantom<T> = T & never;
}

// ═══════════════════════════════════════════════════════════════════════════
// Expressions — types that evaluate to a value
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Call a function with literal arguments. Evaluates to the (awaited) return type.
 *
 * **STRONGLY RECOMMENDED** to use named tuples on `Args` for clarity.
 * `Args` can be left out when no parameter is required.
 *
 * ```ts
 * type Sum = Invoke<typeof add, [a: 4, b: 5]>;               // number  ⇒ 9 at runtime
 * type Name = Invoke<typeof user.getName>;           // `this` is `user`; no arguments, no tuple
 * type Doubled = Invoke<typeof map, [arr: [1, 2], fn: typeof double]>; // functions are literals too
 *
 * export type Simple = Expect<Invoke<typeof add, [a: 4, b: 5]>, "=", 9>;
 * ```
 */
export type Invoke<
  F extends Internal.CalleeFor<Args>,
  Args extends Internal.ArgumentsOf<F> | [] = [],
> = Awaited<Internal.ReturnFor<F, Args>> | Internal.Phantom<Args>;

export declare namespace Internal {
  /**
   * Every call signature a function type has, as its parameters paired with what
   * it returns.
   *
   * `Parameters<F>` and `ReturnType<F>` see only the *last* overload, so
   * `Invoke<typeof s.replace, [searchValue: ",", replaceValue: ";"]>` would be rejected for not being the
   * replacer-function form. Matching the overload list instead means any
   * spelling the function actually accepts is accepted here — up to four
   * overloads, which covers the standard library.
   */
  type Signatures<T> = T extends {
    (...a: infer A1): infer R1;
    (...a: infer A2): infer R2;
    (...a: infer A3): infer R3;
    (...a: infer A4): infer R4;
  }
    ? [A1, R1] | [A2, R2] | [A3, R3] | [A4, R4]
    : T extends {
          (...a: infer A1): infer R1;
          (...a: infer A2): infer R2;
          (...a: infer A3): infer R3;
        }
      ? [A1, R1] | [A2, R2] | [A3, R3]
      : T extends { (...a: infer A1): infer R1; (...a: infer A2): infer R2 }
        ? [A1, R1] | [A2, R2]
        : T extends (...a: infer A) => infer R
          ? [A, R]
          : never;

  /**
   * What a callee must be for `Args`: omitting them, or passing `[]`, is only
   * allowed of a callee that has no required parameters.
   */
  type CalleeFor<Args> = [] extends Args ? () => unknown : AnyFn;

  /** `CalleeFor`, for a class. */
  type ConstructorFor<Args> = [] extends Args ? abstract new () => unknown : AnyCtor;

  /** The arguments any of a function's overloads takes. */
  type ArgumentsOf<T> = Signatures<T>[0];

  /** What the overload that accepts `Args` returns. */
  type ReturnFor<T, Args> =
    Signatures<T> extends infer Signature
      ? Signature extends [infer Params, infer Result]
        ? Args extends Params
          ? Result
          : never
        : never
      : never;
}

/**
 * Instantiate a class with literal arguments. Evaluates to the instance type.
 * Bind it to an alias to keep a handle on the instance:
 *
 * **STRONGLY RECOMMENDED** to use named tuples on `Args` for clarity.
 * `Args` can be left out when no parameter is required.
 *
 * ```ts
 * type Counter = Construct<typeof Counter, [start: 10]>;
 *
 * export type StartsAt = Expect<Counter["count"], "=", 10>;
 * ```
 */
export type Construct<
  C extends Internal.ConstructorFor<Args>,
  Args extends ConstructorParameters<C> | [] = [],
> = InstanceType<C> | Internal.Phantom<Args>;

/**
 * Call a method on a materialized value (typically a `Construct` alias or a
 * `Fixture`). Evaluates to the (awaited) return type of the method.
 *
 * **STRONGLY RECOMMENDED** to use named tuples on `Args` for clarity.
 * `Args` can be left out when no parameter is required.
 *
 * ```ts
 * type Counter = Construct<typeof Counter, [start: 10]>;
 * type Stored = Call<Store, "put", [key: "k", value: 1]>;
 *
 * export type Increments = Given<
 *   Call<Counter, "increment">,
 *   Expect<Counter["count"], "=", 11>
 * >;
 * ```
 */
export type Call<
  Receiver,
  Method extends Internal.MethodsCallableWith<Receiver, Args>,
  Args extends Internal.ArgumentsOf<Receiver[Method]> | [] = [],
> =
  | Awaited<Internal.ReturnFor<Receiver[Method], Args>>
  | Internal.Phantom<Args>;

export declare namespace Internal {
  type MethodsCallableWith<T, Args> = {
    [K in keyof T]-?: T[K] extends CalleeFor<Args> ? K : never;
  }[keyof T] &
    string;
}

/**
 * A typed fixture: declares the *type* the rest of the test sees and the
 * literal *initial value* the test materializes. Solves the problem that a
 * literal `{ name: "parker" }` has type `{ name: "parker" }`, which would
 * reject an expectation of `"olivia"` after a mutation.
 *
 * ```ts
 * type Container = Fixture<{ name: string }, { name: "parker" }>;
 *
 * export type Rename = Given<
 *   Invoke<typeof setName, [container: Container, name: "olivia"]>,
 *   Expect<Container["name"], "=", "olivia">
 * >;
 * ```
 *
 * Prefer this over `Widen` when you know the intended shape.
 */
export type Fixture<T, Initial extends T & Internal.Literal> =
  | T
  | Internal.Phantom<Initial>;

export declare namespace Internal {
  /** The set of JavaScript values that can be written as a TypeScript literal type. */
  type Literal =
    | string
    | number
    | boolean
    | bigint
    | null
    | undefined
    | AnyFn // only as `typeof fn` — an arbitrary function type cannot be materialized
    | readonly Literal[]
    | { readonly [key: string]: Literal };
}

/**
 * Widen literal types to their primitive base (`"parker"` → `string`,
 * `[1, 2]` → `number[]`) while the test still materializes the literal.
 * Handy when a fixture's shape is obvious and you don't want to spell it out.
 *
 * ```ts
 * type Sample = Widen<[2, 4, 4, 4, 5, 5, 7, 9]>; // number[], materialized as written
 *
 * export type Mean = Expect<Invoke<typeof mean, [xs: Sample]>, "=", 5>;
 * ```
 */
export type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends bigint
        ? bigint
        : T extends symbol
          ? symbol
          : T extends readonly (infer U)[]
            ? Widen<U>[]
            : T extends object
              ? { -readonly [K in keyof T]: Widen<T[K]> }
              : T;

/**
 * Load a file relative to the test file at runtime.
 *
 * ```ts
 * type Png = FromFile<"./fixtures/logo.png", "bytes">;      // Uint8Array
 * type Csv = FromFile<"./fixtures/rows.csv">;                // string
 * type Cfg = FromFile<"./fixtures/config.json", "json", AppConfig>;
 *
 * export type Parses = Expect<Invoke<typeof parseCsv, [text: Csv]>, "isNotEmpty">;
 * ```
 */
export type FromFile<
  Path extends string,
  Format extends Internal.FileFormat = "text",
  Json = unknown,
> =
  | (Format extends "text"
      ? string
      : Format extends "bytes"
        ? Uint8Array
        : Json)
  | Internal.Phantom<Path>;

export declare namespace Internal {
  /** How a file's contents are decoded by `FromFile`. */
  type FileFormat = "text" | "bytes" | "json";
}

/**
 * Read an environment variable at runtime. Evaluates to `string`, or to
 * `Default` when the variable is unset. Tests that read an unset variable
 * with no default fail with a clear message.
 *
 * ```ts
 * type Domain = Env<"TEST_EMAIL_DOMAIN", "example.com">;
 *
 * export type Invites = Expect<Invoke<typeof inviteAddress, [user: "ada", domain: Domain]>, "endsWith", "example.com">;
 * ```
 */
export type Env<
  Name extends string,
  Default extends string | undefined = undefined,
> = string | Default | Internal.Phantom<Name>;

// ═══════════════════════════════════════════════════════════════════════════
// Expectations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A stored expected value. On first run the test writes the actual value to
 * `__snapshots__/<file>.<TestName>[.<Name>].snap` next to the test file; on
 * later runs it compares against that file. Updating snapshots is a runner
 * command, not a code change.
 *
 * ```ts
 * export type Renders = Expect<Invoke<typeof render, [tree: Tree]>, "=", Snapshot>;
 * export type Both = [
 *   Expect<Invoke<typeof render, [tree: Tree]>, "=", Snapshot<"html">>,
 *   Expect<Invoke<typeof toText, [tree: Tree]>, "=", Snapshot<"text">>,
 * ];
 * ```
 */
export type Snapshot<Name extends string = ""> = Internal.SnapshotNode<Name>;

export declare namespace Internal {
  interface SnapshotNode<Name extends string> extends Node<"snapshot"> {
    readonly name: Name;
  }
}

/**
 * No expected value: what a condition like `"truthy"` or `"throws"` takes. Written
 * out only to reach the argument after it, a display page or a config.
 *
 * ```ts
 * export type Ready = Expect<Invoke<typeof isReady>, "truthy", Nothing, { timeout: 50 }>;
 * ```
 */
export type Nothing = Internal.NothingNode;

export declare namespace Internal {
  interface NothingNode extends Node<"nothing"> {}
}

/**
 * The core assertion.
 *
 * ```ts
 * Expect<Invoke<typeof add, [a: 4, b: 5]>, "=", 9>
 * Expect<Invoke<typeof greet, [name: "Ada"]>, "startsWith", "Hello">
 * Expect<Invoke<typeof sqrt, [x: 2]>, ["~=", 1e-12], 1.4142135623730951>
 * Expect<Invoke<typeof parse, [source: "{"]>, "throws", SyntaxError>
 * Expect<Invoke<typeof list>, "isEmpty">
 * Expect<Pixels, "=", ExpectedPixels, "./display-image.html">
 * ```
 *
 * `Expected` is constrained by `Actual` and `Condition` together, so mismatched
 * shapes are compile errors — the IDE tells you before the test runs.
 */
export type Expect<
  Actual,
  Condition extends Internal.ConditionsFor<Actual>,
  Expected extends
    | Internal.ExpectedFor<Actual, Condition>
    | Snapshot<any>
    | Nothing = Nothing,
  DisplayOrConfig extends undefined | Internal.DisplayPage | Internal.Config =
    undefined,
> = Expected extends Nothing
  ? Condition extends Internal.NullaryCondition | "throws"
    ? Internal.Assertion<Actual, Condition, Expected, DisplayOrConfig>
    : Internal.MissingExpected<Condition>
  : Internal.Assertion<Actual, Condition, Expected, DisplayOrConfig>;

export declare namespace Internal {
  /** Conditions that apply to any value. */
  type UniversalCondition =
    | "=" // deep structural equality (Object.is for primitives, element-wise for arrays/typed arrays, key-wise for objects)
    | "!=" // negation of "="
    | "is" // reference identity (Object.is), useful with aliases: Expect<Call<B, "self">, "is", B>
    | "isNot"
    | "satisfies" // Expected is `typeof predicate`; passes when predicate(actual) is truthy
    | "instanceOf" // Expected is `typeof SomeClass`
    | "truthy"
    | "falsy"
    | "defined" // !== undefined
    | "undefined"
    | "throws"; // the expression threw / rejected. Expected is optional: `typeof ErrorClass`, a message substring, or a matcher object

  /** Ordering conditions; valid for numbers, bigints, strings and Dates. */
  type OrderingCondition = ">" | ">=" | "<" | "<=";

  /** Approximate equality with an absolute tolerance: `["~=", 1e-9]`. */
  type ApproxCondition = readonly ["~=", number];

  /** Conditions valid on strings. */
  type StringCondition =
    | "includes"
    | "excludes"
    | "startsWith"
    | "endsWith"
    | "matches" // Expected is a regular-expression source string, e.g. "^[a-z]+$" or "/^[a-z]+$/i"
    | "isEmpty"
    | "isNotEmpty";

  /** Conditions valid on arrays and typed arrays. */
  type ArrayCondition =
    | "includes" // element (deep equality)
    | "excludes"
    | "matches" // Expected is a deep-partial of each element, in order, same length
    | "some" // Expected is `typeof predicate`
    | "every"
    | "isEmpty"
    | "isNotEmpty";

  /** Conditions valid on plain objects. */
  type ObjectCondition =
    | "matches" // Expected is a deep-partial of Actual: only listed keys are compared
    | "hasKey"
    | "lacksKey";

  /** Conditions valid on numbers. */
  type NumberCondition = "isNaN" | "isInteger" | "isFinite";

  /** All conditions applicable to a value of type `T`. */
  type ConditionsFor<T> =
    | UniversalCondition
    | (T extends number
        ? OrderingCondition | ApproxCondition | NumberCondition
        : never)
    | (T extends bigint | Date ? OrderingCondition : never)
    | (T extends string ? OrderingCondition | StringCondition : never)
    | (T extends readonly unknown[] | ArrayBufferView ? ArrayCondition : never)
    // A Set is a collection, not a bag of properties: `toContain` and
    // `toHaveLength` both understand one.
    | (T extends ReadonlySet<unknown> ? ArrayCondition : never)
    // A Map understands `toHaveLength`, but not `toContain` — ask about a key
    // with `Call<M, "has", [key: k]>`.
    | (T extends ReadonlyMap<unknown, unknown>
        ? "isEmpty" | "isNotEmpty"
        : never)
    | (T extends object
        ? T extends readonly unknown[] | AnyFn
          ? never
          : ObjectCondition
        : never);

  /** Conditions that take no expected value. */
  type NullaryCondition =
    | "truthy"
    | "falsy"
    | "defined"
    | "undefined"
    | "isEmpty"
    | "isNotEmpty"
    | "isNaN"
    | "isInteger"
    | "isFinite";

  /**
   * Every key optional, at any depth — but a list stays a list. Mapping over a
   * tuple keeps it a tuple, so an expected list written for a tuple actual is
   * checked position by position, which is how `toMatchObject` compares them:
   * element-wise, same length, in order.
   *
   * A plain array is written as `readonly DeepPartial<Element>[]` rather than
   * mapped over. The compiler defers an array of an alias but expands a mapped
   * array eagerly, and on a recursive type (a JSON value, say) that expansion
   * never bottoms out ("type instantiation is excessively deep"). The tuple test
   * is type-fest's: an array of the element type is assignable to a plain array
   * and never to a tuple, whatever its optional or rest elements. `readonly`
   * because this is only ever the type of an *expected* value, and a readonly
   * target accepts a readonly or a mutable literal alike.
   *
   * A function is left as it is: a mapped type would keep its properties and
   * drop its call signature, so `{ onClick: () => void }` would accept anything.
   */
  type DeepPartial<T> = T extends (...args: any[]) => unknown
    ? T
    : T extends readonly (infer Element)[]
      ? Element[] extends T
        ? readonly DeepPartial<Element>[]
        : { [Index in keyof T]: DeepPartial<T[Index]> }
      : T extends object
        ? { [K in keyof T]?: DeepPartial<T[K]> }
        : T;

  type ElementOf<T> = T extends readonly (infer U)[]
    ? U
    : T extends ReadonlySet<infer U>
      ? U
      : T extends string
        ? string
        : T extends { [n: number]: infer U }
          ? U
          : never;

  /**
   * Typed arrays may be compared against plain tuples/arrays of their element type,
   * so `Expect<Uint32Array, "=", [1, 2, 3]>` type-checks.
   */
  type Equatable<T> =
    | T
    | (T extends { [n: number]: infer E; readonly length: number }
        ? readonly E[]
        : never);

  /**
   * A class written as a value (`typeof RangeError`) or, for error classes, as a
   * type (`RangeError`). The printer resolves either spelling to the constructor.
   * For `"instanceOf"` on non-error classes the actual's own instance type is
   * also accepted: `Expect<Repo, "instanceOf", UserRepository>`.
   */
  type ClassRef = AnyCtor | Error;

  /** Shape the expected value must have for a given (Actual, Condition) pair. */
  type ExpectedFor<Actual, Condition> = Condition extends NullaryCondition
    ? Nothing
    : Condition extends "=" | "!=" | "is" | "isNot"
      ? Equatable<Actual>
      : Condition extends OrderingCondition
        ? Actual
        : Condition extends ApproxCondition
          ? number
          : Condition extends "includes" | "excludes"
            ? ElementOf<Actual>
            : Condition extends "startsWith" | "endsWith"
              ? string
              : Condition extends "matches"
                ? Actual extends string
                  ? string
                  : DeepPartial<Actual>
                : Condition extends "some" | "every"
                  ? (element: ElementOf<Actual>, index: number) => boolean
                  : Condition extends "satisfies"
                    ? (actual: Actual) => boolean
                    : Condition extends "instanceOf"
                      ? ClassRef | (Actual extends object ? Actual : never)
                      : Condition extends "hasKey" | "lacksKey"
                        ? keyof Actual & string
                        : Condition extends "throws"
                          ? Nothing | ClassRef | string | ThrowsMatcher
                          : never;

  /** Object form of a `"throws"` expectation. All fields optional; all listed fields must match. */
  interface ThrowsMatcher {
    readonly instanceOf?: ClassRef;
    readonly name?: string;
    readonly message?: string; // substring
    readonly matches?: string; // regex source
  }

  /** The page is loaded relative to the test file. */
  type DisplayPage = `${string}.html`;

  type Config = Partial<{
    /** Custom HTML page used to render this result in the IDE's webview. */
    display: DisplayPage;
    /** Where the module under test is evaluated. Default: "node". */
    environment: "node" | "browser";
    /** Per-test timeout in milliseconds. Default: 5000. */
    timeout: number;
    /** Working directory for relative paths and `FromFile`. Default: the test file's directory. */
    cwd: string;
    /** Re-run a failing test this many times before reporting failure. Default: 0. */
    retries: number;
    /** Extra literal data forwarded to the display page as `meta` (e.g. an image's width). */
    displayMeta: { readonly [key: string]: Literal };
  }>;

  /** The evaluated result of `Expect`. You'll see this in hover text. */
  interface Assertion<
    Actual,
    Condition,
    Expected,
    DisplayOrConfig,
  > extends Node<"assertion"> {
    readonly actual: Actual;
    readonly condition: Condition;
    readonly expected: Expected;
    readonly config: DisplayOrConfig;
  }

  /**
   * What `Expect<X, "=">` evaluates to: the expected value was omitted for a
   * condition that needs one. This is deliberately *not* a `Test`, so it is a
   * compile error inside `Given`, `Skip`, `Only`, `Configure` or a `Table`, is
   * obvious in hover text, and is reported by the runner as an authoring error.
   * (TypeScript cannot reject an omitted type argument at the use site, so the
   * mistake is surfaced in the result type instead.)
   */
  interface MissingExpected<Condition> extends Node<"error"> {
    readonly error: "an expected value is required for this condition";
    readonly condition: Condition;
  }
}

/**
 * Shorthand for `Expect<Expr, "throws", Matcher>`. The matcher is optional: an
 * error class, a message substring, or an object of the fields that must match.
 *
 * ```ts
 * export type Errors = [
 *   Throws<Invoke<typeof parse, [source: "(1 + 2"]>, ParseError>,
 *   Throws<Invoke<typeof parse, [source: "1 +"]>, { instanceOf: ParseError; matches: "unexpected .*end of input" }>,
 *   Throws<Invoke<typeof parse, [source: "1 2"]>, "trailing">,
 *   Throws<Invoke<typeof parse, [source: ""]>>, // any throw at all
 * ];
 * ```
 */
export type Throws<
  Expr,
  Matcher extends Internal.ExpectedFor<Expr, "throws"> = Nothing,
> = Internal.Assertion<Expr, "throws", Matcher, undefined>;

// ═══════════════════════════════════════════════════════════════════════════
// Composition
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run `Effects` (an expression, or a tuple of expressions, evaluated in order
 * purely for their side effects), then evaluate `Then`.
 *
 * ```ts
 * export type Rename = Given<
 *   Invoke<typeof setName, [container: Container, name: "olivia"]>,
 *   Expect<Container["name"], "=", "olivia">
 * >;
 *
 * export type Lifecycle = Given<
 *   [
 *      Call<Store, "open">,
 *      Call<Store, "put", [key: "k", value: 1]>
 *   ],
 *   [
 *      Expect<Call<Store, "get", [key: "k"]>, "=", 1>,
 *      Expect<Store["size"], "=", 1>
 *   ]
 * >;
 * ```
 */
export type Given<Effects, Then extends Internal.Test> = Internal.Sequence<
  Effects,
  Then
>;

export declare namespace Internal {
  /** Anything that can be the right-hand side of an exported test alias. */
  type Test =
    | Node<"assertion">
    | Node<"sequence">
    | Node<"table">
    | Node<"modifier">
    | readonly Test[];

  interface Sequence<Effects, Then> extends Node<"sequence"> {
    readonly effects: Effects;
    readonly then: Then;
  }
}

/**
 * `Given` + `Expect` in one call (the original scaffold's shape).
 *
 * ```ts
 * export type Increments = ExpectGiven<Call<Counter, "increment">, Counter["count"], "=", 11>;
 * ```
 */
export type ExpectGiven<
  Effects,
  Actual,
  Condition extends Internal.ConditionsFor<Actual>,
  Expected extends
    | Internal.ExpectedFor<Actual, Condition>
    | Snapshot<any>
    | Nothing = Nothing,
  DisplayOrConfig extends undefined | Internal.DisplayPage | Internal.Config =
    undefined,
> = Internal.Sequence<
  Effects,
  Expect<Actual, Condition, Expected, DisplayOrConfig>
>;

/**
 * Replace a module for one test, as one of a `Given`'s effects. Whatever its
 * place among them, it applies before the test's code runs.
 *
 * Each test runs its own copy of the modules it imports, so the mock is that
 * test's alone. A package is shared by every test in the file, and so is a
 * mock of one.
 *
 * Without a replacement, every export becomes a `vi.fn()`; set what one returns
 * through `Mocked`. A replacement is imported from another module: a module
 * object, or a factory that is handed `importOriginal`, as `vi.mock`'s is.
 *
 * ```ts
 * export type Faked = Given<
 *   Mock<"./rates.ts", typeof fakeRates>,
 *   Expect<Invoke<typeof inEuros, [dollars: 10]>, "=", 20>
 * >;
 *
 * export type Stubbed = Given<
 *   [Mock<"./rates.ts">, Call<Mocked<typeof exchangeRate>, "mockReturnValue", [value: 2]>],
 *   Expect<Invoke<typeof inEuros, [dollars: 10]>, "=", 20>
 * >;
 * ```
 */
export type Mock<
  Path extends string,
  With extends object | undefined = undefined,
> = Internal.ModuleMock<Path, With>;

export declare namespace Internal {
  interface ModuleMock<Path, With> extends Node<"mock"> {
    readonly path: Path;
    readonly with: With;
  }
}

/**
 * A function a `Mock` replaced, typed as the `vi.fn()` it now is.
 *
 * ```ts
 * export type Stubbed = Given<
 *   [Mock<"./rates.ts">, Call<Mocked<typeof exchangeRate>, "mockReturnValue", [value: 2]>],
 *   Expect<Invoke<typeof inEuros, [dollars: 10]>, "=", 20>
 * >;
 * ```
 */
export type Mocked<F extends Internal.AnyFn> = MockedFunction<F>;

/**
 * Parameterised tests: call `F` once per row and check the result.
 * Each row is reported as its own case (`Tests > add > Table[2]`).
 *
 * **STRONGLY RECOMMENDED** to use named tuples for clarity: name each row's
 * elements, and name the arguments inside `args` as the function names its parameters.
 *
 * ```ts
 * export type Cases = Table<typeof add, [
 *   [args: [a: 1, b: 2], expected: 3],
 *   [args: [a: -1, b: 1], expected: 0],
 *   [args: [a: 0.1, b: 0.2], condition: ["~=", 1e-9], expected: 0.3],
 * ]>;
 * ```
 */
export type Table<
  F extends Internal.AnyFn,
  Rows extends readonly Internal.Row<F>[],
> = Internal.TableNode<F, Rows>;

export declare namespace Internal {
  /**
   * A row of a `Table`: `[args, expected]` (implied `"="`) or `[args, condition, expected]`.
   */
  type Row<F extends AnyFn> =
    | readonly [
        args: Parameters<F>,
        expected: Awaited<ReturnType<F>> | Snapshot<any>,
      ]
    | readonly [
        args: Parameters<F>,
        condition: ConditionsFor<Awaited<ReturnType<F>>>,
        expected:
          | ExpectedFor<
              Awaited<ReturnType<F>>,
              ConditionsFor<Awaited<ReturnType<F>>>
            >
          | Snapshot<any>,
      ];

  interface TableNode<F, Rows> extends Node<"table"> {
    readonly fn: F;
    readonly rows: Rows;
  }
}

/**
 * Skip a test. It is discovered and shown as skipped, never run.
 *
 * ```ts
 * export type Flaky = Skip<Expect<Invoke<typeof fetchRates>, "isNotEmpty">, "rate limited in CI">;
 * ```
 */
export type Skip<
  T extends Internal.Test,
  Reason extends string = "",
> = Internal.Modifier<"skip", T, Reason>;

/**
 * Skip a test when a file it needs is not there, relative to the test file. For
 * a library whose tests read fixtures that ship with its repository but not
 * with the package: the tests run in the repository and are skipped where the
 * package is installed.
 *
 * ```ts
 * export type Seeded = SkipIfNotFound<
 *   "./fixtures/users.json",
 *   Expect<Invoke<typeof load, [users: FromFile<"./fixtures/users.json", "json">]>, "isNotEmpty">
 * >;
 * ```
 */
export type SkipIfNotFound<
  Path extends string,
  T extends Internal.Test,
> = Internal.Modifier<"skipIfNotFound", T, Path>;

export declare namespace Internal {
  interface Modifier<Kind extends string, T, Payload> extends Node<"modifier"> {
    readonly kind: Kind;
    readonly test: T;
    readonly payload: Payload;
  }
}

/**
 * Run only tests marked `Only` (when any exist in the workspace/file).
 *
 * ```ts
 * export type Focus = Only<Expect<Invoke<typeof add, [a: 4, b: 5]>, "=", 9>>;
 * ```
 */
export type Only<T extends Internal.Test> = Internal.Modifier<"only", T, "">;

/**
 * A planned test with no body yet. Shown as "todo".
 *
 * ```ts
 * export type Emoji = Todo<"decide whether emoji should be stripped or transliterated">;
 * ```
 */
export type Todo<Reason extends string = ""> = Internal.Modifier<
  "todo",
  never,
  Reason
>;

/**
 * Apply a `Config` to a whole test (or tuple of tests).
 *
 * ```ts
 * export type Big = Configure<
 *   { timeout: 30_000; retries: 1 },
 *   Expect<Invoke<typeof normalize, [xs: Invoke<typeof range, [n: 1_000_000]>]>["length"], "=", 1_000_000>
 * >;
 * ```
 */
export type Configure<
  C extends Internal.Config,
  T extends Internal.Test,
> = Internal.Modifier<"configure", T, C>;
