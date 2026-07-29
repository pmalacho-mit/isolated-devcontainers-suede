import type { TypeNode } from "ts-morph";
import {
  indent,
  argsOf,
  idOf,
  lastName,
  numOf,
  strOf,
  tupleOf,
} from "../typescript-dsl-suede/index.js";
import { fail, type AnyNode, type Render } from "../common.js";

export namespace Journey {
  /** Task scores are the 1–5 satisfaction scale Mermaid journeys use. */
  export type Satisfaction = 1 | 2 | 3 | 4 | 5;

  export type Diagram<
    Title extends string,
    Body extends readonly Section<any, any>[],
    Opts extends Render.Options<any> = Render.Options,
  > = { readonly __journey: [Title, Body, Opts] };

  export type Section<
    Name extends string,
    Tasks extends readonly Task<any, any, any>[],
  > = { readonly __jsection: [Name, Tasks] };

  /**
   * `Task<"Visit homepage", 5, [User]>` — actors are type references or
   * string literals (for names with spaces).
   */
  export type Task<
    Desc extends string,
    Score extends Satisfaction,
    Actors extends readonly (AnyNode | string)[],
  > = { readonly __jtask: [Desc, Score, Actors] };
}

/** Statement kind → its DSL type, so dispatch labels are checked against the DSL. */
type Statements = {
  Section: Journey.Section<any, any>;
  Task: Journey.Task<any, any, any>;
};

export const render = (body: TypeNode): string => {
  const [title, sections] = argsOf(body);
  const lines: string[] = ["journey", indent(1)`title ${strOf(title) ?? ""}`];

  for (const section of tupleOf(sections)) {
    if (lastName(section) !== ("Section" satisfies keyof Statements))
      fail("Journey body must contain Section<> entries", section);
    const [name, tasks] = argsOf(section);
    lines.push(indent(1)`section ${strOf(name) ?? ""}`);
    for (const task of tupleOf(tasks)) {
      if (lastName(task) !== ("Task" satisfies keyof Statements))
        fail("Section body must contain Task<> entries", task);
      const [desc, score, actors] = argsOf(task);
      const actorNames = tupleOf(actors)
        .map((a) => strOf(a) ?? idOf(a))
        .join(", ");
      // Mermaid journeys indent tasks one step deeper than sections (6 spaces).
      lines.push(
        indent(1, 6)`${strOf(desc) ?? ""}: ${numOf(score) ?? 3}: ${actorNames}`,
      );
    }
  }
  return lines.join("\n");
};
