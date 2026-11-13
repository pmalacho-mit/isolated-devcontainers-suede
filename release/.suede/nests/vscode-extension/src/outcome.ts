import { explain } from "./failure.js";

import type { ResultRecord } from "./vitest.js";

export type Outcome =
  | { state: "running" }
  | { state: "passed"; duration: number }
  | { state: "skipped" }
  | { state: "failed"; message: string; duration: number };

export const lensTitle = (outcome: Outcome | undefined) => {
  if (!outcome) return "$(play) Run";
  if (outcome.state === "running") return "$(sync~spin) Running…";
  if (outcome.state === "passed") return `$(check) Passed (${outcome.duration}ms)`;
  if (outcome.state === "skipped") return "$(circle-slash) Skipped";
  return "$(error) Failed";
};

const BETWEEN_FAILURES = `\n\n${"─".repeat(60)}\n\n`;

const whereOf = ({ file, location }: ResultRecord) => (location ? `${file}:${location.line}` : null);

const explained = (record: ResultRecord) =>
  explain({ name: record.name, where: whereOf(record), message: "failed", ...record.errors[0] });

export function outcomeOf(records: ResultRecord[], duration: number): Outcome {
  const failed = records.filter((r) => r.state === "failed");
  if (failed.length) return { state: "failed", message: failed.map(explained).join(BETWEEN_FAILURES), duration };
  if (records.every((r) => r.state === "passed")) return { state: "passed", duration };
  return { state: "skipped" };
}
