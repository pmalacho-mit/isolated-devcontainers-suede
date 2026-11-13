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
// (Raw 8-bit C1 bytes are not touched: in UTF-8 they are parts of ordinary characters, ✓ is
// E2 9C 93. A C1 control written AS UTF-8, C2 80 to C2 9F, is dropped below.)

export const terminalFilter = () => {
  // "text": passing bytes; "esc": just saw ESC; "csi": inside ESC [ ... (held, to look at);
  // "string": inside a string to drop; "stringEsc": inside one, just saw ESC (ST may follow);
  // "c2": just saw 0xC2, which with 0x80-0x9F is a C1 control written as UTF-8 (U+0080 to
  // U+009F: some emulators act on those as on ESC-forms: OSC, DCS, CSI).
  let state: "text" | "esc" | "csi" | "string" | "stringEsc" | "c2" = "text";
  let dropped = 0;
  let csi: number[] = [];
  return (chunk: Buffer): Buffer => {
    const out: number[] = [];
    const emitCsi = (final: number) => {
      const params = Buffer.from(csi).toString("latin1");
      csi = [];
      // xterm's window operations (move, resize, report the title): not an agent's.
      if (final === 0x74 /* t */) return;
      // SGR 8 (concealed): text that is copied but not seen. Taken out of an SGR.
      if (final === 0x6d /* m */ && /(^|;)(8|28)(;|$)/.test(params)) {
        const kept = params.split(";").filter((p) => p !== "8" && p !== "28").join(";");
        out.push(ESC, 0x5b, ...Buffer.from(kept, "latin1"), final);
        return;
      }
      out.push(ESC, 0x5b, ...Buffer.from(params, "latin1"), final);
    };
    for (const byte of chunk) {
      if (state === "text") {
        if (byte === ESC) state = "esc";
        else if (byte === 0xc2) state = "c2";
        else out.push(byte);
      } else if (state === "c2") {
        if (byte >= 0x80 && byte <= 0x9f) state = "text"; // a C1 control: dropped
        else {
          out.push(0xc2);
          state = "text";
          if (byte === ESC) state = "esc";
          else if (byte === 0xc2) state = "c2";
          else out.push(byte);
        }
      } else if (state === "esc") {
        if (STRING_OPENERS.has(byte)) {
          state = "string";
          dropped = 0;
        } else if (byte === 0x5b /* [ */) {
          state = "csi";
          csi = [];
        } else {
          out.push(ESC);
          if (byte === ESC) continue;
          out.push(byte);
          state = "text";
        }
      } else if (state === "csi") {
        if (byte >= 0x40 && byte <= 0x7e) {
          emitCsi(byte);
          state = "text";
        } else if (csi.length < 256 && byte >= 0x20 && byte <= 0x3f) csi.push(byte);
        else {
          // Not a CSI a terminal would take: what was held is let go as text.
          out.push(ESC, 0x5b, ...csi);
          csi = [];
          state = byte === ESC ? "esc" : "text";
          if (byte !== ESC) out.push(byte);
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
    return Buffer.from(out);
  };
};

/** What undoes the modes a full-screen program may leave on: after a detach, your shell's
 *  terminal is yours again (mouse reporting, focus events, the alternate screen, a hidden
 *  cursor, keypad mode, bracketed paste, colours). */
export const TERMINAL_RESET = "\u001b[?1049l\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1004l\u001b[?2004h\u001b[?25h\u001b>\u001b[0m";

/** One chunk, filtered alone: for the tests below. */
export const filtered = (text: string): string => terminalFilter()(Buffer.from(text, "utf8")).toString("utf8");

declare namespace filtered {
  /** colour, cursor movement and the alternate screen pass: a TUI still draws; so does UTF-8 */
  export type Text = Expect<Invoke<typeof filtered, [text: "ready ✓ café ❝quoted❞"]>, "=", "ready ✓ café ❝quoted❞">;
  export type Kept = Expect<Invoke<typeof filtered, [text: "\u001b[1;32mok\u001b[0m \u001b[?1049h\u001b[2J\u001b[H"]>, "=", "\u001b[1;32mok\u001b[0m \u001b[?1049h\u001b[2J\u001b[H">;
  /** C1 controls written as UTF-8 (U+009D is OSC), window operations, concealed text */
  export type Others = [
    Expect<Invoke<typeof filtered, [text: "a\u009d52;c;eA==\u0007b"]>, "=", "a52;c;eA==\u0007b">,
    Expect<Invoke<typeof filtered, [text: "a\u001b[8;100;200tb"]>, "=", "ab">,
    Expect<Invoke<typeof filtered, [text: "\u001b[1;8mhidden\u001b[0m"]>, "=", "\u001b[1mhidden\u001b[0m">,
    Expect<Invoke<typeof filtered, [text: "\u001b[8m"]>, "=", "\u001b[m">,
  ];
  /** the clipboard, a title, a hyperlink, iTerm2's own: dropped, ended by BEL or by ST */
  export type Dropped = [
    Expect<Invoke<typeof filtered, [text: "a\u001b]52;c;cm0gLXJmIH4=\u0007b"]>, "=", "ab">,
    Expect<Invoke<typeof filtered, [text: "a\u001b]0;You have been pwned\u001b\\b"]>, "=", "ab">,
    Expect<Invoke<typeof filtered, [text: "a\u001b]1337;File=name=eA==:eA==\u0007b"]>, "=", "ab">,
    Expect<Invoke<typeof filtered, [text: "a\u001bP1000p%session-changed\u001b\\b"]>, "=", "ab">,
    Expect<Invoke<typeof filtered, [text: "a\u001b_payload\u001b\\b"]>, "=", "ab">,
  ];
}
