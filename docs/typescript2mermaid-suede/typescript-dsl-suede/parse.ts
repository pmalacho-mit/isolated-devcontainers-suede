/**
 * Generic readers for a type-level DSL.
 *
 * Nothing in here knows what your DSL means — these are the primitives for
 * getting at what the user wrote (`lastName`, `argsOf`, `strOf`, ...) and what
 * the checker makes of it (`resolveMembers`). Domain modules build on top.
 *
 * The recurring rule: use the *syntax* view for identity (names, literals,
 * marker wrappers) and the *semantic* view for structure (resolved members).
 */
import { Node, SyntaxKind, TypeNode } from "ts-morph";

/* ----------------------- syntax-level helpers ----------------------- */

/** Name of a type reference, e.g. `Flow.Connect` for `Flow.Connect<A, B>`. */
export function refName(t: TypeNode | undefined): string | undefined {
  if (!t) return undefined;
  const ref = t.asKind(SyntaxKind.TypeReference);
  if (!ref) return undefined;
  return ref.getTypeName().getText();
}

/** Last segment of a (possibly qualified) type reference name: `Flow.Connect` → `Connect`. */
export function lastName(t: TypeNode | undefined): string | undefined {
  return refName(t)?.split(".").pop();
}

/**
 * Namespace qualifier of a type reference (`Flow.Diagram` → `Flow`), following
 * import aliases so `import { Flow as F }` still resolves.
 */
export function qualifierOf(t: TypeNode | undefined): string | undefined {
  const ref = t?.asKind(SyntaxKind.TypeReference);
  if (!ref) return undefined;
  const name = ref.getTypeName();
  if (!Node.isQualifiedName(name)) return undefined;
  const left = name.getLeft();
  try {
    const sym = left.getSymbol();
    const resolved = (sym?.getAliasedSymbol() ?? sym)?.getName();
    // Unresolvable imports yield the checker's `unknown` symbol — prefer syntax.
    if (resolved && resolved !== "unknown" && !resolved.startsWith("__"))
      return resolved;
  } catch {
    // fall through to syntactic name
  }
  return left.getText();
}

/** Type arguments of a type reference. */
export function argsOf(t: TypeNode | undefined): TypeNode[] {
  return t?.asKind(SyntaxKind.TypeReference)?.getTypeArguments() ?? [];
}

/**
 * Follow a type reference through plain type aliases to the node it names, so a
 * named construct (`type Flow = Diagram<...>`) or a shared body (`type Body =
 * [...]`) can be referenced instead of inlined.
 *
 * Deliberately conservative — a reference is only followed when it takes no type
 * arguments and names an alias that declares no type parameters. Generic aliases
 * would need real type-argument substitution, which is the checker's job, not
 * something worth reimplementing syntactically.
 *
 * Callers must only use this where a DSL construct is expected. A referenced
 * type's *name* is usually its identity in the output, so resolving `A` in
 * `Connect<A, B>` down to its `{}` body would destroy that identity.
 */
export function resolveAlias(t: TypeNode | undefined): TypeNode | undefined {
  let current = t;
  const seen = new Set<TypeNode>();
  while (current && !seen.has(current)) {
    seen.add(current); // self-referential aliases are a type error, but don't hang
    const ref = current.asKind(SyntaxKind.TypeReference);
    if (!ref || ref.getTypeArguments().length > 0) break;
    let decl;
    try {
      const sym = ref.getTypeName().getSymbol();
      decl = (sym?.getAliasedSymbol() ?? sym)?.getDeclarations()?.[0];
    } catch {
      break; // unresolvable import
    }
    if (!decl || !Node.isTypeAliasDeclaration(decl)) break;
    if (decl.getTypeParameters().length > 0) break;
    const next = decl.getTypeNode();
    if (!next) break;
    current = next;
  }
  return current;
}

