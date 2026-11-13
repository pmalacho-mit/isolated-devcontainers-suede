# namespace-tests DSL

## Namespaces

- [Internal](Namespace.Internal.md)

## Call

> **Call**\<`Receiver`, `Method`, `Args`\> = `Awaited`\<[`ReturnFor`](Namespace.Internal.md#returnfor)\<`Receiver`\[`Method`\], `Args`\>\> \| [`Phantom`](Namespace.Internal.md#phantom)\<`Args`\>

Call a method on a materialized value (typically a `Construct` alias or a
`Fixture`). Evaluates to the (awaited) return type of the method.

**STRONGLY RECOMMENDED** to use named tuples on `Args` for clarity.
`Args` can be left out when no parameter is required.

```ts
type Counter = Construct<typeof Counter, [start: 10]>;
type Stored = Call<Store, "put", [key: "k", value: 1]>;

export type Increments = Given<
  Call<Counter, "increment">,
  Expect<Counter["count"], "=", 11>
>;
```

### Type Parameters

#### Receiver

`Receiver`

#### Method

`Method` *extends* [`MethodsCallableWith`](Namespace.Internal.md#methodscallablewith)\<`Receiver`, `Args`\>

#### Args

`Args` *extends* [`ArgumentsOf`](Namespace.Internal.md#argumentsof)\<`Receiver`\[`Method`\]\> \| \[\] = \[\]

***

## Configure

> **Configure**\<`C`, `T`\> = [`Modifier`](Namespace.Internal.md#modifier)\<`"configure"`, `T`, `C`\>

Apply a `Config` to a whole test (or tuple of tests).

```ts
export type Big = Configure<
  { timeout: 30_000; retries: 1 },
  Expect<Invoke<typeof normalize, [xs: Invoke<typeof range, [n: 1_000_000]>]>["length"], "=", 1_000_000>
>;
```

### Type Parameters

#### C

`C` *extends* [`Config`](Namespace.Internal.md#config-1)

#### T

`T` *extends* [`Test`](Namespace.Internal.md#test-1)

***

## Construct

> **Construct**\<`C`, `Args`\> = `InstanceType`\<`C`\> \| [`Phantom`](Namespace.Internal.md#phantom)\<`Args`\>

Instantiate a class with literal arguments. Evaluates to the instance type.
Bind it to an alias to keep a handle on the instance:

**STRONGLY RECOMMENDED** to use named tuples on `Args` for clarity.
`Args` can be left out when no parameter is required.

```ts
type Counter = Construct<typeof Counter, [start: 10]>;

export type StartsAt = Expect<Counter["count"], "=", 10>;
```

### Type Parameters

#### C

`C` *extends* [`ConstructorFor`](Namespace.Internal.md#constructorfor)\<`Args`\>

#### Args

`Args` *extends* `ConstructorParameters`\<`C`\> \| \[\] = \[\]

***

## Env

> **Env**\<`Name`, `Default`\> = `string` \| `Default` \| [`Phantom`](Namespace.Internal.md#phantom)\<`Name`\>

Read an environment variable at runtime. Evaluates to `string`, or to
`Default` when the variable is unset. Tests that read an unset variable
with no default fail with a clear message.

```ts
type Domain = Env<"TEST_EMAIL_DOMAIN", "example.com">;

export type Invites = Expect<Invoke<typeof inviteAddress, [user: "ada", domain: Domain]>, "endsWith", "example.com">;
```

### Type Parameters

#### Name

`Name` *extends* `string`

#### Default

`Default` *extends* `string` \| `undefined` = `undefined`

***

## Expect

> **Expect**\<`Actual`, `Condition`, `Expected`, `DisplayOrConfig`\> = `Expected` *extends* [`Nothing`](#nothing) ? `Condition` *extends* [`NullaryCondition`](Namespace.Internal.md#nullarycondition) \| `"throws"` ? [`Assertion`](Namespace.Internal.md#assertion)\<`Actual`, `Condition`, `Expected`, `DisplayOrConfig`\> : [`MissingExpected`](Namespace.Internal.md#missingexpected)\<`Condition`\> : [`Assertion`](Namespace.Internal.md#assertion)\<`Actual`, `Condition`, `Expected`, `DisplayOrConfig`\>

The core assertion.

```ts
Expect<Invoke<typeof add, [a: 4, b: 5]>, "=", 9>
Expect<Invoke<typeof greet, [name: "Ada"]>, "startsWith", "Hello">
Expect<Invoke<typeof sqrt, [x: 2]>, ["~=", 1e-12], 1.4142135623730951>
Expect<Invoke<typeof parse, [source: "{"]>, "throws", SyntaxError>
Expect<Invoke<typeof list>, "isEmpty">
Expect<Pixels, "=", ExpectedPixels, "./display-image.html">
```

`Expected` is constrained by `Actual` and `Condition` together, so mismatched
shapes are compile errors — the IDE tells you before the test runs.

### Type Parameters

#### Actual

`Actual`

#### Condition

`Condition` *extends* [`ConditionsFor`](Namespace.Internal.md#conditionsfor)\<`Actual`\>

#### Expected

`Expected` *extends* [`ExpectedFor`](Namespace.Internal.md#expectedfor)\<`Actual`, `Condition`\> \| [`Snapshot`](#snapshot)\<`any`\> \| [`Nothing`](#nothing) = [`Nothing`](#nothing)

#### DisplayOrConfig

`DisplayOrConfig` *extends* `undefined` \| [`DisplayPage`](Namespace.Internal.md#displaypage) \| [`Config`](Namespace.Internal.md#config-1) = `undefined`

***

## ExpectGiven

> **ExpectGiven**\<`Effects`, `Actual`, `Condition`, `Expected`, `DisplayOrConfig`\> = [`Sequence`](Namespace.Internal.md#sequence)\<`Effects`, [`Expect`](#expect)\<`Actual`, `Condition`, `Expected`, `DisplayOrConfig`\>\>

`Given` + `Expect` in one call (the original scaffold's shape).

```ts
export type Increments = ExpectGiven<Call<Counter, "increment">, Counter["count"], "=", 11>;
```

### Type Parameters

#### Effects

`Effects`

#### Actual

`Actual`

#### Condition

`Condition` *extends* [`ConditionsFor`](Namespace.Internal.md#conditionsfor)\<`Actual`\>

#### Expected

`Expected` *extends* [`ExpectedFor`](Namespace.Internal.md#expectedfor)\<`Actual`, `Condition`\> \| [`Snapshot`](#snapshot)\<`any`\> \| [`Nothing`](#nothing) = [`Nothing`](#nothing)

#### DisplayOrConfig

`DisplayOrConfig` *extends* `undefined` \| [`DisplayPage`](Namespace.Internal.md#displaypage) \| [`Config`](Namespace.Internal.md#config-1) = `undefined`

***

## Fixture

> **Fixture**\<`T`, `Initial`\> = `T` \| [`Phantom`](Namespace.Internal.md#phantom)\<`Initial`\>

A typed fixture: declares the *type* the rest of the test sees and the
literal *initial value* the test materializes. Solves the problem that a
literal `{ name: "parker" }` has type `{ name: "parker" }`, which would
reject an expectation of `"olivia"` after a mutation.

```ts
type Container = Fixture<{ name: string }, { name: "parker" }>;

export type Rename = Given<
  Invoke<typeof setName, [container: Container, name: "olivia"]>,
  Expect<Container["name"], "=", "olivia">
>;
```

Prefer this over `Widen` when you know the intended shape.

### Type Parameters

#### T

`T`

#### Initial

`Initial` *extends* `T` & [`Literal`](Namespace.Internal.md#literal)

***

## FromFile

> **FromFile**\<`Path`, `Format`, `Json`\> = `Format` *extends* `"text"` ? `string` : `Format` *extends* `"bytes"` ? `Uint8Array` : `Json` \| [`Phantom`](Namespace.Internal.md#phantom)\<`Path`\>

Load a file relative to the test file at runtime.

```ts
type Png = FromFile<"./fixtures/logo.png", "bytes">;      // Uint8Array
type Csv = FromFile<"./fixtures/rows.csv">;                // string
type Cfg = FromFile<"./fixtures/config.json", "json", AppConfig>;

export type Parses = Expect<Invoke<typeof parseCsv, [text: Csv]>, "isNotEmpty">;
```

### Type Parameters

#### Path

`Path` *extends* `string`

#### Format

`Format` *extends* [`FileFormat`](Namespace.Internal.md#fileformat) = `"text"`

#### Json

`Json` = `unknown`

***

## Given

> **Given**\<`Effects`, `Then`\> = [`Sequence`](Namespace.Internal.md#sequence)\<`Effects`, `Then`\>

Run `Effects` (an expression, or a tuple of expressions, evaluated in order
purely for their side effects), then evaluate `Then`.

```ts
export type Rename = Given<
  Invoke<typeof setName, [container: Container, name: "olivia"]>,
  Expect<Container["name"], "=", "olivia">
>;

export type Lifecycle = Given<
  [
     Call<Store, "open">,
     Call<Store, "put", [key: "k", value: 1]>
  ],
  [
     Expect<Call<Store, "get", [key: "k"]>, "=", 1>,
     Expect<Store["size"], "=", 1>
  ]
>;
```

### Type Parameters

#### Effects

`Effects`

#### Then

`Then` *extends* [`Test`](Namespace.Internal.md#test-1)

***

## Invoke

> **Invoke**\<`F`, `Args`\> = `Awaited`\<[`ReturnFor`](Namespace.Internal.md#returnfor)\<`F`, `Args`\>\> \| [`Phantom`](Namespace.Internal.md#phantom)\<`Args`\>

Call a function with literal arguments. Evaluates to the (awaited) return type.

**STRONGLY RECOMMENDED** to use named tuples on `Args` for clarity.
`Args` can be left out when no parameter is required.

```ts
type Sum = Invoke<typeof add, [a: 4, b: 5]>;               // number  ⇒ 9 at runtime
type Name = Invoke<typeof user.getName>;           // `this` is `user`; no arguments, no tuple
type Doubled = Invoke<typeof map, [arr: [1, 2], fn: typeof double]>; // functions are literals too

export type Simple = Expect<Invoke<typeof add, [a: 4, b: 5]>, "=", 9>;
```

### Type Parameters

#### F

`F` *extends* [`CalleeFor`](Namespace.Internal.md#calleefor)\<`Args`\>

#### Args

`Args` *extends* [`ArgumentsOf`](Namespace.Internal.md#argumentsof)\<`F`\> \| \[\] = \[\]

***

## Mock

> **Mock**\<`Path`, `With`\> = [`ModuleMock`](Namespace.Internal.md#modulemock)\<`Path`, `With`\>

Replace a module for one test, as one of a `Given`'s effects. Whatever its
place among them, it applies before the test's code runs.

Each test runs its own copy of the modules it imports, so the mock is that
test's alone. A package is shared by every test in the file, and so is a
mock of one.

Without a replacement, every export becomes a `vi.fn()`; set what one returns
through `Mocked`. A replacement is imported from another module: a module
object, or a factory that is handed `importOriginal`, as `vi.mock`'s is.

```ts
export type Faked = Given<
  Mock<"./rates.ts", typeof fakeRates>,
  Expect<Invoke<typeof inEuros, [dollars: 10]>, "=", 20>
>;

export type Stubbed = Given<
  [Mock<"./rates.ts">, Call<Mocked<typeof exchangeRate>, "mockReturnValue", [value: 2]>],
  Expect<Invoke<typeof inEuros, [dollars: 10]>, "=", 20>
>;
```

### Type Parameters

#### Path

`Path` *extends* `string`

#### With

`With` *extends* `object` \| `undefined` = `undefined`

***

## Mocked

> **Mocked**\<`F`\> = `MockedFunction`\<`F`\>

A function a `Mock` replaced, typed as the `vi.fn()` it now is.

```ts
export type Stubbed = Given<
  [Mock<"./rates.ts">, Call<Mocked<typeof exchangeRate>, "mockReturnValue", [value: 2]>],
  Expect<Invoke<typeof inEuros, [dollars: 10]>, "=", 20>
>;
```

### Type Parameters

#### F

`F` *extends* [`AnyFn`](Namespace.Internal.md#anyfn)

***

## Nothing

> **Nothing** = [`NothingNode`](Namespace.Internal.md#nothingnode)

No expected value: what a condition like `"truthy"` or `"throws"` takes. Written
out only to reach the argument after it, a display page or a config.

```ts
export type Ready = Expect<Invoke<typeof isReady>, "truthy", Nothing, { timeout: 50 }>;
```

***

## Only

> **Only**\<`T`\> = [`Modifier`](Namespace.Internal.md#modifier)\<`"only"`, `T`, `""`\>

Run only tests marked `Only` (when any exist in the workspace/file).

```ts
export type Focus = Only<Expect<Invoke<typeof add, [a: 4, b: 5]>, "=", 9>>;
```

### Type Parameters

#### T

`T` *extends* [`Test`](Namespace.Internal.md#test-1)

***

## Skip

> **Skip**\<`T`, `Reason`\> = [`Modifier`](Namespace.Internal.md#modifier)\<`"skip"`, `T`, `Reason`\>

Skip a test. It is discovered and shown as skipped, never run.

```ts
export type Flaky = Skip<Expect<Invoke<typeof fetchRates>, "isNotEmpty">, "rate limited in CI">;
```

### Type Parameters

#### T

`T` *extends* [`Test`](Namespace.Internal.md#test-1)

#### Reason

`Reason` *extends* `string` = `""`

***

## SkipIfNotFound

> **SkipIfNotFound**\<`Path`, `T`\> = [`Modifier`](Namespace.Internal.md#modifier)\<`"skipIfNotFound"`, `T`, `Path`\>

Skip a test when a file it needs is not there, relative to the test file. For
a library whose tests read fixtures that ship with its repository but not
with the package: the tests run in the repository and are skipped where the
package is installed.

```ts
export type Seeded = SkipIfNotFound<
  "./fixtures/users.json",
  Expect<Invoke<typeof load, [users: FromFile<"./fixtures/users.json", "json">]>, "isNotEmpty">
>;
```

### Type Parameters

#### Path

`Path` *extends* `string`

#### T

`T` *extends* [`Test`](Namespace.Internal.md#test-1)

***

## Snapshot

> **Snapshot**\<`Name`\> = [`SnapshotNode`](Namespace.Internal.md#snapshotnode)\<`Name`\>

A stored expected value. On first run the test writes the actual value to
`__snapshots__/<file>.<TestName>[.<Name>].snap` next to the test file; on
later runs it compares against that file. Updating snapshots is a runner
command, not a code change.

```ts
export type Renders = Expect<Invoke<typeof render, [tree: Tree]>, "=", Snapshot>;
export type Both = [
  Expect<Invoke<typeof render, [tree: Tree]>, "=", Snapshot<"html">>,
  Expect<Invoke<typeof toText, [tree: Tree]>, "=", Snapshot<"text">>,
];
```

### Type Parameters

#### Name

`Name` *extends* `string` = `""`

***

## Table

> **Table**\<`F`, `Rows`\> = [`TableNode`](Namespace.Internal.md#tablenode)\<`F`, `Rows`\>

Parameterised tests: call `F` once per row and check the result.
Each row is reported as its own case (`Tests > add > Table[2]`).

**STRONGLY RECOMMENDED** to use named tuples for clarity: name each row's
elements, and name the arguments inside `args` as the function names its parameters.

```ts
export type Cases = Table<typeof add, [
  [args: [a: 1, b: 2], expected: 3],
  [args: [a: -1, b: 1], expected: 0],
  [args: [a: 0.1, b: 0.2], condition: ["~=", 1e-9], expected: 0.3],
]>;
```

### Type Parameters

#### F

`F` *extends* [`AnyFn`](Namespace.Internal.md#anyfn)

#### Rows

`Rows` *extends* readonly [`Row`](Namespace.Internal.md#row)\<`F`\>[]

***

## Throws

> **Throws**\<`Expr`, `Matcher`\> = [`Assertion`](Namespace.Internal.md#assertion)\<`Expr`, `"throws"`, `Matcher`, `undefined`\>

Shorthand for `Expect<Expr, "throws", Matcher>`. The matcher is optional: an
error class, a message substring, or an object of the fields that must match.

```ts
export type Errors = [
  Throws<Invoke<typeof parse, [source: "(1 + 2"]>, ParseError>,
  Throws<Invoke<typeof parse, [source: "1 +"]>, { instanceOf: ParseError; matches: "unexpected .*end of input" }>,
  Throws<Invoke<typeof parse, [source: "1 2"]>, "trailing">,
  Throws<Invoke<typeof parse, [source: ""]>>, // any throw at all
];
```

### Type Parameters

#### Expr

`Expr`

#### Matcher

`Matcher` *extends* [`ExpectedFor`](Namespace.Internal.md#expectedfor)\<`Expr`, `"throws"`\> = [`Nothing`](#nothing)

***

## Todo

> **Todo**\<`Reason`\> = [`Modifier`](Namespace.Internal.md#modifier)\<`"todo"`, `never`, `Reason`\>

A planned test with no body yet. Shown as "todo".

```ts
export type Emoji = Todo<"decide whether emoji should be stripped or transliterated">;
```

### Type Parameters

#### Reason

`Reason` *extends* `string` = `""`

***

## Widen

> **Widen**\<`T`\> = `T` *extends* `string` ? `string` : `T` *extends* `number` ? `number` : `T` *extends* `boolean` ? `boolean` : `T` *extends* `bigint` ? `bigint` : `T` *extends* `symbol` ? `symbol` : `T` *extends* readonly infer U[] ? [`Widen`](#widen)\<`U`\>[] : `T` *extends* `object` ? `{ -readonly [K in keyof T]: Widen<T[K]> }` : `T`

Widen literal types to their primitive base (`"parker"` → `string`,
`[1, 2]` → `number[]`) while the test still materializes the literal.
Handy when a fixture's shape is obvious and you don't want to spell it out.

```ts
type Sample = Widen<[2, 4, 4, 4, 5, 5, 7, 9]>; // number[], materialized as written

export type Mean = Expect<Invoke<typeof mean, [xs: Sample]>, "=", 5>;
```

### Type Parameters

#### T

`T`
