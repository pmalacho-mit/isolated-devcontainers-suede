import path from "node:path";
import type { Table } from "../dsl.import.meta.vitest.ts";

export const posix = (file: string) => file.split(path.sep).join("/");

export const relativeTo = (dir: string, file: string) =>
  posix(path.relative(dir, file));

export const importPath = (importer: string, file: string) => {
  const rel = relativeTo(path.dirname(importer), file);
  return rel.startsWith(".") ? rel : `./${rel}`;
};

declare namespace importPath {
  export type Relative = Table<
    typeof importPath,
    [
      [
        args: [importer: "/p/src/a.ts", file: "/p/src/codec.mts"],
        expected: "./codec.mts",
      ],
      [
        args: [importer: "/p/src/a.ts", file: "/p/lib/codec.mts"],
        expected: "../lib/codec.mts",
      ],
    ]
  >;
}
