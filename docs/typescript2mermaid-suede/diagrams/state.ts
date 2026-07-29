import type { TypeNode } from "ts-morph";
import {
  indent,
  argsOf,
  idOf,
  lastName,
  strOf,
  tupleOf,
} from "../typescript-dsl-suede/index.js";
import { fail, type Render } from "../common.js";

export namespace State {
  /** The `[*]` start pseudo-state. */
  export interface Start {
    readonly __start: true;
  }
  /** The `[*]` end pseudo-state. */
  export interface End {
    readonly __end: true;
  }

  /** Everything that may appear in a state-diagram body. */
  export type Statement =
    | Transition<any, any, any>
    | Composite<any, any>
    | Note<any, any, any>;

  export type Diagram<
    Body extends readonly Statement[],
    Opts extends Render.Options<any> = Render.Options,
  > = { readonly __state: [Body, Opts] };

  /** `Transition<Idle, Processing, "start">` — use `Start`/`End` for `[*]`. */
  export type Transition<From, To, Label extends string = never> = {
    readonly __transition: [From, To, Label];
  };

  /** `Composite<Active, [Transition<Start, Running>, ...]>` — a nested state machine. */
  export type Composite<T, Body extends readonly Statement[]> = {
    readonly __composite: [T, Body];
  };

  /** `Note<Locked, "right", "Account locked after 3 failed attempts">` */
  export type Note<T, Side extends "right" | "left", Text extends string> = {
    readonly __statenote: [T, Side, Text];
  };
}

/** Statement kind → its DSL type, so dispatch labels are checked against the DSL. */
type Statements = {
  Transition: State.Transition<any, any, any>;
  Composite: State.Composite<any, any>;
  Note: State.Note<any, any, any>;
};

/** Pseudo-states that render as Mermaid's `[*]` start/end marker. */
const pseudoStates = {
  Start: "[*]",
  End: "[*]",
} as const satisfies Record<"Start" | "End", string>;

/** A referenced state's Mermaid id, mapping the Start/End pseudo-states to `[*]`. */
const stateId = (type: TypeNode): string => {
  const name = lastName(type) ?? type.getText();
  return name in pseudoStates
    ? pseudoStates[name as keyof typeof pseudoStates]
    : idOf(type);
};

function appendStateStatement(
  type: TypeNode,
  lines: string[],
  level: number,
): void {
  const kind = lastName(type);
  const args = argsOf(type);
  switch (kind) {
    case "Transition" satisfies keyof Statements: {
      const [from, to, label] = args;
      const text = strOf(label);
      lines.push(
        indent(
          level,
        )`${stateId(from!)} --> ${stateId(to!)}${text ? ` : ${text}` : ""}`,
      );
      return;
    }
    case "Composite" satisfies keyof Statements: {
      const [t, inner] = args;
      lines.push(indent(level)`state ${idOf(t!)} {`);
      for (const s of tupleOf(inner)) appendStateStatement(s, lines, level + 1);
      lines.push(indent(level)`}`);
      return;
    }
    case "Note" satisfies keyof Statements: {
      const [t, side, text] = args;
      lines.push(indent(level)`note ${strOf(side) ?? "right"} of ${idOf(t!)}`);
      lines.push(indent(level + 1)`${strOf(text) ?? ""}`);
      lines.push(indent(level)`end note`);
      return;
    }
    default:
      fail(`unknown state-diagram statement \`${type.getText()}\``, type);
  }
}

export const render = (body: TypeNode): string => {
  const lines: string[] = ["stateDiagram-v2"];
  for (const statement of tupleOf(argsOf(body)[0]))
    appendStateStatement(statement, lines, 1);
  return lines.join("\n");
};
