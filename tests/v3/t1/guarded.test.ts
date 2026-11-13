// T1. A page the daemon serves (the approval page, the git terminal) that throws on a request
// answers that request 500 and goes on: the daemon carries every workspace's editor, ports
// and link, and a bug in one page must not take them down.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { guarded } from "../../../release/host/daemon.ts";

const get = (port: number, path: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject).end();
  });

describe("T1 a page that throws", () => {
  it("is that request's 500, logged, and the next request is answered", async () => {
    const logged: string[] = [];
    const server = createServer(guarded((line) => logged.push(line), async (req, res) => {
      if (req.url === "/boom") throw new ReferenceError("same is not defined");
      res.end("fine");
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const boom = await get(port, "/boom");
      assert.equal(boom.status, 500);
      assert.doesNotMatch(boom.body, /same is not defined/, "the error's text stays in the log");
      assert.deepEqual(logged, ["a page's request failed: same is not defined"]);
      assert.deepEqual(await get(port, "/"), { status: 200, body: "fine" });
    } finally {
      server.close();
    }
  });
});
