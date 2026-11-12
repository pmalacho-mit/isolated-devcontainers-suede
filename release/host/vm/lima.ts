// The Lima backends: `qemu` (Linux; KVM where there is /dev/kvm, TCG where there is not) and
// `vz` (macOS Virtualization.framework, the product backend). One implementation: Lima is the
// same tool on both. What differs is how each enforces, OUTSIDE the VM, the two things the
// interface demands (P5), and docs/v3/decisions.md has the measurements behind each:
//
//                     read-only shares                   a workspace's egress
//   qemu  (Linux)     9p with QEMU's `readonly`.         QEMU's user network with restrict=on,
//                     NOT virtiofs: virtiofsd has no     and guestfwd to the link's socket
//                     read-only mode, and root in the    (qemu-wrapper.sh).
//                     guest remounts it rw (measured).
//   vz    (macOS)     virtiofs; the host refuses the     Lima's host process under sandbox-exec,
//                     write (measured on an M1).         allowed one loopback port: the link.
//
// desolate keeps its own Lima home under ~/.desolate, so it never touches a VM it did not
// make, and refuses Lima's user-wide _config overrides, which could add a network.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../shared/run.ts";
import type { RunResult } from "../../shared/run.ts";
import { readJson, writeJson } from "../../shared/json.ts";
import { INSTANCE, paths, RELEASE_DIR } from "../paths.ts";
import { duplexOf, parseSs } from "./fake.ts";
import type { Backend, Check, ExecOptions, Listener, VmInfo, VmSpec, VmStatus } from "./types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIMA_HOME = path.join(paths.home, "lima");
const LIMACTL = process.env.DESOLATE_LIMACTL ?? "limactl";
const PREFIX = `dsl-${INSTANCE}-`;
const BASE = `${PREFIX}base`;
/** What the guest connects to for its link, per backend. */
const QEMU_LINK = "tcp:192.168.5.100:15000";

type Meta = { spec: VmSpec; sshPort: number; linkPort: number; linkToken: string };
const metaFile = (name: string) => path.join(LIMA_HOME, name, "desolate.json");
const meta = (name: string) => readJson<Meta | null>(metaFile(name), null);

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

