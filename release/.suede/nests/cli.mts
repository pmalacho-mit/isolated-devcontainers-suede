#!/usr/bin/env node
import fs from "node:fs";
import module from "node:module";
import path from "node:path";

import { cli, main } from "./vendored/typescript-cli-suede/index.ts";
import { SUFFIX, extracted } from "./extract.mts";
import { isSearchable } from "./workspace.mts";
import {
  cacheKey,
  caches,
  compileCacheDir,
  ensureDerived,
  read,
  write,
} from "./vite-plugin/cache.mts";

import type { Expect, Invoke, Table } from "./dsl.import.meta.vitest.ts";

const DESCRIPTION = [
  "Print a namespace test as a standalone Vitest file.",
  "",
  "  cli.mts <file> <test>            the test, as it would be extracted",
  "  cli.mts <file> <test> --served   as a run serves it, imports tagged per test",
  "  cli.mts <file> --collector       the module Vitest is handed for the file",
  "  cli.mts --clean [dir]            delete the cache, and the extracted tests",
  "                                   under dir (default: the working directory)",
].join("\n");

/**
 * What was asked for, read off an argv. Kept apart from acting on it, so the
 * reading can be tested without a process.
 */
const parse = (argv: string[]) => {
  const args = main(argv, DESCRIPTION, [
    cli.flag("root", "Only look inside this namespace."),
    cli.flag(
      "served",
      "Print the test as the plugin serves it: every first-party import tagged, so each test gets its own copy.",
      false,
    ),
    cli.flag(
      "collector",
      "Print the module Vitest is handed for the file, instead of one test.",
      false,
    ),
    cli.flag(
      "clean-extracted",
      "Delete extracted tests, searched for recursively from the positional directory argument (default: the current working directory). One edited since it was extracted is kept, unless --force.",
      false,
    ),
    cli.flag(
      "clean-cache",
      "Delete what the library has cached: printed tests, and Node's compiled modules.",
      false,
    ),
    cli.flag("clean", "Both of the above.", false),
    cli.flag(
      "force",
      "With --clean-extracted, delete edited extracts too.",
      false,
    ),
  ]);
  return {
    file: args[0],
    test: args[1],
    mode: args.collector ? "collector" : args.served ? "served" : "test",
    root: args.root,
    clean: {
      extracted: args.clean || args["clean-extracted"],
      cache: args.clean || args["clean-cache"],
      force: args.force,
    },
    help: args.help,
  } as const;
};

type Parsed = ReturnType<typeof parse>;

declare namespace parse {
  /** a file and a test: the test, as it would be extracted */
  export type Test = Expect<
    Invoke<typeof parse, [argv: ["src/a.ts", "a > B"]]>,
    "matches",
    { file: "src/a.ts"; test: "a > B"; mode: "test" }
  >;

  export type Served = Expect<
    Invoke<typeof parse, [argv: ["src/a.ts", "a > B", "--served"]]>,
    "matches",
    { mode: "served" }
  >;

  /** the whole file needs no test to be named */
  export type Collector = Expect<
    Invoke<typeof parse, [argv: ["src/a.ts", "--collector"]]>,
    "matches",
    { file: "src/a.ts"; test: undefined; mode: "collector" }
  >;

  /** a flag may come first: a boolean takes nothing from what follows it */
  export type FlagFirst = Expect<
    Invoke<typeof parse, [argv: ["--collector", "src/a.ts"]]>,
    "matches",
    { file: "src/a.ts"; mode: "collector" }
  >;

  /** `--clean` is both kinds of cleaning, and neither needs a test named */
  export type Clean = Expect<
    Invoke<typeof parse, [argv: ["--clean"]]>,
    "matches",
    { file: undefined; clean: { extracted: true; cache: true; force: false } }
  >;

  /** each kind on its own, and where to look */
  export type CleanOne = Expect<
    Invoke<typeof parse, [argv: ["--clean-extracted", "examples"]]>,
    "matches",
    { file: "examples"; clean: { extracted: true; cache: false } }
  >;

  /** a flag's value is its own, not the next positional */
  export type Root = Expect<
    Invoke<typeof parse, [argv: ["src/a.ts", "a > B", "--root", "Tests"]]>,
    "matches",
    { test: "a > B"; root: "Tests" }
  >;
}

