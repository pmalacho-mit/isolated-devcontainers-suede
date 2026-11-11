// A domain's secrets (section 4.3, Phase 4): where they are kept, and the one process that
// can use them.
//
// A secret's VALUE lives here, in the root, in a file only the root's user reads. A
// workspace holds the secret's NAME, a placeholder it sends in place of the value. The
// domain's secrets proxy (mitmproxy with secrets_addon.py, one per domain that has any)
// swaps name for value on the way out, for the hosts the secret names and no others.
// Workspaces reach it only through their own proxy (proxy.ts), and only for those hosts;
// everything else they send stays end-to-end TLS.
//
// What a workspace is given, in its inbox (which it cannot write): the names, hosts and
// headers of its domain's secrets (never a value), and the CA its secrets proxy signs with,
// which it must trust for those hosts to work.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:net";
import * as path from "node:path";
import { refuse } from "../../shared/exit.ts";
import { readJson, writeJson } from "../../shared/json.ts";
import { normalizeName } from "../../shared/sniff.ts";
import { ROOT } from "../layout.ts";
import { inbox } from "../outbox.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIR = `${ROOT.state}/proxy`;
const MITMDUMP = "/opt/desolate/proxy-venv/bin/mitmdump";
/** `off`: switched off until someone switches it on. `until` (seconds since the epoch): on
 *  until then, off after: `secret on NAME --ttl 30m`. Neither: on. (v2's switch.) */
type Secret = { value: string; hosts: string[]; headers?: string[]; off?: boolean; until?: number };
type Store = { domain: string; secrets: Record<string, Secret> };
export type Running = { port: number; pid: number; hosts: string[] };

const storeFile = (domain: string) => `${ROOT.state}/secrets/${domain}.json`;
export const runningFile = (domain: string) => path.join(DIR, "secrets", `${domain}.json`);
const confdir = (domain: string) => path.join(DIR, "secrets", domain);
const store = (domain: string): Store => readJson<Store>(storeFile(domain), { domain, secrets: {} });

const NAME = /^[A-Z][A-Z0-9_-]{7,63}$/;
const HEADER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

/** What the domain's workspaces may know: names, hosts, headers. Never a value. */
export const list = (domain: string) =>
  Object.entries(store(domain).secrets).map(([name, s]) => {
    const now = Date.now() / 1000;
    const on = s.off !== true && (s.until === undefined || now < s.until);
    return { name, hosts: s.hosts, headers: s.headers ?? null, on, ...(on && s.until !== undefined ? { secondsLeft: Math.max(0, Math.round(s.until - now)) } : {}) };
  }).sort((a, b) => a.name.localeCompare(b.name));

const publish = (domain: string) => {
  // For the workspaces: the switch as stored (`off`, `until`), not "on right now", which
  // would go stale in a file when a time to live ran out.
  writeJson(path.join(inbox(domain), "secrets.json"), Object.entries(store(domain).secrets).map(([name, s]) => ({ name, hosts: s.hosts, headers: s.headers ?? null, ...(s.off ? { off: true } : {}), ...(s.until !== undefined ? { until: s.until } : {}) })).sort((a, b) => a.name.localeCompare(b.name)));
  const ca = path.join(confdir(domain), "mitmproxy-ca-cert.pem");
  if (fs.existsSync(ca)) fs.copyFileSync(ca, path.join(inbox(domain), "ca.pem"));
};

