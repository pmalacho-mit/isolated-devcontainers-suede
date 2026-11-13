# Namespace Tests

Type-level tests in the editor.

Every exported test alias — `export type X = Expect<…>`, in any
`declare namespace` of a file that imports the DSL — shows up as a test: in the
Test Explorer, in the gutter, and as a lens above the line you wrote it on.
Running one runs exactly that one.

Install it from the library's folder with `npm run install-extension`: it
builds, packages and installs it into VS Code, VSCodium or Cursor, whichever is
on your path.

- **Run** — a single test, through Vitest, reported back at its own line. A file
  runs when you open or save it, and the lens shows where each test stands.
- **What Vitest sees** — at the top of a file with tests: your file diffed
  against the module Vitest is actually handed, which is your code plus the
  block that imports one generated test per `export type`.
- **Extract** — writes the test out as a real file beside the module it came
  from (`counter.Counter_Chainable.temp.ts`) and opens it: the part of your
  module the test needs, then the test.
- **Run · Debug · Delete · What Vitest sees** — at the top of an extracted
  file. The last diffs your copy against what a run actually serves for that
  test, where every first-party import carries the test's tag: a run gives each
  test its own copy of the modules it reaches, and a file can only hold one. So
  a table extracted into one file shares what a run would have kept apart —
  which is why the header says so when it can bite. *Run* is verbose,
  so every test in the file reports by name. *Debug* launches Vitest under the
  Node debugger on that one file, in a single process, with no test timeout, so
  a breakpoint you are sat on is not a failure. That is where you go to see what
  everything actually held. *Delete* closes the file's editor on the way out.
- **Failures** — clicking a failed lens opens the output with what the test
  expected against what it got, the line you wrote it on, and the frames from
  your own code. The frames from Vitest, chai and Node are dropped, as are the
  ones pointing into the generated test, since that module is served from
  memory and its path opens nothing.
- **Display** — on a test that names an HTML page (`Expect<…, "./chart.html">`),
  opens that page with what the run saw: a chart instead of a wall of numbers.
  The page is found relative to the test's file; a missing one is marked as an
  error where it is named. The page receives a `namespace-tests:result` message
  with `actual`, `expected`, `passed`, `message` and `meta`, decoded so a `Map`
  or a `bigint` arrives as itself. Listen for it before the page finishes
  loading. It can use VS Code's `--vscode-*` theme variables.
- **Diagnostics** — what the printer could not turn into a value, reported where
  you wrote it.
- **Mistakes, explained** — where TypeScript rejects a test, the printer says
  what is wrong in the test's own terms: every bad row of a `Table`, each at the
  cell that is wrong. That cell is outlined, the explanation is written at the
  end of its line, and hovering anywhere in TypeScript's error shows it.

## About extracted files

They are yours. Edit them freely — nothing regenerates them behind your back,
and *Delete* asks first if what is in the file is no longer what was written
out. Extracting again over a file you have edited asks before overwriting.

They end in `.temp.ts`, which the plugin adds to Vitest's `include` so they run
like any other test file. Add `*.temp.ts` to your `.gitignore`.
