import { init, parse } from "es-module-lexer";

import type { ImportSpecifier } from "es-module-lexer";
import type { Expect, Invoke, Table } from "../dsl.import.meta.vitest.ts";

export const FORK = "namespace-test";

export const forkOf = (id: string) => {
  const [file = "", query = ""] = id.split("?");
  const tag = new URLSearchParams(query).get(FORK);
  return tag ? { file, tag } : null;
};

type Edit = { start: number; end: number; text: string };

const splice = (code: string, edits: Edit[]) => {
  let out = "";
  let last = 0;
  for (const { start, end, text } of edits) {
    out += code.slice(last, start) + text;
    last = end;
  }
  return out + code.slice(last);
};

// read off the module's own import statements, never matched as text
const importsIn = async (code: string): Promise<readonly ImportSpecifier[] | null> => {
  try {
    await init;
    return parse(code)[0];
  } catch {
    return null;
  }
};

type FirstParty = ImportSpecifier & { n: string };

export const isFirstPartySpecifier = (specifier: string) => specifier.startsWith(".");

const isFirstParty = (specifier: ImportSpecifier): specifier is FirstParty =>
  !!specifier.n && isFirstPartySpecifier(specifier.n);

const withTag = (spec: string, tag: string) =>
  `${spec}${spec.includes("?") ? "&" : "?"}${FORK}=${tag}`;

// a static import's span is inside its quotes; a dynamic one's is the whole literal
const retagged = ({ n, s, e, d }: FirstParty, tag: string): Edit => ({
  start: s,
  end: e,
  text: d > -1 ? JSON.stringify(withTag(n, tag)) : withTag(n, tag),
});

export async function fork(code: string, tag: string): Promise<string> {
  const imports = await importsIn(code);
  if (!imports) return code;
  return splice(
    code,
    imports.filter(isFirstParty).map((specifier) => retagged(specifier, tag)),
  );
}

declare namespace fork {
  /** a first-party import becomes this test's own copy of that module */
  export type Tags = Expect<
    Invoke<typeof fork, ['import { a } from "./m.ts";', "t"]>,
    "=",
    'import { a } from "./m.ts?namespace-test=t";'
  >;

  /** a package is not ours to fork: Node would not know the query */
  export type LeavesPackages = Expect<
    Invoke<typeof fork, ['import ts from "typescript";', "t"]>,
    "=",
    'import ts from "typescript";'
  >;

  /** a string that merely looks like one is a string */
  export type LeavesStrings = Expect<
    Invoke<typeof fork, ['const s = \'import { a } from "./m.ts";\';', "t"]>,
    "=",
    'const s = \'import { a } from "./m.ts";\';'
  >;

  /** a dynamic import is rewritten as the literal it was */
  export type Dynamic = Expect<
    Invoke<typeof fork, ['await import("./m.ts");', "t"]>,
    "=",
    'await import("./m.ts?namespace-test=t");'
  >;
}

declare namespace forkOf {
  export type Reads = Table<
    typeof forkOf,
    [
      [args: ["/a/m.ts?namespace-test=t&lang.ts"], cond: "matches", expected: { file: "/a/m.ts"; tag: "t" }],
      [args: ["/a/m.ts"], cond: "is", expected: null]
    ]
  >;
}
