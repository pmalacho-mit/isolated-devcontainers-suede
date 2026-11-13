// Syntax colour for a diff, on the approval page and the dashboard. What is shown is still
// git's text, every character of it, set as text: this only says what colour each piece is.
//
// The colouring is worked out in a worker (highlight-worker.js: Shiki and its grammars, from
// this origin; no network, no WebAssembly, no eval) that answers with data. Each line's tokens
// are used only if their text is exactly the line's text, and a colour only if it is #rrggbb.
// A worker that takes longer than WAIT_MS is ended, and the diff stays plain: a grammar is a
// set of regular expressions, and a line crafted to make one backtrack must cost nothing but
// the colour.
"use strict";
const DesolateHighlight = (() => {
  const WAIT_MS = 2500;
  const MOST = { bytes: 1024 * 1024, lines: 40_000 };
  const BY_EXTENSION = {
    py: "python", pyi: "python", ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript",
    jsx: "jsx", svelte: "svelte", rs: "rust", json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "toml", css: "css", html: "html", htm: "html",
    md: "markdown", sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  };
  const langOf = (file) => {
    const name = file.split("/").pop() || "";
    if (name === "Dockerfile" || name === ".bashrc" || name === ".zshrc") return name === "Dockerfile" ? null : "shellscript";
    const dot = name.lastIndexOf(".");
    return dot > 0 ? BY_EXTENSION[name.slice(dot + 1).toLowerCase()] || null : null;
  };

  let worker = null;
  let next = 1;
  const waiting = new Map();
  const end = () => {
    if (worker) worker.terminate();
    worker = null;
    for (const resolve of waiting.values()) resolve(null);
    waiting.clear();
  };
  const ask = (jobs) => new Promise((resolve) => {
    try {
      if (!worker) {
        worker = new Worker("/highlight-worker.js");
        worker.onmessage = ({ data }) => {
          const done = waiting.get(data && data.id);
          if (done) { waiting.delete(data.id); done(Array.isArray(data.results) ? data.results : null); }
        };
        worker.onerror = end;
      }
    } catch {
      return resolve(null);
    }
    const id = next++;
    const timer = setTimeout(() => { if (waiting.has(id)) end(); }, WAIT_MS);
    waiting.set(id, (results) => { clearTimeout(timer); resolve(results); });
    worker.postMessage({ id, jobs });
  });

  const COLOUR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
  /** A line's tokens, if they are exactly its text and nothing else; else null. */
  const checked = (tokens, text) => {
    if (!Array.isArray(tokens)) return null;
    let joined = "";
    for (const t of tokens) {
      if (!Array.isArray(t) || typeof t[0] !== "string") return null;
      joined += t[0];
    }
    if (joined !== text) return null;
    return tokens.map((t) => [t[0], COLOUR.test(t[1]) ? t[1] : "", COLOUR.test(t[2]) ? t[2] : "", Number(t[3]) & 7]);
  };

  /** For each line of a unified diff, its code's tokens (without the +, - or space), or null.
   *  Each hunk is coloured as two pieces of code, its old side and its new side, so what spans
   *  lines (a string, a docstring, a comment) is coloured as one. */
  const tokensFor = async (text) => {
    const lines = text.split("\n");
    const out = new Array(lines.length).fill(null);
    if (text.length > MOST.bytes || lines.length > MOST.lines) return out;
    const sides = []; // { lang, at: [line indexes], text: [code] }
    let lang = null;
    let old = null;
    let neu = null;
    const close = () => {
      for (const side of [old, neu]) if (side && side.at.length) sides.push(side);
      old = neu = null;
    };
    lines.forEach((line, i) => {
      if (line.startsWith("diff --git ")) {
        close();
        const named = /^diff --git a\/.* b\/(.*)$/.exec(line);
        lang = named ? langOf(named[1]) : null;
      } else if (line.startsWith("@@")) {
        close();
        if (lang) { old = { lang, at: [], text: [] }; neu = { lang, at: [], text: [] }; }
      } else if (old && (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+"))) {
        const code = line.slice(1);
        if (line[0] !== "+") { old.at.push(i); old.text.push(code); }
        if (line[0] !== "-") { neu.at.push(i); neu.text.push(code); }
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file": git's note, inside a hunk, of no side.
      } else close();
    });
    close();
    if (!sides.length) return out;
    const results = await ask(sides.map((s) => ({ lang: s.lang, text: s.text.join("\n") })));
    if (!results) return out;
    sides.forEach((side, k) => {
      const lineTokens = results[k];
      if (!Array.isArray(lineTokens)) return;
      side.at.forEach((i, j) => {
        // A context line is in both sides: the new side's colouring wins (it is coloured last).
        const tokens = checked(lineTokens[j], side.text[j]);
        if (tokens) out[i] = tokens;
      });
    });
    return out;
  };

  /** A line of code as nodes: each token a span of its colour, its text as text (through
   *  `shown`, which names the characters that hide or reorder text), and, given a range of
   *  the shown text, that part marked. */
  const paint = (tokens, shown, range) => {
    const nodes = [];
    let at = 0;
    for (const [text, light, dark, style] of tokens) {
      const piece = shown(text);
      const cuts = [0, piece.length];
      if (range) for (const edge of range) if (edge > at && edge < at + piece.length) cuts.push(edge - at);
      cuts.sort((a, b) => a - b);
      for (let c = 0; c + 1 < cuts.length; c++) {
        if (cuts[c] === cuts[c + 1]) continue;
        const span = document.createElement("span");
        span.className = "hl";
        span.textContent = piece.slice(cuts[c], cuts[c + 1]);
        if (light) span.style.setProperty("--hl-light", light);
        if (dark) span.style.setProperty("--hl-dark", dark);
        if (style & 1) span.style.fontStyle = "italic";
        if (style & 2) span.style.fontWeight = "600";
        const inside = range && at + cuts[c] >= range[0] && at + cuts[c + 1] <= range[1];
        if (inside) {
          const mark = document.createElement("mark");
          mark.append(span);
          nodes.push(mark);
        } else nodes.push(span);
      }
      at += piece.length;
    }
    return nodes;
  };

  return { tokensFor, paint, langOf };
})();
