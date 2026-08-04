// Powers the only container (keyring) in this stack that holds raw private keys.
//
// THE CONTROL PROTOCOL
//
// A narrow line-delimited JSON socket, deliberately without an export/read
// operation. Everything it can do is something a compromised editor could
// already do by other means (generate a key, read a public key, drop a key);
// nothing it can do yields private key material. Adding a "read"/"export" op
// here would silently undo the entire point of this file.
/// <reference types="node" />
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:net";
import * as path from "node:path";
import { isEntryPoint } from "./utils.ts";

const KEYS = process.env.DESOLATE_KEYRING_KEYS ?? "/var/lib/keyring";
const RUN = process.env.DESOLATE_KEYRING_RUN ?? "/run/keyring";
const PUB = `${RUN}/pub`;
const CONTROL = `${RUN}/control.sock`;

/** ssh-agent binds this directly, and the editor connects to it.
 *
 *  This process deliberately does NOT sit in between. It did, briefly, to
 *  measure idleness so keys could be unloaded after a quiet period -- but
 *  reload was on demand, so anything able to connect could wake the keys, which
 *  is every attacker the unloading was supposed to bound. It protected against
 *  nothing and put a moving part in the path of every git operation. */
const AGENT = `${RUN}/agent.sock`;

/** Every fs permission this process sets, spelled out. Octal digits are
 *  owner/group/other, and each digit is read(4) + write(2) + execute(1) --
 *  where "execute" on a directory means "may enter it", not "may run it". */
const mode = {
  /** 0700 -- owner: read, write, enter. group: nothing. other: nothing.
   *  The private half lives here, so nobody but this process's user may even
   *  list the directory. */
  privateDir: 0o700,

  /** 0600 -- owner: read, write. group: nothing. other: nothing.
   *  A private key. ssh refuses to use one that is group- or world-readable,
   *  and it is right to. */
  privateKey: 0o600,

  /** 0755 -- owner: read, write, enter. group: read, enter. other: read,
   *  enter. Directories the editor must traverse to reach the published
   *  public halves; only this process writes into them. */
  publicDir: 0o755,

  /** 0644 -- owner: read, write. group: read. other: read.
   *  A published .pub file. Public by definition; writable only by us. */
  publicFile: 0o644,

  /** 0660 -- owner: read, write. group: read, write. other: nothing.
   *  Same shape as the broker's: the peer needs write to connect (a unix
   *  socket needs write to be connected to at all), the world needs nothing.
   *  Node derives socket mode from the umask otherwise. */
  socket: 0o660,
} as const;

const log = (msg: string) => console.error(`keyring: ${msg}`);

/** Aliases become filenames and ssh host aliases. Same rule newrepo applies,
 *  restated here because this process is reachable from the editor and must not
 *  trust the caller: a traversal here would write a key outside KEYS. */
export const validAlias = (alias: unknown): alias is string =>
  typeof alias === "string" &&
  alias.length > 0 &&
  alias.length <= 128 &&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias) &&
  !alias.includes("..");

/** ONE DIRECTORY PER ALIAS, and the filenames inside are fixed.
 *
 *  The obvious layout -- `deploy_<alias>` beside `deploy_<alias>.pub`, listed by
 *  matching /^deploy_(.+)\.pub$/ -- is a PRIVATE KEY DISCLOSURE, and it is worth
 *  spelling out because it looks fine:
 *
 *    create alias "a.pub"  ->  private key at deploy_a.pub
 *                              public  key at deploy_a.pub.pub
 *    the listing regex then reports a phantom alias "a", because the PRIVATE
 *    file of "a.pub" ends in .pub and matches
 *    pubkey "a"            ->  reads `deploy_a` + ".pub" = deploy_a.pub
 *                          ->  hands back the PRIVATE key, and copies it into
 *                              the world-readable pub/ dir the editor mounts.
 *
 *  Both requests are ones a compromised editor can make. Encoding structure in
 *  a filename and parsing it back is the bug; a directory boundary removes the
 *  ambiguity instead of blacklisting the spellings that trigger it. */
const aliasDir = (alias: string) => path.join(KEYS, alias);
export const keyPath = (alias: string) => path.join(KEYS, alias, "id");
export const pubPath = (alias: string) => path.join(PUB, `${alias}.pub`);

