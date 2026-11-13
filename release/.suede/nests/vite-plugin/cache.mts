/// <reference types="node" />
// Imports no TypeScript: the command line answers a cache hit without loading a compiler.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { Table, Invoke } from "../dsl.import.meta.vitest.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const DERIVED =
  process.env.NAMESPACE_TESTS_DIR ?? path.join(scriptDir, "..", ".derived");

const printedTestsDir = path.join(DERIVED, "cache", "minimal");

export const compileCacheDir = path.join(DERIVED, "cache", "node");

export const caches = [printedTestsDir, compileCacheDir];

const ignoreItself = () => {
  const ignore = path.join(DERIVED, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
};

export function ensureDerived(dir = DERIVED): string {
  fs.mkdirSync(dir, { recursive: true });
  ignoreItself();
  return dir;
}

const printerFiles = () => [
  path.join(scriptDir, "minimal.mts"),
  ...fs
    .readdirSync(path.join(scriptDir, "emit"))
    .map((name) => path.join(scriptDir, "emit", name)),
];

const stampOf = (file: string) => {
  const { size, mtimeMs } = fs.statSync(file);
  return `${path.basename(file)}:${size}:${Math.round(mtimeMs)}`;
};

// a changed printer must not be handed what an earlier one wrote
const printerVersion = createHash("sha256")
  .update(printerFiles().map(stampOf).join("|"))
  .digest("hex")
  .slice(0, 8);

// `file` is where the source is: a printed test imports the library relative to it
export const cacheKey = (source: string, testName: string, root = "", file = "") =>
  createHash("sha256")
    .update(`${printerVersion}\0${root}\0${file}\0${testName}\0${source}`)
    .digest("hex")
    .slice(0, 32);

export const memo = new Map<string, string>();

export function read(key: string): string | null {
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const onDisk = path.join(printedTestsDir, `${key}.ts`);
  if (!fs.existsSync(onDisk)) return null;
  const text = fs.readFileSync(onDisk, "utf8");
  memo.set(key, text);
  return text;
}

export function write(key: string, text: string): void {
  memo.set(key, text);
  fs.writeFileSync(
    path.join(ensureDerived(printedTestsDir), `${key}.ts`),
    text,
  );
}

declare namespace cacheKey {
  type Key<
    Source extends string,
    TestName extends string,
    Root extends string | undefined = undefined,
  > = Invoke<typeof cacheKey, [Source, TestName, Root]>;

  /** what a test is filed under depends on everything that shaped it */
  export type Differs = Table<
    typeof cacheKey,
    [
      [args: ["a.ts", "T"], condition: "=", expected: Key<"a.ts", "T">],
      [args: ["a.ts", "T"], condition: "!=", expected: Key<"a.ts", "Other">],
      [
        args: ["a.ts", "T"],
        condition: "!=",
        expected: Key<"different source", "T">,
      ],
      [
        args: ["a.ts", "T", "Tests"],
        condition: "!=",
        expected: Key<"a.ts", "T", "Spec">,
      ],
      [
        args: ["a.ts", "T", "", "./rt.mts"],
        condition: "!=",
        expected: Key<"a.ts", "T">,
      ],
    ]
  >;
}
