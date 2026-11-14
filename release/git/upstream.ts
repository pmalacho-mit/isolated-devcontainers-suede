// `desolate upstream` in the git VM: propose what a consumer's branch changed in a vendored
// suede dependency to the dependency itself, as suede's `upstream` does, through a push the
// person approves (docs/v3/decisions.md, "`desolate upstream`").
//
//   desolate upstream [<consumer>] <dependency-dir> <owner/repo> [--from <ref>] [--no-wait] [--remote <url>]
//
// In the consumer's clone (/git/<owner>/<repo>), at HEAD (a clean tree) or at --from (a
// branch, `<domain>/<branch>`, a commit). The dependency's `.gitrepo` must name <owner/repo>.
//
//   1. Checks that need nothing run: the names, the `.gitrepo` (its remote is the dependency
//      named; every `.gitrepo` git-subrepo will read in the history has full commit ids), the
//      dependency's mirror has the release commit it names, and no such proposal is there yet.
//   2. suede's own upstream.sh, desolate's pinned copy (its hash checked), with the image's
//      git-subrepo, in a scratch clone: `dependency` fetches from the mirror and pushes into a
//      bare repository beside it, so what suede would have pushed is caught here.
//   3. What it made is checked (its tree is the dependency's files at that commit; it builds on
//      that release commit; it leaves .github/ alone), shown (red if it changes .suede/core/),
//      and pushed with `git push desolate-out::<owner/repo>`: the approval page, then the pusher.
//
// The vendored `<dependency>/.suede/core/upstream` is never run: it is the branch's content.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isCommit, parseRepo, repoId } from "../shared/names.ts";
import type { Repo } from "../shared/names.ts";
import { downstreamBranch, gitrepoProblem, GITHUB_DIR, remoteRepo, sameRepo, SUEDE_CORE } from "../shared/suede.ts";
import type { Gitrepo } from "../shared/suede.ts";
import { printable } from "../shared/text.ts";

export class Stop extends Error {
  fix: string | undefined;
  constructor(message: string, fix?: string) {
    super(message);
    this.fix = fix;
  }
}
const stop = (message: string, fix?: string): never => {
  throw new Stop(message, fix);
};

/** Where things are in the git VM (T1 points these elsewhere). */
export type Places = { clones: string; mirrors: string; release: string; subrepo: string; scratch: string };
export const GIT_VM: Places = { clones: "/git", mirrors: "/desolate/mirrors", release: "/desolate/release", subrepo: "/opt/git-subrepo/lib", scratch: os.tmpdir() };

const git = (dir: string, args: string[], input?: string) => {
  const ran = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_LFS_SKIP_SMUDGE: "1" } });
  return { code: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
};
const bare = (dir: string, args: string[]) => git("/", ["--git-dir", dir, ...args]);
const ok = (dir: string, args: string[], input?: string) => {
  const ran = git(dir, args, input);
  if (ran.code !== 0) stop(`git ${args[0]} failed: ${printable(ran.stderr.trim().split("\n").pop() ?? "", 300)}`);
  return ran.stdout;
};

const DIR = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
/** A ref the person names: a branch, a remote's branch, a commit. Never an option. */
const REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

export type Asked = { consumer: Repo; dir: string; dependency: Repo; from: string | null; remote: string | null };
export type Prepared = Asked & { clone: string; mirror: string; commit: string; base: string; branch: string };

