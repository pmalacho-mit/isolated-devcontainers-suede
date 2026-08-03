// Powers the only container (keyring) in this stack that holds raw private keys.
//
// THE CONTROL PROTOCOL
//
// A narrow line-delimited JSON socket, deliberately without an export/read
// operation. Everything it can do is something a compromised editor could
// already do by other means (generate a key, read a public key, drop a key);
// nothing it can do yields private key material. Adding a "read"/"export" op
// here would silently undo the entire point of this file.
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createConnection, createServer } from "node:net";
import * as path from "node:path";
import { isEntryPoint } from "./utils.ts";

const KEYS = process.env.DESOLATE_KEYRING_KEYS ?? "/var/lib/keyring";
const RUN = process.env.DESOLATE_KEYRING_RUN ?? "/run/keyring";
const PUB = `${RUN}/pub`;
const CONTROL = `${RUN}/control.sock`;

/** What the editor connects to. NOT the ssh-agent itself -- this process
 *  proxies it, so that "when was a key last used" is a question something in
 *  this container can answer. See `keys` below. */
const AGENT = `${RUN}/agent.sock`;

/** The REAL ssh-agent socket, on this container's own filesystem rather than in
 *  RUN. That placement is the point: RUN is shared with the editor, so an agent
 *  socket there would let the editor bypass the proxy and with it every idle
 *  bound this file applies. */
const UPSTREAM_DIR =
  process.env.DESOLATE_KEYRING_UPSTREAM ?? "/tmp/desolate-keyring";
const UPSTREAM = `${UPSTREAM_DIR}/agent.sock`;

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

  /** 0600 -- owner: read, write. group: nothing. other: nothing.
   *  The upstream ssh-agent socket. Same shape as a private key on purpose:
   *  reaching it IS reaching the private keys, and nothing outside this
   *  process has any business connecting to it. */
  privateSocket: 0o600,

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

/** Keys written by the pre-directory layout, which this process can no longer
 *  see.
 *
 *  They are still on the volume, still valid, and still registered on GitHub --
 *  but `listAliases` skips them, so the only symptom would be every push
 *  failing with `Permission denied (publickey)` and a keyring that reports it
 *  is holding zero keys. Say so at startup instead. Deliberately NOT migrated
 *  automatically: the old names were also ambiguous (see above), so picking
 *  which alias a `deploy_x.pub` belonged to is exactly the guess that caused
 *  the disclosure. */
export const legacyKeys = (root: string = KEYS): string[] => {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith("deploy_"))
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

const agentEnv = () => ({ ...process.env, SSH_AUTH_SOCK: UPSTREAM });

const addToAgent = (alias: string) => {
  execFileSync("ssh-add", [keyPath(alias)], {
    env: agentEnv(),
    stdio: ["ignore", "ignore", "inherit"],
  });
};

/**
 * How long the agent may hold keys with nothing using them.
 *
 * 0 (or an unparseable value) disables unloading entirely, which is the old
 * behaviour: load once at startup, hold forever.
 */
const idleSeconds = (() => {
  const raw = Number(process.env.DESOLATE_KEYRING_IDLE_SECONDS ?? 900);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
})();

/**
 * Which keys the agent currently holds, and for how much longer.
 *
 * WHAT THIS BUYS, PRECISELY. It is not a defence against an editor that is
 * compromised right now: `load()` happens on demand, so an attacker who can
 * connect to the agent socket can always wake the keys back up. What it bounds
 * is the RESIDENT window -- after an idle period the private keys are out of
 * the agent, so a compromise that arrives later, or one whose access has since
 * been cut off, finds an agent holding nothing. It also means a stack left
 * running overnight is not an ssh-agent full of deploy keys waiting.
 *
 * Making this a real control against a live attacker means requiring something
 * the editor cannot do to reload -- an explicit unlock from the host. That is a
 * deliberate non-goal here: it would put a manual step in front of every push
 * after a coffee break. The hook for it is `load()`; nothing else would change.
 *
 * `inUse` is what keeps a long push from being unloaded mid-signature: the
 * sweep only fires when no agent connection is open.
 */
