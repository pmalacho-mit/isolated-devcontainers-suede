// What a root clone takes in as a bundle (a domain's, from its outbox; the git VM's, from
// the host) is checked, every object, before any of it enters the clone.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Check every object in a bundle BEFORE any of them enters a root clone (`gitDir`): index its
 *  pack, strictly, into a throwaway object directory that borrows that clone's objects.
 *
 *  `--strict` is git's own fsck, as fatal errors: a tree with ".git" in it (in any case, or
 *  in a form the Mac's or Windows' filesystem would fold to it), a .gitmodules that is a
 *  symlink or names an option or a path that climbs, a malformed or missing object.
 *
 *  Why not rely on fetch.fsckObjects: before git 2.46 a fetch FROM A BUNDLE checked nothing
 *  (measured on the image's 2.43: a tree containing ".git" was imported and offered). This
 *  does not depend on which git the image has. Returns why the bundle is refused, or null. */
export const bundleRefusal = async (copy: string, gitDir: string): Promise<string | null> => {
  // The header: a v2 bundle, which is what a workspace's git writes. v3 exists to carry
  // capabilities (another hash, a filter that leaves objects out); neither is taken.
  const head = Buffer.alloc(4 * 1024 * 1024);
  const fd = fs.openSync(copy, "r");
  const read = fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  const end = head.subarray(0, read).indexOf("\n\n");
  if (!head.subarray(0, 20).toString("latin1").startsWith("# v2 git bundle\n") || end < 0) return "it is not a bundle a workspace's git writes (v2)";
  const quarantine = fs.mkdtempSync(path.join(path.dirname(copy), "check-"));
  fs.mkdirSync(path.join(quarantine, "pack"));
  try {
    const child = spawn("git", ["index-pack", "--strict", "--fix-thin", "--stdin"], {
      stdio: ["pipe", "ignore", "pipe"],
      cwd: path.dirname(gitDir),
      env: { ...process.env, GIT_DIR: gitDir, GIT_OBJECT_DIRECTORY: quarantine, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(gitDir, "objects") },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    child.stdin.on("error", () => {});
    fs.createReadStream(copy, { start: end + 2 }).pipe(child.stdin);
    // A pack made to be slow is refused, not waited on.
    let late = false;
    const timer = setTimeout(() => { late = true; child.kill("SIGKILL"); }, CHECK_MS);
    const code = await new Promise<number>((resolve) => child.on("close", (status) => resolve(status ?? 1)));
    clearTimeout(timer);
    if (late) return `checking its objects took longer than ${CHECK_MS / 60_000} minutes`;
    if (code === 0) return null;
    // git names what it found ("error: object <id>: hasDotgit: contains '.git'") before its
    // last line ("fatal: fsck error in packed object"): the first is the one worth reading.
    const said = stderr.trim().split("\n");
    const why = said.find((line) => line.startsWith("error: ")) ?? said.pop() ?? "its objects did not pass git's checks";
    return why.replace(/^error: /, "").replace(/[^\x20-\x7e]/g, "?").slice(0, 300);
  } finally {
    fs.rmSync(quarantine, { recursive: true, force: true });
  }
};
const CHECK_MS = 8 * 60_000;
