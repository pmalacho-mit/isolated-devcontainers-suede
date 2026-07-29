# typescript-dsl-suede

Write a DSL in TypeScript's **type system**, read it back with the compiler API,
and surface it in the editor. The declarations erase completely at build time.

Vendored as source — no build step, no published package. An extension's bundler
compiles these `.ts` files straight into its output.

## The contract is one interface

```ts
interface Analyzer<T> {
  gates?: readonly string[];              // cheap substring prefilter
  analyze(source: SourceFile): Finding<T>[];
}

interface Finding<T> {
  id: string;          // stable within the file across edits
  label?: string;
  range: SourceRange;  // where it is — lenses, squiggles and edits anchor here
  data: T;             // yours: an artifact, a verdict, an annotation
}
```

That's it. The library has **no opinion** about how your constructs are named,
where they're declared, or what they produce. There is no required "root"
construct, no required namespace layout, and nothing that assumes your DSL
renders to text.

Everything else here is either a *helper for reading types* or *plumbing for
getting findings in front of a developer*.

```
typescript-dsl-suede/
  analyze.ts       the contract: Finding, Analyzer, SourceRange, SourceEdit
  discover.ts      ways to find your constructs (all optional)
  parse.ts         readers: syntax view and checker view
  runner.ts        defineDsl → files / code / source / createSession
  session.ts       DslSession — long-lived project, buffers, deps, edits
  common.ts        optional conventions: AnyType, Options<>, indent
  presets/
    dispatch.ts    construct → handler map; a convenience, not the architecture
  vscode-extension/
    extension.ts   the harness: findings → hover, lenses, diagnostics, commands
    webview.ts     opt-in preview host page (CSP, pan/zoom, theming)
    builder.mjs    esbuild bundling + asset packaging
    installer.mjs  npm → bundle → typecheck → vsix → install
    scaffold.mjs   writes a complete, buildable extension
```

---

## The `dispatch` preset: construct → handler

Writing `analyze` by hand is always available. But most DSLs boil down to *"here
are the type usages I recognize, and here is the function that handles each"* —
so that's what the preset lets you say:

```ts
import { createAnalyzer } from "./typescript-dsl-suede/presets/dispatch.js";

export const analyzer = createAnalyzer({
  name: "my-dsl",
  handlers: {
    "Flowchart.Diagram": Flowchart.render,
    "Sequence.Diagram":  Sequence.render,
  },
});
```

A key names a construct; the value is the function that receives the matching
`TypeNode`. Nothing here is privileged: no "root" construct, no requirement that
keys be namespaced, and **no requirement that a handler produce text** — `T` is
whatever your handlers return.

**Keys** match the type reference's name. `"Flowchart.Diagram"` requires the
qualifier; `"Diagram"` accepts any. Qualifiers resolve through import aliases, so
`import { Flowchart as F }` and `F.Diagram<…>` still match.

**`scan`** decides where to look, and is the difference between the two DSLs
below:

| | |
|---|---|
| `"declarations"` (default) | type aliases whose type *is* one of your constructs. The finding is named after the alias. |
| `"references"` | every use of a construct anywhere — nested in a namespace, a tuple, another type, a return position. |

**Gates are derived** from the keys (`"Flowchart.Diagram"` → `"Diagram<"`), so
the editor's prefilter stays in sync automatically.

**`transform`** post-processes every handler result — useful for something applied
uniformly that you'd otherwise repeat in each handler.

**`identify`** overrides how findings are named and anchored; by default a finding
takes its enclosing alias's namespace-qualified name (`Test.Simple`) and its name
node's range, falling back to the usage itself.

### A. Declarations that render to text

```ts
export type Deploy = Flowchart.Diagram<"topdown", [...]>;
```