/** Step 1: everything that can be refused before anything runs. */
export const prepare = (asked: Asked, at: Places = GIT_VM): Prepared => {
  const { consumer, dependency } = asked;
  const dir = asked.dir.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!DIR.test(dir) || dir.split("/").some((part) => part === "." || part === ".."))
    stop(`'${printable(asked.dir, 100)}' is not a directory in the repository`, "name the dependency's directory, relative to the repository's top: desolate upstream <dir> <owner/repo>");
  const clone = path.join(at.clones, consumer.owner, consumer.name);
  if (!fs.existsSync(path.join(clone, ".git"))) stop(`no clone of ${repoId(consumer)} here`, `on the Mac: desolate git ${repoId(consumer)}`);
  const mirror = path.join(at.mirrors, dependency.owner, `${dependency.name}.git`);
  if (!fs.existsSync(path.join(mirror, "HEAD"))) stop(`desolate holds no mirror of ${repoId(dependency)}`, `on the Mac: desolate clone ${repoId(dependency)}`);
  if (asked.remote !== null) {
    const named = remoteRepo(asked.remote);
    if (!named || !sameRepo(named, dependency))
      stop(`--remote ${printable(asked.remote, 200)} is not ${repoId(dependency)}`, `the push goes to the dependency you name; leave --remote out, or give ${repoId(dependency)}'s address`);
  }

  // The commit: what is checked out (and nothing uncommitted beside it), or what was named.
  let commit: string;
  if (asked.from === null) {
    if (git(clone, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim()) stop("you have uncommitted changes", "commit or stash them, then run it again (or name a branch: --from <ref>)");
    commit = ok(clone, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).trim();
  } else {
    if (!REF.test(asked.from) || asked.from.includes("..") || asked.from.includes("@{")) stop(`'${printable(asked.from, 100)}' is not a branch or a commit`, "--from <branch> | <domain>/<branch> | <commit>");
    // `<domain>/<branch>`: what that domain's workspaces wrote, as the root holds it now.
    const remote = asked.from.split("/")[0]!;
    if (asked.from.includes("/") && git(clone, ["remote"]).stdout.split("\n").includes(remote)) git(clone, ["fetch", "--quiet", remote]);
    const found = git(clone, ["rev-parse", "--verify", "--quiet", `${asked.from}^{commit}`]).stdout.trim();
    if (!isCommit(found)) stop(`${repoId(consumer)} has no ${printable(asked.from, 100)} here`, "git fetch <domain>, or name another: --from <ref>");
    commit = found;
  }

  // The dependency's directory, and its .gitrepo, as git has them at that commit.
  const entry = git(clone, ["ls-tree", "-z", commit, "--", dir]).stdout.split("\0")[0] ?? "";
  if (!entry.startsWith("040000 tree ")) stop(`${dir} is not a directory at ${commit.slice(0, 12)}${entry.startsWith("120000") ? " (it is a link: name the directory it points to)" : ""}`, "name the dependency's own directory");
  if (git(clone, ["cat-file", "-t", `${commit}:${dir}/.gitrepo`]).stdout.trim() !== "blob") stop(`${dir} has no .gitrepo at ${commit.slice(0, 12)}: it is not a vendored suede dependency`, "name the directory that holds the dependency's .gitrepo");
  const field = (blob: string, key: string) => {
    const read = git(clone, ["config", "--blob", blob, "--get", `subrepo.${key}`]);
    return read.code === 0 ? read.stdout.replace(/\n$/, "") : null;
  };
  const record: Gitrepo = { remote: field(`${commit}:${dir}/.gitrepo`, "remote"), branch: field(`${commit}:${dir}/.gitrepo`, "branch"), commit: field(`${commit}:${dir}/.gitrepo`, "commit"), parent: field(`${commit}:${dir}/.gitrepo`, "parent"), method: field(`${commit}:${dir}/.gitrepo`, "method") };
  // v2's H1: the person names where it goes, and a .gitrepo that names another repository stops it.
  const recorded = remoteRepo(record.remote);
  if (!recorded) stop(`${dir}/.gitrepo names no repository desolate can read (${printable(record.remote ?? "nothing", 200)})`, "fix its remote in the consumer, or propose the change by hand");
  if (!sameRepo(recorded!, dependency)) stop(`${dir}/.gitrepo says it comes from ${repoId(recorded!)}, not ${repoId(dependency)}`, `if that is where it goes: desolate upstream ${dir} ${repoId(recorded!)}`);
  const problem = gitrepoProblem(record);
  if (problem) stop(`${dir}/.gitrepo at ${commit.slice(0, 12)}: ${problem}`, "fix it in the consumer (git subrepo pull rewrites it)");
  // Every .gitrepo git-subrepo will read on its way (parent..commit): its commit becomes an argument there.
  if (record.parent !== null) {
    if (git(clone, ["merge-base", "--is-ancestor", record.parent, commit]).code !== 0) stop(`${dir}/.gitrepo's parent ${record.parent.slice(0, 12)} is not in ${commit.slice(0, 12)}'s history`, "the branch was rebased past the last sync: git subrepo can tell you how to recover (git subrepo branch)");
    for (const each of ok(clone, ["rev-list", "--ancestry-path", `${record.parent}..${commit}`]).split("\n").filter(Boolean)) {
      const value = field(`${each}:${dir}/.gitrepo`, "commit");
      if (value !== null && value !== "" && !isCommit(value)) stop(`${dir}/.gitrepo at ${each.slice(0, 12)} names a commit that is not a full id`, "that commit's .gitrepo is not one git subrepo wrote");
    }
  }
  const base = record.commit!;
  if (bare(mirror, ["cat-file", "-e", `${base}^{commit}`]).code !== 0 || !bare(mirror, ["for-each-ref", "--count=1", "--contains", base, "refs/heads"]).stdout.trim())
    stop(`${repoId(dependency)} has no ${base.slice(0, 12)} (the release commit ${dir}/.gitrepo names), as desolate last fetched it`, `on the Mac: desolate fetch ${repoId(dependency)}; if it still has none, the vendored copy did not come from there`);
  // v2's rule, before anything runs (and again on what the split made, in verify): the
  // dependency's .github/ is as the release commit has it.
  const objectAt = (run: typeof git, where: string, spec: string) => {
    const found = run(where, ["rev-parse", "--verify", "--quiet", spec]).stdout.trim();
    return isCommit(found) ? found : null;
  };
  if (objectAt(git, clone, `${commit}:${dir}/.github`) !== objectAt((_, args) => bare(mirror, args), mirror, `${base}:.github`))
    stop(`the branch changes ${dir}/.github/, which is ${repoId(dependency)}'s own .github/: a pushed branch's own workflows run there, with ${repoId(dependency)}'s secrets, on the push itself`,
      `proposals leave .github/ alone: undo that change on the branch, or make it in ${repoId(dependency)} yourself`);
  const branch = downstreamBranch(consumer, commit);
  if (bare(mirror, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0) stop(`this exact snapshot (${commit.slice(0, 12)}) is already proposed: ${repoId(dependency)} has ${branch}`, "see its pull request; a new commit is a new proposal");
  return { ...asked, dir, clone, mirror, commit, base, branch };
};

/** The pinned upstream.sh, refused unless it is the one pins.env names. */
export const pinnedScript = (at: Places = GIT_VM) => {
  const pins = fs.readFileSync(path.join(at.release, "pins.env"), "utf8");
  const want = /^SUEDE_UPSTREAM_SHA256=([0-9a-f]{64})$/m.exec(pins)?.[1];
  const script = path.join(at.release, "git", "suede-upstream.sh");
  const have = createHash("sha256").update(fs.readFileSync(script)).digest("hex");
  if (!want || have !== want) stop("desolate's copy of suede's upstream does not hash to its pin", "reinstall desolate (release/git/suede-upstream.sh, release/pins.env)");
  return script;
};

/** Step 2: suede's upstream, in a scratch clone, its push caught. Returns the scratch clone and
 *  the commit suede would have pushed. */
export const split = (p: Prepared, scratch: string, at: Places = GIT_VM): { work: string; split: string; said: string } => {
  const script = pinnedScript(at);
  const work = path.join(scratch, "consumer");
  const caught = path.join(scratch, "caught.git");
  ok("/", ["clone", "--quiet", "--shared", "--no-checkout", p.clone, work]);
  // The dependency's history, which the split builds on, without copying it: the mirror's objects.
  fs.appendFileSync(path.join(work, ".git", "objects", "info", "alternates"), `${path.join(p.mirror, "objects")}\n`);
  // git-subrepo pushes from a branch.
  ok(work, ["checkout", "--quiet", "-B", "desolate-upstream", p.commit]);
  ok(work, ["config", "remote.origin.url", `https://github.com/${repoId(p.consumer)}.git`]); // suede names the branch from it; never contacted
  ok(work, ["remote", "add", "dependency", p.mirror]);
  ok(work, ["config", "remote.dependency.pushurl", caught]);
  ok(work, ["config", "remote.dependency.uploadpack", "git -c core.alternateRefsCommand=true upload-pack"]);
  ok("/", ["init", "--quiet", "--bare", caught]);
  fs.writeFileSync(path.join(caught, "objects", "info", "alternates"), `${path.join(work, ".git", "objects")}\n`);
  // Who makes the split's commits: you (the authors stay the consumer's).
  for (const key of ["user.name", "user.email"]) {
    const mine = git(p.clone, ["config", key]).stdout.trim();
    if (!mine) stop(`git has no ${key} for you here`, `git config --global ${key} "..."`);
    ok(work, ["config", key, mine]);
  }
  const env: NodeJS.ProcessEnv = { PATH: `${at.subrepo}:/usr/local/bin:/usr/bin:/bin`, HOME: process.env.HOME ?? "/tmp", LANG: "C.UTF-8", GIT_NO_LAZY_FETCH: "1", GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" };
  const ran = spawnSync("bash", [script, p.dir, "-r", "dependency", "--no-wait"], { cwd: work, env, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  const said = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
  if (ran.status !== 0) stop(`suede's upstream stopped${ran.error ? ` (${ran.error.message})` : ""}:\n${said.trim().split("\n").slice(-12).map((line) => `    ${printable(line, 300)}`).join("\n")}`, "if it says the tree is behind, git subrepo pull in a workspace first");
  const refs = bare(caught, ["for-each-ref", "--format=%(objectname) %(refname)"]).stdout.split("\n").filter(Boolean);
  if (refs.length !== 1 || refs[0] !== `${refs[0]!.split(" ")[0]} refs/heads/${p.branch}` || !isCommit(refs[0]!.split(" ")[0]))
    stop(`suede's upstream did not make the one branch it names (${p.branch}): ${printable(refs.join(", ") || "nothing", 300)}`);
  return { work, split: refs[0]!.split(" ")[0]!, said };
};

export type Checked = { commits: string[]; stat: string; core: string[] };

/** Step 3: what the split is, checked against what it should be. */
export const verify = (p: Prepared, work: string, made: string): Checked => {
  // Its tree is the dependency's directory at that commit, less the consumer's .gitrepo.
  const listed = ok(work, ["ls-tree", "-z", `${p.commit}:${p.dir}`]).split("\0").filter((line) => line && line.split("\t")[1] !== ".gitrepo");
  const expected = ok(work, ["mktree", "-z"], listed.map((line) => `${line}\0`).join("")).trim();
  if (ok(work, ["rev-parse", `${made}^{tree}`]).trim() !== expected) stop(`the split is not ${p.dir}'s files at ${p.commit.slice(0, 12)}`, "nothing was pushed; tell desolate's maintainers what the branch was");
  if (git(work, ["merge-base", "--is-ancestor", p.base, made]).code !== 0) stop(`the split does not build on ${p.base.slice(0, 12)}, the release commit ${p.dir}/.gitrepo names`, "nothing was pushed");
  const changed = ok(work, ["diff", "--name-only", "--no-renames", "-z", p.base, made]).split("\0").filter(Boolean);
  const ci = changed.filter((file) => GITHUB_DIR.test(file));
  if (ci.length)
    stop(`the proposal changes ${repoId(p.dependency)}'s ${ci.slice(0, 3).map((f) => printable(f, 120)).join(", ")}${ci.length > 3 ? ` and ${ci.length - 3} more` : ""}: a pushed branch's own .github/ runs there, with ${repoId(p.dependency)}'s secrets, on the push itself`,
      `proposals leave .github/ alone: undo that change on the branch, or make it in ${repoId(p.dependency)} yourself`);
  const tips = bare(p.mirror, ["for-each-ref", "--format=%(objectname)", "refs/heads"]).stdout.split("\n").filter(isCommit);
  const commits = ok(work, ["log", "--no-decorate", "--format=%h %s", "--max-count=50", made, ...tips.map((tip) => `^${tip}`)]).split("\n").filter(Boolean);
  const stat = ok(work, ["diff", "--stat", "--no-ext-diff", "--no-textconv", "--no-color", p.base, made]).trimEnd();
  return { commits, stat, core: changed.filter((file) => SUEDE_CORE.test(file)) };
};

const say = (line = "") => process.stderr.write(`${line}\n`);
const red = (text: string) => (process.env.NO_COLOR ? text : `\x1b[1;31m${text}\x1b[0m`);

/** The command. Returns its exit code. */
export const upstream = async (argv: string[], cwdRepo: () => string): Promise<number> => {
  const positionals: string[] = [];
  let from: string | null = null;
  let remote: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--from") from = argv[++i] ?? stop("--from names a ref");
    else if (arg === "--remote" || arg === "-r") remote = argv[++i] ?? stop("--remote names an address");
    else if (arg === "--no-wait") continue; // (nothing waits here: the git VM has no network)
    else if (arg.startsWith("-")) stop(`unknown flag: ${printable(arg, 40)}`, "desolate upstream [<consumer>] <dependency-dir> <owner/repo> [--from <ref>] [--no-wait] [--remote <url>]");
    else positionals.push(arg);
  }
  if (positionals.length < 2 || positionals.length > 3) stop("upstream what?", "desolate upstream [<consumer>] <dependency-dir> <owner/repo> [--from <ref>]");
  const [consumerName, dir, dependencyName] = positionals.length === 3 ? positionals : [cwdRepo(), ...positionals];
  const consumer = parseRepo(consumerName) ?? stop(`'${printable(consumerName, 100)}' is not a repository`, "name it as <owner>/<repo>");
  const dependency = parseRepo(dependencyName) ?? stop(`'${printable(dependencyName, 100)}' is not a repository`, "name the dependency as <owner>/<repo>");
  if (sameRepo(consumer, dependency)) stop("the consumer and the dependency are the same repository", "name the dependency's own repository");

  const p = prepare({ consumer, dir: dir!, dependency, from, remote });
  say(`desolate upstream: ${repoId(consumer)} ${p.dir}/ at ${p.commit.slice(0, 12)}  ->  ${repoId(dependency)} ${p.branch}`);
  say(`  suede's upstream (pinned at ${/^SUEDE_COMMIT=([0-9a-f]{12})/m.exec(fs.readFileSync(path.join(GIT_VM.release, "pins.env"), "utf8"))?.[1] ?? "?"}), in a scratch clone: nothing leaves until you approve`);
  const scratch = fs.mkdtempSync(path.join(GIT_VM.scratch, "desolate-upstream-"));
  try {
    const { work, split: made } = split(p, scratch);
    const checked = verify(p, work, made);
    say(`  builds on ${repoId(dependency)}'s ${p.base.slice(0, 12)} (the release commit ${p.dir}/.gitrepo names)`);
    say(`  ${checked.commits.length} commit(s) the remote does not have:`);
    for (const line of checked.commits) say(`    ${printable(line, 200)}`);
    for (const line of checked.stat.split("\n")) say(`  ${printable(line, 200)}`);
    if (checked.core.length) {
      say(red(`  It changes suede's own machinery: ${checked.core.slice(0, 5).map((f) => printable(f, 120)).join(", ")}${checked.core.length > 5 ? ` and ${checked.core.length - 5} more` : ""}.`));
      say(red("  Every consumer of the dependency runs those files. Worth a second look before you approve."));
    }
    say();
    const pushed = await new Promise<number>((resolve) => {
      const child = spawn("git", ["-C", work, "push", `desolate-out::${repoId(dependency)}`, `${made}:refs/heads/${p.branch}`], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
      child.on("close", (code) => resolve(code ?? 1));
    });
    if (pushed !== 0) return 1;
    say();
    say(`proposed: ${repoId(dependency)} ${p.branch} at ${made}`);
    say(`  the dependency's own Action (suede-downstream-to-main) opens the pull request from it.`);
    process.stdout.write(`UPSTREAMED ${repoId(dependency)} ${p.branch} ${made}\n`);
    return 0;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};
