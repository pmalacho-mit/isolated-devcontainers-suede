/**
 * Ways to find your DSL's constructs in a file.
 *
 * These are a menu, not a mandate — every one of them is optional, and an
 * `Analyzer` is free to walk the AST however it likes. They exist because a few
 * discovery shapes come up repeatedly:
 *
 *   - named type aliases, possibly inside a namespace, possibly exported
 *     (`export type Simple = Case<...>` inside `namespace Test`)
 *   - every use of a construct anywhere in the file, wherever it appears
 *     (`Case<...>` nested in a tuple, a return type, another construct)
 *   - annotations on members of ordinary types, which erase completely
 */
import {
  Node,
  type SourceFile,
  SyntaxKind,
  type TypeAliasDeclaration,
  type TypeNode,
  type TypeReferenceNode,
} from "ts-morph";
import { lastName, qualifierOf, refName } from "./parse.js";

/* ----------------------------- namespaces ---------------------------- */

/**
 * Enclosing namespace path of a node, outermost first: a declaration inside
 * `namespace Test { namespace Unit { ... } }` yields `["Test", "Unit"]`.
 * Top-level declarations yield `[]`.
 */
export function namespacePath(node: Node): string[] {
  const path: string[] = [];
  let current: Node | undefined = node.getParent();
  while (current) {
    if (Node.isModuleDeclaration(current)) path.unshift(current.getName());
    current = current.getParent();
  }
  return path;
}

/** Matches a namespace path: a name, a path, or a predicate. */
export type NamespaceQuery =
  | string
  | readonly string[]
  | ((path: string[]) => boolean);

export function matchesNamespace(
  path: string[],
  query: NamespaceQuery | undefined,
): boolean {
  if (query === undefined) return true;
  if (typeof query === "function") return query(path);
  const want = typeof query === "string" ? [query] : query;
  // A prefix match, so `namespace: "Test"` also finds `Test.Unit` members.
  return want.every((segment, i) => path[i] === segment);
}

/* --------------------------- type aliases ---------------------------- */

export interface TypeAliasQuery {
  /** Restrict to (or exclude) exported aliases. Omit to accept both. */
  exported?: boolean;
  /** Restrict to aliases declared within a namespace. */
  namespace?: NamespaceQuery;
  /** Descend into namespaces and nested scopes. Default `true`. */
  recursive?: boolean;
  /** Filter by alias name. */
  name?: string | readonly string[] | ((name: string) => boolean);
}

const matchesName = (
  name: string,
  query: TypeAliasQuery["name"],
): boolean => {
  if (query === undefined) return true;
  if (typeof query === "function") return query(name);
  return typeof query === "string" ? name === query : query.includes(name);
};

/**
 * Type aliases in a file. Unlike `SourceFile.getTypeAliases()`, this reaches
 * declarations nested inside namespaces by default — which is where a DSL that
 * groups its declarations (`namespace Test { ... }`) puts all of them.
 */
export function typeAliases(
  source: SourceFile,
  query: TypeAliasQuery = {},
): TypeAliasDeclaration[] {
  const { exported, namespace, recursive = true, name } = query;
  const all = recursive
    ? source.getDescendantsOfKind(SyntaxKind.TypeAliasDeclaration)
    : source.getTypeAliases();
  return all.filter(
    (alias) =>
      (exported === undefined || alias.isExported() === exported) &&
      matchesName(alias.getName(), name) &&
      matchesNamespace(namespacePath(alias), namespace),
  );
}

/**
 * A declaration's dotted path including its namespaces — `Test.Unit.Simple`.
 * A good default `Finding.id`: stable across edits and unique within a file.
 */
export const qualifiedName = (
  node: Node & { getName(): string },
): string => [...namespacePath(node), node.getName()].join(".");

/* -------------------------- type references -------------------------- */

/** Matches a type reference by its last name segment. */
export type NameQuery =
  | string
  | readonly string[]
  | ((name: string) => boolean);

const matchesLastName = (name: string | undefined, query: NameQuery): boolean => {
  if (name === undefined) return false;
  if (typeof query === "function") return query(name);
  return typeof query === "string" ? name === query : query.includes(name);
};

export interface TypeReferenceQuery {
  /**
   * Only references whose root identifier was imported from this module. Guards
   * against a local type that happens to share a name with one of your
   * constructs — cheap and syntactic, so it also works mid-edit when the
   * checker cannot resolve the import.
   */
  importedFrom?: string | ((moduleSpecifier: string) => boolean);
  /** Skip references nested inside another matched reference. Default `false`. */
  outermostOnly?: boolean;
}