```ts
export const analyzer = createAnalyzer({
  name: "typescript2mermaid",
  handlers: {
    "Flowchart.Diagram": Flowchart.render,
    "Sequence.Diagram":  Sequence.render,
    /* … */
  },
  // One theme prologue for every diagram, rather than repeated in each renderer.
  transform: (code, node) => renderOptions(optionsOf(node)) + code,
});
```

→ `Finding<string>`, where `data` is the rendered artifact.

### B. Constructs used inline, results are verdicts

```ts
import type { Case, Snapshot } from "my-test-dsl";

const someFn = (x: number, y: number) => x + y;

export namespace Test {
  export type Simple  = Case<typeof someFn, [2, 3], 5>;
  export type Snapped = Case<typeof someFn, [2, 3], Snapshot>;
}
```

Same preset. Different scan mode, and a handler that returns a verdict instead of
text:

```ts
export const analyzer = createAnalyzer<CaseResult>({
  name: "my-tests",
  scan: "references",
  importedFrom: "my-test-dsl",        // ignore a local type named `Case`
  handlers: { Case: (node) => evaluate(node) },
});
```

→ `Finding<CaseResult>`, ids like `Test.Simple` and `Test.Nested.Deep`.

`Snapshot` fills itself in by returning an edit in `data`:

```ts
{ verdict: "snapshot", fix: editRange(rangeOf(expected), actualTypeText) }
```

which a command applies (see `commands` below).

---

## Finding your constructs

A menu, not a mandate. An `Analyzer` is free to walk the AST however it likes.

| | |
|---|---|
| `typeAliases(source, query)` | aliases **including inside namespaces**, filtered by export / namespace / name |
| `typeReferences(source, name, { importedFrom, outermostOnly })` | every use of a construct anywhere, guarded by its import |
| `constructClassifier(kinds, { qualifier, declaredWithin })` | node → which of `kinds` it is, or `undefined` (see below) |
| `matchesConstruct(node, parseConstruct("Ns.Name"), { declaredWithin })` | the single-pattern test the classifier is built from |
| `resolveConstruct(node)` / `isDeclaredWithin(node, root)` | the checker's answer: where is this type actually declared? |
| `namespacePath(node)` / `qualifiedName(decl)` | `["Test","Unit"]` / `"Test.Unit.Simple"` — a good stable `Finding.id` |
| `enclosingTypeAlias(node)` | the declaration a nested construct belongs to |
| `unwrapMarkers(type, isMarker)` | peel identity annotations (`Secret<string>` *is* `string`) |
| `rangeOf(node)` | the anchor for every editor surface |

### Telling your constructs apart from user types

When a DSL accepts the user's *own* types in the same position as its constructs
— a flowchart node written beside a `Connect<…>` statement — matching by bare
name collides: a user type happening to be called `Connect` is not your
statement. There are two strengths of guard.

**Qualifier** (syntactic). Require the namespace: only `Flowchart.Connect<…>`
matches, a bare `Connect` falls through. It resolves through import aliases
(`import { Flowchart as F }`, `F.Connect<…>` still matches) and works even when
the import doesn't resolve — but a user who declares their *own* `namespace
Flowchart` would slip through.

**Identity** (`declaredWithin`, the strongest). Require the reference to resolve
to a declaration inside your source. A user type — even one under a shadow
`namespace Flowchart` — is declared elsewhere and is rejected with certainty. The
name and qualifier still *route* among your constructs (they tell
`Flowchart.Diagram` from `Sequence.Diagram`, both named `Diagram`); identity is
the *gate* that a match is genuinely yours.

```ts
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const LIBRARY_ROOT = dirname(fileURLToPath(import.meta.url)); // your vendored root

