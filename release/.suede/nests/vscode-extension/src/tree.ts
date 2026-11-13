import fs from "node:fs";
import * as vscode from "vscode";

import { discover, hasTests, type DiscoveredTest } from "./discovery.js";
import { pagePath } from "./display.js";
import { diagnosticAt, folderOf, rangeOf } from "./editor.js";
import { findLibrary, type Library } from "./library.js";
import { parseWithTypeScriptOf } from "./typescript.js";

export type LocatedItem = vscode.TestItem & { uri: vscode.Uri };

export const testId = (uri: vscode.Uri, name: string) => `${uri.toString()}::${name}`;

export const childrenOf = (collection: vscode.TestItemCollection) => {
  const items: vscode.TestItem[] = [];
  collection.forEach((item) => {
    items.push(item);
  });
  return items;
};

export function* everyItem(items: readonly vscode.TestItem[]): Generator<vscode.TestItem> {
  for (const item of items) {
    yield item;
    yield* everyItem(childrenOf(item.children));
  }
}

const unparsableBecause = (folder: string, library: Library | null) =>
  library
    ? `${folder}: found the library, but no TypeScript beside it to parse with — is it installed?`
    : `${folder}: no namespace-tests library found, so its tests cannot be discovered.`;

const missingPageAt = (at: DiscoveredTest["displayAt"] & {}, page: string) =>
  diagnosticAt(
    at,
    `No display page at ${vscode.workspace.asRelativePath(page)}. It is looked for relative to this file.`,
    vscode.DiagnosticSeverity.Error,
  );

const textOf = (uri: vscode.Uri) => {
  try {
    return fs.readFileSync(uri.fsPath, "utf8");
  } catch {
    return null;
  }
};

export function testTree(
  controller: vscode.TestController,
  output: vscode.OutputChannel,
  missingPages: vscode.DiagnosticCollection,
) {
  const toldUnparsable = new Set<string>();

  const parsable = (uri: vscode.Uri) => {
    const folder = folderOf(uri);
    const library = findLibrary(folder);
    if (library && parseWithTypeScriptOf(library.root)) return true;
    if (!toldUnparsable.has(folder)) {
      toldUnparsable.add(folder);
      output.appendLine(unparsableBecause(folder, library));
    }
    return false;
  };

  const checkPages = (uri: vscode.Uri, tests: DiscoveredTest[]) =>
    missingPages.set(
      uri,
      tests.flatMap(({ display, displayAt }) => {
        if (!display || !displayAt) return [];
        const page = pagePath(uri.fsPath, display);
        return fs.existsSync(page) ? [] : [missingPageAt(displayAt, page)];
      }),
    );

  const fileItem = (uri: vscode.Uri) => {
    const file =
      controller.items.get(uri.toString()) ??
      controller.createTestItem(uri.toString(), vscode.workspace.asRelativePath(uri), uri);
    controller.items.add(file);
    return file;
  };

  const testItem = (uri: vscode.Uri, test: DiscoveredTest) => {
    const item = controller.createTestItem(testId(uri, test.name), test.name, uri);
    item.range = rangeOf(test);
    return item;
  };

  const forget = (uri: vscode.Uri) => {
    controller.items.delete(uri.toString());
    missingPages.delete(uri);
  };

  const load = (uri: vscode.Uri, text = textOf(uri)): DiscoveredTest[] => {
    if (text === null) return [];
    if (!hasTests(text) || !parsable(uri)) {
      forget(uri);
      return [];
    }
    const tests = discover(uri.fsPath, text);
    checkPages(uri, tests);
    fileItem(uri).children.replace(tests.map((test) => testItem(uri, test)));
    return tests;
  };

  const itemsOf = (uri: vscode.Uri) => {
    const file = controller.items.get(uri.toString());
    return file ? childrenOf(file.children) : [];
  };

  const itemFrom = (from?: vscode.TestItem | string): LocatedItem | null => {
    const item =
      typeof from === "string"
        ? [...everyItem(childrenOf(controller.items))].find(({ id }) => id === from)
        : from;
    return item?.uri ? (item as LocatedItem) : null;
  };

  return { parsable, load, itemsOf, itemFrom };
}

export type TestTree = ReturnType<typeof testTree>;
