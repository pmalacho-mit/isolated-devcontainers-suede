import { SUFFIX as GENERATED } from "../../vite-plugin/collector.mts";

import type { Expect, Invoke, Table } from "../../dsl.import.meta.vitest.ts";

export type Failure = {
  name: string;
  message: string;
  diff?: string | null;
  where?: string | null;
  stack?: string | null;
};

// a generated test is served from memory, so a frame in it opens nothing
const NOT_YOURS = ["node_modules", "node:internal", "(native)", GENERATED];

const isYours = (frame: string) => !NOT_YOURS.some((part) => frame.includes(part));

export function frames(stack: string | null | undefined): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at ") && isYours(line));
}

export function explain(failure: Failure): string {
  const { name, message, diff, where, stack } = failure;
  const parts = [where ? `${name} — ${where}` : name, "", message];
  if (diff) parts.push("", diff.replace(/\s+$/, ""));
  const rest = frames(stack);
  if (rest.length) parts.push("", ...rest);
  return parts.join("\n");
}

declare namespace frames {
  type Stack = `AssertionError: nope
    at Proxy.<anonymous> (/repo/node_modules/vitest/dist/chunks/index.js:2040:10)
    at /repo/examples/parser.parse_Negation.namespace.test.ts:75:29
    at processTicksAndRejections (node:internal/process/task_queues:104:5)`;

  type Thrown = `RangeError: initial must be an integer
    at new Counter (/repo/examples/counter.ts:12:13)
    at /repo/examples/counter.Counter_Rejects.namespace.test.ts:30:5
    at processTicksAndRejections (node:internal/process/task_queues:104:5)`;

  /** your code is what is left: the runner's frames and the generated one go */
  export type Yours = Expect<
    Invoke<typeof frames, [Thrown]>,
    "=",
    ["at new Counter (/repo/examples/counter.ts:12:13)"]
  >;

  /** a failure inside the generated test alone has no frame worth showing */
  export type NothingToOpen = Expect<Invoke<typeof frames, [Stack]>, "=", []>;

  export type Missing = Table<
    typeof frames,
    [[args: [null], expected: []], [args: [""], expected: []]]
  >;
}

declare namespace explain {
  /** the message, then what it expected against what it got, then where */
  export type WithDiff = Expect<
    Invoke<
      typeof explain,
      [
        {
          name: "parse > Negation";
          message: "expected { kind: 'neg' } to match object { kind: 'neg' }";
          diff: "- Expected\n+ Received\n\n-   4\n+   5\n";
          where: "examples/parser.ts:37";
        },
      ]
    >,
    "=",
    `parse > Negation — examples/parser.ts:37

expected { kind: 'neg' } to match object { kind: 'neg' }

- Expected
+ Received

-   4
+   5`
  >;

  /** with nothing to diff — a printer error, say — just the message */
  export type WithoutDiff = Expect<
    Invoke<
      typeof explain,
      [{ name: "wrong > NotAValue"; message: "cannot materialize" }]
    >,
    "=",
    "wrong > NotAValue\n\ncannot materialize"
  >;
}
