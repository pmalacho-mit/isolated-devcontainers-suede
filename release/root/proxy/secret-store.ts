// A domain's secret values, kept by root and read only by that domain's proxies.
//
//   node secret-store.ts <domain> set|switch|remove|import|copy (as root; the request on stdin)
//
// The host runs this as root in the root VM, through its own way in (never the root's
// ordinary user), with a secret's value on stdin. It writes two files, both root's:
//
//   /var/lib/desolate-proxies/secrets/<domain>.json        the values. Group: the domain's
//                                                           proxies (root/proxy-user.sh), 0640
//   /var/lib/desolate-proxies/secrets/<domain>.index.json  names, hosts, headers, switches:
//                                                           no value. 0644, for the root's user
//
// Why not the root's ordinary user, as before: it runs everything in the root VM that parses
// what a domain sends (git on agent-written packs, outbox files, the dashboard). A bug in any
// of those read every domain's secret values (the independent audit's F6 on the M1). Now
// that user holds names; the values are root's to write and the domain's proxies' to read.
//
// What it prints is the index (as `list` in secrets.ts would): never a value.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Refusal, refuse } from "../../shared/exit.ts";
import { normalizeName } from "../../shared/sniff.ts";
import { ROOT } from "../layout.ts";
import { proxyUserOf } from "./as-proxy.ts";

/** `off`: switched off until switched on. `until` (seconds since the epoch): on until then. */
export type Secret = { value: string; hosts: string[]; headers?: string[]; off?: boolean; until?: number };
export type Store = { domain: string; secrets: Record<string, Secret> };
export type Indexed = Omit<Secret, "value"> & { name: string };

export const SECRETS_DIR = `${ROOT.proxies}/secrets`;
export const storeFile = (domain: string) => path.join(SECRETS_DIR, `${domain}.json`);
export const indexFile = (domain: string) => path.join(SECRETS_DIR, `${domain}.index.json`);

const NAME = /^[A-Z][A-Z0-9_-]{7,63}$/;
const HEADER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

const hostPattern = (text: string): string => {
  const wildcard = text.startsWith("*.");
  const name = normalizeName(wildcard ? text.slice(2) : text);
  // `*.name.tld` and deeper only: `*.com` is a whole TLD, and `*foo.com` also matches evilfoo.com.
  if (!name || text.includes(":") || /[*?[\]]/.test(wildcard ? text.slice(2) : text) || (wildcard && name.split(".").length < 2))
    refuse(`'${text}' does not pin a destination`, "name the hosts the secret may be sent to: api.example.com, or *.example.com");
  return wildcard ? `*.${name}` : name!;
};

/** The change a request asks for, applied to a store; refuses what v2 and v3 always did. */
export const change = (store: Store, domain: string, op: string, input: Record<string, unknown>): Store => {
  const next: Store = { domain, secrets: { ...store.secrets } };
  const name = String(input.name ?? "");
  if (op === "set") {
    const usage = `desolate domain ${domain} secret set <NAME> --hosts <host>[,<host>...] [--headers <header>[,...]]   (the value on stdin)`;
    if (!NAME.test(name)) refuse(`'${name}' is not a placeholder name`, "8 to 64 of A-Z, 0-9, _ and -, starting with a letter: for example MYAPP-OPENAI-KEY. It is what workspaces send in place of the value");
    const value = typeof input.value === "string" ? input.value.replace(/\r?\n$/, "") : "";
    if (!value || /[\r\n]/.test(value)) refuse("a secret's value is one line, and not empty", usage);
    if (value.includes(name) || name.includes(value)) refuse("the value and its placeholder overlap", "choose another name");
    const hosts = (Array.isArray(input.hosts) ? input.hosts : []).map((host) => hostPattern(String(host)));
    if (hosts.length === 0) refuse("a secret names the hosts it may be sent to: with none it would have no allowlist", usage);
    const headers = Array.isArray(input.headers) && input.headers.length > 0 ? input.headers.map((header) => String(header).toLowerCase()) : undefined;
    for (const header of headers ?? []) if (!HEADER.test(header)) refuse(`'${header}' is not a header name`, usage);
    for (const other of Object.keys(next.secrets))
      if (other !== name && (other.includes(name) || name.includes(other))) refuse(`${name} and ${other} overlap (one contains the other), so neither could be substituted unambiguously`, "choose a name that does not contain, and is not contained in, another secret's");
    next.secrets[name] = { value, hosts: [...new Set(hosts)].sort(), ...(headers ? { headers: [...new Set(headers)].sort() } : {}) };
  } else if (op === "switch") {
    const secret = next.secrets[name] ? { ...next.secrets[name]! } : null;
    if (!secret) refuse(`the domain ${domain} has no secret named ${name}`, `desolate domain ${domain} secret list`);
    delete secret!.off;
    delete secret!.until;
    if (input.on !== true) secret!.off = true;
    else if (input.ttlSeconds !== undefined) {
      const ttl = Number(input.ttlSeconds);
      if (!Number.isFinite(ttl) || ttl < 1 || ttl > 366 * 86400) refuse("a time to live is between a second and a year", `desolate domain ${domain} secret on ${name} --ttl 30m`);
      secret!.until = Math.floor(Date.now() / 1000 + ttl);
    }
    next.secrets[name] = secret!;
  } else if (op === "remove") {
    delete next.secrets[name];
  } else if (op !== "import") refuse(`'${op}' is not a change to a domain's secrets`, "set, switch, remove");
  return next;
};

