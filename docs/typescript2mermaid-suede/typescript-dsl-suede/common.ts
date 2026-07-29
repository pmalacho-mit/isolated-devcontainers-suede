/**
 * Optional type-level conventions and the one emitter helper worth sharing.
 *
 * Nothing here is required. `AnyType` and `Options` are idioms that happen to
 * come up often; use them if they fit, ignore them if they don't.
 */
import type { TypeNode } from "ts-morph";
import { argsOf, lastName, tupleOf } from "./parse.js";

/**
 * Any of the user's own object types. The `length` exclusion is what keeps a
 * tuple from matching here — without it, structural typing makes "a referenced
 * type" and "a list of constructs" indistinguishable.
 */
export type AnyType = object & { readonly length?: never };

/**
 * A trailing options bag, located by key rather than by position:
 *
 *   Flow.Diagram<"topdown", [...], Options<[Theme<"dark">]>>
 *
 * Because the reader finds it by name, constructs are free to take different
 * numbers of arguments before it. Define your own option types and union them
 * into `O`.
 */
export type Options<O extends readonly unknown[] = []> = {
  readonly __options: O;
};

/** Name `optionsOf` looks for. */
export const OPTIONS_NAME = "Options";

/**
 * The option constructs supplied to a node, or `[]` when none were given. Found
 * by key among the node's type arguments, so argument position doesn't matter.
 */
export function optionsOf(node: TypeNode, name = OPTIONS_NAME): TypeNode[] {
  const marker = argsOf(node).find((arg) => lastName(arg) === name);
  const list = marker ? argsOf(marker)[0] : undefined;
  return list ? tupleOf(list) : [];
}

/**
 * Indentation-aware template tag: ``indent(2)`class ${id} {` ``.
 *
 * Deliberately the *only* emitter abstraction here — real emitters are
 * idiosyncratic enough that a framework above this line costs more than it saves.
 */
export const indent =
  (level: number, amount = 4) =>
  (strings: TemplateStringsArray, ...values: unknown[]) =>
    " ".repeat(amount).repeat(level) + String.raw({ raw: strings }, ...values);