/** String literal value of a literal type node, e.g. `"topdown"`. */
export function strOf(t: TypeNode | undefined): string | undefined {
  const lit = t?.asKind(SyntaxKind.LiteralType)?.getLiteral();
  if (lit?.isKind(SyntaxKind.StringLiteral)) return lit.getLiteralValue();
  return undefined;
}

/** Numeric literal value of a literal type node, e.g. `5`. */
export function numOf(t: TypeNode | undefined): number | undefined {
  const lit = t?.asKind(SyntaxKind.LiteralType)?.getLiteral();
  if (lit?.isKind(SyntaxKind.NumericLiteral)) return lit.getLiteralValue();
  return undefined;
}

/** Boolean literal (`true` / `false`) of a literal type node. */
export function boolOf(t: TypeNode | undefined): boolean | undefined {
  const lit = t?.asKind(SyntaxKind.LiteralType)?.getLiteral();
  if (lit?.isKind(SyntaxKind.TrueKeyword)) return true;
  if (lit?.isKind(SyntaxKind.FalseKeyword)) return false;
  return undefined;
}

/** Elements of a tuple type node; single non-tuple nodes become a 1-tuple. */
export function tupleOf(t: TypeNode | undefined): TypeNode[] {
  if (!t) return [];
  const direct = t.asKind(SyntaxKind.TupleType);
  if (direct) return direct.getElements();
  // A plain alias may name a reusable tuple (e.g. a body shared across several
  // variants). Follow it, but only when it resolves to a tuple — a single node
  // reference must stay intact, since its identity comes from its name.
  const resolved = resolveAlias(t)?.asKind(SyntaxKind.TupleType);
  if (resolved) return resolved.getElements();
  return [t];
}

/* --------------------------- error reporting ------------------------- */

/** A DSL compilation error, carrying the node it was raised at. */
export class DslError extends Error {
  constructor(
    message: string,
    readonly node?: TypeNode,
  ) {
    super(message);
    this.name = "DslError";
  }
}

/** Source position of a node, for diagnostics. */
export interface DslErrorLocation {
  file: string;
  /** 1-based. */
  line: number;
  /** Character offset into the file. */
  start: number;
  end: number;
}

export function locationOf(node: TypeNode | undefined): DslErrorLocation | undefined {
  if (!node) return undefined;
  return {
    file: node.getSourceFile().getFilePath(),
    line: node.getStartLineNumber(),
    start: node.getStart(),
    end: node.getEnd(),
  };
}

/**
 * Raises a DSL error. Explicitly typed as returning `never` so control-flow
 * narrowing works at call sites (`args[0] ?? fail(...)`) — TypeScript only
 * applies that to a const with an explicit annotation.
 */
export type Fail = (msg: string, at?: TypeNode) => never;

/**
 * Builds a `fail` for one DSL, so every thrown message is prefixed consistently
 * and every error carries the offending node (which is what later becomes an
 * editor squiggle — retrofitting it is painful, so thread it from the start).
 */
export const failWith =
  (prefix: string): Fail =>
  (msg: string, at?: TypeNode): never => {
    const where = at
      ? ` at \`${at.getText()}\` (${at.getSourceFile().getBaseName()}:${at.getStartLineNumber()})`
      : "";
    throw new DslError(`${prefix}: ${msg}${where}`, at);
  };

/** Default `fail`; prefer `failWith("<your-dsl>")`. */
export const fail: Fail = failWith("dsl");

/* ------------------------------ node ids ---------------------------- */

/** The name a referenced type contributes to the output. */
export const nameOf = (type: TypeNode): string =>
  lastName(type) ?? type.getText();

/** Replaces everything outside `[A-Za-z0-9_]` with `_`. */
export const sanitizeId = (name: string): string =>
  name.replace(/[^A-Za-z0-9_]/g, "_");

/** Identifier-safe id for a referenced type. */
export const idOf = (
  type: TypeNode,
  sanitize: (name: string) => string = sanitizeId,
): string => sanitize(nameOf(type));

