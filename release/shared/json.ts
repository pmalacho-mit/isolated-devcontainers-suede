// Small JSON file helpers. Writes are atomic (temp file + rename) because other VMs and the
// host read these files as data, possibly while they are being replaced.
import * as fs from "node:fs";
import * as path from "node:path";

export const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};

export const writeJson = (file: string, value: unknown, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode });
  fs.renameSync(temp, file);
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
