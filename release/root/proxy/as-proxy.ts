// The proxies run as a user of their own (desolate-proxy), not as the root's ordinary user.
//
// They are what parses everything a workspace sends: proxy.ts reads its CONNECTs and TLS
// ClientHellos, mitmproxy whole HTTP exchanges for a secret's hosts. A bug there should
// reach what a proxy needs and nothing else: the domains' policies and secret values (read,
// through the group desolate-proxy) and its own output (proxy-out/: the audit log, each
// domain's CA). Not the keyring's sockets (it is not in the root user's group), so not the
// read keys; not the root clones, the mirrors or the registry.
//
// The root's user starts and stops them through sudo, by the one rule root/start.sh writes
// (`<user> ALL=(desolate-proxy) NOPASSWD: ALL`). That direction is safe: the root's user
// already holds everything the proxies' user can reach. The other direction is what this
// separation is for.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { ROOT } from "../layout.ts";

export const PROXY_USER = "desolate-proxy";
/** Where the proxies' code is for them: a root-owned copy root/start.sh makes. /desolate,
 *  where the release is shared, is closed to them (on vz any user that reaches a share can
 *  write it; start.sh). Outside the root VM (tests on the host), the release itself. */
export const PROXY_CODE = process.env.DESOLATE_PROXY_CODE ?? "/opt/desolate/proxy-code";
/** What the proxies write: theirs, readable by the root's user. */
export const PROXY_OUT = `${ROOT.state}/proxy-out`;

/** `command` as the proxies' user, with exactly `env` (sudo resets the rest), detached, its
 *  output to `log`. The pid is sudo's, which waits for the command and ends with it. */
export const spawnAsProxy = (command: string, args: string[], env: Record<string, string>, log: number): ChildProcess => {
  const vars = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  const child = spawn("sudo", ["-n", "-u", PROXY_USER, "--", "env", "-i", ...vars, command, ...args], { detached: true, stdio: ["ignore", log, log] });
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
export const stopProxy = (pid: number) => {
  if (!Number.isInteger(pid) || pid < 2) return;
  spawnSync("sudo", ["-n", "-u", PROXY_USER, "pkill", "-TERM", "-P", String(pid)], { stdio: "ignore", timeout: 10_000 });
};
