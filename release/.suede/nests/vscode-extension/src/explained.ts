import * as vscode from "vscode";

const TYPESCRIPT = "ts";

const cellDecoration = () =>
  vscode.window.createTextEditorDecorationType({
    border: "1px solid",
    borderColor: new vscode.ThemeColor("editorWarning.foreground"),
    borderRadius: "3px",
    overviewRulerColor: new vscode.ThemeColor("editorWarning.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

const noteDecoration = () =>
  vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor("editorWarning.foreground"),
      fontStyle: "italic",
      margin: "0 0 0 2em",
    },
  });

const byLine = (diagnostics: readonly vscode.Diagnostic[]) => {
  const lines = new Map<number, vscode.Diagnostic[]>();
  for (const d of diagnostics) lines.set(d.range.start.line, [...(lines.get(d.range.start.line) ?? []), d]);
  return lines;
};

const noteAt = (document: vscode.TextDocument, line: number, diagnostics: vscode.Diagnostic[]) => ({
  range: document.lineAt(line).range.with({ start: document.lineAt(line).range.end }),
  renderOptions: { after: { contentText: `← ${diagnostics.map((d) => d.message).join(" · ")}` } },
});

const typeScriptErrorsAt = (uri: vscode.Uri, position: vscode.Position) =>
  vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.source === TYPESCRIPT && d.severity === vscode.DiagnosticSeverity.Error && d.range.contains(position));

// the pointer's own warning is already in the hover, so only the rest of the error's are added
const explainedWithin = (ours: readonly vscode.Diagnostic[], errors: vscode.Diagnostic[], position: vscode.Position) =>
  ours.filter((o) => errors.some((e) => e.range.contains(o.range)) && !o.range.contains(position));

const hoverText = (explained: vscode.Diagnostic[]) =>
  new vscode.MarkdownString(
    explained.map((d) => `- ${d.message} *(line ${d.range.start.line + 1})*`).join("\n"),
  );

// a warning inside a TypeScript error is outlined, noted at the end of its line, and shown on hovering the error
export function explainedWarnings(warnings: vscode.DiagnosticCollection): vscode.Disposable[] {
  const cell = cellDecoration();
  const note = noteDecoration();

  const decorate = (editor: vscode.TextEditor) => {
    const ours = warnings.get(editor.document.uri) ?? [];
    editor.setDecorations(cell, ours.map((d) => d.range));
    editor.setDecorations(note, [...byLine(ours)].map(([line, ds]) => noteAt(editor.document, line, ds)));
  };
  const decorateVisible = () => vscode.window.visibleTextEditors.forEach(decorate);

  const hover: vscode.HoverProvider = {
    provideHover(document, position) {
      const errors = typeScriptErrorsAt(document.uri, position);
      const explained = explainedWithin(warnings.get(document.uri) ?? [], errors, position);
      return explained.length ? new vscode.Hover(hoverText(explained), errors[0]!.range) : undefined;
    },
  };

  decorateVisible();
  return [
    cell,
    note,
    vscode.languages.onDidChangeDiagnostics(decorateVisible),
    vscode.window.onDidChangeVisibleTextEditors(decorateVisible),
    vscode.languages.registerHoverProvider(
      [{ language: "typescript", scheme: "file" }, { language: "typescriptreact", scheme: "file" }],
      hover,
    ),
  ];
}
