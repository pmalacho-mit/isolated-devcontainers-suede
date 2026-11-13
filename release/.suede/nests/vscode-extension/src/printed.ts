import path from "node:path";
import * as vscode from "vscode";

import { ID, folderOf } from "./editor.js";
import { findLibrary } from "./library.js";
import { exec } from "./process.js";

let compiledModules: string | undefined;

// most of a cold run is parsing TypeScript, which Node can keep compiled
export const cacheCompiledModulesIn = (dir: string) => {
  compiledModules = dir;
};

const configuredCommand = () =>
  vscode.workspace.getConfiguration(ID).get<string>("minimalCommand", "");

type Command = [command: string, args: string[]];

function commandFor(uri: vscode.Uri, cwd: string, what: string, extra: string[]): Command {
  const file = path.relative(cwd, uri.fsPath);
  const configured = configuredCommand();
  if (configured) {
    const [command = "", ...args] = configured.split(" ");
    return [command, [...args, file, what, ...extra]];
  }
  const library = findLibrary(cwd);
  if (!library)
    throw new Error(
      `Could not find dsl.import.meta.vitest.ts in this workspace; set ${ID}.minimalCommand`,
    );
  return ["node", [library.cli, file, what, ...extra]];
}

async function ask(
  uri: vscode.Uri,
  what: string,
  output: vscode.OutputChannel,
  extra: string[] = [],
): Promise<string> {
  const cwd = folderOf(uri);
  const [command, args] = commandFor(uri, cwd, what, extra);
  const env = compiledModules ? { NODE_COMPILE_CACHE: compiledModules } : {};
  const result = await exec(command, args, cwd, env);
  if (result.stdout.trim()) return result.stdout;
  output.appendLine(`${command} ${args.join(" ")}`);
  output.appendLine(result.stderr || "(no output)");
  throw new Error(`No generated source for ${what}`);
}

export const printed = {
  minimal: (uri: vscode.Uri, name: string, output: vscode.OutputChannel) =>
    ask(uri, name, output),
  collector: (uri: vscode.Uri, output: vscode.OutputChannel) =>
    ask(uri, "--collector", output),
  served: (uri: vscode.Uri, name: string, output: vscode.OutputChannel) =>
    ask(uri, name, output, ["--served"]),
};
