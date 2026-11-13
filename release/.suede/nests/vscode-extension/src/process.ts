import { spawn } from "node:child_process";

export type Exited = { code: number; stdout: string; stderr: string };

export function exec(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<Exited> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32",
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    // a failing test exits non-zero, which is a result, not an error
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}
