import path from "node:path";
import * as vscode from "vscode";

import { hasTests } from "./discovery.js";
import { ID, orComplain } from "./editor.js";
import {
  debugExtracted,
  deleteExtracted,
  extractTest,
  originOf,
  runExtracted,
} from "./extracted.js";
import { generatedViews } from "./generated.js";
import { extractedFileLenses, testFileLenses } from "./lenses.js";
import { forgetLibrary } from "./library.js";
import { displayPanels, type DisplayPanels } from "./panels.js";
import { cacheCompiledModulesIn, printed } from "./printed.js";
import { testRunner, type TestRunner } from "./runner.js";
import { childrenOf, everyItem, testTree, type TestTree } from "./tree.js";
import { explainedWarnings } from "./explained.js";
import { printerWarnings } from "./warnings.js";

type Parts = {
  output: vscode.OutputChannel;
  tree: TestTree;
  runner: TestRunner;
  panels: DisplayPanels;
  showAgainst: ReturnType<typeof generatedViews>[1];
};

const command = (name: string, run: (...args: any[]) => unknown) =>
  vscode.commands.registerCommand(`${ID}.${name}`, run);

function testCommands({ output, tree, runner, panels }: Parts) {
  return [
    command("runTest", async (id: string) => {
      const item = tree.itemFrom(id);
      if (item) await runner.run(item.uri, item);
    }),
    command("showFailure", (id: string) => {
      const outcome = runner.outcomeOf(id);
      if (outcome?.state !== "failed") return;
      output.clear();
      output.appendLine(outcome.message);
      output.show(true);
    }),
    command("extract", async (from?: vscode.TestItem | string) => {
      const item = tree.itemFrom(from);
      if (item) await extractTest(item, output);
    }),
    command("display", async (from?: vscode.TestItem | string) => {
      const item = tree.itemFrom(from);
      if (!item) return;
      if (!panels.has(item.id)) await runner.run(item.uri, item);
      panels.open(item.id, item.label, item.uri.fsPath);
    }),
  ];
}

function generatedCommands({ output, showAgainst }: Parts) {
  return [
    command("showCollector", async (uri: vscode.Uri) => {
      const text = await orComplain(
        printed.collector(uri, output),
        output,
        `Could not read what Vitest sees for ${path.basename(uri.fsPath)}.`,
      );
      if (text !== null) await showAgainst(uri, text, "what Vitest sees");
    }),
    command("showServed", async (uri: vscode.Uri) => {
      const origin = originOf(uri);
      if (!origin) return;
      const text = await orComplain(
        printed.served(origin.source, origin.test, output),
        output,
        `Could not read what Vitest runs for ${origin.test}.`,
      );
      if (text !== null) await showAgainst(uri, text, "what Vitest runs");
    }),
    command("runExtracted", runExtracted),
    command("debugExtracted", debugExtracted),
    command("deleteExtracted", deleteExtracted),
  ];
}

const runProfile = (controller: vscode.TestController, runner: TestRunner) =>
  controller.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    async (request) => {
      const included = request.include ?? childrenOf(controller.items);
      const files = new Set(
        [...everyItem(included)]
          .filter((item) => !item.children.size && item.uri)
          .map((item) => item.uri!.toString()),
      );
      for (const file of files) await runner.run(vscode.Uri.parse(file));
    },
    true,
  );

const autoRunEnabled = () =>
  vscode.workspace.getConfiguration(ID).get<boolean>("autoRun", true);

const isFile = (document: vscode.TextDocument) => document.uri.scheme === "file";

function followDocuments({ tree, runner }: Parts, lensesChanged: vscode.EventEmitter<void>) {
  const autoRun = (document: vscode.TextDocument) => {
    if (!isFile(document)) return;
    const tests = tree.load(document.uri, document.getText());
    if (tests.length && autoRunEnabled()) void runner.run(document.uri);
  };

  const reloadOpenFilesWithTests = () => {
    for (const document of vscode.workspace.textDocuments)
      if (isFile(document) && hasTests(document.getText()))
        tree.load(document.uri, document.getText());
  };

  const pagesMoved = vscode.workspace.createFileSystemWatcher("**/*.html");
  pagesMoved.onDidCreate(reloadOpenFilesWithTests);
  pagesMoved.onDidDelete(reloadOpenFilesWithTests);

  for (const document of vscode.workspace.textDocuments) autoRun(document);
  return [
    pagesMoved,
    vscode.workspace.onDidOpenTextDocument(autoRun),
    vscode.workspace.onDidSaveTextDocument(autoRun),
    // an edit moves the tests, but does not change what they last did
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (!isFile(document)) return;
      tree.load(document.uri, document.getText());
      lensesChanged.fire();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(forgetLibrary),
  ];
}

export function activate(context: vscode.ExtensionContext): void {
  cacheCompiledModulesIn(path.join(context.globalStorageUri.fsPath, "node"));
  const controller = vscode.tests.createTestController(ID, "Namespace Tests");
  const warnings = vscode.languages.createDiagnosticCollection(ID);
  const missingPages = vscode.languages.createDiagnosticCollection(`${ID}.display`);
  const output = vscode.window.createOutputChannel("Namespace Tests");
  const lensesChanged = new vscode.EventEmitter<void>();
  const [views, showAgainst] = generatedViews();
  context.subscriptions.push(controller, warnings, missingPages, output, lensesChanged, views);

  const tree = testTree(controller, output, missingPages);
  const panels = displayPanels(context.extensionUri);
  const runner = testRunner({ controller, output, tree, panels, lensesChanged });
  const parts: Parts = { output, tree, runner, panels, showAgainst };

  controller.resolveHandler = async (item) => {
    if (item?.uri) return void tree.load(item.uri);
    for (const uri of await vscode.workspace.findFiles("**/*.{ts,tsx,mts,cts}", "**/node_modules/**"))
      tree.load(uri);
  };

  context.subscriptions.push(
    runProfile(controller, runner),
    testFileLenses(tree, runner, lensesChanged),
    extractedFileLenses(),
    ...testCommands(parts),
    ...generatedCommands(parts),
    ...printerWarnings(warnings),
    ...explainedWarnings(warnings),
  );
  void controller.resolveHandler(undefined);
  context.subscriptions.push(...followDocuments(parts, lensesChanged));
}

export function deactivate(): void {}
