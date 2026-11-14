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
import { imageFingerprint } from "../image.ts";
import { INSTANCE, paths, RELEASE_DIR } from "../paths.ts";
import { duplexOf, parseSs } from "./fake.ts";
import { socatAddress } from "./types.ts";
import type { Backend, Check, ExecOptions, Listener, VmInfo, VmSpec, VmStatus } from "./types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIMA_HOME = path.join(paths.home, "lima");
/** The base VM's disk, which every desolate VM is cloned from: the smallest any of them has. */
export const BASE_DISK_GIB = 30;
const LIMACTL = process.env.DESOLATE_LIMACTL ?? "limactl";
const PREFIX = `dsl-${INSTANCE}-`;
const BASE = `${PREFIX}base`;
/** The image the base was provisioned from (host/image.ts), beside Lima's files for it:
 *  read without booting it. */
const STAMP = "desolate-image";
const baseStamp = () => {
  try {
    return /^[0-9a-f]{16}$/.exec(fs.readFileSync(path.join(LIMA_HOME, BASE, STAMP), "utf8").trim())?.[0] ?? null;
  } catch {
    return null;
  }
};
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

/** Which of a VM's shares are not mounted yet, and which are mounted the wrong way, from
 *  the guest's /proc/mounts. `flags`: also hold each mount's ro/rw to the spec (vz, where
 *  the guest's flag and the host's refusal agree; measured).
 *
 *  Why it exists: on vz, ssh answers before every virtiofs share is mounted, so the first
 *  command after `limactl start` can see a share's bare mount point: an empty directory
 *  owned by root (release/docs/incidents.md). And a VM that came up without a share, or
 *  with a read-only one writable, must not be used at all (P6). */
