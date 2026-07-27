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
  alias: string;       // "widgets" (or user-chosen)
  keyPath: string;     // ~/.ssh/deploy_widgets
  hostAlias: string;   // github.com-widgets
}

function parseRepo(ownerRepo: string | undefined, aliasArg?: string): Repo {
  if (!ownerRepo) die("need owner/repo");
  if (!/^[^/]+\/[^/]+$/.test(ownerRepo)) die(`expected owner/repo form, got '${ownerRepo}'`);
  const alias = aliasArg ?? ownerRepo.split("/")[1];
  sanitizeAlias(alias);
  return {
    ownerRepo,
    alias,
    keyPath: `${SSH_DIR}/deploy_${alias}`,
    hostAlias: `github.com-${alias}`,
  };
}

// ---------------------------------------------------------------------------
// Key + ssh config (idempotent)
// ---------------------------------------------------------------------------
function ensureKey(repo: Repo): void {
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });

  if (fs.existsSync(repo.keyPath)) {
    console.log(`newrepo: reusing existing key for '${repo.alias}'`);
  } else {
    execFileSync("ssh-keygen",
      ["-t", "ed25519", "-f", repo.keyPath, "-N", "", "-C", `desolate-${repo.alias}`],
      { stdio: ["ignore", "ignore", "inherit"] });
    console.log(`newrepo: generated new key for '${repo.alias}'`);
  }

  const configPath = `${SSH_DIR}/config`;
  const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  if (!config.split("\n").includes(`Host ${repo.hostAlias}`)) {
    const block = [
      `Host ${repo.hostAlias}`,
      `  HostName github.com`,
      `  User git`,
      `  IdentityFile ${repo.keyPath}`,
      `  IdentitiesOnly yes`,
      ``,
    ].join("\n");
    fs.appendFileSync(configPath, block);
    fs.chmodSync(configPath, 0o600);
  }

  // Machine-readable line, parsed by cli.sh for GitHub registration.
  console.log(`PUBKEY ${fs.readFileSync(`${repo.keyPath}.pub`, "utf8").trim()}`);
}

// ---------------------------------------------------------------------------
// Clone (idempotent) + local git identity from GIT_NAME / GIT_EMAIL env
// ---------------------------------------------------------------------------
function doClone(repo: Repo): void {
  const dest = `${WORKSPACES}/${repo.alias}`;

  if (fs.existsSync(`${dest}/.git`)) {
    console.log(`newrepo: ${dest} already cloned`);
  } else {
    try {
      execFileSync("git", ["clone", `git@${repo.hostAlias}:${repo.ownerRepo}.git`, dest], {
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=accept-new" },
      });
    } catch {
      die(`clone failed -- is the deploy key registered on GitHub yet?
        Repo -> Settings -> Deploy keys -> Add, paste the PUBKEY line,
        tick 'Allow write access', then rerun this command.`);
    }
  }

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
  let found = false;
  let entries: string[] = [];
  try { entries = fs.readdirSync(SSH_DIR); } catch { /* no .ssh yet */ }
  for (const entry of entries) {
    const match = entry.match(/^deploy_(.+)\.pub$/);
    if (!match) continue;
    found = true;
    const alias = match[1];
    const dest = `${WORKSPACES}/${alias}`;
    const state = fs.existsSync(`${dest}/.git`) ? `cloned at ${dest}` : "key only";
    console.log(`  ${alias}: ${state}`);
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
