// The egress relay in a workspace VM. It makes the proxy transparent to programs: they need
// no proxy settings, because every outbound connection to port 80 or 443 is redirected here
// (net/up.sh), and this reads the host the connection wants from its TLS SNI or HTTP Host
// and asks the workspace's proxy for it over the link.
//
// THIS IS NOT A BOUNDARY, and nothing depends on it being honest. It runs inside the VM, where
// an agent may be root: stop it, replace it, or speak to the link directly, and the proxy on
// the other end still decides what this workspace reaches. With no link there is no way out
// at all: that is the backend's doing, outside the VM (P5).
//
//   node egress.ts <link>      link: unix:/path  or  tcp:host:port
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import { sniffSocket } from "../../shared/sniff.ts";

const link = process.argv[2] ?? "";
const dial = (): Socket => {
  if (link.startsWith("unix:")) return connect(link.slice(5));
  const match = /^tcp:([0-9.]+):(\d+)$/.exec(link);
  if (!match) throw new Error(`egress: '${link}' is not a link address`);
  return connect(Number(match[2]), match[1]);
};

const refuse = (client: Socket, http: boolean, status: string, text: string) => {
  if (!http) return client.destroy();
  const body = `desolate: ${text}\n`;
  client.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};

const serve = (port: number, scheme: "http" | "https") =>
  createServer(async (client) => {
    client.on("error", () => client.destroy());
    const { sniffed, head } = await sniffSocket(client, 5000);
    const http = sniffed.kind === "http";
    if ((sniffed.kind !== "http" && sniffed.kind !== "tls") || !sniffed.name)
      return refuse(client, http, "403 Forbidden", "this connection names no host (no TLS server name, no Host header). Only named HTTP and TLS leave a workspace; an address alone does not.");
    const target = `${sniffed.name}:${scheme === "https" ? 443 : 80}`;
    let upstream: Socket;
    try {
      upstream = dial();
    } catch {
      return refuse(client, http, "502 Bad Gateway", "this workspace has no link to its proxy.");
    }
    let answer = Buffer.alloc(0);
    let open = false;
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    upstream.on("error", () => (open ? close() : refuse(client, http, "502 Bad Gateway", "this workspace's proxy is not answering. On the host: desolate doctor")));
    upstream.on("close", close);
    client.on("close", close);
    upstream.on("connect", () => upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    const onAnswer = (chunk: Buffer) => {
      answer = Buffer.concat([answer, chunk]);
      const end = answer.indexOf("\r\n\r\n");
      if (end < 0) return answer.length > 16384 ? close() : undefined;
      upstream.off("data", onAnswer);
      const status = answer.subarray(0, answer.indexOf("\r\n")).toString("latin1");
      if (!/^HTTP\/1\.[01] 200 /.test(status)) {
        // The proxy's refusal, with its reason, reaches a plain-HTTP client as text.
        const reason = /\r\nX-Desolate-Reason: ([^\r\n]{0,300})/i.exec(answer.subarray(0, end).toString("latin1"))?.[1] ?? "the proxy refused this destination";
        upstream.destroy();
        return refuse(client, http, "403 Forbidden", reason);
      }
      open = true;
      const rest = answer.subarray(end + 4);
      if (rest.length > 0) client.write(rest);
      upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    };
    upstream.on("data", onAnswer);
  }).listen(port, "0.0.0.0");

serve(15080, "http");
serve(15443, "https");
