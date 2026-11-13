// The git VM: where the person types git, in a browser tab (host/git-web.ts), in clones of
// their own. Not the root VM: the root's user parses what domains send and talks to the
// keyring, and a shell there is a shell beside all of that. Not a workspace: nothing of a
// project's runs here (no devcontainer, no direnv, no hook), and there is no network at all.
//
//   /git/<owner>/<repo>      the person's clones (on the Mac: ~/.desolate/git), read-write
//   /desolate/mirrors        what each remote published, read-only (`origin` fetches here)
//   /desolate/root           the root's clones, read-only: `git fetch root` brings what the
//                            domains offered, as root/<domain>/<branch>
//   /desolate/out            pushes, handed to the host (~/.desolate/git-out)
//
// `git push origin <branch>` there writes a bundle and a request to /desolate/out
// (git/git-remote-desolate-out.ts); the host hands it to the root (ops.ts, `git.push`),
// which checks every object as it does a domain's and pushes after the person approves on
// the approval page. The git VM cannot write anything the root reads but what the host
// copies on.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { refuse } from "../shared/exit.ts";
import { gitVmName, isBranch, isCommit, isLfsOid, isSlug, parseRepo, repoId } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { guest, INSTANCE, paths, RELEASE_DIR } from "./paths.ts";
import { backend, rootctl } from "./stack.ts";
import type { VmSpec } from "./vm/types.ts";

export const GIT_VM = gitVmName(INSTANCE);

export const gitSpec = (): VmSpec => ({
  name: GIT_VM,
  role: "git",
  egress: "none",
  shares: [
    { host: RELEASE_DIR, guest: guest.release, writable: false },
    { host: paths.mirrors, guest: guest.mirrors, writable: false },
    { host: paths.rootClones, guest: guest.rootClones, writable: false },
    { host: paths.git, guest: guest.git, writable: true },
    { host: paths.gitOut, guest: guest.gitOut, writable: true },
    // The host's answers: the git VM reads them, and cannot leave a link where one is written.
    { host: paths.gitAnswers, guest: guest.gitAnswers, writable: false },
  ],
  sockets: [],
  cpus: 2,
  memoryMiB: 1536,
  diskGiB: 10,
  labels: { title: "git" },
});

