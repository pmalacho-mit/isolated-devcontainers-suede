// T1. The host's daemon restarts itself when the code it runs has changed (daemon.ts, codeOf:
// a hash of host/, host/vm/ and shared/). That holds only while everything it imports lives
// there: an import from elsewhere would be served from old code after an update (the origin
// gate once lived in workspace/, and the approval page's checks with it).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const RELEASE = path.resolve(import.meta.dirname, "../../../release");
const HASHED = ["host", "host/vm", "shared"];

/** Every release file a module reaches by relative imports, static or dynamic, transitively. */
const reached = (start: string): Set<string> => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const m of source.matchAll(/(?:^|\s)(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"|import\(\s*"(\.[^"]+)"\s*\)/gm)) {
      const spec = m[1] ?? m[2]!;
      if (/^import type\s/.test(m[0].trim())) continue;
      if (!spec.endsWith(".ts")) continue;
      visit(path.resolve(path.dirname(file), spec));
    }
  };
  visit(path.join(RELEASE, start));
  return seen;
};

describe("T1 the daemon's code, as its restart sees it", () => {
  it("everything the daemon and the CLI import is in host/, host/vm/ or shared/", () => {
    const outside = [...reached("host/daemon.ts"), ...reached("host/cli.ts")]
      .map((file) => path.relative(RELEASE, file))
      .filter((file) => !HASHED.includes(path.dirname(file)));
    assert.deepEqual([...new Set(outside)].sort(), []);
  });
});
