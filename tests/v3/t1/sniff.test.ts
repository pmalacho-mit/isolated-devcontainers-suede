// T1. Reading the name a connection asks for: the forwarder routes by it, and a wrong
// answer is a request reaching the wrong workspace.
import assert from "node:assert/strict";
import * as net from "node:net";
import { describe, it } from "node:test";
import * as tls from "node:tls";
import { normalizeName, sniff } from "../../../release/shared/sniff.ts";

/** A real ClientHello, as node's TLS client sends it. */
const clientHello = (servername: string | undefined): Promise<Buffer> =>
  new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.once("data", (data) => {
        resolve(Buffer.from(data));
        socket.destroy();
        server.close();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      const client = tls.connect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false });
      client.on("error", () => {});
    });
  });

describe("T1 sniff", () => {
  it("HTTP: the Host header, lowercased, without its port", () => {
    assert.deepEqual(sniff(Buffer.from("GET / HTTP/1.1\r\nHost: Web-One-abc123.localhost:5173\r\nAccept: */*\r\n\r\n")), { kind: "http", name: "web-one-abc123.localhost" });
    assert.deepEqual(sniff(Buffer.from("POST /x HTTP/1.0\nhost:a.localhost\n\n")), { kind: "http", name: "a.localhost" });
  });

  it("HTTP with no Host, or a Host that is not a hostname, names nothing", () => {
    assert.deepEqual(sniff(Buffer.from("GET / HTTP/1.0\r\n\r\n")), { kind: "http", name: null });
    for (const host of ["[::1]:80", "a b", "a/b", "evil.example:port", "", "-a.localhost", "a..b"])
      assert.deepEqual(sniff(Buffer.from(`GET / HTTP/1.1\r\nHost: ${host}\r\n\r\n`)), { kind: "http", name: null }, host);
    // A header that only looks like Host.
    assert.deepEqual(sniff(Buffer.from("GET / HTTP/1.1\r\nX-Host: a.localhost\r\n\r\n")), { kind: "http", name: null });
  });

  it("HTTP: the first Host header is the one that counts, and the body cannot supply one", () => {
    assert.deepEqual(sniff(Buffer.from("GET / HTTP/1.1\r\nHost: one.localhost\r\nHost: two.localhost\r\n\r\n")), { kind: "http", name: "one.localhost" });
    assert.deepEqual(sniff(Buffer.from("POST / HTTP/1.1\r\nContent-Length: 30\r\n\r\nHost: smuggled.localhost\r\n\r\n")), { kind: "http", name: null });
  });

  it("an incomplete request asks for more; a complete one never does", () => {
    assert.deepEqual(sniff(Buffer.from("GET / HT")), { kind: "more" });
    assert.deepEqual(sniff(Buffer.from("GET / HTTP/1.1\r\nHost: a.localhost\r\n")), { kind: "more" });
    assert.deepEqual(sniff(Buffer.alloc(0)), { kind: "more" });
  });

  it("TLS: the SNI of a real ClientHello", async () => {
    assert.deepEqual(sniff(await clientHello("web-two-0a1b2c.localhost")), { kind: "tls", name: "web-two-0a1b2c.localhost" });
    assert.deepEqual(sniff(await clientHello(undefined)), { kind: "tls", name: null }, "no SNI names nothing");
    const hello = await clientHello("a.localhost");
    assert.deepEqual(sniff(hello.subarray(0, 40)), { kind: "more" }, "a partial record asks for more");
  });

  it("anything else is raw: a protocol with no name in it", () => {
    for (const bytes of [Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]), Buffer.from("*1\r\n$4\r\nPING\r\n"), Buffer.from("SSH-2.0-OpenSSH_9.6\r\n"), Buffer.from([0x16, 0x01, 0x00])])
      assert.deepEqual(sniff(bytes), { kind: "raw" });
  });

  it("normalizeName", () => {
    assert.equal(normalizeName("A.Localhost."), "a.localhost");
    assert.equal(normalizeName("a.localhost:8080"), "a.localhost");
    for (const bad of ["a.localhost:http", "a_b.localhost", "a.localhost:80:80", "a".repeat(254), ".localhost"]) assert.equal(normalizeName(bad), null, bad);
  });
});
