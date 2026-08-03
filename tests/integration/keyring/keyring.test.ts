/// <reference types="node" />
// Integration test for the keyring: the real keyring.ts, a real ssh-agent, and
// a client speaking its wire protocol over the real unix socket, exactly as
// `newrepo` does from inside the editor container.
//
// tests/unit/desolate/keyring.test.ts covers the path layout by importing the
// helpers. It cannot cover any of what is here, because all of it only exists
// once the process is running: whether a private key ever lands in the volume
// the editor mounts, what the agent will and will not hand back, and whether a
// client can kill the process by never sending a newline.
//
// Requires: node >= 22.18, and ssh-agent/ssh-add/ssh-keygen on PATH.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const KEYRING = path.join(REPO, "release", "vscode-image", "keyring.ts");

let tmp: string;
let keys: string;
let run: string;
let keyring: ChildProcess;

const agentSocket = () => path.join(run, "agent.sock");
const controlSocket = () => path.join(run, "control.sock");

/** One JSON line in, one JSON line out -- the protocol newrepo speaks. */
function ask(request: unknown, timeoutMs = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(controlSocket());
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("keyring timeout"));
    }, timeoutMs);
    const done = (value: any) => {
      clearTimeout(timer);
      conn.destroy();
      resolve(value);
    };
    conn.on("connect", () => conn.write(JSON.stringify(request) + "\n"));
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      try {
        done(JSON.parse(buf.slice(0, i)));
      } catch {
        done({ raw: buf.slice(0, i) });
      }
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** What the agent is holding, asked through whichever socket is named. */
const fingerprints = (socket: string): string[] => {
  try {
    return execFileSync("ssh-add", ["-l"], {
      env: { ...process.env, SSH_AUTH_SOCK: socket },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter((l) => l.includes("ED25519"));
  } catch {
    return []; // "The agent has no identities." exits non-zero
  }
};

/** Every file under a directory, recursively -- used to assert a negative. */
const filesUnder = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath ?? dir, e.name));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keyring-it-"));
  keys = path.join(tmp, "keys");
  run = path.join(tmp, "run");

  keyring = spawn(process.execPath, [KEYRING], {
    env: {
      ...process.env,
      DESOLATE_KEYRING_KEYS: keys,
      DESOLATE_KEYRING_RUN: run,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  keyring.stderr?.on("data", () => {}); // drained, not asserted on

  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(controlSocket()) && fs.existsSync(agentSocket())) return;
    await sleep(50);
  }
  throw new Error("the keyring never created its sockets");
});

after(() => {
  keyring?.kill();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the control protocol", () => {
  test("creates a key and returns only the public half", async () => {
    const res = await ask({ op: "create", alias: "acme__widgets" });
    assert.equal(res.ok, true);
    assert.ok(
      res.pubkey.startsWith("ssh-ed25519 "),
      `expected a public key, got: ${String(res.pubkey).slice(0, 40)}`,
    );
    assert.ok(
      !JSON.stringify(res).includes("PRIVATE KEY"),
      "a create response carried private key material",
    );
  });

  test("two owners of the same repo name get two different keys", async () => {
    // The bug this pins: newrepo keyed the keyring on the bare repo name while
    // building its ssh host alias from owner__repo. `create` is idempotent, so
    // the second owner was handed the FIRST owner's public key to register --
    // one keypair covering two repos, which is the blast radius the per-repo
    // scheme exists to prevent.
    const acme = await ask({ op: "create", alias: "acme__widgets" });
    const other = await ask({ op: "create", alias: "other__widgets" });
    assert.notEqual(acme.pubkey, other.pubkey);
  });

  test("create is idempotent for the same alias", async () => {
    const first = await ask({ op: "create", alias: "acme__widgets" });
    const again = await ask({ op: "create", alias: "acme__widgets" });
    assert.equal(first.pubkey, again.pubkey);
  });

  test("refuses an alias that could leave the keys directory", async () => {
    for (const alias of ["../etc", "a/b", "", ".hidden"]) {
      const res = await ask({ op: "create", alias });
      assert.equal(res.ok, false, `alias '${alias}' was accepted`);
    }
  });

  test("has no operation that returns private key material", async () => {
    for (const op of ["export", "read", "dump", "private", "reveal"]) {
      const res = await ask({ op, alias: "acme__widgets" });
      assert.equal(res.ok, false);
      assert.match(String(res.error), /no operation that/);
    }
  });
});

