/// <reference types="node" />
// The editor's half of the control protocol, against a real unix socket.
//
// The unit test proves the child's program parses. This one proves the round
// trip: that it connects, frames its request with a newline, reads one line
// back, and reports a failure as the errno rather than as silence. Between them
// they cover the path `newrepo` could not exercise at all -- it spawns a child,
// so none of it was reachable from a test until the client moved out of
// newrepo.ts.
//
// The stub keyring runs in a SEPARATE PROCESS, and it has to: `exchange` is
// synchronous, so it blocks this process's event loop while the child runs. A
// stub served from here would never accept the connection, and the test would
// hang rather than fail. In production the keyring is another container, which
// is the same property by a wider margin.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  KeyringError,
  exchange,
} from "../../../release/vscode-image/keyring-client.ts";

/** Line-delimited JSON, as keyring.ts serves it. Echoes each request back so a
 *  test can assert what ARRIVED, not merely what came home. */
const STUB = String.raw`
const net = require("node:net");
const fs = require("node:fs");
const [socket, log] = process.argv.slice(1);
net.createServer((connection) => {
  let buffer = "";
  connection.on("data", (chunk) => {
    buffer += chunk.toString();
    const end = buffer.indexOf("\n");
    if (end < 0) return;
    const line = buffer.slice(0, end);
    fs.appendFileSync(log, line + "\n");
    const request = JSON.parse(line);
    connection.end(JSON.stringify(
      request.op === "create"
        ? { ok: true, alias: request.alias }
        : { ok: false, error: "unknown op '" + request.op + "'" },
    ) + "\n");
  });
}).listen(socket);
`;

let directory: string;
let socket: string;
let log: string;
let stub: ChildProcess;

/** Run `fn`, returning the error it threw. Fails the test if it did not throw.
 *  `assert.throws` checks the type but hands back nothing, and the MESSAGE is
 *  the whole point here. */
const thrown = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  return assert.fail("expected a throw");
};

/** Every request line the stub received. */
const received = () =>
  fs.readFileSync(log, "utf8").split("\n").filter(Boolean);

before(async () => {
  directory = fs.mkdtempSync(join(tmpdir(), "desolate-keyring-client-"));
  socket = join(directory, "control.sock");
  log = join(directory, "requests.log");
  fs.writeFileSync(log, "");

  stub = spawn(process.execPath, ["-e", STUB, socket, log], {
    stdio: ["ignore", "ignore", "inherit"],
  });

  for (let waited = 0; waited < 5000 && !fs.existsSync(socket); waited += 50)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(fs.existsSync(socket), "the stub keyring never bound its socket");
});

after(() => {
  stub?.kill("SIGTERM");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("one request, one reply", () => {
  test("the reply comes back as the keyring wrote it", () => {
    const reply = JSON.parse(exchange(socket, { op: "create", alias: "a__b" }));
    assert.deepEqual(reply, { ok: true, alias: "a__b" });
  });

  test("the request arrives newline-framed and intact", () => {
    // The framing IS the protocol. A request that never gets its newline leaves
    // the keyring waiting and the caller blocked, with nothing logged anywhere.
    fs.writeFileSync(log, "");
    exchange(socket, { op: "create", alias: "acme__widgets" });
    assert.deepEqual(received(), ['{"op":"create","alias":"acme__widgets"}']);
  });

  test("a refusal is a reply, not a failure", () => {
    // `ok: false` is the keyring answering. Only the transport throws.
    const reply = JSON.parse(exchange(socket, { op: "status" }));
    assert.equal(reply.ok, false);
    assert.match(reply.error, /unknown op 'status'/);
  });

  test("an alias with characters of its own survives the trip", () => {
    // It reaches here from a command line, and used to be interpolated into the
    // child's SOURCE. Passing it in argv is what makes this uninteresting.
    for (const alias of ['a"b', "a\\b", "a'b", "a$b", "a`b", "a\nb"]) {
      fs.writeFileSync(log, "");
      const reply = JSON.parse(exchange(socket, { op: "create", alias }));
      assert.equal(reply.alias, alias, JSON.stringify(alias));
      assert.equal(
        JSON.parse(received()[0]).alias,
        alias,
        JSON.stringify(alias),
      );
    }
  });
});

describe("when the round trip fails", () => {
  test("an absent socket reports ENOENT, not silence", () => {
    const error = thrown(() =>
      exchange(join(directory, "absent.sock"), { op: "create" }),
    );
    assert.ok(error instanceof KeyringError, error.constructor.name);
    assert.match(error.message, /ENOENT/);
  });

  test("a path that is not a socket is reported, not waited on", () => {
    // What a half-initialised volume looks like: the name is there, the thing
    // behind it is not what the protocol needs.
    const plain = join(directory, "not-a-socket");
    fs.writeFileSync(plain, "");
    const error = thrown(() => exchange(plain, { op: "create" }));
    assert.ok(error instanceof KeyringError, error.constructor.name);
    assert.match(error.message, /ECONNREFUSED|ENOTSOCK|EACCES/);
  });
});
