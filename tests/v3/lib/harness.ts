// The end-to-end harness (move-to-vms.md section 13). Every test starts from `desolate
// bootstrap` on an empty home, never from a state set up by hand, so bootstrapping is itself
// tested every time. It drives desolate the way a person does, through the CLI, and records
// every command's output as a transcript and every step's wall-clock time.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../../..");
const CLI = path.join(REPO_ROOT, "release", "cli.sh");
const FORGE_SRC = path.join(REPO_ROOT, "tests", "v3", "forge");
const TRANSCRIPTS = path.join(REPO_ROOT, "tests", "v3", "transcripts");

export type Result = { code: number; stdout: string; stderr: string; ms: number };
export type Stack = {
  tier: "T2" | "T3";
  instance: string;
  home: string;
  work: string;
  env: NodeJS.ProcessEnv;
  /** Run the CLI; the command, its output and exit code go into the transcript. */
  desolate: (...args: string[]) => Result;
  /** Run the CLI without recording (polling, set-up noise). */
  quiet: (...args: string[]) => Result;
  /** Run a command in the root VM as its unprivileged user (or as root). */
  inRoot: (argv: string[], options?: { root?: boolean; input?: string }) => Result;
  inVm: (vm: string, argv: string[], options?: { root?: boolean; input?: string }) => Result;
  forge: (...args: string[]) => string;
  /** Make a repository on the forge from a local seed directory the callback fills. */
  seed: (repo: string, fill: (dir: string) => void) => void;
  step: (name: string) => void;
  timings: { step: string; ms: number }[];
  /** Compare the transcript with the reviewed one (UPDATE_TRANSCRIPTS=1 rewrites it). */
  checkTranscript: (name: string) => void;
  destroy: () => void;
};

