// The source of release/shared/ui/highlight-worker.js (built by build.sh): Shiki, with its
// JavaScript regex engine (no WebAssembly) and only the grammars desolate shows, in a worker.
//
// It answers with DATA only: for each line, its tokens as [text, light colour, dark colour,
// font style]. The page builds what is shown from that, as text (shared/ui/highlight.js),
// and checks the tokens' text is the line's text before it uses them. A grammar that takes
// too long is the page's to stop: it ends this worker and shows the diff plain.
import { createHighlighterCoreSync } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import css from "@shikijs/langs/css";
import html from "@shikijs/langs/html";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsx from "@shikijs/langs/jsx";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
import shellscript from "@shikijs/langs/shellscript";
import svelte from "@shikijs/langs/svelte";
import toml from "@shikijs/langs/toml";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import yaml from "@shikijs/langs/yaml";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";

const LANGS = [css, html, javascript, json, jsx, markdown, python, rust, shellscript, svelte, toml, tsx, typescript, yaml];
const highlighter = createHighlighterCoreSync({ themes: [githubLight, githubDark], langs: LANGS, engine: createJavaScriptRegexEngine() });
const known = new Set(highlighter.getLoadedLanguages());

self.onmessage = ({ data }) => {
  const jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
  const results = jobs.map((job) => {
    if (!job || typeof job.text !== "string" || !known.has(job.lang)) return null;
    try {
      return highlighter
        .codeToTokensWithThemes(job.text, { lang: job.lang, themes: { light: "github-light", dark: "github-dark" }, tokenizeMaxLineLength: 1000, tokenizeTimeLimit: 300 })
        .map((line) => line.map((t) => [t.content, t.variants.light?.color ?? "", t.variants.dark?.color ?? "", t.variants.light?.fontStyle ?? 0]));
    } catch {
      return null;
    }
  });
  self.postMessage({ id: data && data.id, results });
};
