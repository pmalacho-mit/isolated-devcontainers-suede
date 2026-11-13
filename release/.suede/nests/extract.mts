import { createHash } from "node:crypto";

import { perTestFile } from "./vite-plugin/collector.mts";

import type { Call, Expect, Invoke, Table } from "./dsl.import.meta.vitest.ts";

export const SUFFIX = ".temp.ts";

export const tempPathFor = (source: string, testName: string) =>
  perTestFile(source, testName, SUFFIX);

declare namespace tempPathFor {
  /** beside the module, named for the module and the test */
  export type Names = Table<
    typeof tempPathFor,
    [
      [
        args: [source: "src/counter.ts", test: "Counter > Chainable"],
        expected: "src/counter.Counter_Chainable.temp.ts",
      ],
      [
        args: [source: "src/codec.mts", test: "encode > Tagged[1]"],
        expected: "src/codec.encode_Tagged[1].temp.ts",
      ],
    ]
  >;
}

const withOneTrailingNewline = (body: string) => body.replace(/\s*$/, "\n");

const fingerprint = (body: string) =>
  createHash("sha256")
    .update(withOneTrailingNewline(body))
    .digest("hex")
    .slice(0, 12);

const hasSeveralTests = (body: string) =>
  (body.match(/^test[.(]/gm) ?? []).length > 1;

const importsFirstParty = (body: string) => /^import .*from ["']\./m.test(body);

const SHARED_IMPORTS_NOTE =
  "// These tests share module state here (unlike when run as typescript-namespace-tests, where each gets its own copy of every local module).";

// The header is written by `headerLines` and read by `HEADER`: keep them together.
const MARK = "namespace-tests:";

const headerLines = (source: string, testName: string, body: string) => [
  `// ${MARK} ${source} > ${JSON.stringify(testName)} [${fingerprint(body)}]`,
  "// Yours to run, debug and edit. Delete it when you are done.",
  ...(hasSeveralTests(body) && importsFirstParty(body)
    ? [SHARED_IMPORTS_NOTE]
    : []),
];

const HEADER = new RegExp(
  `^// ${MARK} (.+?) > ("(?:[^"\\\\]|\\\\.)*") \\[([0-9a-f]+)\\]$`,
);

const parseHeader = (line: string | undefined) => {
  const match = HEADER.exec(line ?? "");
  if (!match) return null;
  const [source = "", quoted = '""', written = ""] = match.slice(1);
  return { source, test: JSON.parse(quoted) as string, fingerprint: written };
};

const bodyOf = (text: string) =>
  text
    .split("\n")
    .slice(text.split("\n").indexOf("") + 1)
    .join("\n");

export const extract = (source: string, testName: string, body: string) =>
  [
    ...headerLines(source, testName, body),
    "",
    withOneTrailingNewline(body),
  ].join("\n");

export function extracted(text: string) {
  const header = parseHeader(text.split("\n")[0]);
  if (!header) return null;
  return {
    source: header.source,
    test: header.test,
    edited: fingerprint(bodyOf(text)) !== header.fingerprint,
  };
}

declare namespace extracted {
  type Body = "test('x', () => {});";
  type File = Invoke<
    typeof extract,
    ["src/counter.ts", "Counter > Chainable", Body]
  >;

  /** an extracted file knows the module and the test it came from */
  export type Origin = Expect<
    Invoke<typeof extracted, [File]>,
    "matches",
    { source: "src/counter.ts"; test: "Counter > Chainable"; edited: false }
  >;

  /** the same file, with a body that is no longer the one it was written with */
  type Worked = Call<
    File,
    "replace",
    [Body, "test('x', () => { expect(1).toBe(1); });"]
  >;

  /** a body that no longer matches its fingerprint is one someone worked on */
  export type Edited = Expect<
    Invoke<typeof extracted, [Worked]>,
    "matches",
    { edited: true }
  >;

  /** several tests in one file share module state, and it says so */
  export type Warns = Expect<
    Invoke<
      typeof extract,
      [
        source: "src/a.ts",
        testName: "a > Rows",
        body: 'import { f } from "./m.ts";\ntest("one", () => {});\ntest("two", () => {});',
      ]
    >,
    "includes",
    "These tests share module state here"
  >;

  /** one test has nothing to share with, so it is not told about it */
  export type Quiet = Expect<
    Invoke<
      typeof extract,
      [
        "src/a.ts",
        "a > One",
        'import { f } from "./m.ts";\ntest("one", () => {});',
      ]
    >,
    "excludes",
    "share module state"
  >;

  /** nor is a file whose tests import nothing of yours */
  export type NoImports = Expect<
    Invoke<
      typeof extract,
      ["src/a.ts", "a > Rows", 'test("one", () => {});\ntest("two", () => {});']
    >,
    "excludes",
    "share module state"
  >;

  /** anything else is just a file */
  export type NotOurs = Expect<
    Invoke<typeof extracted, ["const x = 1;"]>,
    "is",
    null
  >;
}
