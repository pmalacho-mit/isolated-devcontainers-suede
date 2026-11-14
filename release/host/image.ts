// What a VM is made of, and whether it is older than this desolate. The image is what
// image/provision.sh makes from pins.env and image/locks/; a VM provisioned from other
// inputs runs other tools than this desolate expects. provision.sh writes the fingerprint
// it was given into /opt/desolate/image-info, so every clone of the base carries it.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { RELEASE_DIR } from "./paths.ts";

const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.isFile() ? [path.join(dir, entry.name)] : []));

/** The image's inputs, as a short hash: provision.sh, pins.env and every lock. */
export const imageFingerprint = (release = RELEASE_DIR): string => {
  const inputs = [path.join(release, "image", "provision.sh"), path.join(release, "pins.env"), ...files(path.join(release, "image", "locks"))]
    .map((file) => path.relative(release, file)).sort();
  const hash = createHash("sha256");
  for (const file of inputs) hash.update(`${file}\0`).update(fs.readFileSync(path.join(release, file))).update("\0");
  return hash.digest("hex").slice(0, 16);
};

/** The fingerprint a VM was provisioned with, from what provision.sh wrote; null when it
 *  says none (a VM provisioned before desolate stamped its images). */
export const stampOf = (imageInfo: string): string | null => /^image=([0-9a-f]{16})$/m.exec(imageInfo)?.[1] ?? null;

/** The code a VM runs from its share of the release: each file's hash, so a VM whose share
 *  is another checkout (moved, or a second clone) is found, not trusted. Paths relative to
 *  the release, sorted. */
export const codeFiles = (release = RELEASE_DIR): string[] =>
  ["root", "shared", "workspace", "git"].filter((dir) => fs.existsSync(path.join(release, dir)))
    .flatMap((dir) => files(path.join(release, dir))).map((file) => path.relative(release, file))
    .filter((file) => /\.(ts|sh|py)$/.test(file)).sort();

export const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** `sha256sum` output for the same files, read in a VM, compared with this release's. The
 *  files that differ, or that the VM does not have. */
export const differing = (sums: string, release = RELEASE_DIR): string[] => {
  const seen = new Map<string, string>();
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (match) seen.set(match[2]!, match[1]!);
  }
  return codeFiles(release).filter((file) => seen.get(file) !== sha256(path.join(release, file)));
};
