// The forced command of every key the forge knows: `command="node shell.ts <index>"` in
// authorized_keys. The key decides what it may do, as a deploy key does:
//   read key   git-upload-pack, LFS download            for ITS repository only
//   write key  those, plus git-receive-pack, LFS upload for ITS repository only
import { spawnSync } from "node:child_process";
import { append, config, mintToken, readJson, repoDir, REPO } from "./common.ts";
import type { Key } from "./common.ts";

const key = readJson<Key[]>("keys.json", [])[Number(process.argv[2])];
const command = process.env.SSH_ORIGINAL_COMMAND ?? "";
const deny = (why: string): never => {
  append("access.log", { key: key ? `${key.role}:${key.repo}` : "unknown", command, verdict: "denied", why });
  console.error(`ERROR: ${why}`);
  process.exit(1);
};
if (!key) deny("this key is not registered");

const pack = /^(git-upload-pack|git-receive-pack) '?\/?([^']+?)(?:\.git)?'?$/.exec(command);
const lfs = /^git-lfs-authenticate \/?(\S+?)(?:\.git)? (download|upload)$/.exec(command);
const repo = pack?.[2] ?? lfs?.[1] ?? "";
if (!pack && !lfs) deny("this server speaks git and git-lfs-authenticate only");
if (!REPO.test(repo)) deny("not a repository name");
// A deploy key belongs to one repository. It is no use for another, read or write.
if (repo !== key!.repo) deny(`this deploy key is for ${key!.repo}, not ${repo}`);
const writes = pack?.[1] === "git-receive-pack" || lfs?.[2] === "upload";
if (writes && key!.role !== "write") deny(`this deploy key is read-only; it cannot write to ${repo}`);

append("access.log", { key: `${key!.role}:${key!.repo}`, command, verdict: "allowed" });
if (lfs) {
  const { host, lfsPort } = config();
  process.stdout.write(JSON.stringify({
    href: `http://${host}:${lfsPort}/${repo}.git/info/lfs`,
    header: { Authorization: `Bearer ${mintToken(repo, lfs[2] as "download" | "upload")}` },
    expires_in: 600,
  }));
  process.exit(0);
}
const result = spawnSync(pack![1]!, [repoDir(repo)], { stdio: "inherit", env: { ...process.env, FORGE_PUSH_KEY: `${key!.role}:${key!.repo}`, FORGE_REPO: repo } });
process.exit(result.status ?? 1);
