import fs from "node:fs";
import path from "node:path";
import { ensureDerived } from "./cache.mts";

import { DISPLAY, type DisplayArtifact } from "./codec.mts";

import type { Reporter, TestCase, Vitest } from "vitest/node";

type RecordedError = { message: string; diff: string | null; stack: string | null };

export type ResultRecord = {
  name: string;
  file: string;
  // source-mapped to the `export type` the test was written as
  location: { line: number; column: number } | null;
  state: "passed" | "failed" | "skipped" | "pending";
  errors: RecordedError[];
  displays: DisplayArtifact[];
};

const recordedError = ({ message, diff, stack }: { message: string; diff?: string; stack?: string }): RecordedError => ({
  message,
  diff: diff ?? null,
  stack: stack ?? null,
});

const isDisplay = (artifact: { type: string }): artifact is DisplayArtifact => artifact.type === DISPLAY;

export default class NamespaceTestsReporter implements Reporter {
  results: ResultRecord[] = [];
  root = process.cwd();

  onInit(ctx: Vitest) {
    this.root = ctx.config.root;
  }

  onTestCaseResult(testCase: TestCase) {
    const result = testCase.result();
    this.results.push({
      name: testCase.name,
      file: path.relative(this.root, testCase.module.moduleId),
      location: testCase.location ?? null,
      state: result.state,
      errors: (result.errors ?? []).map(recordedError),
      displays: testCase.artifacts().filter(isDisplay),
    });
  }

  onTestRunEnd() {
    fs.writeFileSync(
      path.join(ensureDerived(), "results.json"),
      JSON.stringify({ results: this.results }, null, 2),
    );
  }
}
