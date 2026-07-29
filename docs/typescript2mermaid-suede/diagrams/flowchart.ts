import type { TypeNode } from "ts-morph";
import {
  indent,
  argsOf,
  boolOf,
  constructClassifier,
  idOf,
  strOf,
  tupleOf,
} from "../typescript-dsl-suede/index.js";
import {
  type AnyNode,
  type Render,
  safeMembers,
  escape,
  LIBRARY_ROOT,
} from "../common.js";

export namespace Flowchart {
  export type Direction = "topdown" | "bottomup" | "leftright" | "rightleft";

  export type Edge = "arrow" | "line" | "dotted" | "thick" | "circle" | "cross";

  export type Shape =
    | "rectangle"
    | "rounded"
    | "stadium"
    | "subroutine"
    | "database"
    | "circle"
    | "diamond"
    | "hexagon"
    | "parallelogram"
    | "parallelogram-alternate";

  /** Everything that may appear in a flowchart body. */
  export type Statement =
    | Connect<any, any, any, any>
    | Node<any, any, any>
    | Subgraph<any, any>
    | Style<any, any>
    | DefineClass<any, any>
    | ApplyClass<any, any>;

  /**
   * Body is a single node type, a single statement, or a tuple of statements.
   * Nodes whose resolved type has members render them into the node label
   * (`C["C<br/>id: string<br/>name: string"]`) unless a `Node<>` declaration
   * overrides the label.
   */
  export type Diagram<
    Dir extends Direction,
    Body extends AnyNode | readonly Statement[],
    Opts extends Render.Options<any> = Render.Options,
  > = { readonly __flow: [Dir, Body, Opts] };

  /** An edge: `Connect<A, B>`, `Connect<A, B, "Yes">`, `Connect<A, B, "maybe", "dotted">`. */
  export type Connect<
    From,
    To,
    Label extends string = never,
    Style extends Edge = "arrow",
  > = { readonly __edge: [From, To, Label, Style] };

  /**
   * Declares a node's shape and/or label.
   * Label semantics: omitted → the node renders its fully-resolved type;
   * a string → custom label (no type expansion); `false` → bare name only.
   */
  export type Node<
    T,
    S extends Shape = "rectangle",
    Label extends string | false = never,
  > = { readonly __node: [T, S, Label] };

  /** `Subgraph<"Title", [A, Connect<A, B>]>` — members may be nodes or nested statements. */
  export type Subgraph<
    Title extends string,
    Members extends readonly (Statement | AnyNode)[],
  > = { readonly __subgraph: [Title, Members] };

  /** `Style<A, "fill:#f9f,stroke:#333,stroke-width:4px">` */
  export type Style<T, Css extends string> = { readonly __style: [T, Css] };

  /** Defines a reusable style class: `DefineClass<"devClass", "fill:#e3f2fd,stroke-width:2px">`. */
  export type DefineClass<Name extends string, Css extends string> = {
    readonly __classdef: [Name, Css];
  };

  /** Applies a defined style class to nodes: `ApplyClass<[A, B], "devClass">`. */
  export type ApplyClass<
    Targets extends readonly AnyNode[],
    Name extends string,
  > = { readonly __useclass: [Targets, Name] };
}

const directions = {
  topdown: "TD",
  bottomup: "BT",
  leftright: "LR",
  rightleft: "RL",
} as const satisfies Record<Flowchart.Direction, string>;

const direction = (
  query: Flowchart.Direction | (string & {}),
): (typeof directions)[Flowchart.Direction] =>
  directions[query in directions ? (query as Flowchart.Direction) : "topdown"];

const plainAndLabeled = <T extends string>(plain: T) => ({
  plain,
  labeled: (label: string) => `${plain}|${label}|` as const,
});

const edges = {
  arrow: plainAndLabeled("-->"),
  line: plainAndLabeled("---"),
  dotted: plainAndLabeled("-.->"),
  thick: plainAndLabeled("==>"),
  circle: plainAndLabeled("--o"),
  cross: plainAndLabeled("--x"),
} satisfies Record<Flowchart.Edge, ReturnType<typeof plainAndLabeled<string>>>;

