// Running other programs: always an argv, never a shell string.
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = {
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** Echo the child's stderr to ours as it arrives (progress for a person). */
  inheritStderr?: boolean;
};

export const run = (command: string, args: string[], options: RunOptions = {}): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", options.inheritStderr ? "inherit" : "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(error.message) });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
    if (options.timeoutMs)
      timer = setTimeout(() => {
        stderr += `\n(timed out after ${options.timeoutMs} ms)`;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    child.stdin!.on("error", () => {});
    child.stdin!.end(options.input ?? "");
  });

/** run(), but a failure is an exception carrying the child's stderr. */
export const must = async (command: string, args: string[], options: RunOptions = {}): Promise<string> => {
  const result = await run(command, args, options);
  if (result.code !== 0)
    throw new Error(`${command} ${args.join(" ")} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-2000)}`);
  return result.stdout;
};

export const spawnPiped = (command: string, args: string[], options: SpawnOptions = {}): ChildProcess =>
  spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...options });

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `probe` is true. Returns false at the deadline: the caller decides what a
 *  timeout means, and must not read it as success. */
export const waitFor = async (probe: () => Promise<boolean> | boolean, timeoutMs: number, everyMs = 100): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await probe()) return true;
    } catch {
      /* not yet */
    }
    if (Date.now() >= deadline) return false;
    await sleep(everyMs);
  }
};
