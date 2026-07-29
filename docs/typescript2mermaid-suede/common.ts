import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TypeNode } from "ts-morph";
import {
  failWith,
  safeMembers as safeMembersOf,
  type AnyType,
  type Options,
  ResolvedMember as BaseMember,
} from "./typescript-dsl-suede/index.js";

/**
 * The vendored library's own root — this `release/` directory.
 *
 * A reference is one of *our* constructs only if the checker resolves it to a
 * declaration inside here. Since consumers vendor this folder into their project
 * and import it by relative path, that resolves; a user type sharing a
 * construct's name never does. Passed to the analyzer and the family classifiers
 * as their `declaredWithin` route. See the DSL library's `constructClassifier`.
 */
export const LIBRARY_ROOT = dirname(fileURLToPath(import.meta.url));

/** Escape text for use inside a quoted Mermaid node label. */
export const escape = (text: string) => text.replace(/"/g, "#quot;");

const VISIBILITY_MARKERS: Record<string, string> = {
  Private: "-",
  Protected: "#",
  Internal: "~",
};

/** Entity.Key.* marker name → mermaid key code. */
const KEY_MARKERS: Record<string, string> = {
  Primary: "PK",
  Foreign: "FK",
  Unique: "UK",
};

const isMarker = (name: string): boolean =>
  name in VISIBILITY_MARKERS || name in KEY_MARKERS;

export interface ResolvedMember extends BaseMember {
  /** Mermaid visibility symbol (+, -, #, ~). Defaults to "+". */
  visibility: string;
  /** Mermaid key codes for Entity.Key markers on the declaration (PK/FK/UK). */
  keys: string[];
}

/**
 * Fully resolved members of a type, with Mermaid's marker wrappers (Private,
 * Key.Primary, ...) decoded. Markers are identity types, so the checker sees
 * clean types; they are recovered syntactically from each property's original
 * declaration.
 */

export function safeMembers(t: TypeNode): ResolvedMember[] {
  return safeMembersOf(t, { isMarker }).map((member) => {
    let visibility = "+";
    const keys: string[] = [];
    for (const marker of member.markers) {
      if (marker in VISIBILITY_MARKERS)
        visibility = VISIBILITY_MARKERS[marker]!;
      else if (marker in KEY_MARKERS) keys.push(KEY_MARKERS[marker]!);
    }
    return { ...member, visibility, keys };
  });
}

export const fail = failWith("typescript2mermaid");

/**
 * A node in a diagram: any of your own object types. Referenced types are
 * fully resolved by the type checker at generation time. (The `length`
 * exclusion only exists to keep statement tuples from matching here.)
 */
export type AnyNode = AnyType;

export namespace Render {
  /** Sets a Mermaid `%%{init}%%` theme directive on the rendered diagram. */
  export type Theme<T extends "default" | "dark" | "forest" | "neutral"> = {
    readonly __theme: T;
  };

  /** A single render option. */
  export type Option = Theme<any>;

  /**
   * A diagram's optional final type argument. The `__options` key lets the
   * generator retrieve options by name, independent of how many content
   * arguments a given family's Diagram takes before them:
   *
   *   Flowchart.Diagram<"topdown", [...], Options<[Theme<"dark">]>>
   */
  export type Options<O extends Option[] = []> = Options_<O>;
}

/** Aliased so the namespace member above can shadow the imported name. */
type Options_<O extends readonly unknown[]> = Options<O>;