const edge = (
  query: Flowchart.Edge | (string & {}),
): (typeof edges)[Flowchart.Edge] =>
  edges[query in edges ? (query as Flowchart.Edge) : "arrow"];

type Brackets = [open: string, close: string];

const shapes = {
  rectangle: ["[", "]"],
  rounded: ["(", ")"],
  stadium: ["([", "])"],
  subroutine: ["[[", "]]"],
  database: ["[(", ")]"],
  circle: ["((", "))"],
  diamond: ["{", "}"],
  hexagon: ["{{", "}}"],
  parallelogram: ["[/", "/]"],
  "parallelogram-alternate": ["[\\", "\\]"],
} as const satisfies Record<Flowchart.Shape, Brackets>;

const bracket = <B extends Brackets, T extends string>(
  [open, close]: B,
  text: T,
) => `${open}"${text}"${close}` as const;

const shapeKey = (query: Flowchart.Shape | (string & {})): Flowchart.Shape =>
  query in shapes ? (query as Flowchart.Shape) : "rectangle";

const shape = (query: Flowchart.Shape | (string & {})) =>
  shapes[shapeKey(query)];

type Statements = {
  Connect: Flowchart.Connect<any, any, any, any>;
  Node: Flowchart.Node<any, any, any>;
  Subgraph: Flowchart.Subgraph<any, any>;
  Style: Flowchart.Style<any, any>;
  DefineClass: Flowchart.DefineClass<any, any>;
  ApplyClass: Flowchart.ApplyClass<any, any>;
};

const statements = [
  "Connect",
  "Node",
  "Subgraph",
  "Style",
  "DefineClass",
  "ApplyClass",
] satisfies (keyof Statements)[];

/**
 * The statement kind of a body member, or `undefined` when it is a plain node.
 *
 * A user type may be called `Node` or `Subgraph`; only a `Flowchart.Node<…>`
 * that the checker resolves into this library is a statement, so a bare `Node`
 * — or anyone else's `Flowchart` namespace — is a node whose type gets rendered.
 * The qualifier routes among our statements; `declaredWithin` proves they are
 * ours.
 */
const statementKind = constructClassifier(statements, {
  qualifier: "Flowchart",
  declaredWithin: LIBRARY_ROOT,
});

const is = {
  statement: (member: TypeNode) => statementKind(member) !== undefined,
};

interface FlowNode {
  id: string;
  shape: Flowchart.Shape;
  /** undefined → auto (expand resolved type); string → custom; false → bare name */
  label?: string | false;
  typeNode: TypeNode;
  declared: boolean; // already emitted with its bracket label
}

class FlowContext {
  nodes = new Map<string, FlowNode>();

  register(type: TypeNode): FlowNode {
    const id = idOf(type);
    let node = this.nodes.get(id);
    if (!node) {
      node = { id, shape: "rectangle", typeNode: type, declared: false };
      this.nodes.set(id, node);
    }
    return node;
  }

  /** Node reference for use in an edge/subgraph line; includes the bracket label on first use. */
  refText(type: TypeNode): string {
    const node = this.register(type);
    if (node.declared) return node.id;
    node.declared = true;
    return node.id + this.bracketLabel(node);
  }

  bracketLabel(node: FlowNode): string {
    const _bracket = bracket.bind(null, shape(node.shape));
    if (node.label === false)
      return node.shape === "rectangle" ? "" : _bracket(escape(node.id));

    if (typeof node.label === "string") return _bracket(escape(node.label));

    // Auto: expand the fully-resolved type when it has members.
    const members = safeMembers(node.typeNode);
    if (members.length === 0)
      return node.shape === "rectangle" ? "" : _bracket(escape(node.id));

    const lines = members.map(
      ({ isMethod, name, params, returns, typeText }) =>
        isMethod
          ? `${name}(${params})${returns ? ": " + returns : ""}`
          : `${name}: ${typeText}`,
    );
    return _bracket(escape([node.id, ...lines].join("<br/>")));
  }
}

