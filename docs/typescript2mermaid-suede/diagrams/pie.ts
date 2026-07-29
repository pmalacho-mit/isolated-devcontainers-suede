import type { TypeNode } from "ts-morph";
import {
  indent,
  argsOf,
  constructClassifier,
  numOf,
  numericLiteralProps,
  strOf,
  tupleOf,
} from "../typescript-dsl-suede/index.js";
import { fail, type Render, LIBRARY_ROOT } from "../common.js";

export namespace Pie {
  /**
   * Body is either a tuple of `Slice<...>` entries or an object type whose
   * numeric-literal properties become slices:
   *
   *   type Usage = { CPU: 35; Memory: 25 };
   *   type Chart = Pie.Diagram<"Resource Usage", Usage>;
   */
  export type Diagram<
    Title extends string,
    Body extends readonly Slice<any, any>[] | Record<string, number>,
    Opts extends Render.Options<any> = Render.Options,
  > = { readonly __pie: [Title, Body, Opts] };

  export type Slice<Label extends string, Value extends number> = {
    readonly __slice: [Label, Value];
  };
}

/** Statement kind → its DSL type, so dispatch labels are checked against the DSL. */
type Statements = {
  Slice: Pie.Slice<any, any>;
};

/**
 * A user type named `Slice` is legal as the object-form body, so only a
 * `Pie.Slice<…>` the checker resolves into this library counts as a tuple entry.
 * The `keyof Statements` annotation keeps the label checked against the DSL.
 */
const isSlice = constructClassifier(["Slice"] satisfies (keyof Statements)[], {
  qualifier: "Pie",
  declaredWithin: LIBRARY_ROOT,
});

export const render = (body: TypeNode): string => {
  const [title, data] = argsOf(body);
  const lines: string[] = [`pie title ${strOf(title) ?? ""}`];

  const entries = tupleOf(data);
  const isSlices = entries.length > 0 && entries.every((e) => isSlice(e));
  if (isSlices) {
    for (const slice of entries) {
      const [label, value] = argsOf(slice);
      lines.push(indent(1)`"${strOf(label) ?? ""}" : ${numOf(value) ?? 0}`);
    }
  } else if (data) {
    // Object-type body: numeric-literal properties become slices.
    const props = numericLiteralProps(data);
    if (props.length === 0)
      fail(
        "Pie body must be Slice<> entries or a type with numeric-literal properties",
        data,
      );
    for (const prop of props)
      lines.push(indent(1)`"${prop.name}" : ${prop.value}`);
  }
  return lines.join("\n");
};
