// Powers the only container in this stack that holds raw private keys.
/// <reference types="node" />
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:net";
import * as path from "node:path";

const KEYS = process.env.DESOLATE_KEYRING_KEYS ?? "/var/lib/keyring";
const RUN = process.env.DESOLATE_KEYRING_RUN ?? "/run/keyring";
const PUB = `${RUN}/pub`;
const AGENT = `${RUN}/agent.sock`;
const CONTROL = `${RUN}/control.sock`;

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
const validAlias = (alias: unknown): alias is string =>
  typeof alias === "string" &&
  alias.length > 0 &&
  alias.length <= 128 &&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias) &&
  !alias.includes("..");

const keyPath = (alias: string) => path.join(KEYS, `deploy_${alias}`);
const pubPath = (alias: string) => path.join(PUB, `deploy_${alias}.pub`);

const listAliases = (): string[] => {
  try {
    return fs
      .readdirSync(KEYS)
      .map((e) => e.match(/^deploy_(.+)\.pub$/)?.[1])
      .filter((a): a is string => !!a)
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

const addToAgent = (alias: string) => {
  execFileSync("ssh-add", [keyPath(alias)], {
    env: { ...process.env, SSH_AUTH_SOCK: AGENT },
    stdio: ["ignore", "ignore", "inherit"],
  });
};

const createKey = (alias: string): string => {
  const key = keyPath(alias);
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
      env: { ...process.env, SSH_AUTH_SOCK: AGENT },
      stdio: "ignore",
    });
  } catch {
    /* not loaded */
  }
  for (const p of [keyPath(alias), `${keyPath(alias)}.pub`, pubPath(alias)])
    try {
      fs.unlinkSync(p);
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

// ---------------------------------------------------------------------------
// start the agent, reload what we already hold, then serve control
// ---------------------------------------------------------------------------
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
agent.on("exit", (code) => {
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

  createServer((connection) => {
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let response: Record<string, unknown>;
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
    log(`agent at ${AGENT}, control at ${CONTROL}`);
    log(`holding ${listAliases().length} key(s); public halves in ${PUB}`);
  });
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