const keys = {
  loaded: false,
  lastUsed: 0,
  inUse: 0,

  load() {
    const aliases = listAliases();
    let loaded = 0;
    for (const alias of aliases)
      try {
        addToAgent(alias);
        loaded++;
      } catch {
        log(`could not load '${alias}'`);
      }
    keys.loaded = true;
    if (loaded) log(`loaded ${loaded} key(s) into the agent`);
  },

  unload() {
    try {
      execFileSync("ssh-add", ["-D"], { env: agentEnv(), stdio: "ignore" });
      log(`idle for ${idleSeconds}s -- unloaded every key from the agent`);
    } catch {
      log(`could not unload keys from the agent`);
    }
    keys.loaded = false;
  },

  /** Something is about to use a key: stamp it, and make sure they are there. */
  touch() {
    keys.lastUsed = Date.now();
    if (!keys.loaded) keys.load();
  },

  sweep() {
    if (!idleSeconds || !keys.loaded || keys.inUse > 0) return;
    if (Date.now() - keys.lastUsed >= idleSeconds * 1000) keys.unload();
  },
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
  // Creating a key is a use of the keyring, and the new key has to reach the
  // agent whether or not the others are currently loaded.
  keys.touch();
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
 * thing that can reach these sockets, so both limits are about the editor
 * rather than about accidents. Without `bytes`, a client that connects and
 * never sends a newline grows the buffer until this process dies -- and this
 * process dying takes git down for every project at once. The broker guards the
 * identical loop for the identical reason (see broker.ts, `request.max`).
 *
 * `control` is small because one request per `newrepo` invocation is the real
 * workload. `agent` is generous because a single `git push` opens several
 * short-lived connections and parallel fetches multiply that.
 */
const limits = {
  control: { bytes: 4096, concurrent: 8 },
  agent: { concurrent: 64 },
} as const;

/**
 * Proxy the ssh-agent socket, byte for byte.
 *
 * Deliberately no parsing of the agent protocol: this process does not need to
 * know what is being asked, only that SOMETHING is asking, which is what makes
 * the idle bound in `keys` measurable. Parsing it would be a second
 * implementation of a protocol whose whole input is attacker-controlled, for no
 * gain.
 */
const serveAgent = () => {
  let open = 0;

  createServer((client) => {
    if (open >= limits.agent.concurrent) return client.destroy();

    open++;
    keys.touch();
    keys.inUse++;

    const upstream = createConnection(UPSTREAM);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      open--;
      keys.inUse--;
      // Stamp on the way out too: a long-running connection is use, and
      // otherwise it would count as idle from the moment it opened.
      keys.lastUsed = Date.now();
      client.destroy();
      upstream.destroy();
    };

    for (const socket of [client, upstream])
      socket.on("error", close).on("close", close);

    client.pipe(upstream);
    upstream.pipe(client);
  }).listen(AGENT, () => {
    fs.chmodSync(AGENT, mode.socket);
    log(`agent at ${AGENT}`);
  });
};

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
    log(
      idleSeconds
        ? `keys load on first use and unload after ${idleSeconds}s idle`
        : `idle unloading is DISABLED (DESOLATE_KEYRING_IDLE_SECONDS=0)`,
    );
  });
};

// ---------------------------------------------------------------------------
// start the agent, publish what we already hold, then serve
//
// Guarded so the path/validation helpers above are importable by tests without
// spawning an agent -- those helpers are where the disclosure bug lived, so
// they are the part that most needs to be exercised directly.
// ---------------------------------------------------------------------------
const main = () => {
  fs.mkdirSync(KEYS, { recursive: true, mode: mode.privateDir });
  fs.mkdirSync(RUN, { recursive: true, mode: mode.publicDir });
  fs.mkdirSync(UPSTREAM_DIR, { recursive: true, mode: mode.privateDir });
  for (const stale of [AGENT, CONTROL, UPSTREAM])
    try {
      fs.unlinkSync(stale);
    } catch {
      /* no stale socket */
    }

  const orphans = legacyKeys();
  if (orphans.length) {
    log(`WARNING: ${orphans.length} key file(s) use the old flat layout and`);
    log(`         are NOT being loaded: ${orphans.slice(0, 4).join(", ")}...`);
    log(`         Re-run 'cli.sh repo add <owner>/<repo>' for each, and`);
    log(`         re-register the new deploy key on GitHub.`);
  }

  const agent = spawn("ssh-agent", ["-D", "-a", UPSTREAM], {
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
      fs.chmodSync(UPSTREAM, mode.privateSocket);
      return true;
    } catch {
      return false;
    }
  };

  const start = () => {
    // Public halves are published up front, because the ssh config the editor
    // already holds names those paths -- but the PRIVATE halves deliberately
    // stay out of the agent until something asks. A stack that boots and sits
    // idle holds no usable key at all.
    for (const alias of listAliases())
      try {
        exportPublic(alias);
      } catch {
        log(`could not export the public half of '${alias}'`);
      }

    serveAgent();
    serveControl();

    // Granularity, not the deadline: keys can outlive the idle window by up to
    // one tick. Bounded at both ends -- never faster than 5s, because a short
    // window should not become a spin; never slower than 60s, because at the
    // 900s default a quarter-window tick would let keys sit for 19 minutes
    // while claiming a 15 minute bound.
    if (idleSeconds)
      setInterval(keys.sweep, Math.min(60, Math.max(5, idleSeconds / 4)) * 1000);
  };

  // ssh-agent creates its socket asynchronously; wait for it rather than racing.
  let waited = 0;
  const poll = setInterval(() => {
    if (ready()) {
      clearInterval(poll);
      start();
    } else if ((waited += 100) > 10_000) {
      clearInterval(poll);
      log(`ssh-agent never created ${UPSTREAM}`);
      process.exit(1);
    }
  }, 100);
};

if (isEntryPoint(import.meta.url)) main();
