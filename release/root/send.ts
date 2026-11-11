// The one place a root clone's commits leave for the remote. Both ways a person pushes come
// here: `desolate push` on the host (push.ts) and a raw `git push origin` in the root's
// terminal (git-remote-desolate-push.ts). Neither can make the write key sign: by the time
// this runs, an approval the person gave ON THE HOST for exactly this repository, branch
// and commit is on file with the keyring, or the remote refuses the connection.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Repo } from "../shared/names.ts";
import { git, remoteUrl } from "./git.ts";
import { clonePath } from "./layout.ts";
import { lfsOf } from "./offers.ts";

/** Returns null when the remote took it, or why it did not. `lease`: what the remote's
 *  branch must still be for a forced update to go ahead (never an unconditional force). */
export const send = async (repo: Repo, branch: string, commit: string, options: { lease?: string } = {}): Promise<{ error: string; moved: boolean } | null> => {
  const clone = clonePath(repo);
  // LFS objects first: the remote never has a pointer without its object.
  const own = (await lfsOf(repo, commit)).filter((oid) => fs.existsSync(path.join(clone, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid)));
  if (own.length > 0) {
    process.stderr.write(`uploading ${own.length} LFS object(s)\n`);
    const lfs = await git(clone, ["lfs", "push", "origin", "--object-id", ...own], { timeoutMs: 1_800_000 });
    if (lfs.code !== 0) return { error: `the LFS objects did not upload, so the commit was not pushed: ${lfs.stderr.trim().split("\n").slice(-2).join(" | ")}`, moved: false };
  }
  // To the remote's own address, not to `origin`, whose push address is desolate's helper.
  const force = options.lease !== undefined ? [`--force-with-lease=refs/heads/${branch}:${options.lease}`] : [];
  const pushed = await git(clone, ["push", "--porcelain", ...force, remoteUrl(repo), `${commit}:refs/heads/${branch}`], { timeoutMs: 1_800_000 });
  if (pushed.code === 0) return null;
  return { error: `the remote did not take the push: ${pushed.stderr.trim().split("\n").slice(-3).join(" | ")}`, moved: /non-fast-forward|fetch first|stale info/.test(pushed.stderr + pushed.stdout) };
};
