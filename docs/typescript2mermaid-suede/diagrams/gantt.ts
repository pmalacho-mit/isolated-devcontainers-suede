import type { TypeNode } from "ts-morph";
import {
  indent,
  argsOf,
  lastName,
  strOf,
  tupleOf,
} from "../typescript-dsl-suede/index.js";
import { fail, type Render } from "../common.js";

export namespace Gantt {
  export type Status = "done" | "active" | "crit";

  export type Diagram<
    Title extends string,
    DateFormat extends string,
    Body extends readonly Section<any, any>[],
    Opts extends Render.Options<any> = Render.Options,
  > = { readonly __gantt: [Title, DateFormat, Body, Opts] };

  export type Section<
    Name extends string,
    Tasks extends readonly Task<any, any, any, any, any>[],
  > = { readonly __gsection: [Name, Tasks] };

  /**
   * `Task<"Requirements Analysis", "req", "2024-01-01", "2024-01-15", "done">`
   * `Task<"System Design", "design", After<"req">, "10d", "done">`
   */
  export type Task<
    Desc extends string,
    Id extends string,
    Begin extends string | After<string>,
    Finish extends string,
    S extends Status = never,
  > = { readonly __gtask: [Desc, Id, Begin, Finish, S] };

  /** Dependency start: `After<"req">` → `after req`. */
  export type After<Id extends string> = { readonly __after: Id };
}

/** Statement kind → its DSL type, so dispatch labels are checked against the DSL. */
type Statements = {
  Section: Gantt.Section<any, any>;
  Task: Gantt.Task<any, any, any, any, any>;
};

/** Render a task's begin field: either a literal date or an `After<Id>` dependency. */
const beginClause = (begin: TypeNode | undefined): string =>
  lastName(begin) === "After"
    ? `after ${strOf(argsOf(begin)[0])}`
    : (strOf(begin) ?? "");

export const render = (body: TypeNode): string => {
  const [title, dateFormat, sections] = argsOf(body);
  const lines: string[] = [
    "gantt",
    indent(1)`title ${strOf(title) ?? ""}`,
    indent(1)`dateFormat  ${strOf(dateFormat) ?? "YYYY-MM-DD"}`,
  ];

  for (const section of tupleOf(sections)) {
    if (lastName(section) !== ("Section" satisfies keyof Statements))
      fail("Gantt body must contain Section<> entries", section);
    const [name, tasks] = argsOf(section);
    lines.push(indent(1)`section ${strOf(name) ?? ""}`);
    for (const task of tupleOf(tasks)) {
      if (lastName(task) !== ("Task" satisfies keyof Statements))
        fail("Section body must contain Gantt.Task<> entries", task);
      const [desc, id, begin, finish, status] = argsOf(task);
      // Task metadata after the colon: `[status,] id, begin, finish`.
      const parts: string[] = [];
      const s = strOf(status);
      if (s) parts.push(s);
      parts.push(strOf(id) ?? "task");
      parts.push(beginClause(begin));
      parts.push(strOf(finish) ?? "");
      lines.push(indent(1)`${strOf(desc) ?? ""} :${parts.join(", ")}`);
    }
  }
  return lines.join("\n");
};
