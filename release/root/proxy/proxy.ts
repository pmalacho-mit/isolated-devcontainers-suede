// A workspace's proxy (section 4.3). One instance per running workspace, in the root VM,
// reached only over that workspace's link. Which instance a connection arrives at is what
// attributes it: `domain=<d> workspace=<w>` comes from this process's arguments, never from
// anything the workspace says.
//
//   node proxy.ts <port> <domain> <workspace>
//
// It speaks one thing: `CONNECT <name>:<80|443>`. For each it
//   - refuses a destination that is not a hostname, or a port other than 80 and 443;
//   - applies the DOMAIN's network rules (open, or enforce an allowlist of hosts);
//   - resolves the name itself, outside the workspace, and refuses an internal address
//     (loopback, private, link-local, CGNAT, metadata) unless the domain was given that
//     address explicitly; then connects to the address it checked, not to the name again;
//   - audits the verdict.
//
// SECRETS (Phase 4): this process never sees one. A connection to port 443 of a host that
// one of the domain's secrets names is handed, after every check above, to the domain's
// secrets proxy (secrets.ts, secrets_addon.py), with the name and the ADDRESS checked here:
// that proxy terminates TLS for that name only, substitutes placeholders, and connects to
// that address, never resolving again. Every other connection stays end-to-end TLS between
// the workspace and the real server.
import { lookup } from "node:dns/promises";
import * as fs from "node:fs";
import { connect, createServer, isIP } from "node:net";
import type { Socket } from "node:net";
import { readJson } from "../../shared/json.ts";
import { normalizeName } from "../../shared/sniff.ts";
import { ROOT } from "../layout.ts";
import type { Running } from "./secrets.ts";

const [, , portArg, domain, workspace] = process.argv;
// Its own output is in proxy-out (as-proxy.ts): the only directory the proxies' user writes.
const AUDIT = `${ROOT.state}/proxy-out/audit.log`;
export type Policy = { mode: "open" | "enforce"; hosts: string[]; internal: string[] };
const policy = (): Policy => ({ mode: "open", hosts: [], internal: [], ...readJson<Partial<Policy>>(`${ROOT.state}/proxy/policy/${domain}.json`, {}) });

const audit = (entry: Record<string, unknown>) =>
  fs.appendFileSync(AUDIT, JSON.stringify({ time: new Date().toISOString(), domain, workspace, ...entry }) + "\n");

/** Addresses a workspace must never be carried to: this machine, the LAN, link-local,
 *  carrier NAT, cloud metadata, multicast, and anything that is not a public unicast IPv4. */
export const isInternal = (address: string): boolean => {
  if (isIP(address) !== 4) return true;
  const [a, b] = address.split(".").map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
};

/** `*.example.com` matches any depth below example.com, never example.com itself. */
export const hostAllowed = (host: string, patterns: string[]): boolean =>
  patterns.some((pattern) => (pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern));

const answer = (client: Socket, status: string, reason: string) =>
  client.end(`HTTP/1.1 ${status}\r\nX-Desolate-Reason: ${reason.replace(/[\r\n]/g, " ").slice(0, 300)}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);

const handle = async (client: Socket, head: string) => {
  const match = /^CONNECT (\S+) HTTP\/1\.[01]\r\n/.exec(head);
  const target = match?.[1] ?? "";
  const colon = target.lastIndexOf(":");
  const host = normalizeName(target.slice(0, colon));
  const port = Number(target.slice(colon + 1));
  const refuse = (reason: string) => {
    audit({ host: host ?? target.slice(0, 100), port, verdict: "refused", reason });
    answer(client, "403 Forbidden", reason);
  };
  if (!match || !host || isIP(host) !== 0) return refuse("a destination is a hostname: an address alone is not carried");
  if (port !== 80 && port !== 443) return refuse("only ports 80 and 443 leave a workspace");
  const rules = policy();
  if (rules.mode === "enforce" && !hostAllowed(host, rules.hosts)) return refuse(`${host} is not on the domain ${domain}'s allowlist`);
  let address: string;
  try {
    address = (await lookup(host, { family: 4 })).address;
  } catch {
    return refuse(`${host} does not resolve`);
  }
  if (isInternal(address) && !rules.internal.includes(address)) return refuse(`${host} resolves to an internal address (${address}), which a workspace is not carried to`);
  // A host one of the domain's secrets names goes through the domain's secrets proxy. If
  // that proxy is not running the connection is refused, not passed around it: a
  // placeholder must never reach such a host as if it were the value (P6).
  const secrets = port === 443 ? readJson<Running | null>(`${ROOT.state}/proxy/secrets/${domain}.json`, null) : null;
  const viaSecrets = secrets !== null && hostAllowed(host, secrets.hosts);
  // To the address that was checked: a second lookup could answer differently.
  const upstream = viaSecrets ? connect({ host: "127.0.0.1", port: secrets.port }) : connect({ host: address, port });
  let open = false;
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("timed out")));
  const established = () => {
    open = true;
    upstream.setTimeout(0);
    audit({ host, port, address, verdict: "allowed", ...(viaSecrets ? { via: "secrets" } : {}) });
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    client.pipe(upstream);
    upstream.pipe(client);
  };
  upstream.on("connect", () => {
    if (!viaSecrets) return established();
    // The tunnel into the secrets proxy: the checked address as the destination, and what
    // this process knows about the connection in headers the workspace cannot set (its own
    // bytes begin after this exchange).
    upstream.write(`CONNECT ${address}:443 HTTP/1.1\r\nHost: ${address}:443\r\nX-Desolate-Workspace: ${workspace}\r\nX-Desolate-Host: ${host}\r\n\r\n`);
    let reply = "";
    const onReply = (chunk: Buffer) => {
      reply += chunk.toString("latin1");
      if (!reply.includes("\r\n\r\n") && reply.length < 8192) return;
      upstream.off("data", onReply);
      if (!/^HTTP\/1\.[01] 200/.test(reply)) return refuse(`the domain's secrets proxy refused the connection to ${host}`);
      established();
    };
    upstream.on("data", onReply);
  });
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  upstream.on("error", (error) => (open ? close() : refuse(viaSecrets ? `${host} is a host of one of this domain's secrets, and the domain's secrets proxy is not running (${error.message})` : `could not connect to ${host}: ${error.message}`)));
  upstream.on("close", close);
  client.on("close", close);
};

if (portArg) {
  fs.mkdirSync(`${ROOT.state}/proxy-out`, { recursive: true });
  createServer((client) => {
    client.on("error", () => client.destroy());
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (head.length > 8192) return client.destroy();
      if (!head.includes("\r\n\r\n")) return;
      client.off("data", onData);
      void handle(client, head);
    };
    client.on("data", onData);
    // Loopback in the root VM only: the host daemon dials it over the VM layer, for the one
    // workspace whose link it is.
  }).listen(Number(portArg), "127.0.0.1");
}
