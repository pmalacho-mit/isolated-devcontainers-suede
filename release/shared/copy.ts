// Files another side wrote, taken in: the host from the git VM's out-box (host/git-vm.ts), the
// root from what the host handed it (root/ops.ts, git.push). Each opens without following a
// link and without blocking (a FIFO in a file's place would hang the reader), checks what it
// opened (fstat, not the name: the name may change between a look and an open), reads at
// most the size that check saw, and COPIES into a new file of its own, hashing on the way, so
// what is hashed is what is kept.
import { createHash } from "node:crypto";
import * as fs from "node:fs";

const OPEN = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/** A plain file, opened without following a link; null if it is not one, or is over `most`. */
export const openPlain = (file: string, most: number): { fd: number; size: number } | null => {
  let fd: number;
  try {
    fd = fs.openSync(file, OPEN);
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

/** Copy from a descriptor into a new file (never an existing one, never through a link),
 *  hashing on the way; exactly `size` bytes, what the descriptor said it held. Its sha256. */
export const copyOut = (from: { fd: number; size: number }, to: string, mode = 0o600): string => {
  const out = fs.openSync(to, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
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

/** An object named by its sha256, taken from `from` to `to` only if it hashes to its name:
 *  through a `.part` file beside `to`, which is gone afterwards whatever happened. Null when
 *  it was taken (or `to` was there already), else why not. */
export const takeHashed = (from: string, to: string, sha256: string, most: number, mode = 0o644): string | null => {
  if (fs.existsSync(to)) return null;
  const source = openPlain(from, most);
  if (!source) return "not a plain file of a size desolate takes";
  const part = `${to}.part-${process.pid}`;
  try {
    if (copyOut(source, part, mode) !== sha256) return "it does not hash to its name";
    fs.renameSync(part, to);
    return null;
  } catch (error) {
    return `it could not be copied: ${(error as Error).message}`;
  } finally {
    fs.closeSync(source.fd);
    fs.rmSync(part, { force: true });
  }
};
