import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

import { extract, extracted, tempPathFor } from "../../extract.mts";
import {
  closeEditorsFor,
  contentsOf,
  folderOf,
  openInActiveGroup,
  orComplain,
  quoteArg,
} from "./editor.js";
import { printed } from "./printed.js";

import type { LocatedItem } from "./tree.js";

const TERMINAL = "Namespace Tests";

const isHandEdited = (text: string) => {
  const mine = extracted(text);
  return !mine || mine.edited;
};

const mayOverwrite = async (target: string) => {
  if (!fs.existsSync(target) || !isHandEdited(contentsOf(vscode.Uri.file(target))))
    return true;
  const answer = await vscode.window.showWarningMessage(
    `${path.basename(target)} has changes that were not generated.`,
    { modal: true },
    "Open it",
    "Overwrite",
  );
  if (answer === "Open it") await openInActiveGroup(target);
  return answer === "Overwrite";
};

const mayDelete = async (uri: vscode.Uri) =>
  !isHandEdited(contentsOf(uri)) ||
  (await vscode.window.showWarningMessage(
    `${path.basename(uri.fsPath)} has changes that were not generated. Delete it?`,
    { modal: true },
    "Delete",
  )) === "Delete";

export async function extractTest(item: LocatedItem, output: vscode.OutputChannel) {
  const target = tempPathFor(item.uri.fsPath, item.label);
  if (!(await mayOverwrite(target))) return;
  const body = await orComplain(
    printed.minimal(item.uri, item.label, output),
    output,
    `Could not generate ${item.label}.`,
  );
  if (body === null) return;
  fs.writeFileSync(target, extract(vscode.workspace.asRelativePath(item.uri), item.label, body));
  await openInActiveGroup(target);
}

export function runExtracted(uri: vscode.Uri) {
  const cwd = folderOf(uri);
  const terminal =
    vscode.window.terminals.find((t) => t.name === TERMINAL) ??
    vscode.window.createTerminal({ name: TERMINAL, cwd });
  terminal.show(true);
  terminal.sendText(
    `npx vitest run ${quoteArg(path.relative(cwd, uri.fsPath))} --reporter=verbose`,
  );
}

const debugConfiguration = (cwd: string, relative: string): vscode.DebugConfiguration => ({
  type: "node",
  request: "launch",
  name: `Debug ${path.basename(relative)}`,
  cwd,
  program: path.join(cwd, "node_modules", "vitest", "vitest.mjs"),
  // one process, no timeout: a breakpoint that is sat on is not a failure
  args: ["run", relative, "--no-file-parallelism", "--testTimeout=0"],
  autoAttachChildProcesses: true,
  console: "integratedTerminal",
  smartStep: true,
  skipFiles: ["<node_internals>/**"],
});

export async function debugExtracted(uri: vscode.Uri) {
  const cwd = folderOf(uri);
  const relative = path.relative(cwd, uri.fsPath);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!(await vscode.debug.startDebugging(folder, debugConfiguration(cwd, relative))))
    void vscode.window.showErrorMessage(
      `Could not start a debug session for ${path.basename(relative)}.`,
    );
}

export async function deleteExtracted(uri: vscode.Uri) {
  if (!(await mayDelete(uri))) return;
  // closed first, or its tab is left showing a file that is gone
  await closeEditorsFor(uri);
  await vscode.workspace.fs.delete(uri);
}

export const originOf = (uri: vscode.Uri) => {
  const mine = extracted(contentsOf(uri));
  return mine
    ? { source: vscode.Uri.file(path.resolve(folderOf(uri), mine.source)), test: mine.test }
    : null;
};
