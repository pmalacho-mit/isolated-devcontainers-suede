import type { TypeNode } from "ts-morph";
import {
  indent,
  argsOf,
  idOf,
  lastName,
  strOf,
  tupleOf,
} from "../typescript-dsl-suede/index.js";
import { fail, type AnyNode, type Render } from "../common.js";

export namespace Sequence {
  /** `"activate"` opens an activation box on the target; `"deactivate"` closes the source's. */
  export type Activation = "activate" | "deactivate";

  /** Everything that may appear in a sequence body. */
  export type Statement =
    | Participant<any, any>
    | Actor<any, any>
    | Message<any, any, any, any>
    | Reply<any, any, any, any>
    | Lost<any, any, any>
    | Async<any, any, any>
    | NoteOver<any, any>
    | NoteRight<any, any>
    | NoteLeft<any, any>
    | Loop<any, any>
    | Optional<any, any>
    | Alternative<any, any, any, any>;

  export type Diagram<
    Body extends readonly Statement[],
    Opts extends Render.Options<any> = Render.Options,
  > = { readonly __seq: [Body, Opts] };

  export type Participant<T, Alias extends string = never> = {
    readonly __participant: [T, Alias];
  };
  export type Actor<T, Alias extends string = never> = {
    readonly __actor: [T, Alias];
  };

  /** Solid arrow `->>` (synchronous message). */
  export type Message<
    From,
    To,
    Text extends string,
    A extends Activation = never,
  > = { readonly __msg: [From, To, Text, A] };
  /** Dashed arrow `-->>`. */
  export type Reply<
    From,
    To,
    Text extends string,
    A extends Activation = never,
  > = { readonly __reply: [From, To, Text, A] };
  /** Cross ending `-x` (lost message). */
  export type Lost<From, To, Text extends string> = {
    readonly __lost: [From, To, Text];
  };
  /** Open arrow `-)` (async). */
  export type Async<From, To, Text extends string> = {
    readonly __async: [From, To, Text];
  };

  export type NoteOver<
    Targets extends readonly AnyNode[],
    Text extends string,
  > = { readonly __noteover: [Targets, Text] };
  export type NoteRight<T, Text extends string> = {
    readonly __noteright: [T, Text];
  };
  export type NoteLeft<T, Text extends string> = {
    readonly __noteleft: [T, Text];
  };

  export type Loop<Label extends string, Body extends readonly Statement[]> = {
    readonly __loop: [Label, Body];
  };
  export type Optional<
    Label extends string,
    Body extends readonly Statement[],
  > = { readonly __opt: [Label, Body] };
  export type Alternative<
    Label extends string,
    Body extends readonly Statement[],
    ElseLabel extends string = never,
    ElseBody extends readonly Statement[] = never,
  > = { readonly __alt: [Label, Body, ElseLabel, ElseBody] };
}

/** Statement kind → its DSL type, so dispatch labels are checked against the DSL. */
type Statements = {
  Participant: Sequence.Participant<any, any>;
  Actor: Sequence.Actor<any, any>;
  Message: Sequence.Message<any, any, any, any>;
  Reply: Sequence.Reply<any, any, any, any>;
  Lost: Sequence.Lost<any, any, any>;
  Async: Sequence.Async<any, any, any>;
  NoteOver: Sequence.NoteOver<any, any>;
  NoteRight: Sequence.NoteRight<any, any>;
  NoteLeft: Sequence.NoteLeft<any, any>;
  Loop: Sequence.Loop<any, any>;
  Optional: Sequence.Optional<any, any>;
  Alternative: Sequence.Alternative<any, any, any, any>;
};

/** Lifeline-declaring statements and their Mermaid keyword. */
const lifelines = {
  Participant: "participant",
  Actor: "actor",
} as const satisfies Partial<Record<keyof Statements, string>>;

/** Message-bearing statements and their base arrow. */
const arrows = {
  Message: "->>",
  Reply: "-->>",
  Lost: "-x",
  Async: "-)",
} as const satisfies Partial<Record<keyof Statements, string>>;

