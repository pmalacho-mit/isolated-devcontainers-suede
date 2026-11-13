// T1. Syntax colour for diffs (release/shared/ui/highlight.js and the Shiki bundle it runs in a
// worker). What is shown must stay git's text: tokens are used only if they are exactly a
// line's text, colours only if they are colours, and a worker that does not answer in time
// is ended, the diff left plain.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vm from "node:vm";

const UI = path.resolve(import.meta.dirname, "../../../release/shared/ui");

/** The real bundled worker, run in a context of its own: a message in, its answer out. */
const realWorker = () => {
  const answers: unknown[] = [];
  const self: Record<string, unknown> = { postMessage: (m: unknown) => answers.push(m) };
  vm.runInNewContext(fs.readFileSync(path.join(UI, "highlight-worker.js"), "utf8"), { self, console });
  return (jobs: { lang: string; text: string }[]) => {
    (self.onmessage as (e: { data: unknown }) => void)({ data: { id: 1, jobs } });
    return (answers.pop() as { results: ([string, string, string, number][][] | null)[] }).results;
  };
};

type Fake = { replies: (jobs: { lang: string; text: string }[]) => unknown; ended: number; made: number };
/** highlight.js with a stand-in Worker (and a stand-in document for paint). */
const page = (fake: Fake) => {
  class Worker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { fake.made++; }
    postMessage(message: { id: number; jobs: { lang: string; text: string }[] }) {
      const results = fake.replies(message.jobs);
      if (results !== undefined) setTimeout(() => this.onmessage?.({ data: { id: message.id, results } }), 5);
    }
    terminate() { fake.ended++; }
  }
  const element = (tag: string) => {
    const props: Record<string, string> = {};
    const node = { tag, className: "", textContent: "", children: [] as unknown[], style: { props, setProperty: (k: string, v: string) => void (props[k] = v) } as Record<string, unknown>, append(...c: unknown[]) { node.children.push(...c); } };
    return node;
  };
  const context = { Worker, setTimeout, clearTimeout, document: { createElement: element }, console };
  vm.runInNewContext(`${fs.readFileSync(path.join(UI, "highlight.js"), "utf8")}\nthis.DesolateHighlight = DesolateHighlight;`, context);
  return (context as unknown as { DesolateHighlight: { tokensFor: (t: string) => Promise<unknown[]>; paint: (t: unknown, s: (x: string) => string, r?: number[] | null) => { tag: string; textContent: string; children: { textContent: string }[]; style: { props: Record<string, string> } }[]; langOf: (f: string) => string | null } }).DesolateHighlight;
};

const DIFF = [
  "diff --git a/api/users.py b/api/users.py",
  "--- a/api/users.py",
  "+++ b/api/users.py",
  "@@ -1,3 +1,3 @@",
  " def greet(name):",
  '-    return "Hello, " + name',
  '+    return f"Hello, {name}!"',
  "\\ No newline at end of file",
  "diff --git a/notes.txt b/notes.txt",
  "@@ -1 +1 @@",
  "-plain",
  "+text",
].join("\n");

