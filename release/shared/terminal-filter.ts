// What an agent prints, on its way to the person's own terminal (desolate agent attach,
// desolate exec to a terminal): the terminal emulator on the Mac is not inside any boundary,
// and some of its escape sequences act beyond the screen (OSC 52 writes the clipboard;
// iTerm2's OSC 1337 offers files and runs triggers; DCS strings feed tmux integration and
// sixel parsers, where emulators have had their worst bugs). An agent's output is kept to
// what a full-screen program needs: text, C0 controls, and CSI and single-character escapes
// (colour, cursor movement, scrolling regions, the alternate screen). Every OSC, DCS, APC, PM
// and SOS string is dropped whole, wherever a read happens to split it.
//
// tmux used to stand between the two, interpreting all of it itself; with the agent's terminal
// streamed straight through, this does that part of tmux's job.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke } from "../.suede/nests/dsl.import.meta.vitest.ts";

const ESC = 0x1b;
const BEL = 0x07;
/** ESC followed by these opens a string that runs to ST (ESC \) or, for OSC, BEL. */
const STRING_OPENERS = new Set([0x5d /* ] OSC */, 0x50 /* P DCS */, 0x5f /* _ APC */, 0x5e /* ^ PM */, 0x58 /* X SOS */]);
// (The 8-bit C1 forms are not handled: in UTF-8 those bytes are parts of ordinary characters,
// ✓ is E2 9C 93, and terminals decoding UTF-8 do not read them as controls.)

export const terminalFilter = () => {
  // "text": passing bytes; "esc": just saw ESC; "string": inside a string to drop;
  // "stringEsc": inside one, just saw ESC (an ST may follow).
  let state: "text" | "esc" | "string" | "stringEsc" = "text";
  let dropped = 0;
  return (chunk: Buffer): Buffer => {
    const out = Buffer.alloc(chunk.length + 1);
    let n = 0;
    for (const byte of chunk) {
      if (state === "text") {
        if (byte === ESC) state = "esc";
        else out[n++] = byte;
      } else if (state === "esc") {
        if (STRING_OPENERS.has(byte)) {
          state = "string";
          dropped = 0;
        } else {
          out[n++] = ESC;
          if (byte === ESC) continue;
          out[n++] = byte;
          state = "text";
        }
      } else if (state === "string") {
        dropped++;
        if (byte === BEL) state = "text";
        else if (byte === ESC) state = "stringEsc";
        // A string that never ends is not allowed to swallow the session: after 64 KiB the
        // filter gives up on it and passes text again.
        else if (dropped > 65536) state = "text";
      } else {
        state = byte === 0x5c /* \ : ST */ ? "text" : byte === ESC ? "stringEsc" : "string";
      }
    }
    return out.subarray(0, n);
  };
};

/** One chunk, filtered alone: for the tests below. */
export const filtered = (text: string): string => terminalFilter()(Buffer.from(text, "utf8")).toString("utf8");

declare namespace filtered {
  /** colour, cursor movement and the alternate screen pass: a TUI still draws; so does UTF-8 */
  export type Text = Expect<Invoke<typeof filtered, [text: "ready ✓ café ❝quoted❞"]>, "=", "ready ✓ café ❝quoted❞">;
  export type Kept = Expect<Invoke<typeof filtered, [text: "\u001b[1;32mok\u001b[0m \u001b[?1049h\u001b[2J\u001b[H"]>, "=", "\u001b[1;32mok\u001b[0m \u001b[?1049h\u001b[2J\u001b[H">;
  /** the clipboard, a title, a hyperlink, iTerm2's own: dropped, ended by BEL or by ST */
  export type Dropped = [
    Expect<Invoke<typeof filtered, [text: "a\u001b]52;c;cm0gLXJmIH4=\u0007b"]>, "=", "ab">,
    Expect<Invoke<typeof filtered, [text: "a\u001b]0;You have been pwned\u001b\\b"]>, "=", "ab">,
    Expect<Invoke<typeof filtered, [text: "a\u001b]1337;File=name=eA==:eA==\u0007b"]>, "=", "ab">,
    Expect<Invoke<typeof filtered, [text: "a\u001bP1000p%session-changed\u001b\\b"]>, "=", "ab">,
    Expect<Invoke<typeof filtered, [text: "a\u001b_payload\u001b\\b"]>, "=", "ab">,
  ];
}
