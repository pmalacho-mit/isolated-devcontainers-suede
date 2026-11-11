// T1. The token that opens a link carried over a loopback port (shared/link.ts): both ends,
// over a real socket.
import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { after, before, describe, it } from "node:test";
import { accept, hello, parseLink } from "../../../release/shared/link.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
let server: Server;
let port = 0;
/** The host's end: after the hello, everything is echoed back in capitals. */
before(async () => {
  server = createServer((socket) => {
    void accept(socket, TOKEN, 500).then((rest) => {
      if (rest === null) return;
      socket.on("data", (chunk) => socket.write(chunk.toString().toUpperCase()));
      if (rest.length > 0) socket.write(rest.toString().toUpperCase());
      socket.resume();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

const talk = (first: string, then = ""): Promise<string> =>
  new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.on("connect", () => {
      socket.write(first);
      if (then) setTimeout(() => socket.write(then), 50);
      setTimeout(() => socket.end(), 300);
    });
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => resolve(data));
    socket.on("error", () => resolve(data));
  });

describe("T1 the link token", () => {
  it("a link address is read strictly", () => {
    assert.deepEqual(parseLink("unix:/desolate/link/proxy.sock"), { unix: "/desolate/link/proxy.sock" });
    assert.deepEqual(parseLink(`tcp:192.168.5.2:5123#${TOKEN}`), { host: "192.168.5.2", port: 5123, token: TOKEN });
    assert.deepEqual(parseLink("tcp:192.168.5.2:5123"), { host: "192.168.5.2", port: 5123, token: null });
    for (const bad of ["", "unix:", "tcp:host:1", "tcp:1.2.3.4:5#short", `tcp:1.2.3.4:5#${TOKEN}x`, "http://1.2.3.4:5"]) assert.equal(parseLink(bad), null, bad);
    assert.throws(() => hello("not-a-token"));
  });
  it("the right token opens the link, and what follows it is carried", async () => {
    assert.equal(await talk(hello(TOKEN) + "connect a\n"), "CONNECT A\n", "sent in one piece");
    assert.equal(await talk(hello(TOKEN), "connect b\n"), "CONNECT B\n", "sent in two");
    assert.equal(await talk(hello(TOKEN).slice(0, 10), hello(TOKEN).slice(10) + "c"), "C", "the hello itself split");
  });
  it("anything else reaches nothing", async () => {
    assert.equal(await talk("CONNECT api.example.com:443 HTTP/1.1\r\n\r\n"), "", "no hello: what a program that found the port would send");
    assert.equal(await talk(hello("f".repeat(32)) + "connect\n"), "", "another link's token");
    assert.equal(await talk(hello(TOKEN).replace("\n", " ") + "connect\n"), "", "the token with something after it");
    assert.equal(await talk("DESOLATE-LINK "), "", "a hello that never finishes is dropped when its time is up");
  });
});
