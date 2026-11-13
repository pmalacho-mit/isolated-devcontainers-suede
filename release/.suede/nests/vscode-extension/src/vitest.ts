import fs from "node:fs";
import path from "node:path";
import type * as vscode from "vscode";

import { testFilter } from "../../test-names.mts";
import { folderOf } from "./editor.js";
import { findLibrary } from "./library.js";
import { exec } from "./process.js";

import type { ResultRecord } from "../../vite-plugin/reporter.mts";

export type { ResultRecord };

export type Shown = ResultRecord["displays"][number] & { passed: boolean; message: string | null };

const recordsIn = (file: string): ResultRecord[] | null => {
  try {
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { results: ResultRecord[] }).results;
  } catch {
    return null;
  }
};

export async function vitest(
  uri: vscode.Uri,
  only: string | undefined,
  output: vscode.OutputChannel,
): Promise<ResultRecord[]> {
  const cwd = folderOf(uri);
  const library = findLibrary(cwd);
  if (!library) throw new Error(`No namespace-tests library in ${cwd}.`);
  const results = path.join(library.derived, "results.json");
  fs.rmSync(results, { force: true });

  const args = [
    "vitest",
    "run",
    path.relative(cwd, uri.fsPath),
    `--reporter=${library.reporter}`,
    ...(only ? ["-t", testFilter(only)] : []),
  ];
  const ran = await exec("npx", args, cwd);
  const records = recordsIn(results);
  if (records) return records;
  output.appendLine(`npx ${args.join(" ")}`);
  output.appendLine(ran.stderr || ran.stdout);
  throw new Error("Vitest produced no report");
}

// a table's rows are several tests: the first with a page is the one shown
export function shownOnPage(records: ResultRecord[]): Shown | null {
  for (const record of records) {
    const [display] = record.displays;
    if (display)
      return { ...display, passed: record.state === "passed", message: record.errors[0]?.message ?? null };
  }
  return null;
}
