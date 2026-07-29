/**
 * Front doors for an `Analyzer`: batch over files, run against a string, run
 * against an already-loaded file, or open a long-lived editor session.
 *
 * This is plumbing only. It adds no opinion about what a DSL looks like — it
 * just carries your analyzer to the three places it needs to run.
 */
import { join } from "node:path";
import { Project, type ProjectOptions, type SourceFile } from "ts-morph";
import { passesGates, type Analyzer, type Finding } from "./analyze.js";
import { DslSession } from "./session.js";

export interface Runner<T> {
  /** The analyzer's cheap substring prefilter, for editors to reuse. */
  readonly gates: readonly string[];
  /** Run against an already-loaded file. */
  source(source: SourceFile): Finding<T>[];
  /** Run against files on disk, honouring a tsconfig when given. */
  files(paths: string[], tsConfigFilePath?: string): Finding<T>[];
  /** Run against a string — the testing front door. See `sourceRoot`. */
  code(text: string, fileName?: string): Finding<T>[];
  /** A long-lived session for editor integrations. */
  createSession(tsConfigFilePath?: string): DslSession<T>;
}

export interface DefineDslOptions {
  compilerOptions?: ProjectOptions["compilerOptions"];
  /**
   * Make `code()` resolve a snippet's imports against the real filesystem.
   *
   * `code()` defaults to an in-memory filesystem, isolated from disk — so a
   * snippet's imports do not resolve. An analyzer that matches constructs by
   * *identity* (`declaredWithin`) needs them to. With this on, the virtual file
   * is placed at the current working directory (outside your vendored library,
   * so the snippet's own declarations are not mistaken for library ones) and its
   * imports are resolved. The snippet must import your library by a specifier
   * that resolves from there — an absolute path is simplest. Nothing is written
   * to disk.
   */
  resolveImports?: boolean;
}

export function defineDsl<T>(
  analyzer: Analyzer<T>,
  { compilerOptions = { strict: true }, resolveImports }: DefineDslOptions = {},
): Runner<T> {
  const source = (file: SourceFile): Finding<T>[] =>
    passesGates(file.getFullText(), analyzer.gates)
      ? analyzer.analyze(file)
      : [];

  return {
    gates: analyzer.gates ?? [],
    source,
    files: (paths, tsConfigFilePath) => {
      const project = new Project(
        tsConfigFilePath ? { tsConfigFilePath } : { compilerOptions },
      );
      const files = paths.map((p) => project.addSourceFileAtPath(p));
      project.resolveSourceFileDependencies();
      return files.flatMap(source);
    },
    code: (text, fileName = "input.ts") => {
      // Real filesystem when imports must resolve, in-memory otherwise. Either
      // way the file is virtual — never written to disk. Placed at cwd so a
      // snippet's own types are declared *outside* the library and cannot pass
      // an identity (`declaredWithin`) check by accident.
      const project = new Project(
        resolveImports
          ? { compilerOptions }
          : { compilerOptions, useInMemoryFileSystem: true },
      );
      const file = project.createSourceFile(
        resolveImports ? join(process.cwd(), fileName) : fileName,
        text,
        { overwrite: true },
      );
      if (resolveImports) project.resolveSourceFileDependencies();
      return source(file);
    },
    createSession: (tsConfigFilePath) =>
      new DslSession(analyzer, tsConfigFilePath, compilerOptions),
  };
}
