// Starting and stopping each workspace's proxy, and a domain's network rules.
import * as fs from "node:fs";
import { createServer } from "node:net";
import * as path from "node:path";
import { refuse } from "../../shared/exit.ts";
import { readJson, writeJson } from "../../shared/json.ts";
import { normalizeName } from "../../shared/sniff.ts";
import { ROOT } from "../layout.ts";
import { alive, PROXY_CODE, PROXY_OUT, spawnAsProxy, stopProxy } from "./as-proxy.ts";
import type { Policy } from "./proxy.ts";

const DIR = `${ROOT.state}/proxy`;
type Running = { port: number; pid: number; domain: string; workspace: string };
const file = (vm: string) => path.join(DIR, "running", `${vm}.json`);
const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

export const start = async (vm: string, domain: string, workspace: string): Promise<{ port: number }> => {
  if (!/^[a-z0-9-]{1,60}$/.test(vm)) throw new Error("not a VM name");
  const existing = readJson<Running | null>(file(vm), null);
  if (existing && alive(existing.pid)) return { port: existing.port };
  fs.mkdirSync(path.join(DIR, "running"), { recursive: true });
  let port = 0;
  for (let candidate = 21000; candidate < 22000 && port === 0; candidate++) if (await free(candidate)) port = candidate;
  if (port === 0) throw new Error("no free port for a proxy in the root");
  const log = fs.openSync(path.join(DIR, "proxy.log"), "a");
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const key of ["DESOLATE_ROOT_STATE", "DESOLATE_ROOT_DOMAINS", "DESOLATE_ROOT_SYS"]) if (process.env[key]) env[key] = process.env[key]!;
  const child = spawnAsProxy(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(PROXY_CODE, "root", "proxy", "proxy.ts"), String(port), domain, workspace], env, log);
  fs.closeSync(log);
  for (let waited = 0; (await free(port)) && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  writeJson(file(vm), { port, pid: child.pid, domain, workspace });
  return { port };
};

export const stop = (vm: string) => {
  const existing = readJson<Running | null>(file(vm), null);
  if (existing && alive(existing.pid)) stopProxy(existing.pid);
  fs.rmSync(file(vm), { force: true });
};

const policyFile = (domain: string) => path.join(DIR, "policy", `${domain}.json`);
export const policy = (domain: string): Policy => ({ mode: "open", hosts: [], internal: [], ...readJson<Partial<Policy>>(policyFile(domain), {}) });

export const setPolicy = (domain: string, change: { mode?: unknown; allow?: unknown; deny?: unknown; internal?: unknown }): Policy => {
  const next = policy(domain);
  if (change.mode !== undefined) {
    if (change.mode !== "open" && change.mode !== "enforce") refuse("a domain's network is 'open' or 'enforce'", `desolate domain ${domain} net enforce | open`);
    next.mode = change.mode;
  }
  const hosts = (value: unknown) => (Array.isArray(value) ? value : []).map((host) => {
    const text = String(host);
    const name = normalizeName(text.startsWith("*.") ? text.slice(2) : text);
    if (!name || text.includes(":")) refuse(`'${text}' is not a hostname or a *.wildcard`, "for example: api.example.com or *.example.com");
    return text.startsWith("*.") ? `*.${name}` : name!;
  });
  next.hosts = [...new Set([...next.hosts, ...hosts(change.allow)])].filter((host) => !hosts(change.deny).includes(host)).sort();
  for (const address of Array.isArray(change.internal) ? change.internal : []) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(address))) refuse(`'${String(address)}' is not an IPv4 address`, "name the one internal address this domain may reach");
    if (!next.internal.includes(String(address))) next.internal.push(String(address));
  }
  // Readable by the proxies' user, through the directory's group (root/start.sh).
  writeJson(policyFile(domain), next, 0o640);
  return next;
};

/** What the domain has been reaching, against its allowlist: v2's `proxy recommend`. With
 *  the network open, this is the list to allow before enforcing; enforced, it is what was
 *  refused for not being on the list. Only names: nothing here is acted on. */
export const recommend = (domain: string) => {
  const rules = policy(domain);
  const listed = (host: string) => rules.hosts.some((pattern) => (pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern));
  const reached = new Map<string, number>();
  const refused = new Map<string, number>();
  for (const entry of auditLog({ domain, last: 100_000 })) {
    const host = typeof entry.host === "string" ? normalizeName(entry.host) : null;
    if (!host || listed(host)) continue;
    if (entry.verdict === "allowed") reached.set(host, (reached.get(host) ?? 0) + 1);
    else if (entry.verdict === "refused" && /allowlist/.test(String(entry.reason ?? ""))) refused.set(host, (refused.get(host) ?? 0) + 1);
  }
  const rank = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([host, count]) => ({ host, count }));
  return { mode: rules.mode, listed: rules.hosts, reached: rank(reached), refused: rank(refused) };
};

export const auditLog = (filter: { domain?: string; last?: number }) => {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(path.join(PROXY_OUT, "audit.log"), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    /* nothing audited yet */
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => !filter.domain || entry.domain === filter.domain).slice(-(filter.last ?? 100));
};