/* --------------------- checker-level type expansion ------------------ */

export interface ResolvedMember {
  name: string;
  /** Declared type text with markers unwrapped (falls back to checker text). */
  typeText: string;
  /**
   * Marker names peeled off the declaration, outermost first — e.g.
   * `["Private"]` for `foo: Private<string>`. See `resolveMembers`.
   */
  markers: string[];
  /** True if this member is callable. */
  isMethod: boolean;
  /** Rendered parameter list for methods, e.g. `name: string`. */
  params: string;
  /** Rendered return type for methods (empty for void). */
  returns: string;
}

export interface ResolveMembersOptions {
  /**
   * Identifies a DSL marker type — an identity alias (`type Private<T> = T`)
   * used to annotate a member without changing what its type actually is. The
   * checker sees straight through them; they are recovered here from the
   * property's original declaration syntax.
   */
  isMarker?(name: string): boolean;
}

/**
 * Fully resolves the type behind a type node (through aliases, intersections,
 * mapped types, etc.) into a flat member list.
 */
export function resolveMembers(
  t: TypeNode,
  { isMarker }: ResolveMembersOptions = {},
): ResolvedMember[] {
  const type = t.getType();
  const members: ResolvedMember[] = [];

  for (const sym of type.getProperties()) {
    const decl = sym.getDeclarations()[0];
    let declTypeNode: TypeNode | undefined;
    let isMethod = false;
    let params = "";
    let returns = "";

    if (decl && Node.isPropertySignature(decl)) {
      declTypeNode = decl.getTypeNode();
    } else if (decl && Node.isMethodSignature(decl)) {
      isMethod = true;
      params = decl
        .getParameters()
        .map((p) => p.getText())
        .join(", ");
      const ret = decl.getReturnTypeNode()?.getText() ?? "";
      returns = ret === "void" ? "" : ret;
    }

    // Unwrap identity markers, recording them outermost-first.
    const markers: string[] = [];
    if (isMarker)
      while (declTypeNode) {
        const name = lastName(declTypeNode);
        if (name === undefined || !isMarker(name)) break;
        markers.push(name);
        declTypeNode = argsOf(declTypeNode)[0];
      }

    // Function-typed properties are methods too.
    if (declTypeNode?.isKind(SyntaxKind.FunctionType)) {
      const fn = declTypeNode.asKindOrThrow(SyntaxKind.FunctionType);
      isMethod = true;
      params = fn
        .getParameters()
        .map((p) => p.getText())
        .join(", ");
      const ret = fn.getReturnTypeNode()?.getText() ?? "";
      returns = ret === "void" ? "" : ret;
    }

    const typeText = isMethod
      ? ""
      : (declTypeNode?.getText() ??
        (decl
          ? sym.getTypeAtLocation(decl).getText()
          : sym.getDeclaredType().getText()));

    members.push({ name: sym.getName(), typeText, markers, isMethod, params, returns });
  }

  return members;
}

/** `resolveMembers` that yields `[]` instead of throwing on unresolvable types. */
export function safeMembers(
  t: TypeNode,
  options?: ResolveMembersOptions,
): ResolvedMember[] {
  try {
    return resolveMembers(t, options);
  } catch {
    return [];
  }
}

/** Numeric-literal properties of an object type (`{ CPU: 35; Memory: 25 }`). */
export function numericLiteralProps(
  t: TypeNode,
): { name: string; value: number }[] {
  const out: { name: string; value: number }[] = [];
  for (const sym of t.getType().getProperties()) {
    const decl = sym.getDeclarations()[0];
    const propType = decl ? sym.getTypeAtLocation(decl) : sym.getDeclaredType();
    if (propType.isNumberLiteral())
      out.push({ name: sym.getName(), value: propType.getLiteralValue() as number });
  }
  return out;
}
