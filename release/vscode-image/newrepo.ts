// newrepo -- per-repo deploy-key identity, idempotent.
//
//   newrepo key   owner/repo [alias]   ensure key + ssh/git config; print pubkey
//   newrepo clone owner/repo [alias]   clone via the alias; set identity
//   newrepo status                     list configured repos
//   newrepo rm    owner/repo [alias]   forget it here: key, ssh/git config, caches
//   newrepo owner/repo [alias]         key, then clone
//
// Idempotent by design: existing keys/config/clones are reused, never
// regenerated -- rerunning after any wipe or partial setup just completes the
// missing steps. Keys persist in the vscode-home volume across container
// restarts and rebuilds (only `docker compose down -v` deletes them).
//
// Security model: the private key is generated HERE and never leaves the
// container. Only the "PUBKEY ..." line is read by cli.sh for registration.

import { execFileSync, spawnSync } from "node:child_process";
import { exchange } from "./keyring-client.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { ask } from "./broker-client.ts";
import { cacheRoot, remoteCacheRoot } from "./caches.ts";
import { reviewsOf, urlSectionsOf, withoutHostBlock } from "./removal.ts";
import { cleanGit, cloneThroughCache, registrationOf } from "./transfer.ts";

/** Overridable, as desolate.ts and transfer.ts are, so it can be pointed at a
 *  throwaway workspace; nothing sets it in production. */
const WORKSPACES = process.env.DESOLATE_WORKSPACES ?? "/workspaces";

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
const identityFile = (alias: string) => `${KEYRING_RUN}/pub/${alias}.pub`;

/** One request, one response, over the keyring's control socket.
 *
 *  Synchronous on purpose: every caller here is a step in a sequential CLI, and
 *  execFileSync sits either side of it. */
function keyring(request: Record<string, unknown>): Record<string, any> {
  const parsed = keyringAnswer(request);
  if (!parsed.ok) return die(`keyring refused: ${parsed.error}`);
  return parsed;
}

/** The keyring's answer, refusal and all: only an unreachable keyring, or
 *  one that says nothing readable, ends this process. */
function keyringAnswer(request: Record<string, unknown>): Record<string, any> {
  let raw: string;
  try {
    raw = exchange(KEYRING_CONTROL, request);
  } catch (err: any) {
    // Quote what actually failed.
    //   ENOENT       -- no socket at that path. The editor is looking at a
    //                   different volume than the keyring is writing to.
    //   EACCES       -- it is there and this uid may not connect: the socket or
    //                   the directory above it is not owned by 1000.
    //   ECONNREFUSED -- nothing is listening; the keyring died after binding.
    return die(`cannot reach the keyring at ${KEYRING_CONTROL}: ${err.message}
        Is the 'keyring' service running?   ./cli.sh up
        Check it with:                      docker logs desolate-keyring
        Compare the two sides of the volume:
          docker exec desolate-keyring ls -ln /run/keyring
          docker exec desolate-vscode  ls -ln /run/keyring`);
  }
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return die(`unreadable reply from the keyring: ${raw.slice(0, 200)}`);
  }
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
  `ssh -F ${SSH_CONFIG}` +
  (strict ? " -o StrictHostKeyChecking=accept-new" : "");

function die(msg: string): never {
  console.error(`newrepo: ${msg}`);
  process.exit(1);
}

/** An alias becomes a filename, an ssh host alias and a /workspaces
 *  subdirectory, so it has to be boring in all three. */
function sanitizeAlias(alias: string): void {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias) ||
    alias === "." ||
    alias === ".."
  ) {
    die(`bad alias: '${alias}'`);
  }
}

interface Repo {
  ownerRepo: string; // "acme/widgets"
  owner: string; // "acme"
  alias: string; // "widgets" (or user-chosen)
  project: string; // "acme/widgets" -- the path under /workspaces
  // Deliberately NO keyPath. There is no private key in this container to
  // point at; the identity is the PUBLIC half the keyring exports, and
  // `identityFile(tag)` is the only thing that names it.
  //
  // `tag`, NOT `alias`, is what the keyring is keyed on. They differ exactly
  // when two owners have a repo of the same name, which is the case the whole
  // per-repo scheme exists for -- see parseRepo.
  tag: string; // acme__widgets
  hostAlias: string; // github.com-acme__widgets
}