const statementKind = constructClassifier(
  ["Connect", "Node", "Subgraph"] as const,
  { qualifier: "Flowchart", declaredWithin: LIBRARY_ROOT },
);
statementKind(node); // "Connect" | "Node" | "Subgraph" | undefined
```

The trade-off identity makes: it **requires the reference to resolve**, so an
unresolved import matches nothing. For a library vendored as source and imported
by relative path that is the right call — imports are written once and resolve;
a same-named user type never does. `dispatch`'s `createAnalyzer` takes the same
`declaredWithin` to gate top-level construct detection, and `defineDsl`'s
`{ resolveImports: true }` makes `code()` resolve a snippet's imports so identity
works there too. Omit both `qualifier` and `declaredWithin` to match on name
alone, for a DSL whose constructs are not namespaced.

## Reading them

Two views, and choosing correctly between them is the core skill.

**Syntax** (`TypeNode`) is what the user typed — names, literals, markers, source
positions. Use it for **identity**: `lastName`, `refName`, `qualifierOf`,
`argsOf`, `strOf` / `numOf` / `boolOf`, `tupleOf`, `resolveAlias`.

**Semantics** (`Type`, via the checker) is what it *means* after resolution
through aliases, intersections, conditionals, generics. Use it for **structure
and value**: `resolveMembers` / `safeMembers`, `numericLiteralProps`, and
anything you reach through ts-morph directly (`getCallSignatures()`,
`isAssignableTo()`, …).

`resolveAlias` is deliberately conservative — it only follows a reference with no
type arguments naming an alias with no type parameters. Over-resolving destroys
identity: resolving `Compile` down to its `{ … }` body erases the name that
identifies it.

`failWith("my-dsl")` gives a `fail` that throws a `DslError` carrying the
offending node; `locationOf(node)` turns that into file/line/offset — which is
all a `DiagnosticCollection` needs.

## Running it

```ts
const runner = defineDsl(analyzer);