const sh = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string; cwd?: string } = {}): Result => {
  const started = Date.now();
  const result = spawnSync(command, args, { env: options.env ?? process.env, input: options.input, cwd: options.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ms: Date.now() - started };
};

export const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=seed", "-c", "user.email=seed@example.invalid", "-c", "init.defaultBranch=main", ...args], { encoding: "utf8" });

export const backendOfTier = (): "fake" | "qemu" => (process.env.DESOLATE_TIER === "T3" ? "qemu" : "fake");

export const newStack = (label: string): Stack => {
  const backend = backendOfTier();
  const instance = `t${Math.random().toString(36).slice(2, 8)}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `desolate-${label}-`));
  fs.chmodSync(work, 0o755);
  const home = path.join(work, "home");
  const forgeState = path.join(work, "forge-state");
  const seeds = path.join(work, "seeds");
  for (const dir of [forgeState, seeds]) fs.mkdirSync(dir, { recursive: true });
  const forgeName = `dsl-forge-${instance}`;

  // The forge: a container of the base image, on the default bridge, where the root reaches it.
  execFileSync("docker", ["run", "-d", "--name", forgeName, "--label", `desolate.forge=${instance}`,
    "-v", `${FORGE_SRC}:/forge:ro`, "-v", `${forgeState}:/forge-state`, "-v", `${seeds}:/seeds:ro`,
    process.env.DESOLATE_FAKE_IMAGE ?? "desolate/base:latest", "sleep", "infinity"], { stdio: "ignore" });
  const ip = execFileSync("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", forgeName], { encoding: "utf8" }).trim();
  execFileSync("docker", ["exec", "-d", forgeName, "bash", "/forge/serve.sh", "/forge-state", ip, "22", "8080"]);
  for (let waited = 0; !fs.existsSync(path.join(forgeState, "sshd.pid")); waited += 100) {
    if (waited > 20_000) throw new Error("the stand-in forge did not start");
    spawnSync("sleep", ["0.1"]);
  }
  const admin = path.join(work, "forge-admin");
  fs.writeFileSync(admin, `#!/bin/sh\nexec docker exec -e FORGE_STATE=/forge-state ${forgeName} node --disable-warning=ExperimentalWarning /forge/admin.ts "$@"\n`, { mode: 0o755 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DESOLATE_HOME: home,
    DESOLATE_INSTANCE: instance,
    DESOLATE_BACKEND: backend,
    DESOLATE_TEST_RUN: "1",
    DESOLATE_FORGE_ADMIN: admin,
    DESOLATE_FORGE_SPEC: `stand-in:ssh://git@${ip}:22`,
    DESOLATE_FORGE_KNOWN_HOSTS: path.join(forgeState, "known_hosts"),
    NO_COLOR: "1",
  };
  const transcript: string[] = [];
  const timings: { step: string; ms: number }[] = [];
  let stepName = "";
  let stepStarted = Date.now();
  const scrub = (text: string) =>
    text
      .split(home).join("<home>").split(work).join("<work>").split(REPO_ROOT).join("<repo>")
      .split(instance).join("<instance>").split(ip).join("<forge>")
      .replace(/\b[0-9a-f]{40}\b/g, "<commit>").replace(/\b[0-9a-f]{64}\b/g, "<oid>")
      .replace(/sha256:[0-9a-f]{12}|\b[0-9a-f]{12}\b/g, "<id>")
      .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>")
      .replace(/\b\d+(\.\d+)? ?(ms|s)\b/g, "<duration>")
      .replace(/dsl-<instance>-[0-9a-f]{10}/g, "dsl-<instance>-<vm>")
      .replace(/-[0-9a-f]{6}\.localhost/g, "-<hex>.localhost");
  const vmExec = (vm: string, argv: string[], options: { root?: boolean; input?: string } = {}) =>
    backend === "fake"
      ? sh("docker", ["exec", "-i", "-u", options.root ? "0:0" : "desolate", "-e", `HOME=${options.root ? "/root" : "/home/desolate"}`, vm, ...argv], { input: options.input ?? "" })
      : sh("limactl", ["shell", "--workdir", "/", vm, ...(options.root ? ["sudo"] : []), ...argv], { env, input: options.input ?? "" });

  const stack: Stack = {
    tier: backend === "fake" ? "T2" : "T3",
    instance, home, work, env, timings,
    desolate: (...args) => {
      const result = sh(CLI, args, { env });
      transcript.push(scrub(`$ desolate ${args.join(" ")}`), ...scrub(result.stdout + result.stderr).trimEnd().split("\n").filter((line) => line.length > 0), `[exit ${result.code}]`, "");
      return result;
    },
    quiet: (...args) => sh(CLI, args, { env }),
    inRoot: (argv, options) => vmExec(`dsl-${instance}-root`, argv, options),
    inVm: vmExec,
    forge: (...args) => execFileSync(admin, args, { encoding: "utf8" }),
    seed: (repo, fill) => {
      const dir = path.join(seeds, repo.replace("/", "--"));
      fs.mkdirSync(dir, { recursive: true });
      git(dir, "init", "--quiet", "-b", "main");
      fill(dir);
      execFileSync(admin, ["create-repo", repo, `/seeds/${path.basename(dir)}`], { stdio: "ignore" });
    },
    step: (name) => {
      if (stepName) timings.push({ step: stepName, ms: Date.now() - stepStarted });
      stepName = name;
      stepStarted = Date.now();
      transcript.push(`## ${name}`, "");
    },
    checkTranscript: (name) => {
      const file = path.join(TRANSCRIPTS, `${name}.txt`);
      const text = transcript.join("\n").trimEnd() + "\n";
      if (process.env.UPDATE_TRANSCRIPTS === "1" || !fs.existsSync(file)) {
        fs.mkdirSync(TRANSCRIPTS, { recursive: true });
        fs.writeFileSync(file, text);
        return;
      }
      const want = fs.readFileSync(file, "utf8");
      if (want !== text) {
        fs.writeFileSync(`${file}.actual`, text);
        throw new Error(`the transcript of '${name}' changed. A changed message is a reviewed change: diff ${file} ${file}.actual, and if it is right, run with UPDATE_TRANSCRIPTS=1.`);
      }
    },
    destroy: () => {
      if (stepName) timings.push({ step: stepName, ms: Date.now() - stepStarted });
      if (process.env.DESOLATE_KEEP === "1") {
        // For debugging a failure by hand: leave the stack up and say how to reach it.
        fs.writeFileSync("/tmp/desolate-kept.env", Object.entries(env).filter(([key]) => key.startsWith("DESOLATE_")).map(([key, value]) => `export ${key}='${value}'`).join("\n") + "\n");
        return;
      }
      sh(CLI, ["destroy", "--all"], { env });
      spawnSync("docker", ["rm", "-f", "-v", forgeName], { stdio: "ignore" });
      // Files the forge's root wrote are not ours to delete directly.
      spawnSync("docker", ["run", "--rm", "-v", `${work}:/w`, process.env.DESOLATE_FAKE_IMAGE ?? "desolate/base:latest", "bash", "-c", "rm -rf /w/* /w/.[!.]* 2>/dev/null; true"], { stdio: "ignore" });
      fs.rmSync(work, { recursive: true, force: true });
      const report = process.env.DESOLATE_TIMINGS;
      if (report) fs.appendFileSync(report, timings.map((t) => `${label}\t${t.step}\t${t.ms}\n`).join(""));
    },
  };
  return stack;
};

/** bootstrap with the stand-in forge: the first command of every end-to-end test. */
export const bootstrap = (stack: Stack) =>
  stack.desolate("bootstrap", "--forge", stack.env.DESOLATE_FORGE_SPEC!, "--forge-known-hosts", stack.env.DESOLATE_FORGE_KNOWN_HOSTS!);
