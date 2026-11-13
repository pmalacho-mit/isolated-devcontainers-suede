// The stack as the host sees it: which backend, the root VM, and the CLI channel to it.
import * as fs from "node:fs";
import * as path from "node:path";
import { Refusal, refuse } from "../shared/exit.ts";
import { readJson, writeJson } from "../shared/json.ts";
import { rootVmName } from "../shared/names.ts";
import { guest, INSTANCE, paths, RELEASE_DIR } from "./paths.ts";
import { fakeBackend } from "./vm/fake.ts";
import { limaBackend } from "./vm/lima.ts";
import type { Backend, VmSpec } from "./vm/types.ts";

export type ForgeConfig = {
  kind: "github" | "stand-in";
  ssh: { user: string; host: string; port: number };
  knownHosts: string;
};
export type Config = { backend: "fake" | "qemu" | "vz"; forge: ForgeConfig };

const CONFIG = path.join(paths.state, "config.json");
export const config = (): Config | null => readJson<Config | null>(CONFIG, null);
export const saveConfig = (value: Config) => writeJson(CONFIG, value);

export const defaultBackend = (): Config["backend"] => (process.platform === "darwin" ? "vz" : "qemu");

/** Which backend this invocation uses. `fake` is never remembered and never a default: it
 *  runs only when DESOLATE_BACKEND=fake is in the environment of this very command
 *  (section 13.2), so a stack cannot quietly be the unisolated kind. */
export const backendKind = (): Config["backend"] => {
  const env = process.env.DESOLATE_BACKEND;
  const stored = config()?.backend;
  if (env !== undefined && env !== "fake" && env !== "qemu" && env !== "vz") refuse(`DESOLATE_BACKEND is '${env}'`, "use fake, qemu or vz");
  if (stored === "fake" && env !== "fake") refuse("this stack was bootstrapped on the fake backend, which gives no isolation and runs only when asked for by name", "set DESOLATE_BACKEND=fake for each command (tests only), or `desolate destroy --all` and bootstrap a real backend");
  if (env === "fake" && stored && stored !== "fake") refuse(`DESOLATE_BACKEND=fake, but this stack was bootstrapped on ${stored}`, "unset DESOLATE_BACKEND");
  return (env as Config["backend"] | undefined) ?? stored ?? defaultBackend();
};

let cached: Backend | null = null;
export const backend = (): Backend => {
  if (cached) return cached;
  const kind = backendKind();
  cached = kind === "fake" ? fakeBackend() : limaBackend(kind);
  return cached;
};

export const ROOT_VM = rootVmName(INSTANCE);

export const rootSpec = (): VmSpec => ({
  name: ROOT_VM,
  role: "root",
  egress: "open",
  shares: [
    { host: RELEASE_DIR, guest: guest.release, writable: false },
    { host: paths.mirrors, guest: guest.mirrors, writable: true },
    { host: paths.rootClones, guest: guest.rootClones, writable: true },
    // One share for every domain, so a new domain needs no restart of the root. The root
    // reads a domain's repos/ as data only and never runs git there (P4): that is enforced
    // by root/git.ts, not by this mount.
    { host: paths.domains, guest: guest.domains, writable: true },
  ],
  sockets: [],
  cpus: 2,
  memoryMiB: 2048,
  diskGiB: 30, // (the base's: a clone's disk cannot be smaller; 20 was never applied)
  labels: { title: "root" },
});

const NODE = ["node", "--disable-warning=ExperimentalWarning"];

/** The CLI channel's service in the root (root/rootctl.ts serve): one request a connection. */
const ROOTCTL_SOCKET = "/run/desolate/rootctl/rootctl.sock";
type Reply<T> = { ok: boolean; result?: T; error?: string; fix?: string; code?: number };

/** The request, over the service: its progress shown as it comes, its answer, or null when
 *  the service is not there or its code is stale (the caller then asks the old way). */
const viaService = <T>(op: string, args: Record<string, unknown>, options: { quiet?: boolean; timeoutMs?: number }): Promise<Reply<T> | null> =>
  new Promise((resolve) => {
    // (socat's -t: how long it waits for the answer after sending the request.)
    const child = backend().spawn(ROOT_VM, ["socat", "-t", "86400", "-", `UNIX-CONNECT:${ROOTCTL_SOCKET}`]);
    let buffer = "";
    let reply: Reply<T> | null = null;
    let accepted = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 900_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as { accepted?: boolean; progress?: unknown; reply?: Reply<T>; stale?: boolean };
          if (message.accepted) accepted = true;
          if (typeof message.progress === "string" && !options.quiet) process.stderr.write(`${message.progress}\n`);
          if (message.reply) reply = message.reply;
        } catch {
          /* not a line of the service's */
        }
      }
    });
    child.stderr!.on("data", () => {});
    child.stdin!.on("error", () => {});
    child.on("error", () => resolve(null));
    child.on("close", () => {
      clearTimeout(timer);
      // Taken and not answered: the operation may have run. Said, not asked again.
      if (!reply && accepted) resolve({ ok: false, error: `the root took '${op}' and its answer was lost: it may have run`, fix: "desolate doctor; then look before asking again", code: 1 });
      else resolve(reply);
    });
    child.stdin!.end(JSON.stringify({ op, args }) + "\n");
  });

