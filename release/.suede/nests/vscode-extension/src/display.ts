import path from "node:path";

import type { Expect, Invoke } from "../../dsl.import.meta.vitest.ts";

export const pagePath = (testFile: string, page: string) =>
  path.resolve(path.dirname(testFile), page);

declare namespace pagePath {
  export type RelativeToTheTest = Expect<
    Invoke<typeof pagePath, ["/p/src/stats.ts", "./fixtures/chart.html"]>,
    "=",
    "/p/src/fixtures/chart.html"
  >;
}

const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const nonce = (random = Math.random) =>
  random().toString(36).slice(2).padEnd(8, "0").slice(0, 8);

export type Sources = { base: string; csp: string; codec: string };

// an editor in a browser hides `window.parent` from a webview; a page announcing
// itself through it is pointed at its own window, where the bootstrap listens
const giveEveryPageAParent = `
  if (!window.parent) {
    try { window.parent = window; } catch {}
    if (!window.parent)
      try { Object.defineProperty(window, "parent", { value: window, configurable: true }); } catch {}
  }`;

const announceReadyOnce = `
  let announced = false;
  const announce = () => {
    if (announced) return;
    announced = true;
    vscode.postMessage({ type: "ready" });
  };`;

// only JSON crosses into a webview, so a `Map` or a `bigint` arrives encoded
const decodeWhatArrives = `
  window.addEventListener("message", async ({ data }) => {
    if (data?.type === "namespace-tests:ready") announce();
    else if (data?.type === "namespace-tests:encoded") {
      const { decode } = await codec;
      window.postMessage(
        { ...data, type: "namespace-tests:result", actual: decode(data.actual), expected: decode(data.expected) },
        "*",
      );
    }
  });`;

const scriptString = (text: string) => JSON.stringify(text).replace(/</g, "\\u003c");

const bootstrap = (codec: string) => `(() => {${giveEveryPageAParent}
  const vscode = acquireVsCodeApi();
  const codec = import(${scriptString(codec)});${announceReadyOnce}${decodeWhatArrives}
  window.addEventListener("load", announce);
})();`;

const policy = ({ csp }: Sources, id: string) =>
  [
    "default-src 'none'",
    `img-src ${csp} data: https:`,
    `font-src ${csp}`,
    `style-src 'unsafe-inline' ${csp}`,
    `script-src 'nonce-${id}' ${csp}`,
    `connect-src ${csp}`,
  ].join("; ");

const asFolder = (url: string) => (url.endsWith("/") ? url : `${url}/`);

const head = (sources: Sources, id: string) =>
  [
    `<meta http-equiv="Content-Security-Policy" content="${policy(sources, id)}" />`,
    `<base href="${escape(asFolder(sources.base))}" />`,
    `<script nonce="${id}">${bootstrap(sources.codec)}</script>`,
  ].join("\n");

const trustingItsScripts = (page: string, id: string) =>
  page.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${id}"`);

const doctypeOf = (page: string) => /^\s*<!doctype[^>]*>/i.exec(page)?.[0] ?? "";

// a policy binds only what follows it, but the doctype must stay first
export function render(page: string, sources: Sources, id = nonce()): string {
  const trusted = trustingItsScripts(page, id);
  const doctype = doctypeOf(trusted);
  return `${doctype}\n${head(sources, id)}\n${trusted.slice(doctype.length)}`;
}

declare namespace render {
  type Page = `<!doctype html>
<div id="chart"></div>
<script>window.addEventListener("message", () => {});</script>`;
  type Html = Invoke<
    typeof render,
    [
      Page,
      { base: "https://r/pages"; csp: "https://r"; codec: "https://r/codec.js" },
      "abc123",
    ]
  >;

  /** the page is the document — there is no frame for a browser to refuse */
  export type NotFramed = Expect<Html, "excludes", "<iframe">;

  /** the doctype stays first, so the page is not rendered in quirks mode */
  export type Doctype = Expect<Html, "startsWith", "<!doctype html>">;

  /** its relative URLs resolve against its own folder */
  export type Based = Expect<Html, "includes", '<base href="https://r/pages/" />'>;

  /** its own scripts run, by the nonce they are given */
  export type Trusted = Expect<
    Html,
    "includes",
    '<script nonce="abc123">window.addEventListener'
  >;

  /** and only those: nothing without the nonce may */
  export type Locked = Expect<
    Html,
    "includes",
    "script-src 'nonce-abc123' https://r;"
  >;

  /**
   * an editor in a browser hides `window.parent` from a webview; a page that
   * announces itself through it is given its own window to announce to
   */
  export type Parent = Expect<
    Html,
    "includes",
    "if (!window.parent) {"
  >;

  /** a base that would break out of its attribute cannot */
  export type Escaped = Expect<
    Invoke<
      typeof render,
      [
        "<p></p>",
        { base: '"><script>alert(1)</script>'; csp: "x"; codec: "x" },
        "abc123",
      ]
    >,
    "excludes",
    "<script>alert(1)"
  >;
}
