import * as vscode from "vscode";

import { SUFFIX, extracted } from "../../extract.mts";
import { discover, hasTests, type DiscoveredTest } from "./discovery.js";
import { ID, rangeOf } from "./editor.js";
import { lensTitle, type Outcome } from "./outcome.js";
import { testId } from "./tree.js";

import type { TestRunner } from "./runner.js";
import type { TestTree } from "./tree.js";

const TOP = new vscode.Range(0, 0, 0, 0);

const lens = (range: vscode.Range, title: string, command: string, argument: unknown) =>
  new vscode.CodeLens(range, { title, command: `${ID}.${command}`, arguments: [argument] });

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const collectorLens = (uri: vscode.Uri, tests: DiscoveredTest[]) =>
  lens(TOP, `$(diff) What Vitest sees (${plural(tests.length, "test")})`, "showCollector", uri);

function testLenses(test: DiscoveredTest, id: string, outcome: Outcome | undefined) {
  const range = rangeOf(test);
  const failed = outcome?.state === "failed";
  return [
    lens(range, lensTitle(outcome), failed ? "showFailure" : "runTest", id),
    lens(range, "$(go-to-file) Extract", "extract", id),
    ...(test.display ? [lens(range, "$(graph) Display", "display", id)] : []),
    ...(failed ? [lens(range, "$(refresh) Run again", "runTest", id)] : []),
  ];
}

const EXTRACTED_ACTIONS = [
  ["$(play) Run", "runExtracted"],
  ["$(debug-alt) Debug", "debugExtracted"],
  ["$(trash) Delete", "deleteExtracted"],
  ["$(diff) What Vitest sees", "showServed"],
] as const;

export const testFileLenses = (
  tree: TestTree,
  runner: TestRunner,
  changed: vscode.EventEmitter<void>,
) =>
  vscode.languages.registerCodeLensProvider(
    [
      { language: "typescript", scheme: "file" },
      { language: "typescriptreact", scheme: "file" },
    ],
    {
      onDidChangeCodeLenses: changed.event,
      provideCodeLenses(document) {
        const { uri } = document;
        const text = document.getText();
        if (!hasTests(text) || !tree.parsable(uri)) return [];
        const tests = discover(uri.fsPath, text);
        if (!tests.length) return [];
        return [
          collectorLens(uri, tests),
          ...tests.flatMap((test) => {
            const id = testId(uri, test.name);
            return testLenses(test, id, runner.outcomeOf(id));
          }),
        ];
      },
    },
  );

export const extractedFileLenses = () =>
  vscode.languages.registerCodeLensProvider(
    { language: "typescript", scheme: "file", pattern: `**/*${SUFFIX}` },
    {
      provideCodeLenses: (document) =>
        extracted(document.getText())
          ? EXTRACTED_ACTIONS.map(([title, command]) => lens(TOP, title, command, document.uri))
          : [],
    },
  );
