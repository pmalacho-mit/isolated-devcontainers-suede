import type {
  Call,
  Construct,
  Expect,
  Invoke,
  Table,
} from "./dsl.import.meta.vitest.ts";

// the separator is the printer's to choose, and a name may come from another version of it
const SEPARATOR = "\\s*[\u203a>]\\s*";

const segmentsOf = (name: string) =>
  name.split(new RegExp(SEPARATOR)).map((segment) => segment.trim());

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const testNameKey = (name: string) => segmentsOf(name).join(">");

export const testFilter = (name: string) =>
  segmentsOf(name).map(escapeRegExp).join(SEPARATOR);

// a table's name answers for every one of its rows
export const answersTo = (name: string, asked: string) => {
  const key = testNameKey(name);
  const wanted = testNameKey(asked);
  return key === wanted || key.startsWith(`${wanted}[`);
};

declare namespace testNameKey {
  /** however the separator is spelled, the same test is the same test */
  export type Spellings = Table<
    typeof testNameKey,
    [
      [args: ["add > Simple"], expected: "add>Simple"],
      [args: ["add \u203a Simple"], expected: "add>Simple"],
      [args: ["a>b>c"], expected: "a>b>c"],
      [args: ["AtTheRoot"], expected: "AtTheRoot"],
    ]
  >;

  /** a table row keeps its index, which is how a row is told from its table */
  export type Rows = Expect<
    Invoke<typeof testNameKey, ["encode \u203a Tagged[1]"]>,
    "=",
    "encode>Tagged[1]"
  >;
}

declare namespace testFilter {
  type TagToFilter = Invoke<typeof testFilter, ["encode > Tagged[1]"]>;

  /** a table row is a name, not a pattern: its brackets are literal */
  export type Rows = Expect<
    TagToFilter,
    "=",
    "encode\\s*[\u203a>]\\s*Tagged\\[1\\]"
  >;

  type TestRegExp<Query extends string> = Call<
    Construct<typeof RegExp, [TagToFilter]>,
    "test",
    [Query]
  >;

  /** it matches the name it was built from */
  export type Matches = Expect<TestRegExp<"encode > Tagged[1]">, "truthy">;

  /** and the same name spelled the other way */
  export type EitherSeparator = Expect<
    TestRegExp<"encode \u203a Tagged[1]">,
    "truthy"
  >;

  /** but not what the unescaped name would have matched */
  export type NotTheClass = Expect<TestRegExp<"encode > Tagged1">, "falsy">;
}

declare namespace answersTo {
  export type Names = Table<
    typeof answersTo,
    [
      [args: ["add > Simple", "add \u203a Simple"], expected: true],
      [args: ["add > Rows[1]", "add > Rows"], expected: true],
      [args: ["add > Rows", "add > Rows[1]"], expected: false],
      [args: ["add > Simpler", "add > Simple"], expected: false],
    ]
  >;
}
