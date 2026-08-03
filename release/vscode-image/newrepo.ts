// newrepo -- per-repo deploy-key identity, idempotent.
//
//   newrepo key   owner/repo [alias]   ensure key + ssh config; print pubkey
//   newrepo clone owner/repo [alias]   clone via the alias; set identity
//   newrepo status                     list configured repos
//   newrepo owner/repo [alias]         key, then clone
//
// Idempotent by design: existing keys/config/clones are reused, never
// regenerated -- rerunning after any wipe or partial setup just completes the
// missing steps. Keys persist in the vscode-home volume across container
// restarts and rebuilds (only `docker compose down -v` deletes them).
//
// Security model: the private key is generated HERE and never leaves the
// container. Only the "PUBKEY ..." line is read by cli.sh for registration.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

const WORKSPACES = "/workspaces";

// Piping our output to `head`/`grep -q` closes stdout early; bash tools
// ignore the resulting SIGPIPE, Node crashes on EPIPE. Exit quietly instead.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const SSH_DIR = `${os.homedir()}/.ssh`;
const SSH_CONFIG = `${SSH_DIR}/config`;

/** The keyring holds the private halves; this container never sees one.
 *
 *  ~/.ssh here holds the CONFIG only. Key generation, storage and signing all
 *  happen in the keyring container over these two sockets, because a repo's own
 *  .git/config and .gitattributes are executable configuration and the editor
 *  runs git against project content -- so any project can eventually execute
 *  code here. What it finds when it does is public keys and a socket. */
const KEYRING_RUN = process.env.DESOLATE_KEYRING_RUN ?? "/run/keyring";
const KEYRING_CONTROL = `${KEYRING_RUN}/control.sock`;
const identityFile = (alias: string) => `${KEYRING_RUN}/pub/deploy_${alias}.pub`;

/** One request, one response, over the keyring's control socket.
 *
 *  Synchronous on purpose: every caller here is a step in a sequential CLI, and
 *  execFileSync sits either side of it. */
function keyring(request: Record<string, unknown>): Record<string, any> {
  const script = `
    const net = require("node:net");
    const c = net.createConnection(${JSON.stringify(KEYRING_CONTROL)});
    let buf = "";
    c.on("connect", () => c.write(${JSON.stringify(JSON.stringify(request))} + "\n"));
    c.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) { process.stdout.write(buf.split("\n")[0]); c.end(); }
    });
    c.on("error", (e) => { console.error(String(e.message)); process.exit(1); });
  `;
  let raw: string;
  try {
    raw = execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return die(`cannot reach the keyring at ${KEYRING_CONTROL}.
        Is the 'keyring' service running?   ./cli.sh up
        Check it with:                      docker logs desolate-keyring`);
  }
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return die(`unreadable reply from the keyring: ${raw.slice(0, 200)}`);
  }
  if (!parsed.ok) return die(`keyring refused: ${parsed.error}`);
  return parsed;
}

/** How git must invoke ssh for the per-repo host aliases to resolve.
 *
 *  `-F` is not belt-and-braces, it is required. Node's os.homedir() prefers
 *  $HOME; OpenSSH finds the user's config through getpwuid(). When those
 *  disagree -- and in this image they can -- newrepo writes ~/.ssh/config to one
 *  path while ssh reads another, the `Host github.com-<alias>` block is never
 *  applied, and ssh treats the alias as a literal hostname:
 *
 *    ssh: Could not resolve hostname github.com-myrepo: Name or service not known
 *
 *  Naming the file explicitly makes it independent of that disagreement. */
const gitSshCommand = (strict = true) =>
  `ssh -F ${SSH_CONFIG}` + (strict ? " -o StrictHostKeyChecking=accept-new" : "");

