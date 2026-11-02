/**
 * plain-output.ts -- what a runner serving the Mac prints, with no control
 * character in it.
 *
 * From the Mac, `./cli.sh desolate <project>` runs the orchestrator's runner
 * over `docker exec -t`, and everything that runner's children print -- the
 * project's lifecycle commands, its builds, the devcontainer CLI quoting them
 * -- lands in a terminal on the Mac. An escape sequence there is the
 * terminal's to act on: a window title it may later report back as input,
 * iTerm2's OSC 1337, a status request answered into stdin. The editor's side
 * already relays a runner's output through plainText (broker-client.ts, audit
 * L5); this is the Mac's.
 *
 * So a runner with DESOLATE_PLANE=mac runs itself again, its two streams piped
 * and passed through plainText. Its children then write to pipes rather than
 * a terminal, and print plainly. Ctrl-C still stops them: `docker exec -t`
 * gave this process a terminal, and the children are in its foreground
 * process group, which is what the terminal signals. `--exec` is a terminal
 * into the container on purpose, and is left one.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { plainText } from "./utils.ts";

/** Set in the runner that is already plain: it runs itself no further. */
export const PLAIN_VARIABLE = "DESOLATE_PLAIN";

/** Does this invocation run itself again, plainly? */
export const wantsPlain = (env: NodeJS.ProcessEnv, argv: string[]) =>
  env.DESOLATE_PLANE === "mac" && env[PLAIN_VARIABLE] !== "1" && !argv.includes("--exec");

/** A stream's bytes, decoded across chunk boundaries and made plain. */
export const plainWriter = (write: (text: string) => void) => {
  const decoder = new StringDecoder("utf8");
  return Object.assign((chunk: Buffer) => write(plainText(decoder.write(chunk))), {
    end: () => write(plainText(decoder.end())),
  });
};

/** Run `script` with `argv` again, plainly; its exit status. */
export const runPlainly = (script: string, argv: string[]) =>
  new Promise<number>((resolve) => {
    const child = spawn("tsx", [script, ...argv], {
      env: { ...process.env, [PLAIN_VARIABLE]: "1" },
      stdio: ["inherit", "pipe", "pipe"],
    });
    const out = plainWriter((text) => process.stdout.write(text));
    const err = plainWriter((text) => process.stderr.write(text));
    child.stdout.on("data", out);
    child.stderr.on("data", err);
    // The terminal signals the child itself; this one waits for it to finish.
    const pass = (signal: NodeJS.Signals) => () => child.kill(signal);
    process.on("SIGINT", () => {});
    process.on("SIGTERM", pass("SIGTERM"));
    process.on("SIGHUP", pass("SIGHUP"));
    child.on("close", (code, signal) => {
      out.end();
      err.end();
      resolve(code ?? (signal ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 }[signal as string] ?? 1) : 1));
    });
  });
