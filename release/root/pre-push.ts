// The root clones' pre-push hook (see hooks/pre-push). git gives it the remote's name and
// URL as arguments and one line per ref on stdin: <local ref> <local sha> <remote ref> <remote sha>.
//
// Pushes through desolate's own helpers (to a domain; to `origin`, whose push address is
// git-remote-desolate-push) are gated there. What is left for this hook is a push straight
// to the remote's address, by hand. That cannot reach the remote: this user has no way to a
// write key (only the pusher does, root/pusher.ts). The hook refuses it first, and says why.
import { spawnSync } from "node:child_process";
import { parseRepo } from "../shared/names.ts";

const [, , , url] = process.argv;
if ((url ?? "").startsWith("desolate::") || (url ?? "").startsWith("desolate-push::")) process.exit(0);
const fail = (message: string, fix: string): never => {
  process.stderr.write(`desolate: ${message}\n  fix: ${fix}\n`);
  process.exit(1);
};
const repoName = spawnSync("git", ["config", "--get", "desolate.repo"], { encoding: "utf8" }).stdout.trim();
if (!parseRepo(repoName)) fail("this is not one of the root's clones", "push from a clone under /desolate/root");
// No push from here reaches the remote's address with a key: this user has none. Said
// plainly, before git tries.
fail(`a push straight to the remote's address is not something ${repoName}'s root clone can make: the write key is the pusher's alone`, "git push origin <branch> (it asks, and you approve on the host), or `desolate push` on the host");
