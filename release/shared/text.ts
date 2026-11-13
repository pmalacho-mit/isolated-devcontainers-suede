// Text someone else wrote (an agent, a repository, a VM), on its way to a person: to a
// terminal, where some characters are commands, and to a page or a prompt, where others
// change what is seen (bidirectional overrides reorder a line; zero-width characters hide in
// one). One rule for every place desolate shows such text.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../.suede/nests/dsl.import.meta.vitest.ts";

/** Controls, format characters (bidirectional overrides, zero-width), private-use and
 *  unassigned code points, and the line and paragraph separators. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;

/** Text another wrote, safe to print in a terminal: no control characters, no
 *  bidirectional overrides or invisible formatting, and not too long. */
export const printable = (value: unknown, max = 300, instead = "?"): string =>
  [...String(value ?? "").slice(0, max * 4).normalize("NFC").replace(UNSAFE, instead)].slice(0, max).join("");
declare namespace printable {
  /** text kept; what a terminal would act on (controls, bidirectional overrides, invisible
   *  formatting) replaced; cut to length */
  export type Cases = Table<typeof printable, [
    [args: [value: "issue/12 ✓ café"], expected: "issue/12 ✓ café"],
    [args: [value: "a\u0000b\u001bc"], expected: "a?b?c"],
    [args: [value: "ready \u202edlrow"], expected: "ready ?dlrow"],
    [args: [value: "zero\u200bwidth"], expected: "zero?width"],
    [args: [value: "xxxxxxxxxx", max: 4], expected: "xxxx"],
    [args: [value: undefined], expected: ""],
    [args: [value: "a\tb\nc", max: 10, instead: " "], expected: "a b c"],
  ]>;
}

/** As printable, for text of many lines: newlines and tabs are kept, and nothing is cut. */
export const printableLines = (value: unknown, instead = "?"): string =>
  String(value ?? "").split("\n").map((line) => line.split("\t").map((part) => printable(part, Infinity, instead)).join("\t")).join("\n");

declare namespace printableLines {
  export type Cases = Table<typeof printableLines, [
    [args: [value: "+ ok\n-\tgone\n"], expected: "+ ok\n-\tgone\n"],
    [args: [value: "+ x = 1; \u202e// \u2066evil\u2069\n\u001b[2J"], expected: "+ x = 1; ?// ?evil?\n?[2J"],
  ]>;
}
