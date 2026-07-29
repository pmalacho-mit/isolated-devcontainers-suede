import type { TypeNode } from "ts-morph";
import {
  indent,
  argsOf,
  idOf,
  lastName,
  strOf,
  tupleOf,
} from "../typescript-dsl-suede/index.js";
import { type Render, fail, safeMembers } from "../common.js";

export namespace Class {
  /** Everything that may appear in a class-diagram body. */
  export type Statement =
    | Class<any, any>
    | Extends<any, any>
    | Composition<any, any, any>
    | Aggregation<any, any, any>
    | Association<any, any, any>
    | Link<any, any, any>
    | DependsOn<any, any, any>
    | Realizes<any, any>
    | Implements<any, any>;

  /**
   * Every referenced type expands into a full `class` body from its
   * *resolved* type: fields, methods (function-typed members), and
   * visibility markers all survive intersections and other composition.
   */
  export type Diagram<
    Body extends readonly Statement[],
    Opts extends Render.Options<any> = Render.Options,
  > = { readonly __class: [Body, Opts] };

  /** Explicitly include a type as a class (relationships auto-include theirs). */
  export type Class<T, Name extends string = never> = {
    readonly __clsinclude: [T, Name];
  };

  /** `Extends<Dog, Animal>` → `Animal <|-- Dog` */
  export type Extends<Child, Parent> = { readonly __extends: [Child, Parent] };
  /** `Composition<Whole, Part>` → `Whole *-- Part` */
  export type Composition<Whole, Part, Label extends string = never> = {
    readonly __composition: [Whole, Part, Label];
  };
  /** `Aggregation<Whole, Part>` → `Whole o-- Part` */
  export type Aggregation<Whole, Part, Label extends string = never> = {
    readonly __aggregation: [Whole, Part, Label];
  };
  /** `Association<Owner, Animal, "owns">` → `Owner --> Animal : owns` */
  export type Association<From, To, Label extends string = never> = {
    readonly __association: [From, To, Label];
  };
  /** `Link<A, B>` → `A -- B` */
  export type Link<A, B, Label extends string = never> = {
    readonly __link: [A, B, Label];
  };
  /** `DependsOn<A, B>` → `A ..> B` */
  export type DependsOn<From, To, Label extends string = never> = {
    readonly __dependson: [From, To, Label];
  };
  /** `Realizes<A, B>` → `A ..|> B` */
  export type Realizes<From, To> = { readonly __realizes: [From, To] };
  /** `Implements<A, B>` → `A --|> B` */
  export type Implements<From, To> = { readonly __implements: [From, To] };

  /* Visibility markers for class members (identity types; the generator
     detects them syntactically on each property's declaration). */

  /** Member renders with `-`. */
  export type Private<T> = T;
  /** Member renders with `#`. */
  export type Protected<T> = T;
  /** Member renders with `~`. */
  export type Internal<T> = T;
}

/** Statement kind → its DSL type, so dispatch labels are checked against the DSL. */
type Statements = {
  Class: Class.Class<any, any>;
  Extends: Class.Extends<any, any>;
  Composition: Class.Composition<any, any, any>;
  Aggregation: Class.Aggregation<any, any, any>;
  Association: Class.Association<any, any, any>;
  Link: Class.Link<any, any, any>;
  DependsOn: Class.DependsOn<any, any, any>;
  Realizes: Class.Realizes<any, any>;
  Implements: Class.Implements<any, any>;
};

const arrow = <T extends string>(arrow: T, swap = false) => ({ arrow, swap });

/**
 * Relationship statements → their Mermaid arrow. `swap` reverses the operands
 * so the arrow reads in Mermaid's canonical direction (e.g. `Extends<Dog,
 * Animal>` emits `Animal <|-- Dog`).
 */
const relations = {
  Extends: arrow("<|--", true),
  Composition: arrow("*--"),
  Aggregation: arrow("o--"),
  Association: arrow("-->"),
  Link: arrow("--"),
  DependsOn: arrow("..>"),
  Realizes: arrow("..|>"),
  Implements: arrow("--|>"),
} as const;

const isRelation = (kind: string | undefined): kind is keyof typeof relations =>
  kind !== undefined && kind in relations;

export const render = (body: TypeNode): string => {
  const lines: string[] = ["classDiagram"];
  const relationLines: string[] = [];
  const classes = new Map<string, TypeNode>();

  /** Register a referenced type as a class (first occurrence wins), return its id. */
  const include = (type: TypeNode): string => {
    const id = idOf(type);
    if (!classes.has(id)) classes.set(id, type);
    return id;
  };

  for (const statement of tupleOf(argsOf(body)[0])) {
    const kind = lastName(statement);
    const args = argsOf(statement);
    if (kind === ("Class" satisfies keyof Statements)) {
      include(args[0] ?? fail("Class<> requires a type", statement));
    } else if (isRelation(kind)) {
      const rel = relations[kind];
      const arrow = rel.arrow;
      const swap = "swap" in rel && rel.swap;
      const [a, b, label] = args;
      const left = include(swap ? b! : a!);
      const right = include(swap ? a! : b!);
      const text = strOf(label);
      relationLines.push(
        indent(1)`${left} ${arrow} ${right}${text ? ` : ${text}` : ""}`,
      );
    } else {
      fail(
        `unknown class-diagram statement \`${statement.getText()}\``,
        statement,
      );
    }
  }

  // Expand each class into a full definition from its resolved type.
  for (const [id, type] of classes) {
    const members = safeMembers(type);
    if (members.length === 0) {
      lines.push(indent(1)`class ${id}`);
      continue;
    }
    lines.push(indent(1)`class ${id} {`);
    for (const member of members)
      lines.push(
        member.isMethod
          ? indent(
              2,
            )`${member.visibility}${member.name}(${member.params})${member.returns ? " " + member.returns : ""}`
          : indent(2)`${member.visibility}${member.typeText} ${member.name}`,
      );
    lines.push(indent(1)`}`);
  }

  lines.push(...relationLines);
  return lines.join("\n");
};
