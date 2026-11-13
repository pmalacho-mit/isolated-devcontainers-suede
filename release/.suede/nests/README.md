> [!NOTE]
> This is a [suede](https://github.com/pmalacho-mit/suede) dependency.

# Namespace Tests

Tests written as TypeScript types, beside the code they test, and run by Vitest.
A test is one declaration that reads as the claim it makes — call `add` with 4
and 5, expect 9 — so the namespace under a function reads as a list of what it
does:

```ts
import type { Expect, Invoke } from "./<path-to-library>/dsl.import.meta.vitest.ts";

export const add = (a: number, b: number) => a + b;

declare namespace add {
  /** four plus five */
  export type Simple = Expect<Invoke<typeof add, [a: 4, b: 5]>, "=", 9>;
}
```

The type checker checks the shape of every test as you write it — you cannot
expect a string from a function that returns a number — and the Vite plugin
prints each one as an ordinary Vitest test, which Vitest runs.

**Documentation:** [API reference](./docs/API.md) · [editor extension](./vscode-extension/README.md)

## Requirements and setup

- **Node 24.** The library is TypeScript that Node runs directly — its command
  line and the editor extension included — so nothing is compiled first.
- **Vitest 5**, which your project provides.

Installing with suede adds the packages the library needs to your
`package.json` (see [package.json](./package.json)): among them
`@typescript/typescript6`, the TypeScript whose API the printer reads your tests
with, under its own name so that it never displaces your project's `typescript`.

Add the plugin to your Vite config, beside the plugins you already have:

```ts
// vite.config.ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import namespaceTests from "./<path-to-library>/vite-plugin/plugin.mts";

export default defineConfig({
  plugins: [react(), namespaceTests()],
});
```

The plugin only does anything under Vitest. `vite dev` and `vite build` load
the same config, and to them it is inert: it does not scan, does not start a
compiler, and does not touch a module. So the one config can serve your app
and your tests, and the tests see the same aliases and plugins as the app.

Nothing else is needed: files with tests are found by scanning the project, and
the plugin adds them to Vitest's `includeSource` itself. You do not list them,
and you do not need the `define: { "import.meta.vitest": "undefined" }` that
in-source testing usually asks for, because nothing that reads
`import.meta.vitest` ever reaches a build.

**If you keep a separate `vitest.config.ts`,** Vitest reads it *instead of*
`vite.config.ts`, not as well as it. Merge the two, so your tests keep the app's
plugins and aliases:

```ts
// vitest.config.ts
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";
import namespaceTests from "./<path-to-library>/vite-plugin/plugin.mts";

export default mergeConfig(
  viteConfig,
  defineConfig({ plugins: [namespaceTests()] }),
);
```

(If `vite.config.ts` exports a function, call it first:
`mergeConfig(viteConfig({ command: "serve", mode: "test" }), …)`.) A project
with no app to build, like a library, can skip `vite.config.ts` and put the
plugin straight into a `vitest.config.ts` from `defineConfig` in
`vitest/config`.

**If your `tsconfig.json` only lists references,** as the one `create-vite`
writes does (`"files": []`, then `tsconfig.app.json` and `tsconfig.node.json`),
name the one that covers your source. The printer reads your tests with that
file's compiler options, including `paths` and `jsx`:

```ts
namespaceTests({ tsconfig: "tsconfig.app.json" });
```

Run Vitest from the project root. Discovery, `exclude` and
`noIsolateModuleImport` are all relative to the directory it starts in.

The options, all optional:

| Option                  | What it does                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `exclude`               | Globs discovery skips, relative to the project root. `node_modules` and dot-directories are always skipped.         |
| `include`               | Extra globs to collect tests from, as Vitest's `include`.                                                           |
| `root`                  | Only read namespaces with this name ([what counts as a test](#what-counts-as-a-test)).                              |
| `noIsolateModuleImport` | Modules every test shares instead of getting its own copy ([how a test is run](#how-a-test-is-run)).                |
| `extracted`             | The glob for extracted tests, added to Vitest's `include`; `false` leaves them out ([extracting](#extracting-a-test)). |
| `tsconfig`              | The tsconfig file name, found upward from the working directory. Default `tsconfig.json`.                          |
| `scan`                  | Discover test files by scanning the working directory. Default `true`.                                              |

## Importing the DSL (_the path matters_)

Import the DSL from [dsl.import.meta.vitest.ts](./dsl.import.meta.vitest.ts) and use
that path in **every** file you write tests in:

```ts
import type {
  Expect,
  Invoke,
} from "./<path-to-library>/dsl.import.meta.vitest.ts";
```

That module is named explicitly so that, when you import it, the string
`import.meta.vitest` appears in your file. Vitest decides which files hold
tests by keeping the ones whose raw text contains that string — its
[in-source testing](https://vitest.dev/guide/in-source.html) — so importing the
DSL is what makes your tests findable. What this library adds to in-source
testing is the form of a test: a type that states its claim, in place of a block
of `it` and `expect` calls.

Two consequences worth knowing:

- **Re-exporting the DSL hides your tests.** If you wrap it in a barrel —
  `export type { Expect } from "./<path-to-library>/dsl.import.meta.vitest.ts"` —
  then the files importing _your_ barrel no longer contain the marker, and they
  are silently never collected. Import the DSL directly in each file that has tests.
- **Always `import type`.** Vitest rewrites every occurrence of
  `import.meta.vitest` in a file it collects, including the one inside your
  import path. A type-only import is erased before that can matter; a value
  import from the same path would break.

## Writing tests

Every building block is documented, with examples, in the
[API reference](./docs/API.md):

| To…                                             | Write                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| call a function, a constructor, a method        | [`Invoke`](./docs/API.md#invoke), [`Construct`](./docs/API.md#construct), [`Call`](./docs/API.md#call)                             |
| assert                                          | [`Expect`](./docs/API.md#expect), [`Throws`](./docs/API.md#throws)                                                                  |
| run effects first                               | [`Given`](./docs/API.md#given), [`ExpectGiven`](./docs/API.md#expectgiven)                                                          |
| check many cases                                | [`Table`](./docs/API.md#table)                                                                                                      |
| build inputs                                    | [`Fixture`](./docs/API.md#fixture), [`Widen`](./docs/API.md#widen), [`FromFile`](./docs/API.md#fromfile), [`Env`](./docs/API.md#env) |
| compare against a stored value                  | [`Snapshot`](./docs/API.md#snapshot)                                                                                                |
| replace a module                                | [`Mock`](./docs/API.md#mock), [`Mocked`](./docs/API.md#mocked)                                                                      |
| skip, focus, plan, configure                    | [`Skip`](./docs/API.md#skip), [`SkipIfNotFound`](./docs/API.md#skipifnotfound), [`Only`](./docs/API.md#only), [`Todo`](./docs/API.md#todo), [`Configure`](./docs/API.md#configure) |
| pass a config without an expected value         | [`Nothing`](./docs/API.md#nothing)                                                                                                  |

**Name the arguments.** Every argument list — to `Invoke`, `Construct`, `Call`,
and a `Table` row's `args` — is a tuple, and a named one says what each value is:

```ts
export type Sum = Expect<Invoke<typeof add, [a: 4, b: 5]>, "=", 9>;
```

The names are only read by you; the printed test passes the values in order.

Everything under `Internal` is what the DSL is built from — the conditions an
`Expect` accepts, the shapes its results take. It is documented in the
[reference](./docs/Namespace.Internal.md) for reading hover text, not for writing
tests.

## What counts as a test

Only one thing decides whether a file is looked at: it imports the DSL, so it
carries the marker Vitest keys on. Inside such a file, **every**
`declare namespace` is looked at, and a test is an exported alias whose type
came from the DSL — resolved through the import, so a local type of your own
named `Expect` is yours, and `import type { Expect as Assert }` still reads.

So a namespace is not a suite because of what it is called. Name it after what
it covers, and the test says where it was written:

```ts
declare namespace parseDate {
  export type Iso = Expect<Invoke<typeof parseDate, [input: "2020-01-01"]>, "truthy">;
}
// parseDate > Iso
```

A test's name is its namespace path exactly as written, so
`declare namespace Tests.parser` gives `Tests > parser > …`. Nothing is
stripped: the name you read in the Test Explorer is the path you can find in
the file.

Exporting an alias is what says "this is a test", and an unexported one is a
helper — that is the only convention. If you export something the printer
cannot run, it says so where you wrote it rather than ignoring it:

```ts
declare namespace add {
  export type Oops = Invoke<typeof add, [a: 1, b: 1]>;
  // `Invoke<typeof add, [a: 1, b: 1]>` is not a test:
  // write Expect, Throws, Given or Table (or a tuple of them)
}
```

That arrives as a diagnostic in the editor, on that line.

If you want the rest of a file's namespaces left alone, name the one to look
inside:

```ts
namespaceTests({ root: "Tests" }); // only `declare namespace Tests…`
```

That is an optimisation, not a requirement — there is no default root.

## When a test is written wrong

TypeScript checks a test as you write it, but its errors are about the DSL's
machinery, and on a `Table` it underlines the whole table and stops at the first
bad row. So the printer also explains each mistake where it is, in the test's
own terms — every bad row, each at the cell that is wrong:

```
Row 2: expected "no", but scrubsTests returns boolean
Row 3: scrubsTests takes [define: Record<string, unknown> | undefined], not ["wrong"]
expected "no", but the actual is boolean
```

They arrive as warnings in the terminal when the tests run, and in the editor,
where each wrong cell is outlined and hovering anywhere in TypeScript's error
shows them. TypeScript still decides what is wrong; this only says where.

## Asserting on records

When a call hands back records and the test is about one field of each, say so
in the expected value rather than reshaping the actual one. `matches` compares
a deep-partial, element by element:

```ts
export type Anywhere = Expect<
  Invoke<typeof discover, [source: Suite]>,
  "matches",
  [{ name: "parseDate > Iso" }, { name: "Tests > elsewhere > Deep" }]
>;
```

```ts
expect(discover(Suite)).toMatchObject([
  { name: "parseDate > Iso" },
  { name: "Tests > elsewhere > Deep" },
]);
```

Only the keys you list are compared, at any depth, so the other fields of each
record are free to change. The list itself is not partial: the actual must have
exactly as many elements, in that order.

Both halves of that are Vitest's own rule, not this library's — `matches` on
anything but a string prints `toMatchObject`, and that matcher compares arrays
element-wise, same length, in order, with each element matched partially. (Its
counterpart, `expect.arrayContaining`, is the one that allows extra elements.)
The DSL adds only the type: the expected list is checked against the real record
type, so a misspelled key or a wrongly typed value is a compile error, and a
tuple actual is checked position by position.

## Beyond literals: harness modules

A test can only say what a type can: literals, calls, `new`, method calls. For
anything else — a callback, a spy, fake timers, async orchestration — write an
ordinary function in a module of its own, and import it into the test **as a
type**:

```ts
// lib/harness.ts
import { vi } from "vitest";
import { each } from "../harnessed.ts";

export const callsOf = (xs: number[]) => {
  const visit = vi.fn();
  each(xs, visit);
  return visit.mock.calls;
};
```

```ts
// harnessed.ts
import type { callsOf } from "./lib/harness.ts";

declare namespace each {
  export type VisitsInOrder = Expect<Invoke<typeof callsOf, [xs: [1, 2, 3]]>, "=", [[1], [2], [3]]>;
}
```

The printed test imports the harness as a value; your module only ever imports
it as a type, so the harness — and `vitest` with it — never reaches your build.
A harness can clean up after itself with Vitest's `onTestFinished`.

## Mocking a module

[`Mock`](./docs/API.md#mock) replaces a module for one test, as one of a
`Given`'s effects:

```ts
import type { fakeRates, keepingTheRest } from "./lib/harness.ts";
import { exchangeRate } from "./lib/rates.ts";

declare namespace inEuros {
  /** replaced by a module object the harness exports */
  export type Faked = Given<
    Mock<"./lib/rates.ts", typeof fakeRates>,
    Expect<Invoke<typeof inEuros, [dollars: 10]>, "=", 20>
  >;

  /** every export a vi.fn(), and one of them told what to return */
  export type Stubbed = Given<
    [Mock<"./lib/rates.ts">, Call<Mocked<typeof exchangeRate>, "mockReturnValue", [value: 3]>],
    Expect<Invoke<typeof inEuros, [dollars: 10]>, "=", 30>
  >;
}
```

- **A local module's mock is that test's alone.** Every test runs its own copy
  of the modules it imports, so the next test sees the real one.
- **A package is shared by every test in the file**, and so is a mock of one;
  the printer warns when you mock one, and when a path resolves to nothing.
- **A replacement comes from another module** — a module object, or a factory
  that is handed `importOriginal`, as `vi.mock`'s is — because `vi.mock` runs
  before the test's own code.

## Tests that need files the package does not ship

A library's tests may read fixtures that are in its repository but not in the
copy someone installs. [`SkipIfNotFound`](./docs/API.md#skipifnotfound) runs a
test where its file is, and skips it where it is not:

```ts
export type Seeded = SkipIfNotFound<
  "./fixtures/users.json",
  Expect<Invoke<typeof countUsers, [users: FromFile<"./fixtures/users.json", "json", unknown[]>]>, ">", 0>
>;
```

The path is relative to the test file, as `FromFile`'s is.

## Display pages

A test can hand what it saw to an HTML page of your own — a chart instead of a
wall of numbers — by naming the page as `Expect`'s fourth argument:

```ts
export type Visual = Expect<
  Invoke<typeof histogram, [xs: [1, 1, 1, 2, 3, 5, 8, 13], buckets: 4, min: 0, max: 16]>,
  "=",
  [5, 1, 1, 1],
  "./fixtures/display-histogram.html"
>;
```

The editor extension opens it beside the code; see
[Display](./vscode-extension/README.md) for what the page receives.

## How a test is run

Nothing is written to disk. For a module with tests, the plugin appends a
collector:

```ts
if (import.meta.vitest) {
  await import("./counter.Counter_Chainable.namespace.test.ts");
}
```

and serves each of those ids from memory: the part of your module that test
needs, pruned of everything it does not, followed by the test itself. So every
test gets a fresh copy of the module under test — and of that module's
first-party imports, which are forked per test so state cannot leak from one
test to the next.

The plugin only runs under Vitest (`vite dev` and `vite build` skip it), so no
collector reaches a build, and the namespaces are erased with the rest of your types. A
value you declare outside a namespace for tests to use is ordinary code, and a
build treats it like any other export.

Packages are shared, since Vitest hands those to Node. If some first-party
module of yours is _meant_ to be singular — a connection pool, a registry —
name it and every test will share one instance:

```ts
namespaceTests({ noIsolateModuleImport: ["src/db/**", "src/registry.ts"] });
```

Those are globs matched against each module's path relative to the project
root, the same shape as Vitest's own `include`. They name _modules_, not the
specifiers that import them, so one entry covers a module however its importers
happen to spell the path — `./registry.ts` from a sibling and
`../../registry.ts` from further down are the same module, and one pattern
catches both.

## Extracting a test

A test can be written out as a file of its own, beside the module it came from:

```
src/counter.ts  >  Counter > Chainable
src/counter.Counter_Chainable.temp.ts
```

That file is the same thing the plugin serves from memory — the part of your
module the test needs, then the test — except it is real, so everything that
works on a test file works on it. Run it (`npx vitest run
src/counter.Counter_Chainable.temp.ts`), put a breakpoint in it and debug it,
edit it to try something out, delete it when you are done.

The plugin adds `**/*.temp.ts` to Vitest's `include`, since no project's own
`include` is written to catch them. Change the glob, or turn it off, with the
`extracted` option — and add `*.temp.ts` to your `.gitignore`: they are scratch.

```ts
namespaceTests({ extracted: "**/*.scratch.ts" }); // or `extracted: false`
```

The editor extension extracts on a click, and puts Run, Debug and Delete at the
top of the file it wrote.

Extracting is usually instant, because a run has already printed every test in
the file: the library's `cli.mts` answers from the cache without loading a
compiler at all. It only does the work when nothing has run yet.

```
node <path-to-library>/cli.mts src/counter.ts "Counter > Chainable" [--root <ns>]
node <path-to-library>/cli.mts src/counter.ts "Counter > Chainable" --served
node <path-to-library>/cli.mts src/counter.ts --collector
node <path-to-library>/cli.mts --help
```

What you get is the test, not quite what a run serves: a run also gives each
test its own copy of the first-party modules it reaches, by tagging their
specifiers. `--served` prints that form instead, and shows a table for what it
is — one module per row, not one file with several tests in it. It matters when
the modules under test hold state, which is why an extract of several tests says
so in its header.

## Where things are written

One directory, and it is not in your project: **`.derived/`, inside the
library's own folder**.

```
.derived/
├── diagnostics.json   what the printer could not turn into a value, and the mistakes it explains
├── results.json       what the reporter saw: each failure's diff, and what a display page shows
└── cache/             only ever an optimisation; delete it freely
    ├── minimal/       tests the printer has already written out
    └── node/          the compiled form of the modules a command loads
```

The name is the point: nothing in it is authored. Every file is derived from
your source, by this library, for this library — so none of it is yours to read
or edit, and deleting any of it costs nothing but the time to write it again.
The two JSON files are how the editor learns what happened; `cache/` is what
makes it fast. Printed tests are keyed by the source they came from _and_ by the
version of the printer, so a changed printer never hands back stale work; Node's
cache holds the compiled form of the modules a command loads, which is what
keeps extracting a test at around 20ms rather than 250ms.

It writes a `.gitignore` of `*` beside itself the first time it is used, so it
stays out of git — and out of whatever else reads your tree. There is nothing to
configure.

To start over:

```
node <path-to-library>/cli.mts --clean-extracted [dir]   # extracted tests, searched recursively from dir (default: cwd)
node <path-to-library>/cli.mts --clean-cache             # printed tests, and Node's compiled modules
node <path-to-library>/cli.mts --clean [dir]             # both of the above
```

An extracted test is recognised by the header the editor writes, not by its
name, so a file of yours that happens to end in `.temp.ts` is left alone — as is
one that has been edited since it was extracted, unless you add `--force`. The
cache is only an optimisation; `diagnostics.json` and `results.json`, which the
editor reads, stay.

`NAMESPACE_TESTS_DIR` moves it, which the library's own end-to-end test needs so
that a run inside a run does not write over what the outer one wrote. There is
no reason to set it otherwise.

## Scripts

Run from the library's folder:

| Script                        | What it does                                                           |
| ----------------------------- | ---------------------------------------------------------------------- |
| `npm run install-extension`   | builds, packages and installs the [editor extension](./vscode-extension/README.md) into VS Code (or VSCodium, Cursor) |
| `npm run build-extension`     | only builds it                                                         |
| `npm run clean-cache`         | deletes the printer's cache, as `--clean-cache` does                   |
