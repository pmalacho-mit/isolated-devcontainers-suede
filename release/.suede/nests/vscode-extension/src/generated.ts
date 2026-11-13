import path from "node:path";
import * as vscode from "vscode";

import { ID } from "./editor.js";

const SCHEME = `${ID}-generated`;

// what the library printed, shown against the file it was printed from
export function generatedViews(): [vscode.Disposable, typeof showAgainst] {
  const texts = new Map<string, string>();
  const changed = new vscode.EventEmitter<vscode.Uri>();
  const provider = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    onDidChange: changed.event,
    provideTextDocumentContent: (uri) => texts.get(uri.fsPath) ?? "",
  });

  async function showAgainst(uri: vscode.Uri, text: string, what: string) {
    texts.set(uri.fsPath, text);
    const generated = uri.with({ scheme: SCHEME, query: `${Date.now()}` });
    changed.fire(generated);
    await vscode.commands.executeCommand(
      "vscode.diff",
      uri,
      generated,
      `${path.basename(uri.fsPath)} ↔ ${what}`,
      { preview: true },
    );
  }

  return [vscode.Disposable.from(provider, changed), showAgainst];
}