function parseRepo(ownerRepo: string | undefined, aliasArg?: string): Repo {
  if (!ownerRepo) die("need owner/repo");
  if (!/^[^/]+\/[^/]+$/.test(ownerRepo))
    die(`expected owner/repo form, got '${ownerRepo}'`);
  const [owner, repo] = ownerRepo.split("/");
  const alias = aliasArg ?? repo;
  sanitizeAlias(owner);
  sanitizeAlias(alias);
  // Clones land under the OWNER: /workspaces/acme/widgets. Two owners can then
  // have a repo of the same name without colliding, and the layout matches how
  // people already think about repositories.
  const project = `${owner}/${alias}`;
  // The key and ssh host alias are keyed on owner AND repo for the same reason
  // -- a key named `widgets` would have been shared by acme/widgets and
  // other/widgets, and `create` is idempotent, so the second repo would have
  // been handed the FIRST repo's public key to register. One keypair for two
  // repos is the exact blast radius this scheme exists to avoid.
  //
  // Both `tag` fields below must stay in step: the ssh config resolves a host
  // alias built from `tag` to an IdentityFile that must be the key the keyring
  // stored under the same `tag`.
  const tag = `${owner}__${alias}`;
  return {
    ownerRepo,
    owner,
    alias,
    project,
    tag,
    hostAlias: `github.com-${tag}`,
  };
}

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
    const line = fs
      .readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((l) => l.split(":")[2] === String(uid));
    // passwd is name:passwd:uid:gid:gecos:HOME:shell -- home is field 5.
    // Field 6 is the shell, which compares unequal to $HOME every time and
    // would make this warn unconditionally.
    passwdHome = line?.split(":")[5] ?? "";
  } catch {
    return;
  }
  if (!passwdHome || passwdHome === os.homedir()) return;
  console.error(
    `newrepo: NOTE -- $HOME is '${os.homedir()}' but this user's passwd entry`,
  );
  console.error(
    `         says '${passwdHome}'. Keys and ssh config are written under`,
  );
  console.error(
    `         $HOME; git here is configured to read them explicitly, but a`,
  );
  console.error(
    `         bare 'ssh'/'git' typed by hand may look in the other place.`,
  );
}

function ensureKey(repo: Repo): void {
  warnIfHomeIsAmbiguous();
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });

  // The keyring generates and keeps it. `create` is idempotent, so this both
  // makes a new key and re-exports an existing one's public half.
  const { pubkey } = keyring({ op: "create", alias: repo.tag });
  console.log(`newrepo: keyring holds the key for '${repo.project}'`);

  const configPath = `${SSH_DIR}/config`;
  const config = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf8")
    : "";
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
      `  IdentityFile ${identityFile(repo.tag)}`,
      `  IdentitiesOnly yes`,
      ``,
    ].join("\n");
    fs.appendFileSync(configPath, block);
    fs.chmodSync(configPath, 0o600);
  }

  ensureUrlRewrites(repo);

  // Machine-readable line, parsed by cli.sh for GitHub registration.
  console.log(`PUBKEY ${pubkey}`);
}

/** Route this repo's CANONICAL url through its host alias.
 *
 *  The block above only pins an identity for `git@github.com-<tag>:`. Anything
 *  naming plain `git@github.com:` matches no Host block, so `IdentitiesOnly`
 *  never applies and the agent is back to offering every deploy key it holds --
 *  the exact failure that block exists to prevent, reached by a different url.
 *
 *  Which matters because the canonical form is not ours to change.
 *
 *  In git config rather than ssh config because ssh cannot do this: it is
 *  handed a host, not a repository path, so it has nothing to select on. git is
 *  the only layer that sees which repo the url points at.
 *
 *  insteadOf matches by prefix and the longest match wins, so sibling repos
 *  sharing a prefix (`acme/widgets`, `acme/widgets-ui`) resolve correctly once
 *  each has been through here -- the more specific rule always wins over the
 *  shorter one. */
