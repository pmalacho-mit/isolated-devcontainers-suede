// What stands between a browser and this workspace's editor. v2's editor-gate.ts, with the
// editor's own hostname as an argument: in v3 each workspace's editor has a hostname of its
// own (section 4.5).
//
//   node editor-gate.ts <editor hostname> <listen port> <server port>
//
// The editor's server (codium-server) listens on this VM's loopback; so does this. The
// host's forwarder reaches only this, and only for connections that named this workspace's
// editor hostname. This passes on what a browser at the editor's own page would send, and
// nothing a page anywhere else could make it send.
//
// WHY (measured against this image's VSCodium server, in v2):
//   - `?tkn=` sets the cookie `vscode-tkn=<token>; SameSite=Lax`, not HttpOnly: the
//     workbench reads it. The cookie alone authenticates, and the WebSocket upgrade takes
//     any Origin. So whatever page can read the cookie, or make the browser send it, can
//     drive the editor: its terminals, every checkout in /workspaces.
//   - With the cookie, `/vscode-remote-resource?path=<any file>` serves that file with its
//     own type, AT THE EDITOR'S ORIGIN: an HTML file from a checkout, as a page.
//
//   Host            this workspace's editor hostname, at any port. Anything else is 421.
//   Sec-Fetch-Site  `same-origin`, `none` (typed, pasted, a bookmark), or absent (not a
//                   browser). A request another site, or another port, started is refused,
//                   WebSocket upgrades included. ONE exception: a top-level navigation to
//                   `/` that carries this editor's own token in its address. That is the
//                   dashboard's "Open editor" (another site: each *.localhost name is its
//                   own), and a page that does not know the token cannot make it. Without
//                   it, the one click the dashboard offers was refused (found on the M1,
//                   in a real browser; the test had only read the link).
//   Origin          absent, or the editor's own hostname.
//   a document      `vscode-remote-resource` opened as a page or in a frame is answered
//                   with `Content-Security-Policy: sandbox`: an opaque origin, which reads
//                   no cookie and sends none.
//
// WHERE IT RUNS, and why that is not a P5 problem: this guards the workspace's own editor
// against other pages in the person's browser. A workspace that broke its own gate would
// expose only itself. What separates workspaces from each other, which name reaches which
// VM, is the host's forwarder (host/daemon.ts), outside every VM.
import { createServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";

/** The hostname of a Host header or an Origin, lowercased; "" for none. */
export const hostnameOf = (value: string | undefined, isOrigin = false): string => {
  if (!value) return "";
  try {
    return new URL(isOrigin ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return "\0unparseable";
  }
};

const DOCUMENTS = new Set(["document", "iframe", "frame", "embed", "object", "fencedframe"]);

/** A top-level GET of the editor's page whose address carries this editor's token: what
 *  following the editor's own address (from the dashboard, or `desolate editor`) sends. */
export const openedWithToken = (request: { method?: string; url?: string; headers: IncomingMessage["headers"] }, token: string | null): boolean => {
  if (!token || request.method !== "GET" || request.headers["sec-fetch-mode"] !== "navigate" || request.headers["sec-fetch-dest"] !== "document") return false;
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://gate");
  } catch {
    return false;
  }
  const given = url.searchParams.get("tkn") ?? "";
  return url.pathname === "/" && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
};

/** Why this request may not reach the editor, or undefined when it may. `opened`: it is a
 *  navigation that carried the editor's token (openedWithToken). */
export const refusal = (editorHost: string, headers: IncomingMessage["headers"], opened = false): { status: number; why: string } | undefined => {
  if (hostnameOf(headers.host) !== editorHost) return { status: 421, why: `this is the editor of ${editorHost}; open it by that name (\`desolate editor\` prints the address)` };
  const site = String(headers["sec-fetch-site"] ?? "");
  if (site !== "" && site !== "same-origin" && site !== "none" && !opened) return { status: 403, why: `a request another site started (Sec-Fetch-Site: ${site.slice(0, 40)})` };
  if (headers.origin !== undefined && hostnameOf(String(headers.origin), true) !== editorHost) return { status: 403, why: `a request from another origin (${String(headers.origin).slice(0, 80).replace(/[^\x20-\x7e]/g, "?")})` };
  return undefined;
};

/** Does this response go out sandboxed? A remote resource opened as a page. */
export const sandboxes = (url: string | undefined, headers: IncomingMessage["headers"]) =>
  (url ?? "").split("?")[0]!.includes("/vscode-remote-resource") && DOCUMENTS.has(String(headers["sec-fetch-dest"] ?? ""));

const refuse = (res: ServerResponse, { status, why }: { status: number; why: string }) => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(`desolate editor-gate: refused ${why}\n`);
};

export const gate = (editorHost: string, serverPort: number, tokenFile?: string) => {
  const token = () => {
    try {
      const value = tokenFile ? fs.readFileSync(tokenFile, "utf8").trim() : "";
      return /^[0-9a-f]{32,128}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  };
  const server = createServer((req, res) => {
    const refused = refusal(editorHost, req.headers, openedWithToken(req, token()));
    if (refused) return refuse(res, refused);
    const upstream = request({ host: "127.0.0.1", port: serverPort, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      const headers = { ...answer.headers };
      if (sandboxes(req.url, req.headers)) {
        headers["content-security-policy"] = "sandbox";
        headers["x-content-type-options"] = "nosniff";
      }
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, headers);
      answer.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("desolate editor-gate: the editor did not answer\n");
    });
    req.pipe(upstream);
  });
  server.on("upgrade", (req: IncomingMessage, client: Socket, head: Buffer) => {
    const refused = refusal(editorHost, req.headers);
    if (refused) {
      client.end(`HTTP/1.1 ${refused.status} Refused\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\ndesolate editor-gate: refused ${refused.why}\n`);
      return;
    }
    const upstream = connect(serverPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    upstream.on("error", drop);
    client.on("error", drop);
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
  return server;
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [editorHost, listen, serverPort, tokenFile] = [process.argv[2] ?? "", Number(process.argv[3]), Number(process.argv[4]), process.argv[5]];
  if (!/^[a-z0-9-]+\.localhost$/.test(editorHost) || !Number.isInteger(listen) || !Number.isInteger(serverPort)) {
    console.error("usage: editor-gate.ts <editor hostname> <listen port> <server port> [<token file>]");
    process.exit(2);
  }
  gate(editorHost, serverPort, tokenFile).listen(listen, "127.0.0.1", () => console.log(`editor-gate: ${editorHost} on 127.0.0.1:${listen} -> 127.0.0.1:${serverPort}`));
}