describe("T1 syntax colour for diffs", () => {
  it("the bundle colours each language desolate shows, with no eval, from data alone", () => {
    const source = fs.readFileSync(path.join(UI, "highlight-worker.js"), "utf8");
    assert.doesNotMatch(source, /new Function|\beval\(|innerHTML|insertAdjacentHTML/);
    const colour = realWorker();
    const samples: [string, string, string][] = [
      ["python", 'def f(x: int) -> str:\n    return f"{x}"', "def"],
      ["typescript", "export const f = (x: number): string => `${x}`;", "export"],
      ["javascript", "export function f(x) { return x + 1; }", "function"],
      ["svelte", '<script lang="ts">\n  let n: number = $state(0);\n</script>\n<button onclick={() => n++}>{n}</button>', "script"],
      ["rust", "pub fn f(x: &str) -> usize { x.len() }", "fn"],
      ["toml", '[package]\nname = "core"', "package"],
    ];
    const results = colour(samples.map(([lang, text]) => ({ lang, text })));
    samples.forEach(([lang, text, keyword], k) => {
      const lines = results[k]!;
      assert.ok(lines, lang);
      assert.equal(lines.map((l) => l.map((t) => t[0]).join("")).join("\n"), text, `${lang}: the tokens are the text`);
      const coloured = lines.flat().find((t) => t[0].trim() === keyword);
      assert.ok(coloured && /^#[0-9a-f]{6}/i.test(coloured[1]) && /^#[0-9a-f]{6}/i.test(coloured[2]), `${lang}: '${keyword}' has a light and a dark colour`);
    });
    assert.deepEqual(colour([{ lang: "cobol", text: "x" }]), [null], "a language it does not have is no colour");
  });

  it("a line of tokens is used only if it is exactly the line; a colour only if it is one", async () => {
    const fake: Fake = { made: 0, ended: 0, replies: (jobs) => jobs.map((job) => job.text.split("\n").map((line, i) =>
      line.includes('"Hello, " + name') ? [[line.replace("Hello", "Goodbye"), "#ff0000", "#ff0000", 0]] // not the line's text
        : [[line, i === 0 ? "red; background: url(x)" : "#79b8ff", "#79B8FF", 2]])) };
    const highlight = page(fake);
    const tokens = await highlight.tokensFor(DIFF);
    const lines = DIFF.split("\n");
    assert.equal(tokens.length, lines.length);
    assert.equal(tokens[4] !== null && (tokens[4] as unknown[][])[0]![1], "", "a 'colour' that is CSS is no colour");
    assert.equal(tokens[5], null, "the old side's second line: its tokens said other text, so it stays plain");
    // (Copies made here: arrays from the page's own context have its own Array.)
    assert.deepEqual(JSON.parse(JSON.stringify(tokens[6])), [['    return f"Hello, {name}!"', "#79b8ff", "#79B8FF", 2]]);
    for (const i of [0, 1, 2, 3, 7, 8, 9, 10, 11]) assert.equal(tokens[i], null, `line ${i} (${lines[i]}): headers, the note, and a file of no language are not coloured`);
  });

  it("a worker that does not answer in time is ended, the diff stays plain, and the next asks a new one", async () => {
    const fake: Fake = { made: 0, ended: 0, replies: () => undefined };
    const highlight = page(fake);
    const started = Date.now();
    const tokens = await highlight.tokensFor(DIFF);
    assert.ok(Date.now() - started >= 2000, "it waited, as long as it allows and no longer");
    assert.ok(tokens.every((t) => t === null));
    assert.equal(fake.ended, 1, "the worker was ended");
    fake.replies = (jobs) => jobs.map((job) => job.text.split("\n").map((line) => [[line, "#000000", "#ffffff", 0]]));
    const again = await highlight.tokensFor(DIFF);
    assert.equal(fake.made, 2, "a new worker");
    assert.ok(again[6]);
  });

  it("paint: the text through `shown`, each token its colours, and a range marked across tokens", () => {
    const highlight = page({ made: 0, ended: 0, replies: () => undefined });
    const nodes = highlight.paint([["let ", "#d73a49", "#f97583", 0], ["a\u202eb", "#24292e", "#e1e4e8", 1], [" = 1", "#005cc5", "#79b8ff", 0]], (s) => s.replace("\u202e", "<U+202E>"), [6, 16]);
    const text = nodes.map((n) => (n.tag === "mark" ? n.children[0]!.textContent : n.textContent)).join("");
    assert.equal(text, "let a<U+202E>b = 1", "the text, its hidden characters named");
    assert.deepEqual([...nodes.map((n) => n.tag)], ["span", "span", "mark", "mark", "span"], "the range splits the token it starts in, and the one it ends in");
    assert.equal(nodes[0]!.style.props["--hl-dark"], "#f97583");
  });

  it("languages by file name", () => {
    const { langOf } = page({ made: 0, ended: 0, replies: () => undefined });
    assert.deepEqual(["a.py", "b.ts", "c.tsx", "d.mjs", "web/App.svelte", "src/lib.rs", "Cargo.toml", "x.yml", "README.md", "run.sh", "Makefile", "x.ts.orig"].map(langOf),
      ["python", "typescript", "tsx", "javascript", "svelte", "rust", "toml", "yaml", "markdown", "shellscript", null, null]);
  });
});
