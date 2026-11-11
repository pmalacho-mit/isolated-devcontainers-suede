/**
 * Strip JSONC comments and trailing commas.
 */
export function strip(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    // Inside a string: copy verbatim through the closing quote, honouring
    // backslash escapes. Comment starts are just characters in here.
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        if (text[i] === "\\" && i + 1 < n) {
          out += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++; // drop to end of line
      continue;
    }

    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2; // skip the closing */
      continue;
    }

    out += c;
    i++;
  }

  // Trailing commas: JSONC allows them, JSON.parse does not. Only reached
  // outside strings because the loop above already consumed string bodies --
  // but we re-scan defensively rather than regexing over raw text.
  return removeTrailingCommas(out);
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        if (text[i] === "\\" && i + 1 < n) {
          out += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      } // drop the comma
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Parse a devcontainer.json (JSONC).
 * @throws on anything unparseable.
 */
export const parse = (text: string) => JSON.parse(strip(text));
