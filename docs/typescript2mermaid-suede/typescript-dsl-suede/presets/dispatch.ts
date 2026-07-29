/**
 * Dispatch by construct: a map from *the type usages you recognize* to *the
 * function that handles them*.
 *
 *   createAnalyzer({
 *     name: "my-dsl",
 *     handlers: {
 *       "Flowchart.Diagram": Flowchart.render,
 *       "Sequence.Diagram":  Sequence.render,
 *     },
 *   })
 *
 * That is the whole idea. A key names a construct you know how to handle; the
 * value is the function that receives the matching `TypeNode`. There is no
 * privileged "root" construct, no requirement that keys be namespaced, and no
 * requirement that a handler produce text — `T` is whatever your handler
 * returns, so a test DSL's handler can return a verdict just as easily.
 *
 *   createAnalyzer({
 *     name: "my-tests",
 *     scan: "references",
 *     handlers: { Case: (node) => evaluate(node) },   // → Finding<Verdict>
 *   })
 *
 * This is a preset. It exists because "recognize a construct, hand it to a
 * function" is common — not because a DSL has to work this way. Writing an
 * `Analyzer` by hand stays a first-class option.
 */
import type { SourceFile, TypeAliasDeclaration, TypeNode } from "ts-morph";
import { rangeOf, type Analyzer, type Finding, type SourceRange } from "../analyze.js";
import {
  enclosingTypeAlias,
  matchesConstruct,
  matchesNamespace,
  namespacePath,
  parseConstruct,
  qualifiedName,
  typeAliases,
  typeReferences,
  type DeclaredWithin,
  type NamespaceQuery,
} from "../discover.js";
import { failWith, resolveAlias, type Fail } from "../parse.js";

/* ------------------------------- handlers ---------------------------- */

/** Everything a handler is told about the usage it was given. */
export interface HandlerContext {
  /** The pattern key that matched, e.g. `"Flowchart.Diagram"`. */
  construct: string;
  /** The type alias the usage belongs to, when it is inside one. */
  declaration: TypeAliasDeclaration | undefined;
  source: SourceFile;
  /** Raises a `DslError` prefixed with the analyzer's name. */
  fail: Fail;
}

/**
 * What you do with a recognized usage. Receives the matched `TypeNode` — for a
 * `"declarations"` scan, the alias's own type node; for a `"references"` scan,
 * the reference itself.
 *
 * Return `undefined` to decline the usage, leaving no finding.
 */
export type Handler<T> = (
  node: TypeNode,
  ctx: HandlerContext,
) => T | undefined;

/**
 * Construct pattern → handler.
 *
 * A key is matched against the type reference's name:
 *   `"Flowchart.Diagram"` — name `Diagram` qualified by `Flowchart`
 *   `"Diagram"`           — name `Diagram`, whatever it is qualified by
 *
 * Qualifiers are resolved through import aliases, so `import { Flowchart as F }`
 * and `F.Diagram<...>` still match `"Flowchart.Diagram"`.
 */
export type HandlerMap<T> = Record<string, Handler<T>>;

/* -------------------------------- config ----------------------------- */

/** How a finding is identified and where it is anchored in the editor. */
export interface Identity {
  id: string;
  label?: string;
  range: SourceRange;
}

export interface DispatchConfig<T> {
  /** Prefixes error messages. */
  name: string;
  /** The constructs you recognize, and what handles each. */
  handlers: HandlerMap<T>;
  /**
   * Where to look.
   *
   * `"declarations"` (default) — type aliases whose type *is* one of your
   * constructs (`export type Deploy = Flowchart.Diagram<...>`). The finding is
   * named after the alias.
   *
   * `"references"` — every use of a construct anywhere: nested in a namespace,
   * a tuple, another type, a return position.
   */
  scan?: "declarations" | "references";
  /**
   * `"declarations"`: restrict by export-ness. Defaults to `true`, which makes
   * an unexported alias a helper — a shared body, a reusable fragment.
   */
  exported?: boolean;
  /** Restrict to declarations/usages inside a namespace. */
  namespace?: NamespaceQuery;
  /**
   * `"references"`: only usages whose root identifier was imported from this
   * module, so a local type sharing a construct's name is ignored.
   */
  importedFrom?: string | ((moduleSpecifier: string) => boolean);
  /**
   * Require a matched construct to resolve to a declaration in your source —
   * identity matching, the strongest guard against a user type that shares a
   * construct's name. Handler keys still route (they discriminate
   * `Flowchart.Diagram` from `Sequence.Diagram`); this gates that the match is
   * genuinely yours. Requires resolution, so an unresolved import is not matched.
   */
  declaredWithin?: DeclaredWithin;
  /** `"references"`: skip usages nested inside another match. Default `true`. */
  outermostOnly?: boolean;
  /**
   * Post-process every handler result — a uniform prologue, a wrapper, a
   * normalization step you'd otherwise repeat in each handler.
   */
  transform?(result: T, node: TypeNode, ctx: HandlerContext): T;
  /** Override how findings are identified and anchored. */
  identify?(node: TypeNode, ctx: HandlerContext): Identity;
  /**
   * Cheap substring prefilter. Derived from the handler keys by default
   * (`"Flowchart.Diagram"` → `"Diagram<"`).
   */
  gates?: readonly string[];
}

