import ts from "@typescript/typescript6";
import { isDslModule } from "../../workspace.mts";

import type { Binding, Expr, ModuleMock } from "./ir.mts";

export type Warning = {
  line: number;
  column: number;
  length: number;
  message: string;
};

export type Line = { code: string; line: number | null };

export type EmitInput = { program: ts.Program; source: ts.SourceFile };

export type TestState = {
  bindings: Map<ts.Symbol, Binding>;
  order: Binding[];
  // specifier → value imports to inject: `a as a$`, `default as d$`, `* as ns$`
  imports: Map<string, Set<string>>;
  mocks: ModuleMock[];
};

const freshTestState = (): TestState => ({
  bindings: new Map(),
  order: [],
  imports: new Map(),
  mocks: [],
});

export type EmitContext = ReturnType<typeof createEmitContext>;

const typeOnlySpecifierOf = (declaration: ts.Declaration) => {
  const statement = ts.findAncestor(declaration, ts.isImportDeclaration);
  if (!statement || !ts.isStringLiteral(statement.moduleSpecifier)) return null;
  const typeOnly =
    statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
    (ts.isImportSpecifier(declaration) && declaration.isTypeOnly);
  return typeOnly ? statement.moduleSpecifier.text : null;
};

const valueBinding = (declaration: ts.Declaration, local: string) => {
  if (ts.isImportSpecifier(declaration))
    return `${(declaration.propertyName ?? declaration.name).text} as ${local}`;
  if (ts.isImportClause(declaration)) return `default as ${local}`;
  if (ts.isNamespaceImport(declaration)) return `* as ${local}`;
  return null;
};

export const createEmitContext = (program: ts.Program, source: ts.SourceFile) => {
  const checker = program.getTypeChecker();
  const warnings: Warning[] = [];
  // a node is asked about several times over, so each answer is kept
  const targets = new WeakMap<ts.Node, ts.Symbol | undefined>();

  const cx = {
    program,
    checker,
    source,
    warnings,
    test: freshTestState(),
    resetTest() {
      cx.test = freshTestState();
      return cx.test;
    },
    lineOf: (node: ts.Node) =>
      source.getLineAndCharacterOfPosition(node.getStart()).line,
    target(name: ts.Node): ts.Symbol | undefined {
      if (targets.has(name)) return targets.get(name);
      const symbol = checker.getSymbolAtLocation(name);
      const target =
        symbol && symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      targets.set(name, target);
      return target;
    },
    dslName(node: ts.TypeReferenceNode): string | null {
      const target = cx.target(node.typeName);
      const declaration = target?.declarations?.[0];
      return target &&
        declaration &&
        isDslModule(declaration.getSourceFile().fileName)
        ? target.getName()
        : null;
    },
    warn(node: ts.Node, message: string) {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart());
      warnings.push({ line, column: character, length: node.getWidth(), message });
    },
    unsupported(node: ts.Node, why = "is a type, not a value"): Expr {
      cx.warn(node, `\`${node.getText()}\` ${why}`);
      return { kind: "unsupported", source: node.getText() };
    },
    // a type-only import has no value at run time, so it is imported again under a new name
    valueName(identifier: ts.Identifier): string | Expr {
      const symbol = checker.getSymbolAtLocation(identifier);
      const declaration =
        symbol && symbol.flags & ts.SymbolFlags.Alias ? symbol.declarations?.[0] : undefined;
      const specifier = declaration && typeOnlySpecifierOf(declaration);
      if (!declaration || !specifier) return identifier.text;
      const local = `${identifier.text}$`;
      const binding = valueBinding(declaration, local);
      if (!binding) return cx.unsupported(identifier, "cannot be re-imported as a value");
      const bindings = cx.test.imports.get(specifier) ?? new Set<string>();
      cx.test.imports.set(specifier, bindings.add(binding));
      return local;
    },
  };
  return cx;
};
