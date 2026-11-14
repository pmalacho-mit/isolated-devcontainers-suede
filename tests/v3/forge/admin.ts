// The forge's admin: what a person does on GitHub's website, for the tests.
//   admin.ts create-repo <owner/repo> [<seed git dir>]   a repository, optionally from a local one (LFS objects too)
//   admin.ts add-key <owner/repo> <read|write> <pubkey>  a deploy key
//   admin.ts commit <owner/repo> <branch> <file> <text> a commit by someone else, pushed to the forge
//   admin.ts pulls [<owner/repo>]                        what the stand-in Action opened
//   admin.ts pushes                                      every push the forge accepted
//   admin.ts upstream                                    every request the stand-in internet host received
//   admin.ts access                                      every request, allowed or denied
//   admin.ts refs <owner/repo>                           its branches and their commits
//   admin.ts lfs-has <owner/repo> <oid>                  exit 0 if the forge holds that object
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { lfsDir, readJson, repoDir, REPO, STATE, writeJson } from "./common.ts";
import type { Key } from "./common.ts";

const [, , verb, ...args] = process.argv;
const need = (repo: string | undefined) => {
  if (!repo || !REPO.test(repo)) throw new Error(`not a repository: ${repo}`);
  return repo;
};
const lines = (name: string) => {
  try {
    return fs.readFileSync(path.join(STATE, name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
const rewriteAuthorizedKeys = (keys: Key[]) => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const text = keys.map((key, index) =>
    `command="FORGE_STATE=${STATE} node --disable-warning=ExperimentalWarning ${here}/shell.ts ${index}",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ${key.pubkey}`).join("\n");
  fs.writeFileSync(path.join(STATE, "authorized_keys"), text + "\n", { mode: 0o644 });
};

if (verb === "create-repo") {
  const repo = need(args[0]);
  const dir = repoDir(repo);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (args[1]) {
    execFileSync("git", ["-c", "safe.directory=*", "clone", "--quiet", "--bare", args[1], dir]);
    const seedLfs = path.join(args[1], ".git", "lfs", "objects");
    if (fs.existsSync(seedLfs))
      for (const name of fs.readdirSync(seedLfs, { recursive: true }) as string[]) {
        const oid = path.basename(name);
        if (!/^[0-9a-f]{64}$/.test(oid)) continue;
        const target = path.join(lfsDir(repo), oid.slice(0, 2), oid.slice(2, 4), oid);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(seedLfs, name), target);
      }
  } else execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", dir]);
  // The stand-in for a repository's Actions: every accepted push is logged, and a push of a
  // `downstream/...` branch opens a "pull request", as suede's downstream-to-main does.
  const hook = path.join(dir, "hooks", "post-receive");
  fs.writeFileSync(hook, `#!/bin/sh
while read old new ref; do
  printf '{"time":"%s","repo":"%s","ref":"%s","old":"%s","new":"%s","key":"%s"}\\n' "$(date -u +%FT%TZ)" "$FORGE_REPO" "$ref" "$old" "$new" "$FORGE_PUSH_KEY" >>"${STATE}/pushes.log"
  case "$ref" in refs/heads/downstream/*)
    printf '{"repo":"%s","head":"%s","commit":"%s","title":"downstream proposal"}\\n' "$FORGE_REPO" "\${ref#refs/heads/}" "$new" >>"${STATE}/pulls.log" ;;
  esac
done
`, { mode: 0o755 });
  execFileSync("chown", ["-R", "git:git", dir, path.join(STATE, "lfs")], { stdio: "ignore" });
  console.log(`created ${repo}`);
} else if (verb === "add-key") {
  const repo = need(args[0]);
  const role = args[1];
  if (role !== "read" && role !== "write") throw new Error("role is read or write");
  if (!fs.existsSync(repoDir(repo))) throw new Error(`no such repository: ${repo}`);
  const pubkey = args.slice(2).join(" ").trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$/.test(pubkey)) throw new Error("not an ed25519 public key");
  const keys = readJson<Key[]>("keys.json", []);
  // GitHub refuses a deploy key that is already in use anywhere.
  if (keys.some((key) => key.pubkey.split(" ")[1] === pubkey.split(" ")[1] && (key.repo !== repo || key.role !== role))) throw new Error("key is already in use");
  if (!keys.some((key) => key.pubkey.split(" ")[1] === pubkey.split(" ")[1])) keys.push({ repo, role, pubkey });
  writeJson("keys.json", keys);
  rewriteAuthorizedKeys(keys);
  console.log(`added a ${role} key to ${repo}`);
} else if (verb === "commit") {
  // Someone else pushed: a new commit on a branch of the repository, made on the forge.
  const repo = need(args[0]);
  const [, branch, file, content] = args;
  const work = fs.mkdtempSync("/tmp/forge-commit-");
  const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" };
  const git = (...argv: string[]) => execFileSync("git", ["-C", work, "-c", "user.name=someone", "-c", "user.email=someone@example.invalid", ...argv], { encoding: "utf8", env });
  execFileSync("git", ["clone", "--quiet", repoDir(repo), work], { env });
  try {
    git("checkout", "--quiet", branch!);
  } catch {
    git("checkout", "--quiet", "-b", branch!);
  }
  fs.writeFileSync(path.join(work, file!), content ?? "");
  git("add", "-A");
  git("commit", "--quiet", "-m", `someone: ${file}`);
  git("push", "--quiet", "origin", branch!);
  process.stdout.write(git("rev-parse", "HEAD"));
  fs.rmSync(work, { recursive: true, force: true });
  execFileSync("chown", ["-R", "git:git", repoDir(repo)], { stdio: "ignore" });
} else if (verb === "squash-merge") {
  // A pull request merged on the forge by squashing, its branch then deleted (GitHub's
  // "delete head branch"): the base gets one new commit, and the branch's commits never
  // become part of it.
  const repo = need(args[0]);
  const [, branch, into] = args;
  const work = fs.mkdtempSync("/tmp/forge-merge-");
  const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" };
  const git = (...argv: string[]) => execFileSync("git", ["-C", work, "-c", "user.name=someone", "-c", "user.email=someone@example.invalid", ...argv], { encoding: "utf8", env });
  execFileSync("git", ["clone", "--quiet", repoDir(repo), work], { env });
  git("checkout", "--quiet", into!);
  git("merge", "--quiet", "--squash", `origin/${branch}`);
  git("commit", "--quiet", "-m", `${branch} (squashed)`);
  git("push", "--quiet", "--no-verify", "origin", into!, `:${branch}`);
  process.stdout.write(git("rev-parse", "HEAD"));
  fs.rmSync(work, { recursive: true, force: true });
  execFileSync("chown", ["-R", "git:git", repoDir(repo)], { stdio: "ignore" });
} else if (verb === "pulls") {
  console.log(JSON.stringify(lines("pulls.log").filter((pull) => !args[0] || pull.repo === args[0])));
} else if (verb === "pushes") {
  console.log(JSON.stringify(lines("pushes.log")));
} else if (verb === "upstream") {
  console.log(JSON.stringify(lines("upstream.log")));
} else if (verb === "access") {
  console.log(JSON.stringify(lines("access.log")));
} else if (verb === "refs") {
  process.stdout.write(execFileSync("git", ["-c", "safe.directory=*", "-C", repoDir(need(args[0])), "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]));
} else if (verb === "lfs-has") {
  const oid = String(args[1]);
  process.exit(fs.existsSync(path.join(lfsDir(need(args[0])), oid.slice(0, 2), oid.slice(2, 4), oid)) ? 0 : 1);
} else {
  console.error("usage: admin.ts create-repo|add-key|pulls|pushes|access|refs|lfs-has ...");
  process.exit(64);
}