runner.files(paths, tsconfig?)   // batch / CLI
runner.code(text, fileName?)     // in-memory — every test is a string in, findings out
runner.source(sourceFile)        // an already-loaded file
runner.createSession(tsconfig?)  // long-lived, for editors
runner.gates                     // hand straight to the extension
```

`DslSession` additionally offers `updateFile` (push an unsaved buffer),
`dependencies` (the transitive import graph), `applyEdits` (back-to-front,
multi-file), and `sourceFile` for actions that need the nodes.

---

## The VSCode harness

The harness knows exactly one thing about your DSL: it produces findings anchored
to ranges. Everything else is a contribution.

```ts
activateDslExtension(ctx, {
  id: "tsTest",                                    // → tsTest.showLog, tsTest.<key>
  name: "ts-test",
  gates: runner.gates,
  createSession: (tsconfig) => runner.createSession(tsconfig),

  hover: (f, api) => `**${f.label}** — ${f.data.verdict}`,

  lenses: (f) => [
    { title: f.data.verdict === "pass" ? "✔ passing" : "✘ failing" },
    ...(f.data.fix ? [{ title: "Accept snapshot", command: "accept" }] : []),
  ],

  diagnostics: (f) =>
    f.data.verdict === "pass" ? [] : [{ message: f.data.message, severity: "error" }],

  commands: {
    accept: async (f, ctx) => {
      await ctx.applyEdits([f.data.fix]);
      await ctx.refresh();
      ctx.info(`snapshot updated: ${f.label}`);
    },
  },

  preview: { /* opt-in; omit entirely for DSLs with nothing to render */ },
});
```

- **Every contribution is optional.** A test DSL uses diagnostics and commands and
  no preview; a diagram DSL uses hover and preview and no diagnostics.
- **Diagnostics and lenses take editor-free shapes** (`{ message, severity }`,
  `{ title, command }`), so your DSL logic stays testable without importing
  `vscode`.
- **Lenses anchor to `finding.range`** — which means they work on declarations
  nested in namespaces, on inline uses, anywhere. No regex hunting for `type X`.
- **`commands` receive a freshly re-analyzed finding** plus `applyEdits`,
  `refresh`, and message helpers. Registered as `${id}.${key}`; reference one from
  a lens with `command: "accept"` or from hover with `api.commandLink(f, "accept", …)`.
- **Supplying `diagnostics` turns on document tracking**: every visible document
  stays analyzed and re-runs when its dependencies change, with no preview open.

### What the live-update engine handles

Four signals feed one debounced refresh: buffer edits, a filesystem watcher (for
changes made outside the editor), a **transitive dependency filter**, and a diff
against the last pushed artifact.

The dependency part is easy to miss and is the difference between a demo and a
tool: your findings usually depend on types declared in *other* modules, so
editing a different file changes the result. Watching only the open file appears
broken in exactly the cases that make the DSL worth using.

Also handled: unsaved buffers beat disk; cache invalidation when a dependency
(not the document) changes; path normalization so lookups don't silently miss on
Windows; re-deriving dependencies after every analysis, since an edit can add or
remove an import; preserving the viewer's pan/zoom across a re-render; and staying
quiet when half-typed code fails to analyze — unless you supply `onError`.

### The preview renderer contract

`bootstrap` is JS injected into the webview. It must define `globalThis.DslRenderer`:

```js
globalThis.DslRenderer = {
  init(dark) { renderer.configure({ theme: dark ? "dark" : "light" }); },
  render(code, seq) { return renderer.toSvg(code); },   // string | Promise<string>
};
```

The host page owns CSP + nonce, editor theme variables, the pan/zoom viewport, the
error pane, the log bridge to the output channel, and the live re-render loop. SVG
output is sized from its `viewBox`; anything else from its bounding box.
`previewHtml` is exported separately and takes only `{ cspSource }`, so the page
can be exercised headlessly.

---

## Build, install, scaffold

**`builder.mjs`** bundles to one self-contained file. `vscode` stays external;
your vendored library source is compiled straight in, so there is no separate
library build. Assets are copied with mode pinned to `0644` and readability
*proven* — `existsSync` is true for files you cannot open, and an unreadable asset
silently degrades the preview to raw text on every machine whose filesystem
enforces permissions. esbuild is resolved from the *extension's* `node_modules`
first, which is what makes a genuinely vendored layout work.

```js
await buildExtension({
  root,
  alias: { "my-dsl-lib": ["../index.ts", "../src/index.ts"] },   // first existing wins
  assets: [{ from: "node_modules/renderer/dist/renderer.min.js", to: "media/renderer.min.js" }],
});
```

`@dsl-suede`, `@dsl-suede/vscode` and `@dsl-suede/webview` are aliased
automatically. Mirror your own aliases into `tsconfig.json` `paths` or `tsc` and
the bundle will disagree about what the imports mean.

**`installer.mjs`** — `npm install` → bundle → typecheck → `vsce package` →
install into the first VSCode-family CLI on `PATH` (`code`, `code-insiders`,
`codium`, `cursor`). No marketplace, no publisher account.

**`scaffold.mjs`** writes the whole extension — `package.json`, `tsconfig.json`
(paths already mirroring the build aliases), `.vscodeignore`, `.gitignore`,
`build.mjs`, `install.mjs`, `install.sh`, `src/extension.ts`. Everything it emits
is a thin shim over the three modules above, so regenerating after a library
update is safe.

```
node typescript-dsl-suede/vscode-extension/scaffold.mjs ../my-extension \
  --id pipeDsl --name pipeline-dsl --display "Pipeline DSL" \
  --lib my-dsl-lib --lib-path ../index.ts --hover-language yaml
```

As a module, which is the only way to configure a preview renderer:

```js
scaffold({
  root: "../my-extension",
  id: "pipeDsl", name: "pipeline-dsl",
  lib: { alias: "my-dsl-lib", candidates: ["../index.ts"] },
  codeOf: "(f) => f.data.code",          // the one line every DSL must set
  renderer: { npm: "renderer", npmVersion: "^11.0.0", asset: "dist/renderer.min.js", bootstrap },
});
```

Then `cd ../my-extension && ./install.sh`, reload the window, and hover a
declaration.