describe("no private key reaches the volume the editor mounts", () => {
  test("nothing under RUN is a private key", () => {
    for (const file of filesUnder(run))
      assert.ok(
        !fs.readFileSync(file, "utf8").includes("PRIVATE KEY"),
        `${file} is in the editor-visible volume and holds a private key`,
      );
  });

  test("an alias ending in .pub cannot be laundered into a public one", async () => {
    // The disclosure: under the flat layout, "a.pub"'s PRIVATE key was written
    // to a path ending in .pub, so asking for the public key of the phantom
    // alias "a" returned it -- and published it into RUN at 0644.
    await ask({ op: "create", alias: "a.pub" });
    const phantom = await ask({ op: "pubkey", alias: "a" });
    assert.equal(phantom.ok, false, "the phantom alias 'a' resolved");

    for (const file of filesUnder(run))
      assert.ok(
        !fs.readFileSync(file, "utf8").includes("PRIVATE KEY"),
        `${file} holds a private key after the .pub alias round trip`,
      );
  });

  test("the listing invents no alias from a filename", async () => {
    const { aliases } = await ask({ op: "list" });
    assert.ok(!aliases.includes("a"), "phantom alias 'a' appeared in the listing");
    assert.ok(aliases.includes("a.pub"));
  });
});

describe("the agent socket", () => {
  test("is group-connectable, because that is how the editor reaches it", () => {
    // Connecting to a unix socket needs WRITE on the inode, so 0755 would leave
    // the editor unable to use the agent at all. No world bits, so a umask of 0
    // cannot silently open it to every uid.
    assert.equal(fs.statSync(agentSocket()).mode & 0o777, 0o660);
  });

  test("serves every key the keyring holds", async () => {
    await ask({ op: "create", alias: "acme__widgets" });
    const held = (await ask({ op: "list" })).aliases.length;
    assert.equal(fingerprints(agentSocket()).length, held);
  });

  test("hands out signatures, not key material", () => {
    // `ssh-add -L` prints public keys; there is no agent operation that returns
    // a private half, which is what makes the agent socket safe to share when
    // the key files are not.
    const listed = execFileSync("ssh-add", ["-L"], {
      env: { ...process.env, SSH_AUTH_SOCK: agentSocket() },
      encoding: "utf8",
    });
    assert.ok(listed.includes("ssh-ed25519 "));
    assert.ok(!listed.includes("PRIVATE KEY"));
  });
});

describe("the control socket cannot be used to kill the keyring", () => {
  test("refuses a request that never sends a newline", async () => {
    // Without a cap this grows the buffer until the process dies -- and it
    // dying takes git down for every project at once.
    const reply = await new Promise<string>((resolve, reject) => {
      const conn = net.createConnection(controlSocket());
      let buf = "";
      const timer = setTimeout(() => {
        conn.destroy();
        reject(new Error("no refusal within the timeout"));
      }, 15_000);
      conn.on("connect", () => conn.write("x".repeat(9000)));
      conn.on("data", (chunk) => (buf += chunk.toString()));
      conn.on("close", () => {
        clearTimeout(timer);
        resolve(buf);
      });
      conn.on("error", () => {});
    });
    assert.match(reply, /too large/);
  });

  test("is still serving afterwards", async () => {
    const res = await ask({ op: "list" });
    assert.equal(res.ok, true);
  });
});

describe("removal", () => {
  test("drops the key, its export, and its listing entry", async () => {
    const res = await ask({ op: "remove", alias: "a.pub" });
    assert.equal(res.ok, true);
    assert.ok(!fs.existsSync(path.join(keys, "a.pub")));
    assert.ok(!fs.existsSync(path.join(run, "pub", "a.pub.pub")));

    const { aliases } = await ask({ op: "list" });
    assert.deepEqual(aliases, ["acme__widgets", "other__widgets"]);
  });
});