function ensureUrlRewrites(repo: Repo): void {
  const rewrites: Array<[canonical: string, aliased: string]> = [
    // scp-like: what .gitrepo carries, and what GitHub offers for copying.
    [`git@github.com:${repo.ownerRepo}`, `git@${repo.hostAlias}:${repo.ownerRepo}`],
    // The same remote spelled as a url. Rewriting only the first would leave
    // this one silently authenticating as some other repo's key.
    [
      `ssh://git@github.com/${repo.ownerRepo}`,
      `ssh://git@${repo.hostAlias}/${repo.ownerRepo}`,
    ],
  ];
  // https is deliberately left alone: it cannot use a deploy key at all
  for (const [canonical, aliased] of rewrites) {
    // --replace-all, not plain set: insteadOf is multi-valued, so re-running
    // would either stack duplicates or fail on the second key. The rewritten
    // url embeds this repo, so replacing this key's value in full is exactly
    // the intent.
    execFileSync("git", [
      "config",
      "--global",
      "--replace-all",
      `url.${aliased}.insteadOf`,
      canonical,
    ]);
  }
}

/** A clone's own config file: its `.git` a directory of its own at its own
 *  path -- not a link, put there by the project, to another project's -- and
 *  the file in it not a link either, which git would write through. */
function cloneConfigOf(dest: string): string {
  const git = `${dest}/.git`;
  const real = (path: string) => {
    try {
      return fs.realpathSync(path);
    } catch {
      return "";
    }
  };
  if (!fs.lstatSync(git, { throwIfNoEntry: false })?.isDirectory() || real(git) !== git)
    die(`${git} is not a directory of ${dest}'s own; not writing its config`);
  const config = `${git}/config`;
  if (fs.lstatSync(config, { throwIfNoEntry: false })?.isSymbolicLink())
    die(`${config} is a link; not writing through it`);
  return config;
}

/** Idempotent, and it carries the Mac's git identity in via GIT_NAME/GIT_EMAIL. */
async function doClone(repo: Repo): Promise<void> {
  const dest = `${WORKSPACES}/${repo.project}`;
  fs.mkdirSync(`${WORKSPACES}/${repo.owner}`, { recursive: true });

  // What a hand delete leaves (#63): a container's root-owned files stop a
  // plain `rm -rf` part-way, and what is left of `.git` -- its objects, say,
  // with no HEAD -- once read as "already cloned", so `repo add` did nothing
  // and said READY. Asked of the filesystem, as everything here is: the
  // project's git is not run in the editor.
  const leftover = (() => {
    if (!fs.lstatSync(dest, { throwIfNoEntry: false })) return "";
    const git = `${dest}/.git`;
    if (fs.lstatSync(git, { throwIfNoEntry: false })?.isDirectory()) {
      const missing = ["HEAD", "objects", "refs"].filter((part) => !fs.existsSync(`${git}/${part}`));
      return missing.length ? `${git} has no ${missing.join(", ")}` : "";
    }
    const entries = fs.readdirSync(dest);
    return entries.length ? `${dest} holds ${entries.slice(0, 3).join(", ")}${entries.length > 3 ? ", ..." : ""} and no clone` : "";
  })();
  if (leftover)
    die(`${leftover}: what is left of a clone deleted by hand, most likely
        (a container's root-owned files stop a plain rm part-way).
        Remove what is left, and everything desolate kept of it, then add it again:
          ./cli.sh repo rm ${repo.project} --force   (on your Mac)`);

  if (fs.existsSync(`${dest}/.git`)) {
    console.log(`newrepo: ${dest} already cloned`);
  } else {
    // Through desolate push/pull's cache (transfer.ts): the one download
    // fills it, and the project is cloned from it, so neither the first push
    // nor the first pull fetches the history again.
    try {
      // Its ssh config is transfer.ts's own, written per use from the
      // keyring's exports -- not ~/.ssh/config, which is in the home volume.
      cloneThroughCache(
        { tag: repo.tag, ownerRepo: repo.ownerRepo, url: `git@${repo.hostAlias}:${repo.ownerRepo}.git` },
        dest,
      );
    } catch (err: any) {
      die(`clone failed (${err?.message ?? err}) -- is the deploy key registered on GitHub yet?
        Repo -> Settings -> Deploy keys -> Add, paste the PUBKEY line,
        tick 'Allow write access', then rerun this command.`);
    }
  }

  // Persist it into the clone, so every LATER git operation works too -- a
  // `git push` typed in the editor's terminal invokes ssh itself, with no
  // GIT_SSH_COMMAND set, and would hit exactly the same lookup problem. Set on
  // the already-cloned path as well, to repair clones made before this existed.
  //
  // Written to the clone's config FILE by path, not `git -C <project>`: that
  // is git discovering a repository the project may have rewritten since, and
  // reading its config to write one key (audit M1).
  const config = cloneConfigOf(dest);
  const set = (key: string, value: string) => {
    if (!cleanGit(["config", "--file", config, key, value]).ok) die(`could not set ${key} in ${config}`);
  };
  set("core.sshCommand", gitSshCommand(false));

  const name = process.env.GIT_NAME;
  const email = process.env.GIT_EMAIL;
  if (name) set("user.name", name);
  if (email) set("user.email", email);

  // The clone has no checkout (transfer.ts, audit M1). Its files are written
  // by the orchestrator, in the sandbox a worktree is checked out in -- never
  // by git here. A no-op for a clone that has its files already.
  const populated = await ask({ op: "populate", project: repo.project });
  if (populated !== 0)
    die(`${dest} is cloned, but its checkout failed (exit ${populated}; the output is above).
        Starting it (desolate ${repo.project}) tries the checkout again.`);

  console.log(`READY ${dest}`);
}

