import {
  Project,
  type ProjectOptions,
  type SourceFile,
} from "ts-morph";
import {
  passesGates,
  type Analyzer,
  type Finding,
  type SourceEdit,
} from "./analyze.js";

/**
 * A long-lived analysis session for editor integrations.
 *
 * Keeps a ts-morph Project alive across calls so cross-file type resolution
 * works and repeated analysis is cheap, while letting the editor push unsaved
 * buffer contents in via `updateFile`.
 *
 * Nothing here knows what your DSL means; it only runs your `Analyzer`.
 */
export class DslSession<T = unknown> {
  private readonly project: Project;

  constructor(
    private readonly analyzer: Analyzer<T>,
    tsConfigFilePath?: string,
    compilerOptions: ProjectOptions["compilerOptions"] = { strict: true },
  ) {
    this.project = new Project(
      tsConfigFilePath ? { tsConfigFilePath } : { compilerOptions },
    );
  }

  get gates(): readonly string[] {
    return this.analyzer.gates ?? [];
  }

  /** Sync a file's contents (e.g. an unsaved editor buffer) into the project. */
  updateFile(filePath: string, text: string): void {
    const source = this.project.getSourceFile(filePath);
    if (source !== undefined && source.getFullText() !== text)
      source.replaceWithText(text);
    else this.project.createSourceFile(filePath, text, { overwrite: true });
  }

  /** Run the analyzer over a file. Honours `gates`. */
  analyze(filePath: string): Finding<T>[] {
    const source = this.sourceFile(filePath);
    if (!passesGates(source.getFullText(), this.analyzer.gates)) return [];
    return this.analyzer.analyze(source);
  }

  /**
   * Every source file that can affect the findings in `filePath`: the file
   * itself plus everything it transitively imports or re-exports.
   *
   * A DSL's referenced types usually live in *other* modules — the checker
   * resolves them at analysis time — so an editor watching only the open file
   * would miss the edits that actually change the result.
   */
  dependencies(filePath: string): string[] {
    const seen = new Set<string>();
    const queue = [this.sourceFile(filePath)];
    while (queue.length > 0) {
      const current = queue.pop()!;
      const path = current.getFilePath();
      if (seen.has(path)) continue;
      seen.add(path);
      for (const referenced of current.getReferencedSourceFiles())
        if (!seen.has(referenced.getFilePath())) queue.push(referenced);
    }
    return [...seen];
  }

  /**
   * Apply edits to the in-memory project and return the new text per file.
   *
   * Used by DSLs that write back to source — filling in a snapshot, applying a
   * fix, expanding a placeholder. The caller decides what to do with the text
   * (write it to disk, hand it to a `WorkspaceEdit`); this only guarantees that
   * overlapping offsets are applied consistently, back to front.
   */
  applyEdits(edits: readonly SourceEdit[]): Map<string, string> {
    const byFile = new Map<string, SourceEdit[]>();
    for (const edit of edits) {
      const list = byFile.get(edit.file);
      if (list) list.push(edit);
      else byFile.set(edit.file, [edit]);
    }

    const out = new Map<string, string>();
    for (const [file, list] of byFile) {
      const source = this.sourceFile(file);
      let text = source.getFullText();
      // Back to front, so earlier offsets stay valid as later ones are replaced.
      for (const edit of [...list].sort((a, b) => b.start - a.start))
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
      source.replaceWithText(text);
      out.set(file, text);
    }
    return out;
  }

  /** The parsed file, for analyzers and actions that need the nodes themselves. */
  sourceFile(filePath: string): SourceFile {
    return (
      this.project.getSourceFile(filePath) ??
      this.project.addSourceFileAtPath(filePath)
    );
  }

  /** Escape hatch for callers that need the underlying project. */
  get tsProject(): Project {
    return this.project;
  }
}
