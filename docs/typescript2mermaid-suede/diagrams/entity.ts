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

export namespace Entity {
  export type Cardinality =
    | "one-to-one" // ||--||
    | "one-to-many" // ||--|{
    | "one-to-zero-or-many" // ||--o{
    | "zero-or-one-to-many" // |o--|{
    | "many-to-one" // }|--||
    | "many-to-many"; // }|--|{

  /** Everything that may appear in an entity-relationship body. */
  export type Statement = Relation<any, any, any, any> | Include<any>;

  /**
   * Entity attribute lists come straight from the resolved types;
   * `Key.Primary` / `Key.Foreign` / `Key.Unique` are identity wrappers
   * detected on each property's declaration.
   */
  export type Diagram<
    Body extends readonly Statement[],
    Opts extends Render.Options<any> = Render.Options,
  > = { readonly __er: [Body, Opts] };

  /** `Relation<USER, ORDER, "one-to-zero-or-many", "places">` */
  export type Relation<A, B, Card extends Cardinality, Label extends string> = {
    readonly __relation: [A, B, Card, Label];
  };

  /** Include an entity that has no relations. */
  export type Include<T> = { readonly __entity: [T] };

  /**
   * Attribute key markers (identity types; detected syntactically):
   *
   *   type USER = {
   *     user_id: Entity.Key.Primary<Entity.Integer>;
   *     username: Entity.Key.Unique<Entity.Text>;
   *   };
   */
  export namespace Key {
    /** Renders the `PK` marker. */
    export type Primary<T> = T;
    /** Renders the `FK` marker. */
    export type Foreign<T> = T;
    /** Renders the `UK` marker. */
    export type Unique<T> = T;
  }

  /* SQL-ish primitive aliases; rendered lowercased in attribute lists. */
  export type Integer = number;
  export type Decimal = number;
  export type Text = string;
  export type DateTime = string;
  export type Boolean = boolean;
}

/** Statement kind → its DSL type, so dispatch labels are checked against the DSL. */
type Statements = {
  Relation: Entity.Relation<any, any, any, any>;
  Include: Entity.Include<any>;
};

/** Cardinality → its Mermaid crow's-foot connector. */
const cardinalities = {
  "one-to-one": "||--||",
  "one-to-many": "||--|{",
  "one-to-zero-or-many": "||--o{",
  "zero-or-one-to-many": "|o--|{",
  "many-to-one": "}|--||",
  "many-to-many": "}|--|{",
} as const satisfies Record<Entity.Cardinality, string>;

const cardinality = (query: Entity.Cardinality | (string & {})): string =>
  cardinalities[
    query in cardinalities ? (query as Entity.Cardinality) : "one-to-one"
  ];

/**
 * Declared TS type text → conventional ER attribute type. Anything unmapped
 * falls back to a sanitized lowercasing of the declared type.
 */
const erTypes = {
  string: "string",
  number: "int",
  boolean: "boolean",
  Date: "datetime",
  Integer: "int",
  Decimal: "decimal",
  Text: "text",
  DateTime: "datetime",
  Boolean: "boolean",
} as const satisfies Record<string, string>;

const attributeType = (typeText: string): string => {
  const short = typeText.split(".").pop() ?? typeText;
  return (
    (erTypes as Record<string, string>)[short] ??
    short.toLowerCase().replace(/[^a-z0-9_]/g, "_")
  );
};

export const render = (body: TypeNode): string => {
  const lines: string[] = ["erDiagram"];
  const relationLines: string[] = [];
  const entities = new Map<string, TypeNode>();

  /** Register a referenced type as an entity (first occurrence wins), return its id. */
  const include = (type: TypeNode): string => {
    const id = idOf(type);
    if (!entities.has(id)) entities.set(id, type);
    return id;
  };

  for (const statement of tupleOf(argsOf(body)[0])) {
    const kind = lastName(statement);
    const args = argsOf(statement);
    if (kind === ("Relation" satisfies keyof Statements)) {
      const [a, b, card, label] = args;
      const connector = cardinality(strOf(card) ?? "one-to-one");
      const text = strOf(label) ?? "";
      // Mermaid requires quoting relation labels that contain whitespace.
      const labelText = /\s/.test(text) ? `"${text}"` : text;
      relationLines.push(
        indent(1)`${include(a!)} ${connector} ${include(b!)} : ${labelText}`,
      );
    } else if (kind === ("Include" satisfies keyof Statements)) {
      include(args[0] ?? fail("Entity.Include<> requires a type", statement));
    } else {
      fail(
        `unknown entity-relationship statement \`${statement.getText()}\``,
        statement,
      );
    }
  }

  lines.push(...relationLines);
  if (relationLines.length && entities.size) lines.push("");

  for (const [id, type] of entities) {
    const members = safeMembers(type);
    if (members.length === 0) continue;
    lines.push(indent(1)`${id} {`);
    for (const member of members) {
      const keys = member.keys.length ? " " + member.keys.join(",") : "";
      lines.push(
        indent(2)`${attributeType(member.typeText)} ${member.name}${keys}`,
      );
    }
    lines.push(indent(1)`}`);
  }

  return lines.join("\n");
};
