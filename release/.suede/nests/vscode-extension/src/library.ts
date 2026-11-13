import fs from "node:fs";
import path from "node:path";

import { DSL_FILE, isSearchable } from "../../workspace.mts";

export type Library = {
  root: string;
  cli: string;
  reporter: string;
  derived: string;
};

const libraryAt = (root: string): Library => ({
  root,
  cli: path.join(root, "cli.mts"),
  reporter: path.join(root, "vite-plugin", "reporter.mts"),
  derived: path.join(root, ".derived"),
});

// wherever the library is installed, the DSL keeps its name and the command line sits beside it
const isLibrary = (dir: string) =>
  [DSL_FILE, "cli.mts"].every((file) =>
    fs.existsSync(path.join(dir, file)),
  );

const entriesOf = (dir: string) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

function* breadthFirst(folder: string): Generator<string> {
  const queue = [folder];
  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    yield dir;
    for (const entry of entriesOf(dir))
      if (entry.isDirectory() && isSearchable(entry))
        queue.push(path.join(dir, entry.name));
  }
}

const locate = (folder: string) => {
  for (const dir of breadthFirst(folder)) if (isLibrary(dir)) return libraryAt(dir);
  return null;
};

const found = new Map<string, Library | null>();

export function findLibrary(folder: string): Library | null {
  if (!found.has(folder)) found.set(folder, locate(folder));
  return found.get(folder) ?? null;
}

export const forgetLibrary = () => found.clear();