function collectNodeDeclarations(statement: TypeNode, ctx: FlowContext): void {
  const kind = statementKind(statement);
  if (kind === ("Node" satisfies keyof Statements)) {
    const [type, shape, label] = argsOf(statement);
    const node = ctx.register(type);
    if (shape) node.shape = shapeKey(strOf(shape) ?? node.shape);
    if (label) {
      const text = strOf(label);
      if (text !== undefined) node.label = text;
      else if (boolOf(label) === false) node.label = false;
    }
  } else if (kind === ("Subgraph" satisfies keyof Statements))
    for (const member of tupleOf(argsOf(statement)[1]))
      collectNodeDeclarations(member, ctx);
}

function appendFlowStatement(
  type: TypeNode,
  ctx: FlowContext,
  lines: string[],
  level: number,
): void | number {
  // A member that isn't a qualified statement falls through to `default`, where
  // it renders as a standalone node — which is how a user type named `Connect`
  // reaches the output as a node instead of being mistaken for an edge.
  const kind = statementKind(type);
  switch (kind) {
    case "Connect" satisfies keyof Statements: {
      const [from, to, label, style] = argsOf(type);
      const { labeled, plain } = edge(strOf(style) ?? "arrow");
      const text = strOf(label);
      const arrow = text !== undefined ? labeled(text) : plain;
      return lines.push(
        indent(level)`${ctx.refText(from)} ${arrow} ${ctx.refText(to)}`,
      );
    }
    case "Node" satisfies keyof Statements: {
      // Emit the node declaration if it hasn't appeared yet.
      const node = ctx.register(argsOf(type)[0]);
      if (!node.declared) {
        node.declared = true;
        lines.push(indent(level)`${node.id + ctx.bracketLabel(node)}`);
      }
      return;
    }
    case "Subgraph" satisfies keyof Statements: {
      const [title, members] = argsOf(type);
      lines.push(indent(level)`subgraph "${strOf(title) ?? "Subgraph"}"`);
      for (const member of tupleOf(members))
        if (is.statement(member))
          appendFlowStatement(member, ctx, lines, level + 1);
        else lines.push(indent(level + 1)`${ctx.refText(member)}`);
      return lines.push(indent(level)`end`);
    }
    case "Style": {
      const [target, css] = argsOf(type);
      return lines.push(
        indent(level)`style ${idOf(target)} ${strOf(css) ?? ""}`,
      );
    }
    case "DefineClass": {
      const [name, css] = argsOf(type);
      return lines.push(
        indent(level)`classDef ${strOf(name)} ${strOf(css) ?? ""}`,
      );
    }
    case "ApplyClass": {
      const [targets, name] = argsOf(type);
      const ids = tupleOf(targets)
        .map((t) => idOf(t))
        .join(",");
      return lines.push(indent(level)`class ${ids} ${strOf(name)}`);
    }
    default:
      // A bare type reference in the body → standalone node.
      return lines.push(indent(level)`${ctx.refText(type)}`);
  }
}

export const render = (body: TypeNode): string => {
  const [dirNode, bodyNode] = argsOf(body);
  const ctx = new FlowContext();
  const lines: string[] = [
    `flowchart ${direction(strOf(dirNode) ?? "topdown")}`,
  ];

  const statements = bodyNode ? tupleOf(bodyNode) : [];

  // First pass: apply Node<> declarations so shapes/labels are known before edges render.
  for (const statement of statements) collectNodeDeclarations(statement, ctx);

  // Second pass: emit.
  for (const statement of statements)
    appendFlowStatement(statement, ctx, lines, 1);

  // Any registered-but-never-declared nodes with expandable content (e.g. Node<> only): ensure emitted.
  for (const node of ctx.nodes.values())
    if (!node.declared) {
      node.declared = true;
      const bracket = ctx.bracketLabel(node);
      if (bracket) lines.push(indent(1)`${node.id + bracket}`);
      else if (ctx.nodes.size === 1) lines.push(indent(1)`${node.id}`); // single bare node body
    }

  return lines.join("\n");
};