/** Make the git VM if there is none, start it, and give it its settings. Idempotent. */
export const ensureGitVm = async (log: (line: string) => void = () => {}) => {
  const b = backend();
  for (const dir of [paths.git, paths.gitOut, paths.gitAnswers]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = await b.info(GIT_VM);
  if (info.status === "missing") {
    log("git VM: making it (once)");
    await b.ensureImage(log);
    await b.create(gitSpec());
  }
  if ((await b.info(GIT_VM)).status !== "running") await b.start(GIT_VM);
  const provisioned = await b.exec(GIT_VM, ["bash", `${guest.release}/git/provision.sh`], { root: true, timeoutMs: 120_000 });
  if (provisioned.code !== 0) refuse(`the git VM could not be set up: ${(provisioned.stderr || provisioned.stdout).trim().slice(-300)}`, "desolate doctor");
};

/** The person's clone of a repository in the git VM: from the mirror, with `root` as a
 *  second remote (what the domains offered), and `origin`'s push going to the host. */
export const ensureGitClone = async (repo: Repo) => {
  const id = repoId(repo);
  const mirror = guest.mirror(repo);
  const dir = `${guest.git}/${repo.owner}/${repo.name}`;
  // A remote for each domain that has this repository: `git fetch <domain>` brings what its
  // workspaces wrote (<domain>/<branch>), and `git push <domain> <branch>` delivers a branch
  // to it (its workspaces see root/<branch>). (A domain named like a remote already here is
  // reached through `root` alone.)
  const domainList = (await rootctl<{ slug: string; repos: string[] }[]>("domain.list", {}, { quiet: true }).catch(() => []))
    .filter((d) => d.repos.includes(id) && isSlug(d.slug) && d.slug !== "origin" && d.slug !== "root").map((d) => d.slug);
  const perDomain = domainList.flatMap((d) => [
    `git remote get-url ${d} >/dev/null 2>&1 || git remote add ${d} "$4"`,
    `git config remote.${d}.url "$4"`,
    `git config --replace-all remote.${d}.fetch '+refs/remotes/${d}/*:refs/remotes/${d}/*'`,
    `git config remote.${d}.pushurl "desolate-out::$3@${d}"`,
    `git config remote.${d}.uploadpack "git -c core.alternateRefsCommand=true upload-pack"`,
  ]);
  const script = [
    "set -euo pipefail",
    `if [ ! -d "$2/.git" ]; then mkdir -p "$(dirname "$2")"; GIT_LFS_SKIP_SMUDGE=1 git clone --no-local --quiet "$1" "$2"; fi`,
    'cd "$2"',
    `git config remote.origin.url "$1"`,
    `git config remote.origin.pushurl "desolate-out::$3"`,
    `git config lfs.url "file://$1"`,
    "git config lfs.locksverify false",
    `git remote get-url root >/dev/null 2>&1 || git remote add root "$4"`,
    `git config remote.root.url "$4"`,
    // What the root holds of each domain's offers: root/<domain>/<branch>.
    `git config --replace-all remote.root.fetch '+refs/remotes/*:refs/remotes/root/*'`,
    `git config remote.root.pushurl /nonexistent/the-root-is-not-pushed-to`,
    // `origin` and `root` are the root's user's repositories (the mirror; its clone), and a
    // local fetch runs upload-pack under THEIR config. What of it could name a command is
    // set here, on this side, where the root's user cannot write: the alternates' refs come
    // from a command that prints nothing. (uploadpack.packObjectsHook needs no setting: git
    // reads it from no repository's own config. Set empty, it was a command to run, and
    // every fetch failed: "unable to fork git-pack-objects".)
    `git config remote.origin.uploadpack "git -c core.alternateRefsCommand=true upload-pack"`,
    `git config remote.root.uploadpack "git -c core.alternateRefsCommand=true upload-pack"`,
    ...perDomain,
    "git lfs pull >/dev/null 2>&1 || true",
  ].join("\n");
  const made = await backend().exec(GIT_VM, ["bash", "-c", script, "_", mirror, dir, id, `${guest.rootClones}/${repo.owner}/${repo.name}`], { timeoutMs: 1_800_000 });
  if (made.code !== 0) refuse(`the git VM could not clone ${id}: ${(made.stderr || made.stdout).trim().slice(-300)}`, `desolate clone ${id} first, if the root has not`);
  return dir;
};

// ---------------------------------------------------------------- pushes from the git VM
// The out-box is the git VM's to write: any name in it may be a link, a FIFO, a directory, or
// a file the git VM still holds open and will change. So the host never follows a name
// there, never moves a file out of it, and never writes into it: it opens each file without
// following links, checks it is a plain file of a bounded size, and COPIES what it reads into
// a file of its own; answers go to a directory only the host writes (read-only to the git VM).
const GIT_IN = path.join(paths.rootClones, ".git-in");
const LIMIT = { request: 64 * 1024, bundle: 2 * 1024 ** 3, lfs: 5 * 1024 ** 3, objects: 2000 } as const;
const NOFOLLOW = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/** A plain file in the out-box, opened without following a link; null if it is not one. */
const openPlain = (file: string, most: number): { fd: number; size: number } | null => {
  let fd: number;
  try {
    fd = fs.openSync(file, NOFOLLOW);
  } catch {
    return null;
  }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size > most) {
    fs.closeSync(fd);
    return null;
  }
  return { fd, size: stat.size };
};

/** A directory the host made, in a share the root's user can write: a real directory, not
 *  a link it left there. */
const ownDirectory = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== path.resolve(dir)) throw new Error(`${dir} is not the host's own directory`);
};