/** One request over the CLI channel. The root's refusals arrive as Refusals, with their fix.
 *  Asked of the root's CLI service when it is up (a fraction of the time), else by running
 *  rootctl.ts once (a fresh stack, a service restarting on new code). */
export const rootctl = async <T = unknown>(op: string, args: Record<string, unknown> = {}, options: { quiet?: boolean; timeoutMs?: number } = {}): Promise<T> => {
  const served = process.env.DESOLATE_ROOTCTL === "exec" ? null : await viaService<T>(op, args, options);
  if (served) {
    if (!served.ok) throw new Refusal(served.error ?? "the root refused", served.fix ?? "", served.code ?? 1);
    return served.result as T;
  }
  const result = await backend().exec(ROOT_VM, [...NODE, `${guest.release}/root/rootctl.ts`], {
    input: JSON.stringify({ op, args }),
    inheritStderr: !options.quiet,
    timeoutMs: options.timeoutMs ?? 900_000,
  });
  const line = result.stdout.trim().split("\n").pop() ?? "";
  let reply: { ok: boolean; result?: T; error?: string; fix?: string; code?: number };
  try {
    reply = JSON.parse(line);
  } catch {
    throw new Refusal(`the root did not answer '${op}' (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(-400) || "no output"}`, "desolate doctor");
  }
  if (!reply.ok) throw new Refusal(reply.error ?? "the root refused", reply.fix ?? "", reply.code ?? 1);
  return reply.result as T;
};

export const ensureHome = () => {
  for (const dir of [paths.home, paths.mirrors, paths.rootClones, paths.domains, paths.state, paths.run, paths.logs]) fs.mkdirSync(dir, { recursive: true });
  // The home holds every repository's history and every domain's work: the user's alone.
  fs.chmodSync(paths.home, 0o700);
};

const proxyUsers = new Set<string>();
/** Have root make a domain's proxies' user and its two directories, if it has not (root/
 *  proxy-user.sh). Before anything starts the domain's proxies or writes its secrets. Root
 *  is asked through the host's own way in (never the root's ordinary user, which may run
 *  programs as these users and must not make them). */
export const ensureProxyUser = async (domain: string) => {
  if (proxyUsers.has(domain)) return;
  const result = await backend().exec(ROOT_VM, ["bash", `${guest.release}/root/proxy-user.sh`, String(process.getuid!()), domain], { root: true, timeoutMs: 60_000 });
  if (result.code !== 0) refuse(`the domain ${domain}'s proxies' user could not be made: ${(result.stderr || result.stdout).trim().slice(-300)}`, "desolate doctor");
  proxyUsers.add(domain);
};

/** The forge's address and host key, for the pusher: written by root in root's own
 *  directory (root/forge-pin.ts), through the host's own way in, never through the root's
 *  ordinary user (which could rewrite its own copy, and so aim a push elsewhere). */
export const pinForge = async (forge: unknown) => {
  const result = await backend().exec(ROOT_VM, [...NODE, `${guest.release}/root/forge-pin.ts`], { root: true, input: JSON.stringify(forge), timeoutMs: 60_000 });
  if (result.code !== 0) refuse(`the root could not pin the forge's address: ${(result.stdout || result.stderr).trim().slice(-300)}`, "desolate doctor");
};

/** Change a domain's secrets: as root in the root VM, through the host's own way in, with
 *  the request (a value among it) on stdin (root/proxy/secret-store.ts). Then the root's
 *  user, which never sees a value, starts or stops the domain's secrets proxy and tells its
 *  workspaces the names. Returns the names, hosts and switches. */
export const changeSecrets = async <T>(domain: string, op: "set" | "switch" | "remove", input: Record<string, unknown>): Promise<T> => {
  await ensureProxyUser(domain);
  const result = await backend().exec(ROOT_VM, [...NODE, `${guest.release}/root/proxy/secret-store.ts`, domain, op], { root: true, input: JSON.stringify(input), timeoutMs: 60_000 });
  let reply: { ok: boolean; error?: string; fix?: string };
  try {
    reply = JSON.parse(result.stdout.trim().split("\n").pop() ?? "");
  } catch {
    throw new Refusal(`the root did not change ${domain}'s secrets (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(-300)}`, "desolate doctor");
  }
  if (!reply.ok) throw new Refusal(reply.error ?? "the root refused", reply.fix ?? "");
  return rootctl<T>("secret.apply", { domain }, { quiet: true });
};
