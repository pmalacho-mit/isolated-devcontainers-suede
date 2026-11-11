/// <reference types="node" />
// editor-gate.ts: in front of the outer editor, it passes what a browser on
// the editor's own page sends and refuses what another site's page could make
// it send. Run here against a stand-in server; tests/environments/editor-gate
// runs the real editor behind it in Chromium.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";

import { gate, refusal, sandboxes, hostnameOf } from "../../../release/vscode-image/editor-gate.ts";

const OWN = "desolate.localhost:3000";

describe("which requests may reach the editor", () => {
  test("its own host, from its own page, from the address bar, or from no browser at all", () => {
    assert.equal(refusal({ host: OWN, "sec-fetch-site": "same-origin" }), undefined);
    assert.equal(refusal({ host: OWN, "sec-fetch-site": "none" }), undefined);
    assert.equal(refusal({ host: OWN }), undefined);
    assert.equal(refusal({ host: "DESOLATE.localhost:3000", origin: "http://desolate.localhost:3000" }), undefined);
  });

  test("not by another name: 127.0.0.1 is the jar every port shares", () => {
    for (const host of ["127.0.0.1:3000", "localhost:3000", "acme-widgets-babf3e111073ee33.localhost:3000", "desolate.localhost.evil:3000", "", undefined])
      assert.equal(refusal({ host })?.status, 421, String(host));
  });

  test("not when another site, or another port of this one, started it", () => {
    for (const site of ["cross-site", "same-site", "bogus"])
      assert.equal(refusal({ host: OWN, "sec-fetch-site": site })?.status, 403, site);
  });

  test("not from another origin, whatever Sec-Fetch-Site says", () => {
    for (const origin of ["http://hostile.localhost:8081", "http://127.0.0.1:3000", "null", "http://desolate.localhost.evil"])
      assert.equal(refusal({ host: OWN, origin })?.status, 403, origin);
  });

  test("hostnames are read as URLs read them", () => {
    assert.equal(hostnameOf("Desolate.Localhost:3000"), "desolate.localhost");
    assert.equal(hostnameOf("http://desolate.localhost:3000", true), "desolate.localhost");
    assert.equal(hostnameOf("a b"), "\0unparseable");
  });
});

describe("what goes out sandboxed", () => {
  test("a remote resource opened as a page or a frame -- and nothing the workbench loads", () => {
    const url = "/stable-x/vscode-remote-resource?path=/workspaces/p/x.html";
    for (const dest of ["document", "iframe", "frame", "embed", "object"]) assert.equal(sandboxes(url, { "sec-fetch-dest": dest }), true, dest);
    for (const dest of ["image", "script", "style", "font", "empty", undefined]) assert.equal(sandboxes(url, { "sec-fetch-dest": dest }), false, String(dest));
    assert.equal(sandboxes("/", { "sec-fetch-dest": "document" }), false, "the workbench itself");
  });
});

describe("the gate, in front of a server", () => {
  let upstream: Server, front: Server, port = 0;
  const seen: string[] = [];
  before(async () => {
    upstream = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "text/html", "set-cookie": ["vscode-tkn=t; SameSite=Lax", "other=1"] });
      res.end("<p>page</p>");
    });
    upstream.on("upgrade", (req, socket) => {
      seen.push(`UPGRADE ${req.url}`);
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello");
    });
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    front = gate((upstream.address() as AddressInfo).port);
    await new Promise<void>((done) => front.listen(0, "127.0.0.1", done));
    port = (front.address() as AddressInfo).port;
  });
  after(() => { front.close(); upstream.close(); });

  const get = (path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((done, failed) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { host: OWN, ...headers } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk)).on("end", () => done({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on("error", failed);
      req.end();
    });
  const upgrade = (headers: string) =>
    new Promise<string>((done) => {
      const socket = connect(port, "127.0.0.1", () =>
        socket.write(`GET /?reconnectionToken=x HTTP/1.1\r\nHost: ${OWN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${headers}\r\n`));
      let said = "";
      socket.on("data", (chunk) => (said += chunk)).on("close", () => done(said)).on("error", () => done(said));
    });

  test("passes the editor's own requests, and its answers as they were -- every cookie", async () => {
    const answer = await get("/?tkn=t", { "sec-fetch-site": "none" });
    assert.equal(answer.status, 200);
    assert.equal(answer.body, "<p>page</p>");
    assert.deepEqual(answer.headers["set-cookie"], ["vscode-tkn=t; SameSite=Lax", "other=1"]);
    assert.equal(answer.headers["content-security-policy"], undefined);
  });

  test("refuses another site's, and the server never sees it", async () => {
    const before = seen.length;
    const answer = await get("/vscode-remote-resource?path=/workspaces/p/x.html", { "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" });
    assert.equal(answer.status, 403);
    assert.match(answer.body, /editor-gate: refused/);
    assert.equal(seen.length, before);
  });

  test("sandboxes a remote resource opened as a page the user's way", async () => {
    const answer = await get("/vscode-remote-resource?path=/workspaces/p/x.html", { "sec-fetch-site": "none", "sec-fetch-dest": "document" });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers["content-security-policy"], "sandbox");
    assert.equal(answer.headers["x-content-type-options"], "nosniff");
  });

  test("passes the editor's socket, and refuses one another origin opens", async () => {
    assert.match(await upgrade("Origin: http://desolate.localhost:3000\r\nSec-Fetch-Site: same-origin\r\n"), /^HTTP\/1.1 101 [\s\S]*hello$/);
    const before = seen.length;
    assert.match(await upgrade("Origin: http://hostile.localhost:8081\r\n"), /^HTTP\/1.1 403 /);
    assert.match(await upgrade("Origin: http://desolate.localhost:3000\r\nSec-Fetch-Site: cross-site\r\n"), /^HTTP\/1.1 403 /);
    assert.equal(seen.length, before, "a refused upgrade reached the server");
  });
});