export const indexOf = (store: Store): Indexed[] =>
  Object.entries(store.secrets).map(([name, { value: _value, ...rest }]) => ({ name, ...rest })).sort((a, b) => a.name.localeCompare(b.name));

/** Write a root-owned file atomically, with this group and mode. */
const writeRoot = (file: string, text: string, gid: number, mode: number) => {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, text, { mode });
  fs.chownSync(temp, 0, gid);
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, file);
};

const main = async () => {
  const [domain, op] = process.argv.slice(2);
  if (process.getuid!() !== 0) refuse("secret-store.ts runs as root, from the host's own way in", "desolate domain <d> secret ...");
  if (!domain || !SLUG.test(domain)) refuse(`'${domain ?? ""}' is not a domain`, "desolate domain <d> secret ...");
  const group = spawnSync("id", ["-g", proxyUserOf(domain!)], { encoding: "utf8" });
  if (group.status !== 0) refuse(`the domain ${domain} has no proxies' user yet`, "desolate bootstrap");
  const gid = Number(group.stdout.trim());
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text || "{}") as Record<string, unknown>;
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o755 });
  fs.chownSync(SECRETS_DIR, 0, 0);
  fs.chmodSync(SECRETS_DIR, 0o755);
  let current: Store = { domain: domain!, secrets: {} };
  try {
    current = JSON.parse(fs.readFileSync(storeFile(domain!), "utf8")) as Store;
  } catch {
    /* none yet */
  }
  // `copy`: another domain's secret, value and all, without the value leaving root (one
  // subscription token for every domain, set once). Then checked like any set.
  if (op === "copy") {
    const from = String(input.from ?? "");
    if (!SLUG.test(from) || from === domain) refuse(`'${from}' is not another domain`, `desolate domain ${domain} secret copy <NAME> --from <domain>`);
    let source: Store | null = null;
    try {
      source = JSON.parse(fs.readFileSync(storeFile(from), "utf8")) as Store;
    } catch {
      source = null;
    }
    const secret = source?.secrets[String(input.name ?? "")];
    if (!secret) refuse(`the domain ${from} has no secret named ${String(input.name ?? "")}`, `desolate domain ${from} secret list`);
    const copied = change(current, domain!, "set", { name: input.name, value: secret!.value, hosts: secret!.hosts, headers: secret!.headers });
    writeRoot(storeFile(domain!), JSON.stringify(copied, null, 2) + "\n", gid, 0o640);
    writeRoot(indexFile(domain!), JSON.stringify(indexOf(copied), null, 2) + "\n", 0, 0o644);
    process.stdout.write(JSON.stringify({ ok: true, result: indexOf(copied) }) + "\n");
    return;
  }
  // `import`: a store kept by an older desolate, as the data it is (root/start.sh hands it
  // over, read by the user who could read it), checked like any set.
  let next = change(current, domain!, op!, input);
  if (op === "import" && typeof input.secrets === "object" && input.secrets !== null)
    for (const [name, s] of Object.entries(input.secrets as Record<string, Secret>)) {
      next = change(next, domain!, "set", { name, value: s.value, hosts: s.hosts, headers: s.headers });
      if (s.off === true || typeof s.until === "number") next.secrets[name] = { ...next.secrets[name]!, ...(s.off === true ? { off: true } : {}), ...(typeof s.until === "number" ? { until: s.until } : {}) };
    }
  writeRoot(storeFile(domain!), JSON.stringify(next, null, 2) + "\n", gid, 0o640);
  writeRoot(indexFile(domain!), JSON.stringify(indexOf(next), null, 2) + "\n", 0, 0o644);
  process.stdout.write(JSON.stringify({ ok: true, result: indexOf(next) }) + "\n");
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname)
  main().catch((error) => {
    const refusal = error instanceof Refusal ? error : null;
    process.stdout.write(JSON.stringify({ ok: false, error: refusal ? refusal.message : (error as Error).message, fix: refusal?.fix ?? "" }) + "\n");
    process.exit(1);
  });