export const limaBackend = (kind: "qemu" | "vz"): Backend => {
  const arch = os.arch() === "arm64" ? "aarch64" : "x86_64";
  const imageDir = process.env.DESOLATE_IMAGE_DIR ?? path.join(paths.images, arch);
  const realQemu = () => {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      const candidate = path.join(dir, `qemu-system-${arch}`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return "";
  };
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const out: NodeJS.ProcessEnv = { ...process.env, LIMA_HOME, ...extra };
    // Lima copies proxy variables into the guest; a desolate VM gets none of the host's.
    for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "ftp_proxy", "FTP_PROXY", "all_proxy", "ALL_PROXY"]) delete out[key];
    if (kind === "qemu") {
      out[`QEMU_SYSTEM_${arch.toUpperCase()}`] = path.join(HERE, "qemu-wrapper.sh");
      out.DESOLATE_QEMU_REAL = realQemu();
    }
    return out;
  };
  const lima = (args: string[], options: { timeoutMs?: number; input?: string | Buffer; extraEnv?: Record<string, string>; inheritStderr?: boolean } = {}) =>
    run(LIMACTL, ["--tty=false", ...args], { env: env(options.extraEnv), timeoutMs: options.timeoutMs, input: options.input, inheritStderr: options.inheritStderr });
  const limaOk = async (args: string[], options: Parameters<typeof lima>[1] = {}) => {
    const result = await lima(args, options);
    if (result.code !== 0) throw new Error(`limactl ${args.slice(0, 3).join(" ")} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().split("\n").slice(-6).join(" | ").slice(-900)}`);
    return result.stdout;
  };

  const yq = (value: unknown) => JSON.stringify(value);
  /** The settings every desolate VM has, as yq assignments for `limactl clone --set`. */
  const settings = (spec: VmSpec, sshPort: number): string[] => [
    `.mounts = ${yq(spec.shares.map((share) => ({ location: share.host, mountPoint: share.guest, writable: share.writable })))}`,
    `.cpus = ${spec.cpus ?? 2}`,
    `.memory = ${yq(`${spec.memoryMiB ?? 2048}MiB`)}`,
    `.ssh.localPort = ${sshPort}`,
    // No automatic forwards of guest ports onto the host: Lima publishes a guest's port 80
    // on every interface (measured). desolate's forwarder is the only way in.
    `.portForwards = [{"guestIP": "0.0.0.0", "guestPortRange": [1, 65535], "ignore": true}]`,
    // A second network would be a way around the proxy.
    `.networks = []`,
  ];

  const baseYaml = (): string => {
    const common = [
      `vmType: ${kind}`, `arch: ${arch}`,
      // qemu: 9p, whose read-only is QEMU's. vz: virtiofs, whose read-only is the host's.
      `mountType: ${kind === "qemu" ? "9p" : "virtiofs"}`,
      "cpus: 2", "memory: 2GiB", "disk: 30GiB", "mounts: []",
      "containerd:\n  system: false\n  user: false",
      'portForwards:\n- guestIP: "0.0.0.0"\n  guestPortRange: [1, 65535]\n  ignore: true',
      "networks: []",
    ];
    if (kind === "qemu")
      return [
        ...common, "images:",
        `- location: ${yq(path.join(imageDir, "disk.raw"))}`, `  arch: ${arch}`,
        "  kernel:", `    location: ${yq(path.join(imageDir, "vmlinuz"))}`, '    cmdline: "root=LABEL=desolate-root rw console=ttyS0"',
        "  initrd:", `    location: ${yq(path.join(imageDir, "initrd"))}`,
      ].join("\n") + "\n";
    // vz: Lima's own digest-pinned Ubuntu image, provisioned once by image/provision.sh.
    return ["minimumLimaVersion: 2.0.0", "base:", "- template:_images/ubuntu-24.04", ...common,
      `mounts:\n- location: ${yq(RELEASE_DIR)}\n  mountPoint: /desolate/release\n  writable: false`].filter((line) => line !== "mounts: []").join("\n") + "\n";
  };

  const status = async (name: string): Promise<VmStatus> => {
    if (!fs.existsSync(path.join(LIMA_HOME, name, "lima.yaml"))) return "missing";
    const listed = await lima(["list", "--format", "{{.Status}}", name], { timeoutMs: 30_000 });
    const text = listed.stdout.trim();
    return text === "Running" ? "running" : text === "" ? "missing" : "stopped";
  };

  /** The sandbox profile for a vz workspace's host process (decisions.md: measured on an M1).
   *  Outbound: unix sockets except the Mac's resolver; this VM's ssh forward; its link. */
  const profile = (m: Meta) => [
    "(version 1)", "(allow default)", "(deny network-outbound)",
    "(allow network-outbound (remote unix-socket))",
    '(deny network-outbound (literal "/private/var/run/mDNSResponder"))',
    '(deny network-outbound (literal "/var/run/mDNSResponder"))',
    `(allow network-outbound (remote ip "localhost:${m.sshPort}"))`,
    `(allow network-outbound (remote ip "localhost:${m.linkPort}"))`,
  ].join("\n") + "\n";

  const shellArgs = (name: string, argv: string[], options: ExecOptions) => {
    const vars = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`);
    const command = options.root ? ["sudo", "env", ...vars, ...argv] : vars.length > 0 ? ["env", ...vars, ...argv] : argv;
    return ["shell", "--workdir", options.cwd ?? "/", name, ...command];
  };

  const backend: Backend = {
    kind,
    isolated: true,

    async check(): Promise<Check[]> {
      const checks: Check[] = [];
      const version = await run(LIMACTL, ["--version"], { env: env() });
      const number = /(\d+)\.(\d+)\.(\d+)/.exec(version.stdout);
      // vz needs 2.3: on 2.1.2 a confined guest's pings were answered and it was never
      // shown that nothing left the Mac; on 2.3.0 they are not (decisions.md, section 4.3).
      const [major, minor] = number ? [Number(number[1]), Number(number[2])] : [0, 0];
      const least = kind === "vz" ? [2, 3] : [2, 0];
      checks.push({
        name: "lima", ok: version.code === 0 && number !== null && (major > least[0]! || (major === least[0] && minor >= least[1]!)),
        detail: version.code === 0 ? version.stdout.trim() : "limactl was not found",
        fix: process.platform === "darwin" ? `brew upgrade lima (${least.join(".")} or newer)` : `install Lima ${least.join(".")} or newer (https://lima-vm.io) and put limactl on PATH, or set DESOLATE_LIMACTL`,
      });
      for (const override of ["default.yaml", "override.yaml"])
        if (fs.existsSync(path.join(LIMA_HOME, "_config", override)))
          checks.push({ name: "lima overrides", ok: false, detail: `${LIMA_HOME}/_config/${override} would change every VM (it could add a network)`, fix: `remove ${LIMA_HOME}/_config/${override}` });
      if (kind === "qemu") {
        checks.push({ name: "qemu", ok: realQemu() !== "", detail: realQemu() || `qemu-system-${arch} was not found`, fix: "apt-get install qemu-system-x86 qemu-utils (or your distribution's package)" });
        const socat = await run("socat", ["-V"]);
        checks.push({ name: "socat (carries a workspace's link)", ok: socat.code === 0, detail: socat.code === 0 ? "present" : "not found", fix: "apt-get install socat" });
        checks.push({ name: "acceleration", ok: true, detail: fs.existsSync("/dev/kvm") ? "KVM" : "none: software emulation (TCG). A real VM boundary, and slow: minutes to boot" });
      } else {
        const sandbox = await run("sandbox-exec", ["-n", "no-network", "true"]);
        checks.push({ name: "sandbox-exec (cuts a workspace's egress from outside it)", ok: sandbox.code === 0, detail: sandbox.code === 0 ? "present" : "not usable on this macOS", fix: "desolate's vz backend needs macOS's sandbox-exec" });
        // Measured, by tests/probes/v3/phase0-mac-egress3.sh and on every T4 run
        // (tests/v3/t3/01-boundaries): docs/v3/decisions.md, section 4.3.
        checks.push({ name: "vz: ICMP from a workspace", ok: true, detail: "closed by the same confinement as TCP, UDP and DNS (measured on Lima 2.3.0: a confined guest's echo gets no reply; the unconfined control's does)" });
      }
      const haveBase = fs.existsSync(path.join(LIMA_HOME, BASE, "lima.yaml"));
      checks.push({ name: "base image", ok: haveBase, detail: haveBase ? `the base VM ${BASE}` : "no base VM yet", fix: `desolate bootstrap --backend ${kind}` });
      return checks;
    },

    async ensureImage(log) {
      fs.mkdirSync(LIMA_HOME, { recursive: true });
      if (fs.existsSync(path.join(LIMA_HOME, BASE, "lima.yaml"))) return log(`base VM ${BASE} present`);
      const file = path.join(LIMA_HOME, "base.yaml");
      if (kind === "qemu") {
        for (const need of ["disk.raw", "vmlinuz", "initrd"])
          if (!fs.existsSync(path.join(imageDir, need)))
            throw new Error(`the base image is missing (${path.join(imageDir, need)}). Build it: sudo release/image/build.sh --out ${imageDir}  (or set DESOLATE_IMAGE_DIR to where it was built)`);
        fs.writeFileSync(file, baseYaml());
        log(`creating the base VM from ${imageDir}`);
        await limaOk(["create", `--name=${BASE}`, file], { timeoutMs: 1_200_000 });
        return;
      }
      // vz: boot Lima's pinned Ubuntu image once, provision it with the same script the
      // Linux image is built from, and stop it. Every VM is then a copy-on-write clone.
      fs.writeFileSync(file, baseYaml());
      log("creating the base VM from Lima's pinned Ubuntu image (downloads it the first time)");
      await limaOk(["start", `--name=${BASE}`, "--timeout", "20m", file], { timeoutMs: 1_500_000 });
      log("provisioning it (packages, node, docker, the editor server): several minutes, once");
      const provisioned = await lima(["shell", "--workdir", "/", BASE, "sudo", "env", "DESOLATE_IMAGE_KIND=vm", "bash", "/desolate/release/image/provision.sh"], { timeoutMs: 3_600_000, inheritStderr: true });
      if (provisioned.code !== 0) {
        await lima(["delete", "-f", BASE]);
        throw new Error(`provisioning the base VM failed: ${provisioned.stdout.trim().split("\n").slice(-5).join(" | ")}`);
      }
      await limaOk(["stop", BASE], { timeoutMs: 300_000 });
    },

    async create(spec) {
      return backend.clone(BASE, spec);
    },

    async clone(from, spec) {
      for (const share of spec.shares) fs.mkdirSync(share.host, { recursive: true });
      for (const socket of spec.sockets) fs.mkdirSync(path.dirname(socket.host), { recursive: true });
      const m: Meta = { spec, sshPort: await freePort(), linkPort: await freePort(), linkToken: randomBytes(16).toString("hex") };
      const args = ["clone", ...settings(spec, m.sshPort).flatMap((assignment) => ["--set", assignment]), from, spec.name];
      await limaOk(args, { timeoutMs: 600_000 });
      writeJson(metaFile(spec.name), m);
    },

    async start(name) {
      const m = meta(name);
      if (!m) throw new Error(`${name} is not a VM desolate made`);
      const cut = m.spec.egress === "none";
      const args = ["start", "--timeout", "30m", name];
      if (kind === "vz" && cut) {
        const file = path.join(LIMA_HOME, name, "confine.sb");
        fs.writeFileSync(file, profile(m));
        // The host process starts under the profile and keeps it for its whole life.
        const result = await run("sandbox-exec", ["-f", file, LIMACTL, "--tty=false", ...args], { env: env(), timeoutMs: 2_400_000 });
        if (result.code !== 0) throw new Error(`could not start ${name} confined: ${(result.stderr || result.stdout).trim().split("\n").slice(-4).join(" | ")}`);
        return;
      }
      const extraEnv: Record<string, string> = kind === "qemu" && cut ? { DESOLATE_QEMU_EGRESS: "none", DESOLATE_QEMU_LINK: m.spec.sockets[0]?.host ?? "" } : {};
      await limaOk(args, { timeoutMs: 2_400_000, extraEnv });
      if (cut && kind === "qemu") {
        // Not taken on trust: the QEMU that is running must be the restricted one.
        const pid = fs.readFileSync(path.join(LIMA_HOME, name, "qemu.pid"), "utf8").trim();
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (!cmdline.includes("restrict=on")) {
          await lima(["stop", "-f", name]);
          throw new Error(`${name} came up with an unrestricted network; it was stopped. This is a bug in desolate's qemu backend.`);
        }
      }
    },

    async stop(name) {
      await limaOk(["stop", name], { timeoutMs: 600_000 });
    },
    async suspend() {
      throw new Error(`the ${kind} backend cannot suspend a VM (Lima has no suspend to disk for it); stop it instead`);
    },
    async resume(name) {
      return backend.start(name);
    },
    async destroy(name) {
      await lima(["delete", "-f", name], { timeoutMs: 300_000 });
      fs.rmSync(path.join(LIMA_HOME, name), { recursive: true, force: true });
    },

    async info(name): Promise<VmInfo> {
      const m = meta(name);
      return { name, status: await status(name), labels: m ? { ...m.spec.labels, role: m.spec.role } : {} };
    },

    async list() {
      let names: string[] = [];
      try {
        names = fs.readdirSync(LIMA_HOME).filter((entry) => entry.startsWith(PREFIX) && fs.existsSync(path.join(LIMA_HOME, entry, "lima.yaml")));
      } catch {
        return [];
      }
      return Promise.all(names.sort().map((name) => backend.info(name)));
    },

    exec(name, argv, options = {}): Promise<RunResult> {
      return lima(shellArgs(name, argv, options), { input: options.input, timeoutMs: options.timeoutMs, inheritStderr: options.inheritStderr });
    },

    spawn(name, argv, options = {}) {
      return spawn(LIMACTL, ["--tty=false", ...shellArgs(name, argv, options)], { stdio: ["pipe", "pipe", "pipe"], env: env() });
    },

    attach(name, argv, options = {}) {
      const child = spawn(LIMACTL, shellArgs(name, argv, { cwd: options.cwd }), { stdio: "inherit", env: env() });
      return new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));
    },

    dial(name, port) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port ${port}`);
      // A session, not ssh's stdio forwarding, which Lima's control master refuses (measured).
      return duplexOf(spawn(LIMACTL, ["--tty=false", "shell", "--workdir", "/", name, "socat", "STDIO", `TCP:127.0.0.1:${port}`], { stdio: ["pipe", "pipe", "ignore"], env: env() }));
    },

    link(name) {
      // qemu: QEMU carries connections to this address to the link's socket (qemu-wrapper.sh).
      // vz: the Mac's loopback, where the sandbox allows this VM one port.
      if (kind === "qemu") return { guest: QEMU_LINK };
      // A loopback port is open to every process on the Mac, so the link opens with a token
      // that only this host and this VM are given (shared/link.ts). No token, no link.
      const m = meta(name);
      if (!m || !/^[0-9a-f]{32}$/.test(m.linkToken ?? "")) throw new Error(`${name} has no link token: it was made by an older desolate. Remove the workspace and make it again.`);
      return { guest: `tcp:192.168.5.2:${m.linkPort}#${m.linkToken}`, hostPort: m.linkPort, token: m.linkToken };
    },

    async listeners(name): Promise<Listener[]> {
      const result = await lima(["shell", "--workdir", "/", name, "ss", "-H", "-ltn"], { timeoutMs: 60_000 });
      if (result.code !== 0) throw new Error(`cannot list listeners in ${name}: ${result.stderr.trim()}`);
      return parseSs(result.stdout);
    },

    async logs(name) {
      const tail = (file: string) => {
        try {
          return fs.readFileSync(path.join(LIMA_HOME, name, file), "utf8").split("\n").slice(-60).join("\n");
        } catch {
          return "";
        }
      };
      return `${tail("ha.stderr.log")}\n${tail("serial.log")}`;
    },
  };
  return backend;
};
