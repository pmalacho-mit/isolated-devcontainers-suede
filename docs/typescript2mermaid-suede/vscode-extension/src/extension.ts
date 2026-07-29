import * as vscode from "vscode";
import { dsl } from "../../index";
import { activateDslExtension } from "@typescript-dsl-suede/vscode";

/**
 * Runs inside the preview webview. The host page owns CSP, theming, pan/zoom
 * and the live-render loop; all it needs from us is a `DslRenderer`.
 */
const MERMAID_BOOTSTRAP = `
globalThis.DslRenderer = {
  init: function (dark) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
    });
  },
  // Mermaid keys internal state off the render id, so each pass needs a fresh one.
  render: function (code, seq) {
    return mermaid.render("tsm-diagram-" + seq, code).then(function (r) { return r.svg; });
  },
};
`;

export function activate(ctx: vscode.ExtensionContext): void {
  // Every handler renders to Mermaid source, so a finding's `data` *is* the
  // diagram. `T` is inferred from the session the dsl hands back.
  activateDslExtension(ctx, {
    id: "tsMermaid",
    name: "typescript2mermaid",
    gates: dsl.gates,
    createSession: (tsconfig) => dsl.createSession(tsconfig),

    hover: (f, api) => {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**typescript2mermaid** · \`${f.label ?? f.id}\`\n\n`);
      md.appendCodeblock(f.data, "mermaid");
      md.appendMarkdown(`\n${api.previewLink!(f, "Preview rendered diagram")}`);
      return md;
    },

    lenses: () => [{ title: "Preview diagram" }],

    preview: {
      // First readable candidate wins: the packaged copy, then a dev checkout.
      assets: [
        "media/mermaid.min.js",
        "node_modules/mermaid/dist/mermaid.min.js",
      ],
      bootstrap: MERMAID_BOOTSTRAP,
      codeOf: (f) => f.data,
      title: (f) => `Diagram: ${f.label ?? f.id}`,
      missingAssetMessage:
        "Failed to load mermaid.min.js.\nThe webview could not fetch the extension asset — re-run the build and reinstall.",
    },
  });
}

export function deactivate(): void {
  // The harness registers itself in ctx.subscriptions and tears down there.
}