function die(msg: string): never {
  console.error(`newrepo: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Input validation: aliases become filenames, ssh host aliases, and
// /workspaces subdirectories -- keep them boring.
// ---------------------------------------------------------------------------
function sanitizeAlias(alias: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias) || alias === "." || alias === "..") {
    die(`bad alias: '${alias}'`);
  }
}

interface Repo {
  ownerRepo: string;   // "acme/widgets"
  owner: string;       // "acme"
  alias: string;       // "widgets" (or user-chosen)
  project: string;     // "acme/widgets" -- the path under /workspaces
  // Deliberately NO keyPath. There is no private key in this container to
  // point at; the identity is the PUBLIC half the keyring exports, and
  // `identityFile(alias)` is the only thing that names it.
  hostAlias: string;   // github.com-acme__widgets
}

function parseRepo(ownerRepo: string | undefined, aliasArg?: string): Repo {
  if (!ownerRepo) die("need owner/repo");
  if (!/^[^/]+\/[^/]+$/.test(ownerRepo)) die(`expected owner/repo form, got '${ownerRepo}'`);
  const [owner, repo] = ownerRepo.split("/");
  const alias = aliasArg ?? repo;
  sanitizeAlias(owner);
  sanitizeAlias(alias);
  // Clones land under the OWNER: /workspaces/acme/widgets. Two owners can then
  // have a repo of the same name without colliding, and the layout matches how
  // people already think about repositories.
  const project = `${owner}/${alias}`;
  // The key and ssh host alias are keyed on owner AND repo for the same reason
  // -- `deploy_widgets` would have been shared by acme/widgets and other/widgets
  // and silently handed the wrong identity to one of them.
  const tag = `${owner}__${alias}`;
  return {
    ownerRepo,
    owner,
    alias,
    project,
    hostAlias: `github.com-${tag}`,
  };
}

// ---------------------------------------------------------------------------
// Key + ssh config (idempotent)
// ---------------------------------------------------------------------------
/** Warn when $HOME and the passwd entry disagree.
 *
 *  Everything here writes relative to os.homedir() ($HOME), while ssh, and
 *  anything else consulting getpwuid(), may look somewhere else entirely. The
 *  git paths below name their config explicitly so they do not care -- but a
 *  developer typing `ssh` or `git` by hand in the editor terminal will, and the
 *  resulting error names a hostname rather than a config file. Say it once,
 *  here, where the keys are created. */
function warnIfHomeIsAmbiguous(): void {
  let passwdHome = "";
  try {
    const uid = process.getuid?.() ?? -1;
    const line = fs.readFileSync("/etc/passwd", "utf8").split("\n")
      .find(l => l.split(":")[2] === String(uid));
    // passwd is name:passwd:uid:gid:gecos:HOME:shell -- home is field 5.
    // Field 6 is the shell, which compares unequal to $HOME every time and
    // would make this warn unconditionally.
    passwdHome = line?.split(":")[5] ?? "";
  } catch { return; }
  if (!passwdHome || passwdHome === os.homedir()) return;
  console.error(`newrepo: NOTE -- $HOME is '${os.homedir()}' but this user's passwd entry`);
  console.error(`         says '${passwdHome}'. Keys and ssh config are written under`);
  console.error(`         $HOME; git here is configured to read them explicitly, but a`);
  console.error(`         bare 'ssh'/'git' typed by hand may look in the other place.`);
}

function ensureKey(repo: Repo): void {
  warnIfHomeIsAmbiguous();
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });

  // The keyring generates and keeps it. `create` is idempotent, so this both
  // makes a new key and re-exports an existing one's public half.
  const { pubkey } = keyring({ op: "create", alias: repo.alias });
  console.log(`newrepo: keyring holds the key for '${repo.alias}'`);

  const configPath = `${SSH_DIR}/config`;
  const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  if (!config.split("\n").includes(`Host ${repo.hostAlias}`)) {
    const block = [
      `Host ${repo.hostAlias}`,
      `  HostName github.com`,
      `  User git`,
      // A PUBLIC key as IdentityFile. ssh pairs it with the agent's private
      // half, which is what keeps `IdentitiesOnly yes` usable: with several
      // deploy keys loaded, an agent offers them in an arbitrary order and
      // GitHub authenticates as whichever repo matches first, so pushing to A
      // can authenticate as B. Pinning the identity per host alias avoids that
      // without the editor ever holding a private key.
      `  IdentityFile ${identityFile(repo.alias)}`,
      `  IdentitiesOnly yes`,
      ``,
    ].join("\n");
    fs.appendFileSync(configPath, block);
    fs.chmodSync(configPath, 0o600);
  }

  // Machine-readable line, parsed by cli.sh for GitHub registration.
  console.log(`PUBKEY ${pubkey}`);
}

