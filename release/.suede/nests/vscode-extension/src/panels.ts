import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

import { pagePath, render } from "./display.js";
import { ID } from "./editor.js";

import type { Shown } from "./vitest.js";

type Open = { panel: vscode.WebviewPanel; page: vscode.Uri };

const folderOfPage = (page: vscode.Uri) => vscode.Uri.file(path.dirname(page.fsPath));

export function displayPanels(extensionUri: vscode.Uri) {
  const recorded = new Map<string, Shown>();
  const open = new Map<string, Open>();
  const dist = vscode.Uri.joinPath(extensionUri, "dist");

  // read afresh, so an edited page shows, and a page that appends starts clean
  const show = (id: string) => {
    const shown = open.get(id);
    if (!shown) return;
    const { webview } = shown.panel;
    webview.html = render(fs.readFileSync(shown.page.fsPath, "utf8"), {
      base: webview.asWebviewUri(folderOfPage(shown.page)).toString(),
      csp: webview.cspSource,
      codec: webview.asWebviewUri(vscode.Uri.joinPath(dist, "codec.js")).toString(),
    });
  };

  // the page's bootstrap decodes these, and hands them on as `namespace-tests:result`
  const send = async (id: string) => {
    const shown = open.get(id);
    const values = recorded.get(id);
    if (!shown || !values) return;
    await shown.panel.webview.postMessage({
      type: "namespace-tests:encoded",
      actual: values.actual,
      expected: values.expected,
      passed: values.passed,
      message: values.message,
      meta: values.meta,
    });
  };

  const createPanel = (id: string, title: string, page: vscode.Uri) => {
    const panel = vscode.window.createWebviewPanel(
      `${ID}.display`,
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [folderOfPage(page), dist],
      },
    );
    panel.onDidDispose(() => open.delete(id));
    // the page announces itself once it is ready for the values
    panel.webview.onDidReceiveMessage(() => void send(id));
    return panel;
  };

  return {
    record: (id: string, shown: Shown) => void recorded.set(id, shown),
    has: (id: string) => recorded.has(id),
    redraw: () => {
      for (const id of open.keys()) show(id);
    },
    open(id: string, title: string, testFile: string) {
      const values = recorded.get(id);
      if (!values)
        return void vscode.window.showWarningMessage(
          `${title} recorded nothing to display. Does its page exist, and did the test run?`,
        );
      const page = vscode.Uri.file(pagePath(testFile, values.page));
      if (!fs.existsSync(page.fsPath))
        return void vscode.window.showErrorMessage(
          `${title} names a display page that is not there: ${values.page}`,
        );
      const panel = open.get(id)?.panel ?? createPanel(id, title, page);
      open.set(id, { panel, page });
      show(id);
      panel.reveal(panel.viewColumn, true);
    },
  };
}

export type DisplayPanels = ReturnType<typeof displayPanels>;