/**
 * Local names introduced by importing from a module — named bindings, a default
 * import, or a namespace import. Aliases (`import { Case as C }`) yield the
 * local name, which is what appears in the type reference.
 */
export function importedNames(
  source: SourceFile,
  from: string | ((moduleSpecifier: string) => boolean),
): Set<string> {
  const match =
    typeof from === "function" ? from : (s: string) => s === from;
  const names = new Set<string>();
  for (const decl of source.getImportDeclarations()) {
    if (!match(decl.getModuleSpecifierValue())) continue;
    const def = decl.getDefaultImport();
    if (def) names.add(def.getText());
    const ns = decl.getNamespaceImport();
    if (ns) names.add(ns.getText());
    for (const named of decl.getNamedImports())
      names.add((named.getAliasNode() ?? named.getNameNode()).getText());
  }
  return names;
}

/**
 * Every use of a construct in a file, wherever it appears — nested in a tuple,
 * inside another construct, as a return type. This is the discovery shape for a
 * DSL whose constructs are used inline rather than declared at a known place.
 */
export function typeReferences(
  source: SourceFile,
  name: NameQuery,
  { importedFrom, outermostOnly = false }: TypeReferenceQuery = {},
): TypeReferenceNode[] {
  const local = importedFrom
    ? importedNames(source, importedFrom)
    : undefined;

  const hits = source
    .getDescendantsOfKind(SyntaxKind.TypeReference)
    .filter((ref) => {
      if (!matchesLastName(lastName(ref), name)) return false;
      if (!local) return true;
      // `Case` → "Case"; `T.Case` → "T" (a namespace import).
      const root = refName(ref)?.split(".")[0];
      return root !== undefined && local.has(root);
    });

  if (!outermostOnly) return hits;
  const set = new Set<Node>(hits);
  return hits.filter((ref) => !ref.getAncestors().some((a) => set.has(a)));
}

/** The type alias a node is (transitively) part of, if any. */
export function enclosingTypeAlias(
  node: Node,
): TypeAliasDeclaration | undefined {
  return node.getFirstAncestorByKind(SyntaxKind.TypeAliasDeclaration);
}

/* --------------------------- construct matching ---------------------- */

/**
 * A construct name split into its parts:
 *
 *   "Flowchart.Connect" → { name: "Connect", qualifier: "Flowchart" }
 *   "Case"              → { name: "Case",    qualifier: undefined }
 *
 * A `qualifier` is what distinguishes *your* construct from a user type that
 * happens to share its name: `Flowchart.Node<…>` is a statement, a bare
 * `Node<…>` is one of the user's own types. Leaving the qualifier off matches
 * on name alone, for a DSL whose constructs are not namespaced.
 */
export interface ConstructPattern {
  /** The pattern as written, e.g. `"Flowchart.Connect"`. */
  key: string;
  /** Last segment, e.g. `"Connect"`. */
  name: string;
  /** Namespace qualifier if the pattern had one, else `undefined`. */
  qualifier: string | undefined;
}

export function parseConstruct(key: string): ConstructPattern {
  const dot = key.lastIndexOf(".");
  return dot === -1
    ? { key, name: key, qualifier: undefined }
    : { key, name: key.slice(dot + 1), qualifier: key.slice(0, dot) };
}

/**
 * The declaration a construct reference resolves to: the file it is declared in,
 * and its declared name. `undefined` when the reference does not resolve — an
 * unresolved import, a type-only reference the checker cannot pin down.
 *
 * This is the checker's answer to "what type is this, really", independent of
 * how it was written or imported. It is what lets a DSL be *certain* a reference
 * is one of its own constructs rather than a user type that merely shares a name
 * — see `declaredWithin`.
 */
export interface ConstructDeclaration {
  name: string | undefined;
  file: string;
}

export function resolveConstruct(
  node: TypeNode | undefined,
): ConstructDeclaration | undefined {
  const ref = node?.asKind(SyntaxKind.TypeReference);
  if (!ref) return undefined;
  let decl: Node | undefined;
  try {
    const sym = ref.getTypeName().getSymbol();
    decl = (sym?.getAliasedSymbol() ?? sym)?.getDeclarations()?.[0];
  } catch {
    return undefined; // unresolvable import
  }
  if (!decl) return undefined;
  const named = decl as Node & { getName?: () => string | undefined };
  return { name: named.getName?.(), file: decl.getSourceFile().getFilePath() };
}

/**
 * Where a construct must be declared to count as yours: a directory the
 * declaration file must sit under, or a predicate on its path.
 *
 * A vendored DSL's construct types live at a known place in the consumer's tree
 * (`…/release/…`), so "declared under that directory" is a definition of *your*
 * type that no user type can satisfy by accident — the strongest check
 * available. It requires the reference to resolve; an unresolved import is
 * therefore treated as *not* yours.
 */