// ---------------------------------------------------------------------------
// Clone (idempotent) + local git identity from GIT_NAME / GIT_EMAIL env
// ---------------------------------------------------------------------------
function doClone(repo: Repo): void {
  const dest = `${WORKSPACES}/${repo.project}`;
  fs.mkdirSync(`${WORKSPACES}/${repo.owner}`, { recursive: true });

  if (fs.existsSync(`${dest}/.git`)) {
    console.log(`newrepo: ${dest} already cloned`);
  } else {
    try {
      execFileSync("git", ["clone", `git@${repo.hostAlias}:${repo.ownerRepo}.git`, dest], {
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, GIT_SSH_COMMAND: gitSshCommand() },
      });
    } catch {
      die(`clone failed -- is the deploy key registered on GitHub yet?
        Repo -> Settings -> Deploy keys -> Add, paste the PUBKEY line,
        tick 'Allow write access', then rerun this command.`);
    }
  }

  // Persist it into the clone, so every LATER git operation works too -- a
  // `git push` typed in the editor's terminal invokes ssh itself, with no
  // GIT_SSH_COMMAND set, and would hit exactly the same lookup problem. Set on
  // the already-cloned path as well, to repair clones made before this existed.
  execFileSync("git", ["-C", dest, "config", "core.sshCommand", gitSshCommand(false)]);

  const name = process.env.GIT_NAME;
  const email = process.env.GIT_EMAIL;
  if (name) execFileSync("git", ["-C", dest, "config", "user.name", name]);
  if (email) execFileSync("git", ["-C", dest, "config", "user.email", email]);

  console.log(`READY ${dest}`);
}

// ---------------------------------------------------------------------------
// Status: derived from key files + workspace state, no bookkeeping to drift.
// ---------------------------------------------------------------------------
function showStatus(): void {
  // Ask the keyring, not the filesystem: ~/.ssh here holds config only now.
  const aliases: string[] = keyring({ op: "list" }).aliases ?? [];
  let found = false;
  for (const alias of aliases) {
    found = true;
    // <owner>__<repo> -> the project path it clones to.
    const project = alias.replace(/__/g, "/");
    const dest = `${WORKSPACES}/${project}`;
    const state = fs.existsSync(`${dest}/.git`) ? `cloned at ${dest}` : "key only";
    console.log(`  ${project}: ${state}`);
  }
  if (!found) console.log("  (no repos configured yet)");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
function usage(): never {
  console.log([
    "usage: newrepo key   owner/repo [alias]   ensure key + ssh config; print pubkey",
    "       newrepo clone owner/repo [alias]   clone via the alias; set identity",
    "       newrepo status                     list configured repos",
    "       newrepo owner/repo [alias]         key, then clone",
  ].join("\n"));
  process.exit(0);
}

const argv = process.argv.slice(2);
switch (argv[0]) {
  case "key":    ensureKey(parseRepo(argv[1], argv[2])); break;
  case "clone":  doClone(parseRepo(argv[1], argv[2])); break;
  case "status": showStatus(); break;
  case undefined:
  case "-h":
  case "--help": usage();
  default: {
    const repo = parseRepo(argv[0], argv[1]);
    ensureKey(repo);
    doClone(repo);
  }
}
