/**
 * The one thing every type-level DSL has in common.
 *
 * Whatever your DSL means — a diagram to render, a test case to evaluate, a
 * field to annotate — the shape of the work is the same: read a source file,
 * produce a list of **findings**, each anchored to a source range and carrying
 * whatever payload you care about.
 *
 * That is the entire contract. This library does not know, and must not assume,
 * how your constructs are named, where they are declared, or what they produce.
 */
import type { Node, SourceFile } from "ts-morph";

/** A span in a file. Line/character are 0-based, matching VSCode. */
export interface SourceRange {
  file: string;
  /** Character offsets into the file. */
  start: number;
  end: number;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/** The range of any node — the anchor for lenses, squiggles, and edits. */
export function rangeOf(node: Node): SourceRange {
  const source = node.getSourceFile();
  const start = node.getStart();
  const end = node.getEnd();
  const from = source.getLineAndColumnAtPos(start);
  const to = source.getLineAndColumnAtPos(end);
  return {
    file: source.getFilePath(),
    start,
    end,
    startLine: from.line - 1,
    startCharacter: from.column - 1,
    endLine: to.line - 1,
    endCharacter: to.column - 1,
  };
}

/**
 * One thing your DSL found in a file.
 *
 * `data` is yours — a rendered artifact, a pass/fail verdict, an extracted
 * annotation. The library only requires that a finding be *identifiable* and
 * *locatable*, because those are what editor surfaces need.
 *
 * Keep findings plain and serializable: they are cached, diffed, and sent to
 * webviews. If an action needs a ts-morph node, re-resolve it from the session.
 */
export interface Finding<T = unknown> {
  /**
   * Stable within a file across edits, so an open panel or a running action can
   * be matched to the same thing after re-analysis. A declaration name, a
   * namespace-qualified path, or an index — whatever is stable for your DSL.
   */
  id: string;
  /** Short human-facing name. Defaults to `id` where one is needed. */
  label?: string;
  /** Where it is. Editor surfaces anchor to this. */
  range: SourceRange;
  /** Your payload. */
  data: T;
}

/** A replacement in a file — what a fix, a snapshot update, or a codegen writes. */
export interface SourceEdit {
  file: string;
  start: number;
  end: number;
  text: string;
}

/** An edit that replaces exactly what a range covers. */
export const editRange = (range: SourceRange, text: string): SourceEdit => ({
  file: range.file,
  start: range.start,
  end: range.end,
  text,
});

/**
 * Your DSL, as far as this library is concerned.
 *
 * Implement `analyze` however you like — walk type aliases, scan for a construct
 * by name, look inside a particular namespace, inspect variable declarations.
 * See `discover.ts` for helpers covering the common shapes; none of them are
 * required.
 */
export interface Analyzer<T = unknown> {
  /**
   * Cheap substring prefilter. A file containing none of these is skipped
   * without parsing — the whole performance story for an editor integration.
   * Omit or leave empty to always analyze.
   */
  gates?: readonly string[];
  analyze(source: SourceFile): Finding<T>[];
}

/** True when a file is worth analyzing under `gates`. */
export const passesGates = (
  text: string,
  gates: readonly string[] | undefined,
): boolean => !gates?.length || gates.some((g) => text.includes(g));
