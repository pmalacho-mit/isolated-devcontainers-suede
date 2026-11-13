import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

export const ID = "namespace-tests";

export type Span = { line: number; column: number; length: number };

export const rangeOf = ({ line, column, length }: Span) =>
  new vscode.Range(line, column, line, column + length);

export const diagnosticAt = (
  span: Span,
  message: string,
  severity: vscode.DiagnosticSeverity,
) => {
  const diagnostic = new vscode.Diagnostic(rangeOf(span), message, severity);
  diagnostic.source = ID;
  return diagnostic;
};

export const folderOf = (uri: vscode.Uri) =>
  vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);

// an open editor's unsaved text is the truth, not what was last written
export const contentsOf = (uri: vscode.Uri) => {
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.fsPath === uri.fsPath,
  );
  if (open) return open.getText();
  try {
    return fs.readFileSync(uri.fsPath, "utf8");
  } catch {
    return "";
  }
};

export const openInActiveGroup = async (file: string) => {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Active,
    preview: false,
  });
};

const shows = (tab: vscode.Tab, uri: vscode.Uri) =>
  tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === uri.fsPath;

const closeTab = async (group: vscode.TabGroup, tab: vscode.Tab, uri: vscode.Uri) => {
  if (!tab.isDirty) return void (await vscode.window.tabGroups.close(tab));
  // reverting is what closes a tab with unsaved changes without asking to save them
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, {
    viewColumn: group.viewColumn,
    preview: false,
  });
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
};

export const closeEditorsFor = async (uri: vscode.Uri) => {
  for (const group of vscode.window.tabGroups.all)
    for (const tab of group.tabs) if (shows(tab, uri)) await closeTab(group, tab, uri);
};

export const quoteArg = (value: string) =>
  /^[\w./-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;

export async function orComplain<T>(
  work: Promise<T>,
  output: vscode.OutputChannel,
  message: string,
): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    output.appendLine(String(error));
    output.show(true);
    void vscode.window.showErrorMessage(`${message} See the Namespace Tests output.`);
    return null;
  }
}
