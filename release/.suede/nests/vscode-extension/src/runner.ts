import * as vscode from "vscode";

import { answersTo } from "../../test-names.mts";
import { outcomeOf, type Outcome } from "./outcome.js";
import { shownOnPage, vitest, type ResultRecord } from "./vitest.js";

import type { DisplayPanels } from "./panels.js";
import type { TestTree } from "./tree.js";

type Surfaces = {
  controller: vscode.TestController;
  output: vscode.OutputChannel;
  tree: TestTree;
  panels: DisplayPanels;
  lensesChanged: vscode.EventEmitter<void>;
};

const notCollected = (uri: vscode.Uri) =>
  `${vscode.workspace.asRelativePath(uri)} has tests, but this project's Vitest config does not collect it — check \`test.includeSource\` and the plugin's \`exclude\`.`;

const perTest = (started: number, count: number) =>
  Math.round((Date.now() - started) / Math.max(count, 1));

export function testRunner({ controller, output, tree, panels, lensesChanged }: Surfaces) {
  const outcomes = new Map<string, Outcome>();

  const settle = (run: vscode.TestRun, item: vscode.TestItem, outcome: Outcome) => {
    outcomes.set(item.id, outcome);
    if (outcome.state === "running") run.started(item);
    else if (outcome.state === "passed") run.passed(item, outcome.duration);
    else if (outcome.state === "skipped") run.skipped(item);
    else run.failed(item, new vscode.TestMessage(outcome.message), outcome.duration);
  };

  const errored = (run: vscode.TestRun, items: vscode.TestItem[], error: unknown) => {
    output.appendLine(String(error));
    for (const item of items) {
      outcomes.delete(item.id);
      run.errored(item, new vscode.TestMessage(String(error)));
    }
  };

  const outcomeFor = (uri: vscode.Uri, item: vscode.TestItem, report: ResultRecord[], duration: number): Outcome => {
    const records = report.filter((r) => answersTo(r.name, item.label));
    // Vitest said nothing of this test: the project's config does not collect its file
    if (!records.length) {
      if (!report.length) output.appendLine(notCollected(uri));
      return { state: "skipped" };
    }
    const shown = shownOnPage(records);
    if (shown) panels.record(item.id, shown);
    return outcomeOf(records, duration);
  };

  const run = async (uri: vscode.Uri, only?: vscode.TestItem) => {
    const items = only ? [only] : tree.itemsOf(uri);
    if (!items.length) return;
    const testRun = controller.createTestRun(new vscode.TestRunRequest(items), undefined, false);
    for (const item of items) settle(testRun, item, { state: "running" });
    lensesChanged.fire();
    const started = Date.now();
    try {
      const report = await vitest(uri, only?.label, output);
      const duration = perTest(started, items.length);
      for (const item of items) settle(testRun, item, outcomeFor(uri, item, report, duration));
    } catch (error) {
      errored(testRun, items, error);
    } finally {
      testRun.end();
      lensesChanged.fire();
      panels.redraw();
    }
  };

  return { run, outcomeOf: (id: string) => outcomes.get(id) };
}

export type TestRunner = ReturnType<typeof testRunner>;
