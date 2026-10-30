/**
 * hints.ts -- the follow-up commands desolate prints, spelled for the terminal
 * the reader is actually in.
 *
 * There are two, and the same command is spelled differently in each:
 *
 *   editor  the outer editor's terminal. `desolate` there is a broker client.
 *   mac     the Mac's terminal. The same thing is `./cli.sh desolate`.
 *
 * The process printing a hint cannot tell which one it serves -- both reach
 * desolate.ts through `docker exec` or the broker -- so each caller says, in
 * DESOLATE_PLANE: broker.ts sets `editor`, cli.sh sets `mac`. With neither set
 * a hint names both spellings rather than guessing one (#9).
 */

export type Plane = "editor" | "mac";

export const PLANE_VARIABLE = "DESOLATE_PLANE";

/** The plane named by `value`, or undefined for anything else -- an unknown
 *  value is treated exactly like an unset one. */
export const planeFrom = (value: string | undefined): Plane | undefined =>
  value === "editor" || value === "mac" ? value : undefined;

const WHERE = {
  editor: "(in the editor terminal)",
  mac: "(on your Mac)",
} as const;

export const createHints = (plane: Plane | undefined) => {
  /** A command both terminals have, under a different name in each. */
  const anywhere = (editorCommand: string, macCommand: string) => {
    if (plane === "editor") return `${editorCommand}   ${WHERE.editor}`;
    if (plane === "mac") return `${macCommand}   ${WHERE.mac}`;
    return `${editorCommand}   ${WHERE.editor}, or ${macCommand}   ${WHERE.mac}`;
  };

  return {
    anywhere,
    /** `desolate <args>`, the command both terminals have. */
    desolate: (args: string) =>
      anywhere(`desolate ${args}`, `./cli.sh desolate ${args}`),
    /** `./cli.sh <args>`, which exists only on the Mac -- said so even when the
     *  reader is in the editor, because that is where they would try it. */
    mac: (args: string) => `./cli.sh ${args}   ${WHERE.mac}`,
  };
};

/** The hints for this process, from its environment. */
export const hint = createHints(planeFrom(process.env[PLANE_VARIABLE]));
