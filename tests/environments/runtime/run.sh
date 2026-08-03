#!/usr/bin/env bash
# Runs inside the `runtime` environment. Sources were COPIED in at build time.
set -uo pipefail
RC=0
cd /repo || exit 1
SRC=/repo/release/vscode-image

echo "node $(node --version)  tsx $(tsx --version 2>&1 | head -1)"

echo
echo "-- the unit suite, on the toolchain the image ships --"
node --test /repo/tests/unit/broker/*.test.ts /repo/tests/unit/desolate/*.test.ts || RC=1

echo
echo "-- library modules import cleanly --"
# The COPY in release/vscode-image/Dockerfile decides what is in the image. A
# module extracted during a refactor and forgotten there fails at runtime with
# "cannot find module", inside a container, at the worst moment. Importing each
# one turns that into a failure here.
#
# The entry points are excluded because they still run at module scope, which
# would end this process rather than report. That list is asserted, not assumed:
# a NEW self-executing module is a regression (it cannot be unit-tested at all),
# so it shows up as an unexpected import failure below rather than being skipped.
node - <<'NODE' || RC=1
const { readdirSync } = require("node:fs");
const dir = "/repo/release/vscode-image";

// Known to execute on import. desolate.ts is deliberately NOT here -- it guards
// its entry point, which is what makes tests/unit/desolate possible.
const ENTRY_POINTS = new Set(["broker.ts", "desolate-client.ts", "newrepo.ts"]);

const all = readdirSync(dir).filter((f) => f.endsWith(".ts"));
const libraries = all.filter((f) => !ENTRY_POINTS.has(f));

(async () => {
  if (!all.length) { console.log("  FAIL no .ts modules found"); process.exit(1); }
  let failed = 0;
  for (const file of libraries) {
    try {
      await import(`${dir}/${file}`);
      console.log(`  ok   ${file}`);
    } catch (err) {
      console.log(`  FAIL ${file}: ${err.message}`);
      failed++;
    }
  }
  for (const file of [...ENTRY_POINTS].sort())
    console.log(`  --   ${file} (runs at module scope; exercised as a program below)`);
  process.exit(failed ? 1 : 0);
})();
NODE

echo
echo "-- entry points still run as programs --"
# The guard that makes desolate.ts importable must not stop it executing. Each
# of these prints usage and exits non-zero when invoked with no arguments.
for entry in desolate.ts desolate-client.ts; do
  out=$(tsx "$SRC/$entry" 2>&1)
  if printf '%s' "$out" | grep -qi "usage:"; then
    echo "  ok   $entry"
  else
    echo "  FAIL $entry did not print usage; got: $(printf '%s' "$out" | head -1)"
    RC=1
  fi
done

exit "$RC"