/** Derived from what the keyring holds and what is on disk -- no bookkeeping
 *  of its own, so there is nothing here to drift. */
function showStatus(): void {
  // Ask the keyring, not the filesystem: ~/.ssh here holds config only now.
  const aliases: string[] = keyring({ op: "list" }).aliases ?? [];
  let found = false;
  for (const alias of aliases) {
    found = true;
    // <owner>__<repo> -> the project path it clones to.
    const project = alias.replace(/__/g, "/");
    const dest = `${WORKSPACES}/${project}`;
    const state = fs.existsSync(`${dest}/.git`)
      ? `cloned at ${dest}`
      : "key only";
    console.log(`  ${project}: ${state}`);
  }
  if (!found) console.log("  (no repos configured yet)");
}

/**
 * Forget a repository here: everything `key` and `clone` wrote in the editor
 * -- the keyring's deploy key, the ssh Host block, the url rewrites that name
 * the repository (which is also what makes it a push and pull target), and
 * the push/pull and review caches. What `cli.sh repo rm` runs once the
 * orchestrator has removed the project itself, which is why a project still
 * on disk is refused: forgetting its key first would leave a clone that can
 * neither push nor be told apart from one somebody dragged in.
 *
 * Idempotent, like the rest: whatever is already gone is skipped. Prints, for
 * cli.sh, `REPOSITORY <owner/repo>` (the registered one, so a project added
 * under an alias finds its real repository), `PUBKEY <key>` while the key is
 * still known -- the line GitHub's deploy key is matched by -- and `FORGOTTEN
 * <project>` once it is all gone.
 */