export const listAliases = (root: string = KEYS): string[] => {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() && fs.existsSync(path.join(root, e.name, "id.pub")),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
};

/** Publish the PUBLIC half where the editor can read it.
 *
 *  ssh accepts a .pub file as IdentityFile and pairs it with the agent's
 *  private half. That is what lets the editor keep `IdentitiesOnly yes` -- and
 *  it matters: with several deploy keys loaded, an agent offers them in an
 *  arbitrary order, and GitHub authenticates as whichever repo's key matches
 *  first. Without pinning the identity per host alias, pushing to repo A can
 *  authenticate as repo B and fail confusingly. */
const exportPublic = (alias: string) => {
  fs.mkdirSync(PUB, { recursive: true, mode: mode.publicDir });
  fs.copyFileSync(`${keyPath(alias)}.pub`, pubPath(alias));
  fs.chmodSync(pubPath(alias), mode.publicFile);
};

const agentEnv = () => ({ ...process.env, SSH_AUTH_SOCK: AGENT });

const addToAgent = (alias: string) => {
  execFileSync("ssh-add", [keyPath(alias)], {
    env: agentEnv(),
    stdio: ["ignore", "ignore", "inherit"],
  });
};

const createKey = (alias: string): string => {
  const key = keyPath(alias);
  fs.mkdirSync(aliasDir(alias), { recursive: true, mode: mode.privateDir });
  if (!fs.existsSync(key)) {
    execFileSync(
      "ssh-keygen",
      ["-t", "ed25519", "-f", key, "-N", "", "-C", `desolate-${alias}`],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    fs.chmodSync(key, mode.privateKey);
    log(`generated key for '${alias}'`);
  }
  exportPublic(alias);
  addToAgent(alias);
  return fs.readFileSync(`${key}.pub`, "utf8").trim();
};

const removeKey = (alias: string) => {
  try {
    execFileSync("ssh-add", ["-d", keyPath(alias)], {
      env: agentEnv(),
      stdio: "ignore",
    });
  } catch {
    /* not loaded */
  }
  try {
    fs.rmSync(aliasDir(alias), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
  try {
    fs.unlinkSync(pubPath(alias));
  } catch {
    /* already gone */
  }
  log(`removed key for '${alias}'`);
};

type Request = { op?: unknown; alias?: unknown };

const handle = (request: Request): Record<string, unknown> => {
  const { op } = request;

  if (op === "list") return { ok: true, aliases: listAliases() };

  if (op === "create" || op === "pubkey" || op === "remove") {
    if (!validAlias(request.alias))
      return { ok: false, error: `invalid alias: ${String(request.alias)}` };
    const alias = request.alias;

    if (op === "create") return { ok: true, alias, pubkey: createKey(alias) };

    if (op === "pubkey") {
      if (!fs.existsSync(`${keyPath(alias)}.pub`))
        return { ok: false, error: `no key for '${alias}'` };
      exportPublic(alias);
      return {
        ok: true,
        alias,
        pubkey: fs.readFileSync(`${keyPath(alias)}.pub`, "utf8").trim(),
        identityFile: pubPath(alias),
      };
    }

    removeKey(alias);
    return { ok: true, alias };
  }

  // Deliberately including any spelling of "give me the private key". Naming it
  // in the refusal is the point: the next person to want that operation should
  // find this line rather than add it.
  return {
    ok: false,
    error:
      `unknown op '${String(op)}' -- this socket has no operation that ` +
      `returns private key material, by design (see keyring.ts)`,
  };
};

/**
 * Bounds on what a client may do to this process before saying anything valid.
 *
 * The editor is the least trusted container in the stack and it is the only
 * thing that can reach this socket, so both limits are about the editor rather
 * than about accidents. Without `bytes`, a client that connects and never sends
 * a newline grows the buffer until this process dies -- and this process dying
 * takes git down for every project at once. The broker guards the identical
 * loop for the identical reason (see broker.ts, `request.max`).
 *
 * Small numbers because one request per `newrepo` invocation is the real
 * workload. Nothing here bounds the AGENT socket, which ssh-agent serves
 * directly; OpenSSH does its own accounting there.
 */
const limits = {
  control: { bytes: 4096, concurrent: 8 },
} as const;

const serveControl = () => {
  let open = 0;

  createServer((connection) => {
    if (open >= limits.control.concurrent) {
      connection.write(
        JSON.stringify({ ok: false, error: "too many connections" }) + "\n",
      );
      return connection.destroy();
    }

    open++;
    connection.on("close", () => open--);

    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString();

      // Checked BOTH here and on the extracted line below, and neither subsumes
      // the other: without this one, a client that never sends a newline
      // exhausts memory; without the other, a single chunk can arrive with its
      // newline already past the limit.
      if (buffer.length > limits.control.bytes) {
        connection.write(
          JSON.stringify({ ok: false, error: "request too large" }) + "\n",
        );
        return connection.destroy();
      }

      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let response: Record<string, unknown>;
        if (line.length > limits.control.bytes)
          response = { ok: false, error: "request too large" };
        else
          try {
            response = handle(JSON.parse(line));
          } catch (error) {
            response = { ok: false, error: `bad request: ${String(error)}` };
          }
        connection.write(JSON.stringify(response) + "\n");
      }
    });
    connection.on("error", () => connection.destroy());
  }).listen(CONTROL, () => {
    fs.chmodSync(CONTROL, mode.socket);
    log(`control at ${CONTROL}`);
    log(`holding ${listAliases().length} key(s); public halves in ${PUB}`);
  });
};

