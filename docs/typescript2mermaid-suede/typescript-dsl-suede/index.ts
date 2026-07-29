/**
 * typescript-dsl-suede — write a DSL in TypeScript's type system, read it back
 * with the compiler API, and surface it in the editor.
 *
 * The core contract is small on purpose: an `Analyzer` turns a source file into
 * `Finding`s. Everything above that — how constructs are named, where they are
 * declared, what they produce — is yours.
 *
 * The VSCode harness is a separate entry point (`vscode-extension/extension.ts`)
 * so this one stays free of any editor dependency.
 */

/* The contract. */
export {
  editRange,
  passesGates,
  rangeOf,
  type Analyzer,
  type Finding,
  type SourceEdit,
  type SourceRange,
} from "./analyze.js";

/* Running it. */
export { defineDsl, type DefineDslOptions, type Runner } from "./runner.js";
export { DslSession } from "./session.js";

/* Getting output into docs. */
export {
  embed,
  targets,
  type EmbedOptions,
  type EmbedResult,
  type EmbedTarget,
  type Resolve,
} from "./markdown.js";

/* Finding your constructs. */
export {
  constructClassifier,
  enclosingTypeAlias,
  importedNames,
  isDeclaredWithin,
  matchesConstruct,
  matchesNamespace,
  namespacePath,
  parseConstruct,
  qualifiedName,
  resolveConstruct,
  typeAliases,
  typeReferences,
  unwrapMarkers,
  type ClassifyOptions,
  type ConstructDeclaration,
  type ConstructPattern,
  type DeclaredWithin,
  type MatchConstructOptions,
  type NameQuery,
  type NamespaceQuery,
  type TypeAliasQuery,
  type TypeReferenceQuery,
} from "./discover.js";

/* Reading them. */
export {
  argsOf,
  boolOf,
  DslError,
  fail,
  failWith,
  idOf,
  lastName,
  locationOf,
  nameOf,
  numOf,
  numericLiteralProps,
  qualifierOf,
  refName,
  resolveAlias,
  resolveMembers,
  safeMembers,
  sanitizeId,
  strOf,
  tupleOf,
  type DslErrorLocation,
  type Fail,
  type ResolvedMember,
  type ResolveMembersOptions,
} from "./parse.js";

/* Optional conventions. */
export {
  indent,
  optionsOf,
  OPTIONS_NAME,
  type AnyType,
  type Options,
} from "./common.js";