export const unmounted = (procMounts: string, shares: { guest: string; writable: boolean }[], fsType: string, flags: boolean): { missing: string[]; wrong: string[] } => {
  // /proc/mounts escapes space, tab, newline and backslash as octal.
  const decode = (field: string) => field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  const mounted = new Map<string, { type: string; ro: boolean }>();
  for (const line of procMounts.split("\n")) {
    const [, where, type, options] = line.split(" ");
    // The last mount at a path is the one that is seen.
    if (where && type && options) mounted.set(decode(where), { type, ro: options.split(",").includes("ro") });
  }
  const missing: string[] = [];
  const wrong: string[] = [];
  for (const share of shares) {
    const found = mounted.get(share.guest);
    if (!found || found.type !== fsType) missing.push(share.guest);
    else if (flags && found.ro === share.writable) wrong.push(`${share.guest} is mounted ${found.ro ? "read-only" : "read-write"}`);
  }
  return { missing, wrong };
};

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
  /** Lima forwards a guest's listeners onto the Mac by itself. Every one is refused, for TCP
   *  and UDP: on 0.0.0.0 (Lima published a guest's port 80 on *:80, measured in Phase 0) and
   *  on loopback, which the first rule did not cover: a workspace's 127.0.0.1 and ::1
   *  listeners appeared on the Mac's 127.0.0.1, around desolate's forwarder, the per-
   *  workspace hostnames and the editor's gate (measured on the M1, 2026-11-12: the editor
   *  server's own port, 31580, among them). desolate's forwarder is the only way in. */
  const NO_FORWARDS = ["0.0.0.0", "127.0.0.1"].flatMap((guestIP) => ["tcp", "udp"].map((proto) => ({ guestIP, guestPortRange: [1, 65535], proto, ignore: true })));
  /** The settings every desolate VM has, as yq assignments for `limactl clone --set`. */
  const settings = (spec: VmSpec, sshPort: number): string[] => [
    `.mounts = ${yq(spec.shares.map((share) => ({ location: share.host, mountPoint: share.guest, writable: share.writable })))}`,
    `.cpus = ${spec.cpus ?? 2}`,
    `.memory = ${yq(`${spec.memoryMiB ?? 2048}MiB`)}`,
    // A clone's disk can grow and never shrink (Lima refuses): every VM is cloned from the
    // base's BASE_DISK_GIB, so a size above it grows the disk and anything else is the base's.
    ...(spec.diskGiB && spec.diskGiB > BASE_DISK_GIB ? [`.disk = ${yq(`${spec.diskGiB}GiB`)}`] : []),
    `.ssh.localPort = ${sshPort}`,
    // No automatic forwards of guest ports onto the host: Lima publishes a guest's port 80
    // on every interface (measured). desolate's forwarder is the only way in.
    `.portForwards = ${yq(NO_FORWARDS)}`,
    // A second network would be a way around the proxy.
    `.networks = []`,
  ];

  const baseYaml = (): string => {
    const common = [
      `vmType: ${kind}`, `arch: ${arch}`,
      // qemu: 9p, whose read-only is QEMU's. vz: virtiofs, whose read-only is the host's.
      `mountType: ${kind === "qemu" ? "9p" : "virtiofs"}`,
      "cpus: 2", "memory: 2GiB", `disk: ${BASE_DISK_GIB}GiB`, "mounts: []",
      "containerd:\n  system: false\n  user: false",
      `portForwards: ${yq(NO_FORWARDS)}`,
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

  /** One argument for a remote shell, quoted so that it stays one argument. */
  const quote = (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`;
  /** Root in the ROOT VM is reached by ssh as root, with Lima's key for this home (on the
   *  host only), on its own control socket: never through the VM's login user, which runs
   *  everything there that reads a domain's data and has no sudo (root/start.sh). */
  const rootSshArgs = (name: string, argv: string[], options: ExecOptions) => {
    const vars = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`);
    const command = `cd ${quote(options.cwd ?? "/")} && exec ${["env", ...vars, ...argv].map(quote).join(" ")}`;
    return ["-F", path.join(LIMA_HOME, name, "ssh.config"), "-o", `ControlPath=${path.join(LIMA_HOME, name, "ssh-root.sock")}`, "-o", "ControlMaster=auto", "-o", "ControlPersist=60", "-l", "root", `lima-${name}`, "--", command];
  };
  const rootReady = new Set<string>();
  /** Make sure root in a root VM takes this home's key. The first time (and after a boot
   *  that reset root's keys), the key is put there through the login user's sudo, which
   *  Lima's cloud-init gives it at boot and root/start.sh then takes away. */
  const ensureRootSsh = async (name: string) => {
    if (rootReady.has(name)) return;
    const probe = () => run("ssh", rootSshArgs(name, ["true"], {}), { env: env(), timeoutMs: 60_000 });
    if ((await probe()).code !== 0) {
      const pub = fs.readFileSync(path.join(LIMA_HOME, "_config", "user.pub"), "utf8").trim();
      if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( \S+)?$/.test(pub)) throw new Error(`${LIMA_HOME}/_config/user.pub is not the ed25519 key Lima makes`);
      const put = await lima(["shell", "--workdir", "/", name, "sudo", "-n", "bash", "-c", "install -d -m 0700 -o root -g root /root/.ssh && cat >/root/.ssh/authorized_keys.new && chmod 0600 /root/.ssh/authorized_keys.new && mv /root/.ssh/authorized_keys.new /root/.ssh/authorized_keys"], { input: pub + "\n", timeoutMs: 60_000 });
      const again = put.code === 0 ? await probe() : put;
      if (again.code !== 0) throw new Error(`cannot reach root in ${name}: ssh as root was refused and its login user could not install the key (${(again.stderr || again.stdout).trim().split("\n").slice(-2).join(" | ")}). Only the first bootstrap can install that key (root/start.sh then takes the login user's sudo away for good), so ${LIMA_HOME}/_config/user.pub or root's authorized_keys in ${name} has changed since. Its keys are on its own disk: make it again (desolate destroy, then bootstrap) only after adding new deploy keys is acceptable.`);
    }
    rootReady.add(name);
  };
  const isRootVm = (name: string) => meta(name)?.spec.role === "root";

  const shellArgs = (name: string, argv: string[], options: ExecOptions) => {
    const vars = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`);
    const command = options.root ? ["sudo", "env", ...vars, ...argv] : vars.length > 0 ? ["env", ...vars, ...argv] : argv;
    return ["shell", "--workdir", options.cwd ?? "/", name, ...command];
  };

  /** Whether a VM's Lima configuration refuses every forward NO_FORWARDS refuses. */
  const forwardsClosed = (name: string) => {
    try {
      const text = fs.readFileSync(path.join(LIMA_HOME, name, "lima.yaml"), "utf8");
      return /guestIP: ?"?127\.0\.0\.1"?[\s\S]{0,120}?ignore: true/.test(text) && /proto: ?"?udp"?/.test(text);
    } catch {
      return false;
    }
  };

  /** Wait for every share to be mounted as the spec says; stop the VM and refuse if one
   *  is mounted the wrong way, or is still missing after a minute. */
  const sharesReady = async (name: string, m: Meta) => {
    const fsType = kind === "qemu" ? "9p" : "virtiofs";
    let last = { missing: m.spec.shares.map((share) => share.guest), wrong: [] as string[] };
    for (let waited = 0; waited <= 60_000; waited += 250) {
      const mounts = await lima(["shell", "--workdir", "/", name, "cat", "/proc/mounts"], { timeoutMs: 30_000 });
      if (mounts.code === 0) {
        last = unmounted(mounts.stdout, m.spec.shares, fsType, kind === "vz");
        if (last.wrong.length > 0) break;
        if (last.missing.length === 0) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await lima(["stop", "-f", name], { timeoutMs: 120_000 });
    throw new Error(last.wrong.length > 0
      ? `${name} came up with a share mounted against its spec (${last.wrong.join("; ")}); it was stopped. This is a bug in desolate's ${kind} backend.`
      : `${name} came up without its shares after a minute (${last.missing.join(", ")}); it was stopped. ${path.join(LIMA_HOME, name, "ha.stderr.log")} may say why.`);
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
      // macOS keeps a unix socket's path under 104 bytes, and Lima's ssh control socket (and
      // desolate's own, for root in the root VM) is under each VM's directory. The longest
      // is a workspace VM's (found on the M1, where a long home made Lima refuse to start).
      const longest = path.join(LIMA_HOME, `${PREFIX}0123456789`, "ssh-root.sock.0123456789012345");
      const limit = process.platform === "darwin" ? 103 : 107;
      checks.push({ name: "socket paths fit", ok: Buffer.byteLength(longest) <= limit, detail: Buffer.byteLength(longest) <= limit ? `the longest fits in ${limit} bytes` : `the longest is ${Buffer.byteLength(longest)} bytes, over ${limit}: ${LIMA_HOME}`, fix: "set DESOLATE_HOME to a shorter path (the default, ~/.desolate, fits unless your home's path is very long)" });
      // Every running VM refuses Lima's own forwarding (NO_FORWARDS): one made before the
      // loopback rules forwarded its 127.0.0.1 listeners onto this Mac.
      const open: string[] = [];
      for (const vm of await backend.list()) if (vm.status === "running" && !forwardsClosed(vm.name)) open.push(vm.labels.title ?? vm.name);
      checks.push({ name: "VMs forward nothing by themselves", ok: open.length === 0, detail: open.length === 0 ? "every running VM refuses Lima's own forwarding" : `${open.join(", ")} still forward their loopback listeners onto this Mac`, fix: "restart each: desolate stop <domain>/<workspace> && desolate start <domain>/<workspace> (the root VM: desolate down, then desolate bootstrap)" });
      const haveBase = fs.existsSync(path.join(LIMA_HOME, BASE, "lima.yaml"));
      const stamp = baseStamp();
      const current = haveBase && stamp === imageFingerprint();
      checks.push({
        name: "base image", ok: current,
        detail: !haveBase ? "no base VM yet" : current ? `the base VM ${BASE}, provisioned from this desolate's image (${stamp})` : `the base VM ${BASE} was provisioned from ${stamp ? `another image (${stamp})` : "an image older than image stamps"}; this desolate's is ${imageFingerprint()}`,
        fix: `desolate bootstrap${haveBase ? " (it provisions the base again, in place: minutes, once)" : ` --backend ${kind}`}`,
      });
      return checks;
    },

    baseStale() {
      if (!fs.existsSync(path.join(LIMA_HOME, BASE, "lima.yaml"))) return null;
      const stamp = baseStamp();
      return stamp === imageFingerprint() ? null : `the base VM was provisioned from ${stamp ? `image ${stamp}` : "an unstamped image"}, and this desolate's is ${imageFingerprint()}`;
    },

    async ensureImage(log) {
      fs.mkdirSync(LIMA_HOME, { recursive: true });
      const fingerprint = imageFingerprint();
      const provision = async (what: string) => {
        log(`provisioning it${what} (packages, node, docker, the editor server): several minutes`);
        const provisioned = await lima(["shell", "--workdir", "/", BASE, "sudo", "env", "DESOLATE_IMAGE_KIND=vm", `DESOLATE_IMAGE_FINGERPRINT=${fingerprint}`, "bash", "/desolate/release/image/provision.sh"], { timeoutMs: 3_600_000, inheritStderr: true });
        return provisioned;
      };
      if (fs.existsSync(path.join(LIMA_HOME, BASE, "lima.yaml"))) {
        const stamp = baseStamp();
        if (stamp === fingerprint) return log(`base VM ${BASE} present, image ${fingerprint}`);
        // Older than this desolate (pins.env, a lock or provision.sh changed since it was
        // made): provisioned again in place. provision.sh is idempotent; what it installs
        // changes, nothing of the stack's lives in the base.
        log(`base VM ${BASE} was provisioned from ${stamp ? `image ${stamp}` : "an unstamped image"}; this desolate's is ${fingerprint}`);
        await limaOk(["start", BASE, "--timeout", "10m"], { timeoutMs: 900_000 });
        const again = await provision(" again");
        await limaOk(["stop", BASE], { timeoutMs: 300_000 });
        if (again.code !== 0) throw new Error(`provisioning the base VM again failed (it is left as it was, still older): ${again.stdout.trim().split("\n").slice(-5).join(" | ")}`);
        fs.writeFileSync(path.join(LIMA_HOME, BASE, STAMP), `${fingerprint}\n`);
        return;
      }
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
      const provisioned = await provision("");
      if (provisioned.code !== 0) {
        await lima(["delete", "-f", BASE]);
        throw new Error(`provisioning the base VM failed: ${provisioned.stdout.trim().split("\n").slice(-5).join(" | ")}`);
      }
      await limaOk(["stop", BASE], { timeoutMs: 300_000 });
      fs.writeFileSync(path.join(LIMA_HOME, BASE, STAMP), `${fingerprint}\n`);
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
      // A VM made by an older desolate gets today's forwarding rules before it boots.
      if (!forwardsClosed(name)) await limaOk(["edit", "--set", `.portForwards = ${yq(NO_FORWARDS)}`, name], { timeoutMs: 120_000 });
      const args = ["start", "--timeout", "30m", name];
      if (kind === "vz" && cut) {
        const file = path.join(LIMA_HOME, name, "confine.sb");
        fs.writeFileSync(file, profile(m));
        // The host process starts under the profile and keeps it for its whole life.
        const result = await run("sandbox-exec", ["-f", file, LIMACTL, "--tty=false", ...args], { env: env(), timeoutMs: 2_400_000 });
        if (result.code !== 0) throw new Error(`could not start ${name} confined: ${(result.stderr || result.stdout).trim().split("\n").slice(-4).join(" | ")}`);
        return sharesReady(name, m);
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
      await sharesReady(name, m);
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

    async exec(name, argv, options = {}): Promise<RunResult> {
      if (options.root && isRootVm(name)) {
        await ensureRootSsh(name);
        return run("ssh", rootSshArgs(name, argv, options), { env: env(), input: options.input, timeoutMs: options.timeoutMs, inheritStderr: options.inheritStderr });
      }
      return lima(shellArgs(name, argv, options), { input: options.input, timeoutMs: options.timeoutMs, inheritStderr: options.inheritStderr });
    },

    spawn(name, argv, options = {}) {
      // Root in the root VM is asked for by exec() only; nothing streams as root there.
      if (options.root && isRootVm(name)) throw new Error("spawn as root in the root VM is not offered; use exec");
      return spawn(LIMACTL, ["--tty=false", ...shellArgs(name, argv, options)], { stdio: ["pipe", "pipe", "pipe"], env: env() });
    },

    attach(name, argv, options = {}) {
      const child = spawn(LIMACTL, shellArgs(name, argv, { cwd: options.cwd }), { stdio: "inherit", env: env() });
      return new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));
    },

    dial(name, target) {
      // A session, not ssh's stdio forwarding, which Lima's control master refuses (measured).
      return duplexOf(spawn(LIMACTL, ["--tty=false", "shell", "--workdir", "/", name, "socat", "STDIO", socatAddress(target)], { stdio: ["pipe", "pipe", "ignore"], env: env() }));
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

    hostPorts() {
      const ports = new Set<number>();
      let names: string[] = [];
      try {
        names = fs.readdirSync(LIMA_HOME);
      } catch {
        return ports;
      }
      for (const name of names) {
        const m = meta(name);
        if (m) for (const port of [m.sshPort, m.linkPort]) if (Number.isInteger(port)) ports.add(port);
        // A VM desolate did not clone (the base) has its ssh port in Lima's own file.
        try {
          const port = /^\s*localPort:\s*(\d+)\s*$/m.exec(fs.readFileSync(path.join(LIMA_HOME, name, "lima.yaml"), "utf8"))?.[1];
          if (port) ports.add(Number(port));
        } catch {
          /* not a VM */
        }
      }
      return ports;
    },

    async refreshSessions(name, force = false) {
      const same = force ? { code: 1 } : await lima(["shell", "--workdir", "/", name, "bash", "-c", 'test "$(id -G)" = "$(id -G "$(id -un)")"'], { timeoutMs: 60_000 });
      if (same.code === 0) return;
      await run("ssh", ["-F", path.join(LIMA_HOME, name, "ssh.config"), "-O", "exit", `lima-${name}`], { env: env(), timeoutMs: 30_000 });
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