/** Start the agent, publish what we already hold, then serve.
 *
 *  Everything above this line is importable without any of it happening: the
 *  path and validation helpers are where the disclosure bug lived, so they are
 *  the part that most needs to be exercised on its own. */
const main = () => {
  fs.mkdirSync(KEYS, { recursive: true, mode: mode.privateDir });
  fs.mkdirSync(RUN, { recursive: true, mode: mode.publicDir });
  for (const stale of [AGENT, CONTROL])
    try {
      fs.unlinkSync(stale);
    } catch {
      /* no stale socket */
    }

  const agent = spawn("ssh-agent", ["-D", "-a", AGENT], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  // An unhandled 'error' event on a ChildProcess throws, and node prints a spawn
  // stack trace that says nothing about what is actually wrong. The only likely
  // cause is a missing openssh-client in the image, so say that instead.
  agent.on("error", (error) => {
    log(`could not start ssh-agent: ${error.message}`);
    log(
      `this image must provide openssh-client (ssh-agent, ssh-add, ssh-keygen)`,
    );
    process.exit(1);
  });
  // Take the agent down with us.
  //
  // This process is not PID 1 -- the entrypoint is `tsx keyring.ts`, so the
  // agent is a grandchild of the container's init and outlives us if nothing
  // says otherwise. An orphaned `ssh-agent -D` goes on holding every private
  // key it was given, which makes "the incident ends when the container
  // restarts" false at the process level: a keyring that crashes and is
  // restarted by `restart: unless-stopped` would leave the old agent, and its
  // keys, resident beside the new one.
  let stopping = false;
  const stopAgent = () => {
    stopping = true;
    try {
      agent.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.once("exit", stopAgent);
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      stopAgent();
      process.exit(0);
    });

  agent.on("exit", (code) => {
    if (stopping) return; // we asked for this
    log(`ssh-agent exited (${code}) -- restarting the container`);
    process.exit(1);
  });

  const ready = () => {
    try {
      fs.chmodSync(AGENT, mode.socket);
      return true;
    } catch {
      return false;
    }
  };

  const start = () => {
    for (const alias of listAliases())
      try {
        exportPublic(alias);
        addToAgent(alias);
        log(`loaded '${alias}'`);
      } catch {
        log(`could not load '${alias}'`);
      }

    serveControl();
  };

  // ssh-agent creates its socket asynchronously; wait for it rather than racing.
  let waited = 0;
  const poll = setInterval(() => {
    if (ready()) {
      clearInterval(poll);
      start();
    } else if ((waited += 100) > 10_000) {
      clearInterval(poll);
      log(`ssh-agent never created ${AGENT}`);
      process.exit(1);
    }
  }, 100);
};

if (isEntryPoint(import.meta.url)) main();