/** Copy from a descriptor into a new file of the host's (never an existing one), hashing on
 *  the way; at most `size` bytes, what the descriptor said it held. */
const copyOut = (from: { fd: number; size: number }, to: string): string => {
  const out = fs.openSync(to, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (let done = 0; done < from.size; ) {
      const read = fs.readSync(from.fd, buffer, 0, Math.min(buffer.length, from.size - done), done);
      if (read === 0) throw new Error("the file got shorter while it was copied");
      hash.update(buffer.subarray(0, read));
      fs.writeSync(out, buffer, 0, read);
      done += read;
    }
  } finally {
    fs.closeSync(out);
  }
  return hash.digest("hex");
};

/** The answer the git VM's helper waits for: in the host's own directory. */
const answerFile = (id: string) => path.join(paths.gitAnswers, `${id}.json`);
const answer = (id: string, value: Record<string, unknown>) => {
  const temp = path.join(paths.gitAnswers, `.${id}.${randomBytes(4).toString("hex")}`);
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o644, flag: "wx" });
  fs.renameSync(temp, answerFile(id));
};

/** One request the git VM left: read safely, its files copied where the root reads them,
 *  handed to the root, and the answer left where the git VM reads it. */
const FETCH_GAP_MS = 5000;
const fetchedAt = new Map<string, number>();
const take = async (id: string, log: (line: string) => void, announce: (fields: Record<string, unknown>) => void = () => {}) => {
  const out = paths.gitOut;
  const opened = openPlain(path.join(out, `${id}.json`), LIMIT.request);
  fs.rmSync(path.join(out, `${id}.json`), { force: true });
  if (!opened) return;
  let asked: { op?: unknown; repo?: unknown; branch?: unknown; commit?: unknown; forced?: unknown; lfs?: unknown; domain?: unknown };
  try {
    const text = Buffer.alloc(opened.size);
    fs.readSync(opened.fd, text, 0, opened.size, 0);
    asked = JSON.parse(text.toString("utf8")) as typeof asked;
  } catch {
    return answer(id, { pushed: false, error: "the git VM's request is not JSON" });
  } finally {
    fs.closeSync(opened.fd);
  }
  const repo = parseRepo(asked.repo);
  // `desolate fetch` in the git VM: the root refreshes the mirror (with its read key), and
  // the git VM then fetches from it. At most once every few seconds a repository.
  if (asked.op === "fetch") {
    if (!repo) return answer(id, { fetched: false, error: "the git VM's request is not one desolate makes" });
    const last = fetchedAt.get(repoId(repo)) ?? 0;
    if (Date.now() - last < FETCH_GAP_MS) return answer(id, { fetched: true, said: [`${repoId(repo)}: refreshed a moment ago`] });
    fetchedAt.set(repoId(repo), Date.now());
    try {
      await rootctl("repo.fetch", { repo: repoId(repo) }, { quiet: true, timeoutMs: 10 * 60_000 });
      return answer(id, { fetched: true });
    } catch (error) {
      return answer(id, { fetched: false, error: (error as Error).message });
    }
  }
  const domain = asked.domain === undefined ? null : isSlug(asked.domain) ? String(asked.domain) : false;
  if (domain === false) return answer(id, { pushed: false, error: "the git VM's request names no domain desolate would make" });
  const lfs = Array.isArray(asked.lfs) ? asked.lfs : [];
  if (!repo || !isBranch(asked.branch) || !isCommit(asked.commit) || lfs.length > LIMIT.objects || !lfs.every(isLfsOid) || new Set(lfs).size !== lfs.length)
    return answer(id, { pushed: false, error: "the git VM's request is not one desolate makes" });
  ownDirectory(GIT_IN);
  const name = randomBytes(8).toString("hex");
  const bundleTo = path.join(GIT_IN, `${name}.bundle`);
  const lfsTo = path.join(GIT_IN, `${name}.lfs`);
  try {
    // Copied, never moved: the git VM keeps no hold on the root's copy.
    const bundle = openPlain(path.join(out, `${id}.bundle`), LIMIT.bundle);
    if (!bundle) return answer(id, { pushed: false, error: "the push's bundle is not a plain file of at most 2 GiB" });
    try {
      copyOut(bundle, bundleTo);
    } finally {
      fs.closeSync(bundle.fd);
    }
    if (lfs.length) {
      fs.mkdirSync(lfsTo, { mode: 0o700 });
      for (const oid of lfs as string[]) {
        // Flat names in the out-box: no directory of the git VM's is ever walked into.
        const object = openPlain(path.join(out, `${id}.${oid}.lfs`), LIMIT.lfs);
        if (!object) return answer(id, { pushed: false, error: `the LFS object ${oid.slice(0, 12)} is not a plain file` });
        try {
          if (copyOut(object, path.join(lfsTo, oid)) !== oid) return answer(id, { pushed: false, error: `the LFS object ${oid.slice(0, 12)} does not hash to its name` });
        } finally {
          fs.closeSync(object.fd);
        }
      }
    }
    log(`git VM: ${domain ? `a delivery to ${domain}` : "a push"} of ${repoId(repo)} ${String(asked.branch)} at ${String(asked.commit)}, handed to the root`);
    announce({ repo: repoId(repo), branch: asked.branch, commit: asked.commit, ...(domain ? { domain } : {}) });
    const reply = await rootctl<{ pushed: boolean; error?: string; said?: string[] }>("git.push", { repo: repoId(repo), branch: asked.branch, commit: asked.commit, forced: asked.forced === true, bundle: `${name}.bundle`, lfs, ...(domain ? { domain } : {}) }, { quiet: true, timeoutMs: 20 * 60_000 });
    answer(id, reply);
  } catch (error) {
    answer(id, { pushed: false, error: (error as Error).message });
  } finally {
    fs.rmSync(bundleTo, { force: true });
    fs.rmSync(lfsTo, { recursive: true, force: true });
    for (const leftover of [`${id}.bundle`, ...lfs.map((oid) => `${id}.${String(oid)}.lfs`)]) fs.rmSync(path.join(out, leftover), { force: true });
  }
};