function* extractsUnder(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory() && isSearchable(entry)) yield* extractsUnder(at);
    else if (entry.isFile() && entry.name.endsWith(SUFFIX)) yield at;
  }
}

type Verdict = "delete" | "keep" | "ignore";

const verdict = (file: { edited: boolean } | null, force: boolean): Verdict =>
  !file ? "ignore" : file.edited && !force ? "keep" : "delete";

declare namespace verdict {
  export type Rules = Table<
    typeof verdict,
    [
      [args: [file: null, force: true], expected: "ignore"],
      [args: [file: { edited: false }, force: false], expected: "delete"],
      [args: [file: { edited: true }, force: false], expected: "keep"],
      [args: [file: { edited: true }, force: true], expected: "delete"],
    ]
  >;
}

const shown = (file: string) => path.relative(process.cwd(), file);

const report = {
  delete: (file: string) => console.log(`deleted  ${shown(file)}`),
  keep: (file: string) =>
    console.log(
      `kept     ${shown(file)} — edited since it was extracted (--force to delete it too)`,
    ),
  ignore: () => {},
  cleared: (dir: string) => console.log(`cleared  ${shown(dir)}`),
};

const cleanup = {
  extracted(dir: string, force: boolean) {
    for (const file of extractsUnder(dir)) {
      const decided = verdict(extracted(fs.readFileSync(file, "utf8")), force);
      if (decided === "delete") fs.rmSync(file);
      report[decided](file);
    }
  },

  cache() {
    for (const dir of caches.filter((dir) => fs.existsSync(dir))) {
      fs.rmSync(dir, { recursive: true, force: true });
      report.cleared(dir);
    }
  },
};

const tryCacheNodeCompilation = () => {
  ensureDerived();
  if (!process.env.NODE_COMPILE_CACHE)
    module.enableCompileCache?.(compileCacheDir);
};

const nullPrefixed = <T extends string>(str: T) => `\0${str}` as const;

/**
 * The whole file, and a test as served, are filed under names no test can
 * have, so they never land on a test's own entry.
 */
const cacheName = ({ mode, test }: Pick<Parsed, "mode" | "test">) =>
  mode === "collector"
    ? nullPrefixed(mode)
    : mode === "served"
      ? nullPrefixed(`served ${test}`)
      : test!;

const tryRetrieveFromCache = ({ file, mode, test, root }: Parsed) => {
  if (!file || !fs.existsSync(file)) return { key: null, hit: null };
  const source = fs.readFileSync(path.resolve(file), "utf8");
  const key = cacheKey(source, cacheName({ mode, test }), root, path.resolve(file));
  return { key, hit: read(key) };
};

const cleanUp = ({ file, clean }: Parsed) => {
  // no compile cache here: Node writes it on exit, and would recreate what was cleared
  if (clean.extracted)
    cleanup.extracted(path.resolve(file ?? "."), clean.force);
  if (clean.cache) cleanup.cache();
};

const wantsCleaning = ({ clean }: Parsed) => clean.extracted || clean.cache;

async function print(parsed: Parsed) {
  const { file, test, mode, help } = parsed;
  tryCacheNodeCompilation();

  if (!file || (mode !== "collector" && !test)) {
    console.error(help());
    process.exit(2);
  }

  const { hit, key } = tryRetrieveFromCache(parsed);

  if (hit !== null) process.stdout.write(hit);
  else {
    const printer = await import("./vite-plugin/minimal.mts");
    const text =
      mode === "collector"
        ? printer.collectorFor(file, parsed)
        : mode === "served"
          ? await printer.servedFor(file, test!, parsed)
          : printer.minimalFor(file, test!, parsed);

    // `minimalFor` caches its own answer...
    // but `collectorFor` and `servedFor` don't, so do it here
    if (key && mode !== "test") write(key, text);

    process.stdout.write(text);
  }
}

if (cli.entry(import.meta.url)) {
  const parsed = parse(process.argv.slice(2));
  if (wantsCleaning(parsed)) cleanUp(parsed);
  else await print(parsed);
}
