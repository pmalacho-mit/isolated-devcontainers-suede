import type fs from "node:fs";
import type { Table } from "./dsl.import.meta.vitest.ts";

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "out",
  "coverage",
]);

export const isSearchable = (directory: fs.Dirent) =>
  !directory.name.startsWith(".") && !SKIPPED_DIRECTORIES.has(directory.name);

// the name carries `import.meta.vitest`, which is what makes Vitest collect a module importing it
export const DSL_FILE = "dsl.import.meta.vitest.ts";

// a specifier may leave off the extension
export const isDslModule = (name: string) => {
  const base = name.slice(name.lastIndexOf("/") + 1);
  return base === DSL_FILE || `${base}.ts` === DSL_FILE;
};

declare namespace isDslModule {
  export type Names = Table<
    typeof isDslModule,
    [
      [args: ["/repo/release/dsl.import.meta.vitest.ts"], expected: true],
      [args: ["namespace-tests/dsl.import.meta.vitest"], expected: true],
      [args: ["./dsl.import.meta.vitest.ts"], expected: true],
      [args: ["./my-dsl.import.meta.vitest.ts"], expected: false],
      [args: ["./dsl.import.meta.vitest.ts.bak"], expected: false],
    ]
  >;
}