export interface DispatchAnalyzer<T> extends Analyzer<T> {
  /** The pattern key matching a node, or `undefined` when none does. */
  match(node: TypeNode | undefined): string | undefined;
  /** Run the matching handler, or `undefined` when nothing matches. */
  handle(node: TypeNode, source: SourceFile): T | undefined;
}

/* ------------------------------- analyzer ---------------------------- */

export function createAnalyzer<T>(config: DispatchConfig<T>): DispatchAnalyzer<T> {
  const {
    name,
    handlers,
    scan = "declarations",
    exported = true,
    namespace,
    importedFrom,
    outermostOnly = true,
    transform,
    identify,
    declaredWithin,
  } = config;

  const fail: Fail = failWith(name);
  const patterns = Object.keys(handlers).map(parseConstruct);

  const gates =
    config.gates ?? [...new Set(patterns.map((p) => `${p.name}<`))];

  const match = (node: TypeNode | undefined): string | undefined => {
    if (!node) return undefined;
    // Follow a plain alias so a named construct (`type Named = Flow.Diagram<…>`)
    // referenced elsewhere still resolves. Conservative by design.
    const target = resolveAlias(node) ?? node;
    return patterns.find((p) => matchesConstruct(target, p, { declaredWithin }))
      ?.key;
  };

  const context = (
    construct: string,
    node: TypeNode,
    source: SourceFile,
  ): HandlerContext => ({
    construct,
    declaration: enclosingTypeAlias(node),
    source,
    fail,
  });

  const run = (
    construct: string,
    node: TypeNode,
    ctx: HandlerContext,
  ): T | undefined => {
    const target = resolveAlias(node) ?? node;
    const result = handlers[construct]!(target, ctx);
    if (result === undefined) return undefined;
    return transform ? transform(result, target, ctx) : result;
  };

  /** Default identity: the alias it belongs to, else the usage itself. */
  const defaultIdentity = (node: TypeNode, ctx: HandlerContext): Identity => {
    const decl = ctx.declaration;
    return decl
      ? {
          // Namespace-qualified, so `namespace Test { type Simple = … }` is
          // "Test.Simple" — stable across edits and unique within the file.
          id: qualifiedName(decl),
          label: decl.getName(),
          range: rangeOf(decl.getNameNode()),
        }
      : {
          id: `${ctx.construct}@${node.getStart()}`,
          label: ctx.construct,
          range: rangeOf(node),
        };
  };

  const emit = (
    node: TypeNode,
    construct: string,
    source: SourceFile,
    out: Finding<T>[],
  ): void => {
    const ctx = context(construct, node, source);
    const data = run(construct, node, ctx);
    if (data === undefined) return;
    const { id, label, range } = (identify ?? defaultIdentity)(node, ctx);
    out.push({ id, label, range, data });
  };

  const analyze = (source: SourceFile): Finding<T>[] => {
    const out: Finding<T>[] = [];

    if (scan === "declarations") {
      for (const alias of typeAliases(source, { exported, namespace })) {
        const node = alias.getTypeNode();
        const construct = match(node);
        if (construct) emit(node!, construct, source, out);
      }
      return out;
    }

    const names = patterns.map((p) => p.name);
    for (const ref of typeReferences(source, names, {
      importedFrom,
      outermostOnly,
    })) {
      if (!matchesNamespace(namespacePath(ref), namespace)) continue;
      const construct = match(ref);
      if (construct) emit(ref, construct, source, out);
    }
    return out;
  };

  return {
    gates,
    analyze,
    match,
    handle: (node, source) => {
      const construct = match(node);
      return construct === undefined
        ? undefined
        : run(construct, node, context(construct, node, source));
    },
  };
}