/** Suffix an activation adds to a message arrow (`->>+` / `->>-`). */
const activations = {
  activate: "+",
  deactivate: "-",
} as const satisfies Record<Sequence.Activation, string>;

const activationSuffix = (
  query: Sequence.Activation | (string & {}) | undefined,
): string =>
  query && query in activations
    ? activations[query as Sequence.Activation]
    : "";

/** Note-placement statements and the phrase that follows `Note`. */
const notes = {
  NoteOver: "over",
  NoteRight: "right of",
  NoteLeft: "left of",
} as const satisfies Partial<Record<keyof Statements, string>>;

/** Block statements that wrap an inner body between a keyword line and `end`. */
const blocks = {
  Loop: "loop",
  Optional: "opt",
  Alternative: "alt",
} as const satisfies Partial<Record<keyof Statements, string>>;

function appendSeqStatement(
  type: TypeNode,
  lines: string[],
  level: number,
): void {
  const kind = lastName(type);
  const args = argsOf(type);
  switch (kind) {
    case "Participant" satisfies keyof Statements:
    case "Actor" satisfies keyof Statements: {
      const [t, alias] = args;
      const named = strOf(alias);
      lines.push(
        indent(
          level,
        )`${lifelines[kind]} ${idOf(t!)}${named ? ` as ${named}` : ""}`,
      );
      return;
    }
    case "Message" satisfies keyof Statements:
    case "Reply" satisfies keyof Statements: {
      const [from, to, text, act] = args;
      const arrow = arrows[kind] + activationSuffix(strOf(act));
      lines.push(
        indent(level)`${idOf(from!)}${arrow}${idOf(to!)}: ${strOf(text) ?? ""}`,
      );
      return;
    }
    case "Lost" satisfies keyof Statements:
    case "Async" satisfies keyof Statements: {
      const [from, to, text] = args;
      lines.push(
        indent(
          level,
        )`${idOf(from!)}${arrows[kind]}${idOf(to!)}: ${strOf(text) ?? ""}`,
      );
      return;
    }
    case "NoteOver" satisfies keyof Statements: {
      const [targets, text] = args;
      const ids = tupleOf(targets)
        .map((t) => idOf(t))
        .join(",");
      lines.push(
        indent(level)`Note ${notes.NoteOver} ${ids}: ${strOf(text) ?? ""}`,
      );
      return;
    }
    case "NoteRight" satisfies keyof Statements:
    case "NoteLeft" satisfies keyof Statements: {
      const [t, text] = args;
      lines.push(
        indent(level)`Note ${notes[kind]} ${idOf(t!)}: ${strOf(text) ?? ""}`,
      );
      return;
    }
    case "Loop" satisfies keyof Statements:
    case "Optional" satisfies keyof Statements: {
      const [label, body] = args;
      lines.push(indent(level)`${blocks[kind]} ${strOf(label) ?? ""}`);
      for (const inner of tupleOf(body))
        appendSeqStatement(inner, lines, level + 1);
      lines.push(indent(level)`end`);
      return;
    }
    case "Alternative" satisfies keyof Statements: {
      const [label, body, elseLabel, elseBody] = args;
      lines.push(indent(level)`${blocks.Alternative} ${strOf(label) ?? ""}`);
      for (const inner of tupleOf(body))
        appendSeqStatement(inner, lines, level + 1);
      if (elseBody) {
        lines.push(indent(level)`else ${strOf(elseLabel) ?? ""}`);
        for (const inner of tupleOf(elseBody))
          appendSeqStatement(inner, lines, level + 1);
      }
      lines.push(indent(level)`end`);
      return;
    }
    default:
      fail(`unknown sequence statement \`${type.getText()}\``, type);
  }
}

export const render = (body: TypeNode): string => {
  const lines: string[] = ["sequenceDiagram"];
  for (const statement of tupleOf(argsOf(body)[0]))
    appendSeqStatement(statement, lines, 1);
  return lines.join("\n");
};
