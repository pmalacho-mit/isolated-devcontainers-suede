import {
  argsOf,
  defineDsl,
  lastName,
  optionsOf,
  strOf,
  type Finding,
} from "./typescript-dsl-suede/index.js";
import { createAnalyzer } from "./typescript-dsl-suede/presets/dispatch.js";
import { LIBRARY_ROOT } from "./common.js";
import * as Flowchart from "./diagrams/flowchart.js";
import * as Sequence from "./diagrams/sequence.js";
import * as Class from "./diagrams/class.js";
import * as State from "./diagrams/state.js";
import * as Entity from "./diagrams/entity.js";
import * as Journey from "./diagrams/journey.js";
import * as Pie from "./diagrams/pie.js";
import * as Gantt from "./diagrams/gantt.js";

/**
 * The type usages this DSL recognizes, and the function that renders each. Both
 * the DSL specifics and the rendering live in the family's own module; this map
 * only says which node goes to which function.
 */
const analyzer = createAnalyzer({
  name: "typescript2mermaid",
  handlers: {
    "Flowchart.Diagram": Flowchart.render,
    "Sequence.Diagram": Sequence.render,
    "Class.Diagram": Class.render,
    "State.Diagram": State.render,
    "Entity.Diagram": Entity.render,
    "Journey.Diagram": Journey.render,
    "Pie.Diagram": Pie.render,
    "Gantt.Diagram": Gantt.render,
  },
  // A `<Family>.Diagram` is only ours if the checker resolves it into this
  // library — a user's own `namespace Flowchart { type Diagram }` is not a
  // diagram. The qualified handler keys still route among the families.
  declaredWithin: LIBRARY_ROOT,
  // Every diagram gets the same theme prologue, so it belongs here rather than
  // repeated inside eight render functions.
  transform: (code, node) => {
    const lines = new Array<string>();
    for (const opt of optionsOf(node))
      if (lastName(opt) === "Theme")
        lines.push(
          `%%{init: {'theme':'${strOf(argsOf(opt)[0]) ?? "default"}'}}%%`,
        );
    lines.push(code);
    return lines.join("\n");
  },
});

// Identity matching needs a snippet's imports to resolve, so `dsl.code(...)`
// runs on the real filesystem. `files`/`createSession` already do.
export const dsl = defineDsl(analyzer, { resolveImports: true });

const emit = ({ label, id, range: { file }, data: code }: Finding<string>) => ({
  name: label ?? id,
  file,
  code,
});

export const renderFrom = {
  files: (paths: string[], tsConfigFilePath?: string) =>
    dsl.files(paths, tsConfigFilePath).map(emit),
  /**
   * Generate from a string — the testing front door. Only exported aliases are
   * emitted; an unexported alias is a helper (e.g. a `type Body = [...]` shared
   * across several themed diagrams).
   */
  code: (code: string, fileName = "diagram.ts") =>
    dsl.code(code, fileName).map(emit),
};