/** Watch what the git VM leaves: one request at a time (a git VM cannot crowd the root, or
 *  the approval page). (The host daemon runs this.) */
export const watchGitOut = (log: (line: string) => void, announce: (fields: Record<string, unknown>) => void = () => {}) => {
  for (const dir of [paths.gitOut, paths.gitAnswers]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let busy = false;
  const scan = () => {
    if (busy) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(paths.gitOut);
    } catch {
      return;
    }
    // Answers nobody read within the hour: gone.
    try {
      for (const old of fs.readdirSync(paths.gitAnswers)) {
        const file = path.join(paths.gitAnswers, old);
        if (Date.now() - fs.lstatSync(file).mtimeMs > 3_600_000) fs.rmSync(file, { force: true });
      }
    } catch {
      /* nothing there */
    }
    const id = names.map((file) => /^([0-9a-f]{16})\.json$/.exec(file)?.[1]).find(Boolean);
    if (!id) return;
    busy = true;
    void take(id, log, announce)
      .catch((error: Error) => {
        log(`git VM: a request could not be taken: ${error.message}`);
        try {
          answer(id, { pushed: false, error: error.message });
        } catch {
          /* nothing more to say */
        }
      })
      .finally(() => {
        busy = false;
        // One that landed while this was taken: its event came and went.
        scan();
      });
  };
  // The share's files are the Mac's, so a request the git VM writes is a file event here:
  // taken as it lands. The look every few seconds is for an event missed (or a watch that
  // failed), not the way requests arrive.
  try {
    const watcher = fs.watch(paths.gitOut, (_event, file) => {
      if (file === null || /\.json$/.test(String(file))) scan();
    });
    watcher.on("error", () => watcher.close());
    watcher.unref();
  } catch {
    /* no outbox yet: the look below finds requests */
  }
  const timer = setInterval(scan, 5000);
  timer.unref();
  scan();
};
