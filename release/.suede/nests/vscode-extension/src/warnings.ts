import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

import { diagnosticAt, type Span } from "./editor.js";
import { findLibrary } from "./library.js";

type Warning = Span & { message: string };

const warningsFile = (folder: vscode.WorkspaceFolder) => {
  const library = findLibrary(folder.uri.fsPath);
  return library ? path.join(library.derived, "diagnostics.json") : null;
};

// null while it is being written: the watcher fires again once it has been
const warningsIn = (file: string): Record<string, Warning[]> | null => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const publish = (diagnostics: vscode.DiagnosticCollection, folder: vscode.WorkspaceFolder, file: string) => {
  for (const [relative, warnings] of Object.entries(warningsIn(file) ?? {}))
    diagnostics.set(
      vscode.Uri.file(path.join(folder.uri.fsPath, relative)),
      warnings.map((w) => diagnosticAt(w, w.message, vscode.DiagnosticSeverity.Warning)),
    );
};

export function printerWarnings(diagnostics: vscode.DiagnosticCollection): vscode.Disposable[] {
  const watchers: vscode.Disposable[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const file = warningsFile(folder);
    if (!file) continue;
    publish(diagnostics, folder, file);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)),
    );
    const refresh = () => publish(diagnostics, folder, file);
    watcher.onDidChange(refresh);
    watcher.onDidCreate(refresh);
    watchers.push(watcher);
  }
  return watchers;
}
