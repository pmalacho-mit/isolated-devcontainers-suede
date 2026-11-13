// Stands in for "@typescript/typescript6" in the bundle: see the alias in build.mjs.
import { createRequire } from "node:module";
import path from "node:path";

import type TS from "@typescript/typescript6";
import type { Expect, Invoke } from "../../dsl.import.meta.vitest.ts";

const resolveFrom = (dir: string): typeof TS | null => {
  try {
    const require = createRequire(path.join(dir, "noop.js"));
    return require(require.resolve("@typescript/typescript6")) as typeof TS;
  } catch {
    return null;
  }
};

const loaded = new Map<string, typeof TS | null>();

export const typescriptOf = (dir: string) => {
  if (!loaded.has(dir)) loaded.set(dir, resolveFrom(dir));
  return loaded.get(dir) ?? null;
};

let from = process.cwd();

export function parseWithTypeScriptOf(dir: string): boolean {
  from = dir;
  return typescriptOf(dir) !== null;
}

export default new Proxy({} as typeof TS, {
  get(_, key) {
    const ts = typescriptOf(from);
    if (!ts)
      throw new Error(`namespace-tests: no TypeScript to parse with from ${from}`);
    return ts[key as keyof typeof TS];
  },
});

declare namespace typescriptOf {
  /** this repository has one, as any project using the library does */
  export type Found = Expect<
    Invoke<typeof typescriptOf, ["."]>,
    "defined"
  >;

  /** and nothing above it can be found from the root of the filesystem */
  export type Missing = Expect<Invoke<typeof typescriptOf, ["/"]>, "is", null>;
}
