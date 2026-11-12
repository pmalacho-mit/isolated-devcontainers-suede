// The VM layer: one interface, three kinds of backend (section 13.2).
//
//   fake   each "VM" is a container. NO hypervisor isolation, and it says so everywhere.
//   qemu   Lima's QEMU driver on Linux: KVM where /dev/kvm exists, TCG where it does not.
//   vz     Lima's Virtualization.framework driver on a Mac: the product backend.
//
// Everything above this file is written against `Backend` only. What a backend must enforce
// OUTSIDE the VM (P5), so that root inside it cannot undo it:
//   - a share with writable:false cannot be written;
//   - a VM with egress "none" reaches nothing but the sockets in `sockets`;
//   - nothing in the VM is reachable from the host except through exec() and dial().
import type { ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import type { RunResult } from "../../shared/run.ts";

export type Share = { host: string; guest: string; writable: boolean };

/** A unix socket the host listens on, shown inside the VM at `guest`. The VM connects; the
 *  host answers. This is a workspace's whole "network link". */
export type SocketLink = { host: string; guest: string };

export type VmSpec = {
  name: string;
  role: "root" | "workspace";
  /** "open": ordinary outbound network (the root, which reaches the remotes).
   *  "none": no route to anything; only `sockets` lead out. */
  egress: "open" | "none";
  shares: Share[];
  sockets: SocketLink[];
  cpus?: number;
  memoryMiB?: number;
  diskGiB?: number;
  labels: Record<string, string>;
};

export type VmStatus = "running" | "stopped" | "suspended" | "missing";
export type VmInfo = { name: string; status: VmStatus; labels: Record<string, string> };

export type ExecOptions = {
  /** Run as root in the VM. Default: the unprivileged user that owns the shares. */
  root?: boolean;
  input?: string | Buffer;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  inheritStderr?: boolean;
};

export type Listener = { port: number; address: string };

export type Check = { name: string; ok: boolean; detail: string; fix?: string };

export interface Backend {
  readonly kind: "fake" | "qemu" | "vz";
  /** false for `fake`. Shown on every workspace and checked by `doctor`. */
  readonly isolated: boolean;
  /** What this backend needs on the host, for `doctor` and `bootstrap`. */
  check(): Promise<Check[]>;
  /** Make the base image available (build, fetch or verify it). Idempotent. */
  ensureImage(log: (line: string) => void): Promise<void>;
  create(spec: VmSpec): Promise<void>;
  /** A new VM whose disk is a copy-on-write clone of `from`'s, with its own spec. */
  clone(from: string, spec: VmSpec): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  suspend(name: string): Promise<void>;
  resume(name: string): Promise<void>;
  destroy(name: string): Promise<void>;
  info(name: string): Promise<VmInfo>;
  /** Every VM of this instance. */
  list(): Promise<VmInfo[]>;
  exec(name: string, argv: string[], options?: ExecOptions): Promise<RunResult>;
  /** exec() as a live process: stdin, stdout and stderr are pipes. */
  spawn(name: string, argv: string[], options?: ExecOptions): ChildProcess;
  /** Run a command with this process's own stdin, stdout and stderr, and a terminal if this
   *  process has one: a person's shell, or a prompt only a person can answer. */
  attach(name: string, argv: string[], options?: { cwd?: string }): Promise<number>;
  /** Open a connection, from the host, to a port on the VM's loopback or to a unix socket in
   *  the VM (an absolute path: a workspace's proxy, which listens where only its domain's
   *  proxies and the root's user can reach it). */
  dial(name: string, target: number | string): Duplex;
  /** A workspace's link to its proxy: the address the guest connects to, and, where the
   *  backend carries it over a loopback port on the host, that port (the host daemon then
   *  listens there as well as on the socket). */
  link(name: string): { guest: string; hostPort?: number; token?: string };
  /** TCP listeners inside the VM right now. */
  listeners(name: string): Promise<Listener[]>;
  logs(name: string): Promise<string>;
  /** After root in the VM changed the ordinary user's groups (docker in a workspace, the
   *  proxies' group in the root): make the next commands run with them. Lima's sessions
   *  share one ssh connection, and a session keeps the groups that connection logged in
   *  with (found on the M1: `docker` refused every command the host ran). */
  refreshSessions?(name: string, force?: boolean): Promise<void>;
  /** The host's loopback ports this backend's VMs use (ssh, links). Never published for a
   *  workspace: a workspace listening on one must not get the host to bind it, in front of
   *  another VM's ssh or link (found by an audit on the M1). */
  hostPorts?(): Set<number>;
}

export const GUEST_USER = "desolate";

/** socat's address for a dial target; a port, or a socket path made only of plain names. */
export const socatAddress = (target: number | string): string => {
  if (typeof target === "number") {
    if (!Number.isInteger(target) || target < 1 || target > 65535) throw new Error(`bad port ${target}`);
    return `TCP:127.0.0.1:${target}`;
  }
  if (!/^(\/[A-Za-z0-9._-]+)+$/.test(target) || target.includes("/../") || target.length > 200) throw new Error("bad socket path");
  return `UNIX-CONNECT:${target}`;
};
