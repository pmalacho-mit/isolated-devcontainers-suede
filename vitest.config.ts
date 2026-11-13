// In-source tests (suede.nests): `declare namespace` blocks beside the code, in release/,
// whose types say what each function does. Vitest runs them; node never sees them (a
// declared namespace and an `import type` are erased). The tiers' own tests (tests/v3) are
// node:test files, run by tests/v3/run.sh, not by Vitest.
import { defineConfig } from "vitest/config";
import namespaceTests from "./release/.suede/nests/vite-plugin/plugin.mts";

export default defineConfig({
  plugins: [namespaceTests({ exclude: ["tests/**", "carryover/**", "samples/**", "demo-out/**", "release/.suede/**"] })],
  test: { include: [], passWithNoTests: false },
});
