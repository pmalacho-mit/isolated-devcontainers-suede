// The git VM's LFS transfer agent (git-lfs's custom transfer protocol): downloads only, from
// the two stores this VM can read, read-only: the mirror's (what the remote has) and the
// root clone's (what domains offered, and what was pushed through desolate).
//
// git-lfs's own file transfer cannot be used here: it runs `git rev-parse` inside the bare
// mirror, which the git VM's `safe.bareRepository=explicit` (kept: it is a guard against a
// clone's embedded repositories) refuses. So no LFS file was ever checked out in the git VM.
//
// Each object is copied without following a link and kept only if it hashes to its name.
//
//   lfs.standalonetransferagent = desolate-file
//   lfs.customtransfer.desolate-file.path = /usr/local/bin/desolate-lfs-file
//   lfs.customtransfer.desolate-file.args = <owner>/<repo>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const repo = process.argv[2] ?? "";
const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const STORES = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) ? [`/desolate/mirrors/${repo}.git/lfs/objects`, `/desolate/root/${repo}/.git/lfs/objects`] : [];
const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).stdout.trim() || path.resolve(".git");

/** The object, copied into the clone's LFS temp directory, if a store has it whole. */
const fetchOne = (oid: string, size: number): string | null => {
  const tmp = path.join(gitDir, "lfs", "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  for (const store of STORES) {
    let fd: number | null = null;
    const to = path.join(tmp, `${oid}.desolate-${process.pid}`);
    try {
      fd = fs.openSync(path.join(store, oid.slice(0, 2), oid.slice(2, 4), oid), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (!fs.fstatSync(fd).isFile()) continue;
      const out = fs.openSync(to, "w", 0o644);
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(1024 * 1024);
      let total = 0;
      try {
        for (let read = fs.readSync(fd, buffer); read > 0; read = fs.readSync(fd, buffer)) {
          hash.update(buffer.subarray(0, read));
          fs.writeSync(out, buffer, 0, read);
          total += read;
        }
      } finally {
        fs.closeSync(out);
      }
      if (hash.digest("hex") === oid && total === size) return to;
      fs.rmSync(to, { force: true });
    } catch {
      fs.rmSync(to, { force: true });
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
  return null;
};

const lines = readline.createInterface({ input: process.stdin, terminal: false });
for await (const line of lines) {
  let message: { event?: string; operation?: string; oid?: string; size?: number };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    continue;
  }
  if (message.event === "init") say(message.operation === "download" ? {} : { error: { code: 1, message: "the git VM's LFS agent only downloads: a push carries its LFS objects itself" } });
  else if (message.event === "download") {
    const oid = String(message.oid ?? "");
    if (!/^[0-9a-f]{64}$/.test(oid) || !Number.isInteger(message.size)) {
      say({ event: "complete", oid, error: { code: 2, message: "not an LFS object id" } });
      continue;
    }
    const file = fetchOne(oid, message.size!);
    say(file ? { event: "complete", oid, path: file } : { event: "complete", oid, error: { code: 2, message: `neither the mirror nor the root has ${oid.slice(0, 12)}: on the Mac, desolate fetch, or have the agent offer the branch` } });
  } else if (message.event === "terminate") break;
}