export type DeclaredWithin = string | ((file: string) => boolean);

const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** Whether a construct resolves to a declaration inside `within`. */
export function isDeclaredWithin(
  node: TypeNode | undefined,
  within: DeclaredWithin,
): boolean {
  const decl = resolveConstruct(node);
  if (!decl) return false;
  const file = normalize(decl.file);
  if (typeof within === "function") return within(file);
  const root = normalize(within);
  return file === root || file.startsWith(root + "/");
}

export interface MatchConstructOptions {
  /**
   * Also require the reference to resolve to a declaration here. Turns name
   * matching into identity matching: a user type sharing a construct's name is
   * rejected because it is declared elsewhere. Requires resolution, so an
   * unresolved reference never matches.
   */
  declaredWithin?: DeclaredWithin;
}

/**
 * Whether a type node is a reference to the given construct.
 *
 * The name must match; if the pattern is qualified, the reference's qualifier
 * must too. `qualifierOf` follows import aliases, so `import { Flowchart as F }`
 * and `F.Connect<…>` still match `"Flowchart.Connect"`. The raw `refName`
 * fallback covers a reference the checker cannot resolve — constant while a file
 * is being edited — where the qualifier was written literally.
 *
 * With `declaredWithin`, matching additionally requires the reference to resolve
 * to a declaration in your source. Name and qualifier still *route* among your
 * constructs (they discriminate `Flowchart.Diagram` from `Sequence.Diagram`,
 * both named `Diagram`); identity is the *gate* that a matched construct is
 * genuinely yours and not a user type wearing the same name.
 */
export function matchesConstruct(
  node: TypeNode | undefined,
  pattern: ConstructPattern,
  { declaredWithin }: MatchConstructOptions = {},
): boolean {
  if (!node || lastName(node) !== pattern.name) return false;
  if (
    pattern.qualifier !== undefined &&
    qualifierOf(node) !== pattern.qualifier &&
    refName(node) !== pattern.key
  )
    return false;
  return declaredWithin === undefined || isDeclaredWithin(node, declaredWithin);
}

export interface ClassifyOptions extends MatchConstructOptions {
  /** Namespace the constructs share, e.g. `"Flowchart"`. See `ConstructPattern`. */
  qualifier?: string;
}

/**
 * Build a classifier over a set of construct kinds sharing one namespace.
 *
 * The returned function reports which kind a node is, or `undefined` for
 * anything else — including a user type that merely shares a construct's name.
 * This is what lets a DSL accept arbitrary user types in the same position as
 * its own constructs (a flowchart node beside a `Connect<…>` statement) without
 * the two colliding.
 *
 *   const statementKind = constructClassifier(
 *     ["Connect", "Node", "Subgraph"] as const,
 *     { qualifier: "Flowchart", declaredWithin: LIBRARY_ROOT },
 *   );
 *   statementKind(node); // "Connect" | "Node" | "Subgraph" | undefined
 *
 * `qualifier` alone matches syntactically (works mid-edit, but a user could
 * shadow your namespace). Adding `declaredWithin` requires the reference to
 * resolve into your source — certain, at the cost of failing on unresolved
 * imports.
 */
export function constructClassifier<const K extends string>(
  kinds: readonly K[],
  { qualifier, declaredWithin }: ClassifyOptions = {},
): (node: TypeNode | undefined) => K | undefined {
  const patterns = kinds.map((kind) =>
    parseConstruct(qualifier ? `${qualifier}.${kind}` : kind),
  );
  return (node) =>
    (patterns.find((p) => matchesConstruct(node, p, { declaredWithin }))
      ?.name as K) ?? undefined;
}

/* ---------------------------- member markers ------------------------- */

/**
 * Peel identity-marker wrappers off a type node, returning the markers found
 * (outermost first) and the node underneath.
 *
 * An identity marker (`type Secret<T> = T`) annotates without changing what the
 * type *is* — the checker sees straight through it, so it must be recovered
 * syntactically. Zero-cost metadata that erases completely.
 */
export function unwrapMarkers(
  type: TypeNode | undefined,
  isMarker: (name: string) => boolean,
): { markers: string[]; type: TypeNode | undefined } {
  const markers: string[] = [];
  let current = type;
  while (current) {
    const name = lastName(current);
    if (name === undefined || !isMarker(name)) break;
    markers.push(name);
    current = current
      .asKind(SyntaxKind.TypeReference)
      ?.getTypeArguments()[0];
  }
  return { markers, type: current };
}
