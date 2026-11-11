// The `fake` backend: each "VM" is a privileged container on the host's Docker daemon.
//
// IT GIVES NO HYPERVISOR ISOLATION. It exists so that everything except the VM boundary can
// be exercised in minutes on any Docker host (tier T2). It is refused unless
// DESOLATE_BACKEND=fake is set explicitly, every workspace on it is labelled "not isolated",
// and `doctor` fails on it outside a test run. A T2 test is never proof of a boundary.
//
// It still implements the interface faithfully, so the code above cannot tell:
//   read-only shares   read-only bind mounts
//   egress "none"      --network none: the container has a loopback interface and nothing else
//   sockets            the socket's host directory, bind-mounted read-only
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Duplex } from "node:stream";
import { must, run } from "../../shared/run.ts";
import type { RunResult } from "../../shared/run.ts";
import { INSTANCE } from "../paths.ts";
import { GUEST_USER } from "./types.ts";
import type { Backend, Check, ExecOptions, Listener, VmInfo, VmSpec, VmStatus } from "./types.ts";

const IMAGE = process.env.DESOLATE_FAKE_IMAGE ?? "desolate/base:latest";
const LABEL = "desolate.instance";

const docker = (args: string[], options: { input?: string | Buffer; timeoutMs?: number } = {}) =>
  run("docker", args, options);

/** A child process's stdio as one Duplex stream. */
export const duplexOf = (child: ChildProcess): Duplex => {
  const stdin = child.stdin!;
  const stdout = child.stdout!;
  const stream = new Duplex({
    read() {
      stdout.resume();
    },
    write(chunk, encoding, callback) {
      stdin.write(chunk, encoding, callback);
    },
    final(callback) {
      stdin.end(callback);
    },
    destroy(error, callback) {
      child.kill();
      callback(error);
    },
  });
  stdout.on("data", (chunk) => {
    if (!stream.push(chunk)) stdout.pause();
  });
  stdout.on("end", () => stream.push(null));
  stdin.on("error", () => {});
  child.on("error", (error) => stream.destroy(error));
  return stream;
};

const execArgs = (name: string, argv: string[], options: ExecOptions, interactive: boolean) => {
  const args = ["exec"];
  if (interactive) args.push("-i");
  args.push("-u", options.root ? "0:0" : GUEST_USER);
  if (options.cwd) args.push("-w", options.cwd);
  const env = { HOME: options.root ? "/root" : `/home/${GUEST_USER}`, ...(options.env ?? {}) };
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  args.push(name, ...argv);
  return args;
};

