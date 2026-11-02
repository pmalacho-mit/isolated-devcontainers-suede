/**
 * editor-gate.ts -- what stands between a browser and the outer editor.
 *
 *   node editor-gate.ts <listen port> <server port>
 *
 * The outer editor's server listens on the container's loopback; this listens
 * where compose publishes it, and passes on what a browser at the editor's own
 * page would send, and nothing a page anywhere else could make it send.
 *
 * WHY (measured against this image's VSCodium server)
 *
 *   - `?tkn=` sets `vscode-tkn=<token>; SameSite=Lax`, not HttpOnly: the
 *     workbench reads it from document.cookie, so it cannot be. The cookie
 *     alone authenticates, and the WebSocket upgrade takes any Origin -- the
 *     token is checked inside the protocol. So whatever page can read the
 *     cookie can drive the editor: its terminals, the keyring's agent socket,
 *     every project in /workspaces.
 *   - With the cookie, `/vscode-remote-resource?path=<any file>` serves that
 *     file with its own type: `/workspaces/<project>/x.html` as text/html, AT
 *     THE EDITOR'S ORIGIN. And a Lax cookie goes with a top-level navigation
 *     from any site. So a page a project serves -- its dev server, which
 *     `desolate` tells you to open -- could send the browser to a page the
 *     project wrote, running as the editor, reading the token.
 *
 * hosts.ts gives the editor a host no project can serve a page under (the
 * ingress holds every forwarded port to its own target's), which keeps the
 * cookie out of every other page's reach. This keeps every other page's
 * requests out of the editor's:
 *
 *   Host            `desolate.localhost` (hosts.ts EDITOR_HOST), at any port.
 *                   127.0.0.1 is refused with the address to use: a cookie set
 *                   there is in the jar every forward used to share.
 *   Sec-Fetch-Site  `same-origin`, `none` (typed, pasted, a bookmark), or
 *                   absent (not a browser -- with no cookie, nothing). A
 *                   request another site, or another port, started is refused
 *                   -- WebSocket upgrades included.
 *   Origin          absent, or the editor's own host.
 *   a document      `vscode-remote-resource` opened as a page, or in a frame,
 *                   is answered with `Content-Security-Policy: sandbox`: an
 *                   opaque origin, which reads no cookie and sends none. The
 *                   workbench loads those as images, fonts, scripts and
 *                   fetches, which a CSP header on them does not touch.
 *
 * What it does not do: look inside the editor's own traffic, change a cookie
 * or a header the server set, or hold a connection open on its own account.
 */
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { EDITOR_HOST } from "./hosts.ts";
import { isEntryPoint } from "./utils.ts";

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

/** Why this request may not reach the editor, or "" when it may. */
export const refusal = (headers: IncomingMessage["headers"]): { status: number; why: string } | undefined => {
  if (hostnameOf(headers.host) !== EDITOR_HOST)
    return { status: 421, why: `the editor is at http://${EDITOR_HOST}:<port>/ -- \`./cli.sh url\` prints it` };
  const site = String(headers["sec-fetch-site"] ?? "");
  if (site !== "" && site !== "same-origin" && site !== "none")
    return { status: 403, why: `a request another site started (Sec-Fetch-Site: ${site})` };
  if (headers.origin !== undefined && hostnameOf(String(headers.origin), true) !== EDITOR_HOST)
    return { status: 403, why: `a request from another origin (${String(headers.origin).slice(0, 80)})` };
  return undefined;
};

/** Does this response go out sandboxed? A remote resource opened as a page. */
export const sandboxes = (url: string | undefined, headers: IncomingMessage["headers"]) =>
  (url ?? "").split("?")[0].includes("/vscode-remote-resource") && DOCUMENTS.has(String(headers["sec-fetch-dest"] ?? ""));

const refuse = (res: ServerResponse, { status, why }: { status: number; why: string }) => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(`desolate editor-gate: refused ${why}\n`);
};

export const gate = (serverPort: number) => {
  const server = createServer((req, res) => {
    const refused = refusal(req.headers);
    if (refused) return refuse(res, refused);
    const upstream = request(
      { host: "127.0.0.1", port: serverPort, method: req.method, path: req.url, headers: req.headers },
      (answer) => {
        const headers = { ...answer.headers };
        if (sandboxes(req.url, req.headers)) {
          headers["content-security-policy"] = "sandbox";
          headers["x-content-type-options"] = "nosniff";
        }
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("desolate editor-gate: the editor did not answer\n");
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req: IncomingMessage, client: Socket, head: Buffer) => {
    const refused = refusal(req.headers);
    if (refused) {
      client.end(`HTTP/1.1 ${refused.status} Refused\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n` +
        `desolate editor-gate: refused ${refused.why}\n`);
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
    const drop = () => { client.destroy(); upstream.destroy(); };
    upstream.on("error", drop);
    client.on("error", drop);
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
  return server;
};

if (isEntryPoint(import.meta.url)) {
  const [listen, serverPort] = process.argv.slice(2).map(Number);
  if (!Number.isInteger(listen) || !Number.isInteger(serverPort)) {
    console.error("usage: editor-gate.ts <listen port> <server port>");
    process.exit(2);
  }
  gate(serverPort).listen(listen, "0.0.0.0", () =>
    console.log(`editor-gate: ${EDITOR_HOST}:${listen} -> 127.0.0.1:${serverPort}`));
}
