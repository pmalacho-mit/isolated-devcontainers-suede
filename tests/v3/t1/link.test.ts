// T1. A link carried over a loopback port (shared/link.ts): each side proves it knows the
// workspace's token, the host first, and the token never crosses. Both ends, and both kinds
// of impostor, over real sockets.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { connect, createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { after, before, describe, it } from "node:test";
import { accept, open, parseLink } from "../../../release/shared/link.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER = "f".repeat(32);
const listen = (onSocket: (socket: Socket) => void): Promise<{ server: Server; port: number }> =>
  new Promise((resolve) => {
    const server = createServer(onSocket);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });

/** The host's end: after the handshake, everything is echoed back in capitals. */
let host: { server: Server; port: number };
before(async () => {
  host = await listen((socket) => {
    void accept(socket, TOKEN, 500).then((rest) => {
      if (rest === null) return;
      socket.on("data", (chunk) => socket.write(chunk.toString().toUpperCase()));
      if (rest.length > 0) socket.write(rest.toString().toUpperCase());
      socket.resume();
    });
  });
});
after(() => host.server.close());

/** A guest that opens the link with `token`, then sends `text`; what came back. */
const guest = (port: number, token: string, text: string): Promise<{ opened: boolean; got: string }> =>
  new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let got = "";
    socket.on("error", () => {});
    socket.on("connect", () => {
      void open(socket, token, 500).then((opened) => {
        if (!opened) return resolve({ opened, got });
        socket.on("data", (chunk) => (got += chunk));
        socket.write(text);
        setTimeout(() => {
          socket.destroy();
          resolve({ opened, got });
        }, 200);
      });
    });
  });

/** Raw bytes to the host's port, as a program that found it would send; what came back. */
const raw = (first: string, then?: (seen: string) => string): Promise<string> =>
  new Promise((resolve) => {
    const socket = connect(host.port, "127.0.0.1");
    let data = "";
    socket.on("connect", () => socket.write(first));
    socket.on("data", (chunk) => {
      data += chunk;
      if (then && data.includes("\n")) {
        socket.write(then(data));
        then = undefined;
      }
    });
    setTimeout(() => socket.destroy(), 700);
    socket.on("close", () => resolve(data));
    socket.on("error", () => resolve(data));
  });

describe("T1 the link's handshake", () => {
  it("a link address is read strictly", () => {
    assert.deepEqual(parseLink("unix:/desolate/link/proxy.sock"), { unix: "/desolate/link/proxy.sock" });
    assert.deepEqual(parseLink(`tcp:192.168.5.2:5123#${TOKEN}`), { host: "192.168.5.2", port: 5123, token: TOKEN });
    assert.deepEqual(parseLink("tcp:192.168.5.2:5123"), { host: "192.168.5.2", port: 5123, token: null });
    for (const bad of ["", "tcp:", "tcp:host:1#short", "udp:1.2.3.4:5", `tcp:1.2.3.4:5#${TOKEN}x`]) assert.equal(parseLink(bad), null, bad);
  });

  it("control: the workspace's guest and its host open the link, and bytes flow both ways", async () => {
    assert.deepEqual(await guest(host.port, TOKEN, "connect a\n"), { opened: true, got: "CONNECT A\n" });
  });

  it("a program holding the port learns nothing from the guest: not the token, not where it wants to go", async () => {
    const heard: string[] = [];
    // It cannot prove what it does not know: it answers with a proof made of another token.
    const squatter = await listen((socket) => {
      socket.on("data", (chunk) => {
        heard.push(chunk.toString());
        const nonce = /^DESOLATE-LINK2 ([0-9a-f]{32})\n$/.exec(chunk.toString())?.[1] ?? "";
        socket.write(`${"1".repeat(32)} ${createHmac("sha256", Buffer.from(OTHER, "hex")).update(`host ${nonce} ${"1".repeat(32)}`).digest("hex")}\n`);
      });
    });
    const result = await guest(squatter.port, TOKEN, "CONNECT api.secret-host.example:443\r\n\r\n");
    squatter.server.close();
    assert.equal(result.opened, false);
    const all = heard.join("");
    assert.match(all, /^DESOLATE-LINK2 [0-9a-f]{32}\n$/, "all it got was the guest's nonce");
    assert.doesNotMatch(all, new RegExp(TOKEN), "never the token");
    assert.doesNotMatch(all, /CONNECT|secret-host/, "and never what the guest wanted");
  });

  it("a program connecting to the host's port gets nothing through: no hello, a wrong answer, another token, an answer too late", async () => {
    assert.equal(await raw("CONNECT api.example.com:443 HTTP/1.1\r\n\r\n"), "", "no hello");
    assert.equal(await raw("DESOLATE-LINK pretend-old-hello\n"), "", "the first version's hello");
    const proofLine = await raw(`DESOLATE-LINK2 ${"a".repeat(32)}\n`, () => `${"0".repeat(64)}\nconnect\n`);
    assert.match(proofLine, /^[0-9a-f]{32} [0-9a-f]{64}\n$/, "the host proves itself, and echoes nothing after a wrong answer");
    assert.deepEqual(await guest(host.port, OTHER, "connect\n"), { opened: false, got: "" }, "a guest with another workspace's token does not accept the host's proof");
    assert.equal(await raw(`DESOLATE-LINK2 ${"a".repeat(32)}`), "", "a hello that never ends is dropped when its time is up");
  });
});