function forget(repo: Repo): void {
  const dest = `${WORKSPACES}/${repo.project}`;
  if (fs.lstatSync(dest, { throwIfNoEntry: false }))
    die(`${dest} is still there. Remove the project first, which runs this after it:
        ./cli.sh repo rm ${repo.project}   (on your Mac)`);

  // spawnSync: --get-regexp exits 1 when nothing matches, which is an answer.
  const urls = spawnSync("git", ["config", "--global", "--get-regexp", "^url\\."], { encoding: "utf8" }).stdout ?? "";
  const registered = registrationOf(repo.project, urls);
  console.log(`REPOSITORY ${registered?.ownerRepo ?? repo.ownerRepo}`);

  // The push/pull cache (transfer.ts openCache) is not removed under one
  // that is using it: refused before anything else is touched.
  const caches = remoteCacheRoot();
  const lock = join(caches, `${repo.tag}.lock`);
  if (fs.existsSync(lock)) {
    const holder = Number(fs.readFileSync(lock, "utf8"));
    let alive = false;
    try { process.kill(holder, 0); alive = true; } catch (err: any) { alive = err?.code === "EPERM"; }
    if (alive && holder !== process.pid) die(`a push or pull of ${repo.project} is running (pid ${holder}); try again once it is done`);
  }

  // Said first, removed last: a run that stops before the end leaves the key
  // in the keyring, so the next one can still name it to GitHub.
  const known = keyringAnswer({ op: "pubkey", alias: repo.tag });
  if (known.ok) console.log(`PUBKEY ${known.pubkey}`);

  const removed: string[] = [];
  if (fs.existsSync(SSH_CONFIG)) {
    const config = fs.readFileSync(SSH_CONFIG, "utf8");
    const kept = withoutHostBlock(config, repo.hostAlias);
    if (kept !== config) {
      // Beside it, then renamed over it: a half-written ssh config would stop
      // every other repository's push.
      const scratch = `${SSH_CONFIG}.desolate-${process.pid}`;
      fs.writeFileSync(scratch, kept, { mode: 0o600 });
      fs.renameSync(scratch, SSH_CONFIG);
      removed.push(`its Host ${repo.hostAlias} block in ~/.ssh/config`);
    }
  }

  for (const section of urlSectionsOf(urls, repo.tag)) {
    execFileSync("git", ["config", "--global", "--remove-section", section]);
    removed.push(`git config ${section}`);
  }

  for (const entry of [`${repo.tag}.git`, `${repo.tag}.known`, `${repo.tag}.lock`]) {
    const path = join(caches, entry);
    if (!fs.lstatSync(path, { throwIfNoEntry: false })) continue;
    fs.rmSync(path, { recursive: true, force: true });
    if (entry.endsWith(".git")) removed.push(`its push/pull cache (${path})`);
  }
  const reviews = join(cacheRoot(), "reviews");
  const entries = fs.existsSync(reviews) ? fs.readdirSync(reviews) : [];
  for (const entry of reviewsOf(entries, repo.tag)) {
    fs.rmSync(join(reviews, entry), { recursive: true, force: true });
    removed.push(`its review cache (${entry})`);
  }

  if (known.ok) {
    keyring({ op: "remove", alias: repo.tag });
    removed.push("its deploy key in the keyring");
  }

  if (removed.length) for (const what of removed) console.log(`newrepo: removed ${what}`);
  else console.log(`newrepo: nothing of ${repo.project} was left in the editor`);
  console.log(`FORGOTTEN ${repo.project}`);
}

function usage(): never {
  console.log(
    [
      "usage: newrepo key   owner/repo [alias]   ensure key + ssh/git config; print pubkey",
      "       newrepo clone owner/repo [alias]   clone via the alias; set identity",
      "       newrepo status                     list configured repos",
      "       newrepo rm    owner/repo [alias]   forget it here (cli.sh repo rm runs it)",
      "       newrepo owner/repo [alias]         key, then clone",
    ].join("\n"),
  );
  process.exit(0);
}

async function main(argv: string[]): Promise<void> {
  switch (argv[0]) {
    case "key":
      ensureKey(parseRepo(argv[1], argv[2]));
      break;
    case "clone":
      await doClone(parseRepo(argv[1], argv[2]));
      break;
    case "status":
      showStatus();
      break;
    case "rm":
      forget(parseRepo(argv[1], argv[2]));
      break;
    case undefined:
    case "-h":
    case "--help":
      usage();
    default: {
      const repo = parseRepo(argv[0], argv[1]);
      ensureKey(repo);
      await doClone(repo);
    }
  }
}

main(process.argv.slice(2));
