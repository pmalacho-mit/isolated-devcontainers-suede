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
// WHAT THIS DOES NOT DO YET (Phase 4): it does not terminate TLS, so it cannot substitute a
// secret's placeholder in a header. TLS runs end to end between the workspace and the real
// server. v2's addon.py (carryover/proxy/addon.py) is the piece that does substitution; it
// takes this process's place behind the same CONNECT interface.
import { lookup } from "node:dns/promises";
import * as fs from "node:fs";
import { connect, createServer, isIP } from "node:net";
import type { Socket } from "node:net";
import { readJson } from "../../shared/json.ts";
import { normalizeName } from "../../shared/sniff.ts";
import { ROOT } from "../layout.ts";

const [, , portArg, domain, workspace] = process.argv;
const AUDIT = `${ROOT.state}/proxy/audit.log`;
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
  // To the address that was checked: a second lookup could answer differently.
  const upstream = connect({ host: address, port });
  let open = false;
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("timed out")));
  upstream.on("connect", () => {
    open = true;
    upstream.setTimeout(0);
    audit({ host, port, address, verdict: "allowed" });
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    client.pipe(upstream);
    upstream.pipe(client);
  });
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  upstream.on("error", (error) => (open ? close() : refuse(`could not connect to ${host}: ${error.message}`)));
  upstream.on("close", close);
  client.on("close", close);
};

if (portArg) {
  fs.mkdirSync(`${ROOT.state}/proxy`, { recursive: true });
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