/** The domain's secrets proxy: running if the domain has a secret, stopped if it has none. */
export const ensure = async (domain: string): Promise<Running | null> => {
  const hosts = [...new Set(Object.values(store(domain).secrets).flatMap((s) => s.hosts))].sort();
  const existing = readJson<Running | null>(runningFile(domain), null);
  if (hosts.length === 0) {
    if (existing && alive(existing.pid) && !(await free(existing.port))) process.kill(existing.pid);
    fs.rmSync(runningFile(domain), { force: true });
    publish(domain);
    return null;
  }
  // Alive means listening: a process that was killed can linger as a pid (unreaped) and
  // answer nothing.
  if (existing && alive(existing.pid) && !(await free(existing.port))) {
    // The addon reloads the store by itself; the hosts are what proxy.ts routes by.
    if (existing.hosts.join() !== hosts.join()) writeJson(runningFile(domain), { ...existing, hosts }, 0o600);
    publish(domain);
    return { ...existing, hosts };
  }
  if (!fs.existsSync(MITMDUMP)) refuse("this image has no mitmproxy, so secrets cannot be substituted", "rebuild the base image (release/image/build.sh)");
  fs.mkdirSync(confdir(domain), { recursive: true, mode: 0o700 });
  let port = 0;
  for (let candidate = 22000; candidate < 23000 && port === 0; candidate++) if (await free(candidate)) port = candidate;
  if (port === 0) throw new Error("no free port for a secrets proxy in the root");
  const log = fs.openSync(path.join(DIR, "secrets", `${domain}.log`), "a");
  const child = spawn(MITMDUMP, [
    "--mode", "regular", "--listen-host", "127.0.0.1", "--listen-port", String(port),
    "--set", `confdir=${confdir(domain)}`,
    // Upstream certificates are checked against this VM's own trust store.
    "--set", "ssl_verify_upstream_trusted_ca=/etc/ssl/certs/ca-certificates.crt",
    "--set", "flow_detail=0", "--set", "termlog_verbosity=warn",
    "-s", path.join(HERE, "secrets_addon.py"),
  ], {
    detached: true, stdio: ["ignore", log, log],
    env: { PATH: process.env.PATH ?? "", HOME: confdir(domain), DESOLATE_SECRETS: storeFile(domain), DESOLATE_POLICY: `${DIR}/policy/${domain}.json`, DESOLATE_AUDIT: `${DIR}/audit.log` },
  });
  child.unref();
  const ca = path.join(confdir(domain), "mitmproxy-ca-cert.pem");
  for (let waited = 0; waited < 180_000 && ((await free(port)) || !fs.existsSync(ca)); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  if ((await free(port)) || !fs.existsSync(ca)) throw new Error(`the secrets proxy for ${domain} did not start; see ${DIR}/secrets/${domain}.log`);
  const running = { port, pid: child.pid!, hosts };
  writeJson(runningFile(domain), running, 0o600);
  publish(domain);
  return running;
};

const hostPattern = (text: string): string => {
  const wildcard = text.startsWith("*.");
  const name = normalizeName(wildcard ? text.slice(2) : text);
  // `*.name.tld` and deeper only: `*.com` is a whole TLD, and `*foo.com` also matches evilfoo.com.
  if (!name || text.includes(":") || /[*?[\]]/.test(wildcard ? text.slice(2) : text) || (wildcard && name.split(".").length < 2))
    refuse(`'${text}' does not pin a destination`, "name the hosts the secret may be sent to: api.example.com, or *.example.com");
  return wildcard ? `*.${name}` : name!;
};

export const set = async (domain: string, input: { name?: unknown; value?: unknown; hosts?: unknown; headers?: unknown }) => {
  const usage = `desolate domain ${domain} secret set <NAME> --hosts <host>[,<host>...] [--headers <header>[,...]]   (the value on stdin)`;
  const name = String(input.name ?? "");
  if (!NAME.test(name)) refuse(`'${name}' is not a placeholder name`, "8 to 64 of A-Z, 0-9, _ and -, starting with a letter: for example MYAPP-OPENAI-KEY. It is what workspaces send in place of the value");
  const value = typeof input.value === "string" ? input.value.replace(/\r?\n$/, "") : "";
  if (!value || /[\r\n]/.test(value)) refuse("a secret's value is one line, and not empty", usage);
  if (value.includes(name) || name.includes(value)) refuse("the value and its placeholder overlap", "choose another name");
  const hosts = (Array.isArray(input.hosts) ? input.hosts : []).map((host) => hostPattern(String(host)));
  if (hosts.length === 0) refuse("a secret names the hosts it may be sent to: with none it would have no allowlist", usage);
  const headers = Array.isArray(input.headers) && input.headers.length > 0 ? input.headers.map((header) => String(header).toLowerCase()) : undefined;
  for (const header of headers ?? []) if (!HEADER.test(header)) refuse(`'${header}' is not a header name`, usage);
  const next = store(domain);
  for (const other of Object.keys(next.secrets))
    if (other !== name && (other.includes(name) || name.includes(other))) refuse(`${name} and ${other} overlap (one contains the other), so neither could be substituted unambiguously`, "choose a name that does not contain, and is not contained in, another secret's");
  next.domain = domain;
  next.secrets[name] = { value, hosts: [...new Set(hosts)].sort(), ...(headers ? { headers: [...new Set(headers)].sort() } : {}) };
  fs.mkdirSync(path.dirname(storeFile(domain)), { recursive: true, mode: 0o700 });
  writeJson(storeFile(domain), next, 0o600);
  await ensure(domain);
  return list(domain).find((s) => s.name === name)!;
};

/** Switch a secret off, or on (for good, or for a while). Off, its value goes nowhere and a
 *  request that carries its name toward its hosts is refused: the name is never sent in
 *  the value's place. The addon reads the store again by itself. */
export const switchSecret = async (domain: string, input: { name?: unknown; on?: unknown; ttlSeconds?: unknown }) => {
  const next = store(domain);
  const name = String(input.name ?? "");
  const secret = next.secrets[name];
  if (!secret) refuse(`the domain ${domain} has no secret named ${name}`, `desolate domain ${domain} secret list`);
  delete secret!.off;
  delete secret!.until;
  if (input.on !== true) secret!.off = true;
  else if (input.ttlSeconds !== undefined) {
    const ttl = Number(input.ttlSeconds);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 366 * 86400) refuse("a time to live is between a second and a year", `desolate domain ${domain} secret on ${name} --ttl 30m`);
    secret!.until = Math.floor(Date.now() / 1000 + ttl);
  }
  writeJson(storeFile(domain), next, 0o600);
  await ensure(domain);
  return list(domain).find((s) => s.name === name)!;
};

export const remove = async (domain: string, name: unknown) => {
  const next = store(domain);
  const existed = typeof name === "string" && name in next.secrets;
  if (existed) {
    delete next.secrets[name as string];
    writeJson(storeFile(domain), next, 0o600);
  }
  await ensure(domain);
  return { existed };
};