export const fakeBackend = (): Backend => {
  const containerArgs = (spec: VmSpec, image: string) => {
    const args = [
      "create", "--name", spec.name, "--hostname", spec.name,
      "--label", `${LABEL}=${INSTANCE}`, "--label", `desolate.role=${spec.role}`,
      // dockerd (workspaces) and nftables (the root) need it. This is the fake backend: the
      // container is not a boundary and does not pretend to be one.
      "--privileged",
      "--tmpfs", "/run:exec,mode=755", "--tmpfs", "/tmp:exec,mode=1777",
      "--network", spec.egress === "open" ? "bridge" : "none",
    ];
    for (const [key, value] of Object.entries(spec.labels)) args.push("--label", `desolate.${key}=${value}`);
    for (const share of spec.shares) args.push("-v", `${share.host}:${share.guest}${share.writable ? "" : ":ro"}`);
    for (const socket of spec.sockets) args.push("-v", `${path.dirname(socket.host)}:${path.dirname(socket.guest)}:ro`);
    if (spec.role === "workspace") args.push("-v", `${spec.name}-docker:/var/lib/docker`);
    if (spec.cpus) args.push("--cpus", String(spec.cpus));
    if (spec.memoryMiB) args.push("--memory", `${spec.memoryMiB}m`);
    args.push(image, "sleep", "infinity");
    return args;
  };

  /** The unprivileged user owns the shares, so it has the host user's uid, as Lima's does. */
  const ensureUser = async (name: string) => {
    const uid = process.getuid!();
    const gid = process.getgid!();
    if (uid === 0) throw new Error("the fake backend refuses to run as root: its guest user would be root, and nothing about users could be tested. Run desolate as an ordinary user in the docker group.");
    const script = [
      `getent group ${gid} >/dev/null || groupadd -g ${gid} ${GUEST_USER}`,
      // The image may already have a user with this uid (Ubuntu's own uid 1000): it becomes
      // the guest user, rather than a second name for one uid.
      `other=$(getent passwd ${uid} | cut -d: -f1); if [ -n "$other" ] && [ "$other" != ${GUEST_USER} ]; then usermod -l ${GUEST_USER} -d /home/${GUEST_USER} -m "$other"; fi`,
      `id -u ${GUEST_USER} >/dev/null 2>&1 || useradd -u ${uid} -g ${gid} -m -s /bin/bash ${GUEST_USER}`,
      // docker group: the workspace user drives the VM's own dockerd, as on any dev VM.
      `if getent group docker >/dev/null; then usermod -aG docker ${GUEST_USER}; fi`,
    ].join(" && ");
    await must("docker", ["exec", "-u", "0:0", name, "bash", "-c", script]);
  };

  const status = async (name: string): Promise<VmStatus> => {
    const result = await docker(["inspect", "-f", "{{.State.Status}} {{.State.Paused}}", name]);
    if (result.code !== 0) return "missing";
    const [state, paused] = result.stdout.trim().split(" ");
    if (paused === "true") return "suspended";
    return state === "running" ? "running" : "stopped";
  };

  const labelsOf = async (name: string): Promise<Record<string, string>> => {
    const result = await docker(["inspect", "-f", "{{json .Config.Labels}}", name]);
    if (result.code !== 0) return {};
    const all = JSON.parse(result.stdout) as Record<string, string>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(all)) if (key.startsWith("desolate.")) out[key.slice(9)] = value;
    return out;
  };

  const backend: Backend = {
    kind: "fake",
    isolated: false,

    async check(): Promise<Check[]> {
      const checks: Check[] = [];
      const info = await docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15_000 });
      checks.push({
        name: "docker daemon", ok: info.code === 0,
        detail: info.code === 0 ? `docker ${info.stdout.trim()}` : "no Docker daemon answers",
        fix: "start Docker (the fake backend runs each VM as a container)",
      });
      if (info.code === 0) {
        const image = await docker(["image", "inspect", "-f", "{{.Id}}", IMAGE]);
        checks.push({
          name: "base image", ok: image.code === 0,
          detail: image.code === 0 ? `${IMAGE} ${image.stdout.trim().slice(7, 19)}` : `${IMAGE} is not in the image store`,
          fix: "desolate bootstrap --backend fake",
        });
      }
      return checks;
    },

    async ensureImage(log) {
      const have = await docker(["image", "inspect", "-f", "{{.Id}}", IMAGE]);
      if (have.code === 0) return log(`base image ${IMAGE} present (${have.stdout.trim().slice(7, 19)})`);
      const built = process.env.DESOLATE_IMAGE_DIR;
      if (built && fs.existsSync(path.join(built, "rootfs.tar"))) {
        log(`importing ${built}/rootfs.tar as ${IMAGE}`);
        await must("docker", ["import", "-c", 'CMD ["sleep","infinity"]', path.join(built, "rootfs.tar"), IMAGE]);
        return;
      }
      throw new Error(`the base image ${IMAGE} is missing. Build it: sudo release/image/build.sh --out <dir>, then set DESOLATE_IMAGE_DIR=<dir> and run bootstrap again.`);
    },

    async create(spec) {
      for (const share of spec.shares) fs.mkdirSync(share.host, { recursive: true });
      for (const socket of spec.sockets) fs.mkdirSync(path.dirname(socket.host), { recursive: true });
      await must("docker", containerArgs(spec, IMAGE));
    },

    async clone(from, spec) {
      const image = `desolate/clone-${from}:latest`;
      await must("docker", ["commit", from, image]);
      for (const share of spec.shares) fs.mkdirSync(share.host, { recursive: true });
      for (const socket of spec.sockets) fs.mkdirSync(path.dirname(socket.host), { recursive: true });
      await must("docker", containerArgs(spec, image));
    },

    async start(name) {
      await must("docker", ["start", name]);
      await ensureUser(name);
    },
    async stop(name) {
      await must("docker", ["stop", "-t", "3", name]);
    },
    async suspend(name) {
      await must("docker", ["pause", name]);
    },
    async resume(name) {
      await must("docker", ["unpause", name]);
    },
    async destroy(name) {
      await docker(["rm", "-f", "-v", name]);
      await docker(["volume", "rm", "-f", `${name}-docker`]);
      await docker(["image", "rm", "-f", `desolate/clone-${name}:latest`]);
    },

    async info(name): Promise<VmInfo> {
      return { name, status: await status(name), labels: await labelsOf(name) };
    },

    async list() {
      const result = await must("docker", ["ps", "-a", "--filter", `label=${LABEL}=${INSTANCE}`, "--format", "{{.Names}}"]);
      const names = result.split("\n").filter(Boolean).sort();
      return Promise.all(names.map((name) => backend.info(name)));
    },

    exec(name, argv, options = {}): Promise<RunResult> {
      return run("docker", execArgs(name, argv, options, options.input !== undefined), {
        input: options.input, timeoutMs: options.timeoutMs, inheritStderr: options.inheritStderr,
      });
    },

    spawn(name, argv, options = {}) {
      return spawn("docker", execArgs(name, argv, options, true), { stdio: ["pipe", "pipe", "pipe"] });
    },

    attach(name, argv, options = {}) {
      const args = ["exec", "-i", ...(process.stdin.isTTY ? ["-t"] : []), "-u", GUEST_USER, "-e", `HOME=/home/${GUEST_USER}`, "-e", `TERM=${process.env.TERM ?? "xterm"}`];
      if (options.cwd) args.push("-w", options.cwd);
      const child = spawn("docker", [...args, name, ...argv], { stdio: "inherit" });
      return new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));
    },

    dial(name, port) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port ${port}`);
      return duplexOf(spawn("docker", ["exec", "-i", "-u", "0:0", name, "socat", "STDIO", `TCP:127.0.0.1:${port}`], { stdio: ["pipe", "pipe", "ignore"] }));
    },

    async listeners(name): Promise<Listener[]> {
      const result = await docker(["exec", "-u", "0:0", name, "ss", "-H", "-ltn"], { timeoutMs: 10_000 });
      if (result.code !== 0) throw new Error(`cannot list listeners in ${name}: ${result.stderr.trim()}`);
      return parseSs(result.stdout);
    },

    async logs(name) {
      return (await docker(["logs", "--tail", "200", name])).stdout;
    },
  };
  return backend;
};

/** `ss -H -ltn` lines: `LISTEN 0 511 0.0.0.0:5173 0.0.0.0:*`. */
export const parseSs = (text: string): Listener[] => {
  const seen = new Map<string, Listener>();
  for (const line of text.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const at = local.lastIndexOf(":");
    const port = Number(local.slice(at + 1));
    if (!Number.isInteger(port) || port < 1) continue;
    const address = local.slice(0, at).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    seen.set(`${address}:${port}`, { port, address });
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
};
