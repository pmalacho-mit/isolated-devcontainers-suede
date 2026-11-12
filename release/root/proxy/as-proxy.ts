// Each domain's proxies run as a user of that domain's own (dsp-<hash>), not as the root's
// ordinary user, and not as one user for every domain.
//
// They are what parses everything a workspace sends: proxy.ts reads its CONNECTs and TLS
// ClientHellos, mitmproxy whole HTTP exchanges for a secret's hosts. A bug there should
// reach what that domain's proxies need and nothing else: the domain's policy, its secret
// values and its handoff token (read, through the domain's proxies' group, in
// proxy-domains/<domain>), and their own output (proxy-out/<domain>). Not another domain's
// secrets, and not another domain's secrets proxy (it takes a connection only with its own
// domain's token). Not the keyring's sockets (no proxies' user is in the root user's group),
// so not the read keys; not the shares (/desolate is closed to them: root/start.sh).
//
// The users and their directories are made by root (root/proxy-user.sh, which the host runs
// when a domain's proxies are first wanted). The root's user starts and stops proxies as
// them through one sudoers rule (`<user> ALL=(%desolate-proxies) NOPASSWD: ALL`): safe in
// that direction, since the root's user already holds everything any of them can reach.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { ROOT } from "../layout.ts";

/** A domain's proxies' user: what root/proxy-user.sh makes for it. */
export const proxyUserOf = (domain: string) => `dsp-${createHash("sha256").update(domain).digest("hex").slice(0, 10)}`;
/** The domain's directory of what its proxies read: policy, secrets, token, the secrets
 *  proxy's port. The root's user writes it; the domain's proxies read it. */
export const proxyDomainDir = (domain: string) => `${ROOT.proxies}/domains/${domain}`;
/** Where the proxies' code is for them: a root-owned copy root/start.sh makes. /desolate,
 *  where the release is shared, is closed to them (on vz any user that reaches a share can
 *  write it; start.sh). Outside the root VM (tests on the host), the release itself. */
export const PROXY_CODE = process.env.DESOLATE_PROXY_CODE ?? "/opt/desolate/proxy-code";
/** What a domain's proxies write: theirs, readable by the root's user. */
export const proxyOutDir = (domain: string) => `${ROOT.proxies}/out/${domain}`;

/** `command` as the proxies' user, with exactly `env` (sudo resets the rest), detached, its
 *  output to `log`. The pid is sudo's, which waits for the command and ends with it. */
export const spawnAsProxy = (domain: string, command: string, args: string[], env: Record<string, string>, log: number): ChildProcess => {
  const vars = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  const child = spawn("sudo", ["-n", "-u", proxyUserOf(domain), "--", "env", "-i", ...vars, command, ...args], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  return child;
};

/** Whether a proxy started by spawnAsProxy is still there: sudo runs as root, so asking
 *  it is refused (EPERM) while it lives. */
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Stop a proxy started by spawnAsProxy: the command (sudo's child) is the proxies' user's
 *  to signal, and sudo ends with it. */
export const stopProxy = (domain: string, pid: number) => {
  if (!Number.isInteger(pid) || pid < 2) return;
  spawnSync("sudo", ["-n", "-u", proxyUserOf(domain), "pkill", "-TERM", "-P", String(pid)], { stdio: "ignore", timeout: 10_000 });
};

/** Whether root has made this domain's proxies' user (root/proxy-user.sh). */
export const hasProxyUser = (domain: string) => spawnSync("id", ["-u", proxyUserOf(domain)], { stdio: "ignore" }).status === 0;

/** The token a workspace's proxy shows its domain's secrets proxy: made once, in the
 *  domain's directory (its proxies' to read, nobody else's). */
export const linkTokenFile = (domain: string) => `${proxyDomainDir(domain)}/link-token`;
export const ensureLinkToken = (domain: string) => {
  const file = linkTokenFile(domain);
  try {
    if (/^[0-9a-f]{64}$/.test(fs.readFileSync(file, "utf8").trim())) return;
  } catch {
    /* none yet */
  }
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, randomBytes(32).toString("hex") + "\n", { mode: 0o640 });
  fs.renameSync(temp, file);
};

/** The uid that owns the socket listening on 127.0.0.1:<port> in this VM, from the kernel's
 *  own table; null if none. A port is anyone's to take first: a secrets proxy is believed to
 *  be on its port only if its domain's proxies' user is what listens there (an audit on the
 *  M1 found the race: another domain's proxies binding the port before mitmproxy did). */
export const listenerUid = (port: number): number | null => {
  let table = "";
  try {
    table = fs.readFileSync("/proc/net/tcp", "utf8");
  } catch {
    return null;
  }
  const want = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  for (const row of table.split("\n").slice(1)) {
    const cols = row.trim().split(/\s+/);
    if (cols[1] === want && cols[3] === "0A") return Number(cols[7]);
  }
  return null;
};
/** The uid of a domain's proxies' user; null if root has not made it. */
export const proxyUid = (domain: string): number | null => {
  const found = spawnSync("id", ["-u", proxyUserOf(domain)], { encoding: "utf8" });
  return found.status === 0 ? Number(found.stdout.trim()) : null;
};
