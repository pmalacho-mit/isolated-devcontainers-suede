// The stand-in forge (move-to-vms.md section 13.2): a local git server where keys are per
// repository and read-only or read-write, as GitHub's deploy keys are; it serves LFS; and an
// on-push hook stands in for a dependency's Action. Test harness only: it is not shipped.
import { createHmac, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const STATE = process.env.FORGE_STATE ?? "/forge-state";
export const repoDir = (repo: string) => path.join(STATE, "repos", `${repo}.git`);
export const lfsDir = (repo: string) => path.join(STATE, "lfs", repo);
export const REPO = /^[A-Za-z0-9_][A-Za-z0-9._-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export type Key = { repo: string; role: "read" | "write"; pubkey: string };
export const readJson = <T>(name: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE, name), "utf8")) as T;
  } catch {
    return fallback;
  }
};
export const writeJson = (name: string, value: unknown) => {
  const file = path.join(STATE, name);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
};
export const append = (name: string, entry: Record<string, unknown>) =>
  fs.appendFileSync(path.join(STATE, name), JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n");

const secret = () => fs.readFileSync(path.join(STATE, "secret"), "utf8").trim();
export const config = () => readJson<{ host: string; lfsPort: number }>("config.json", { host: "127.0.0.1", lfsPort: 8080 });

/** An LFS token: what `git-lfs-authenticate` hands a key, scoped to one repository and one
 *  operation, as GitHub's is. A download token cannot upload. */
export const mintToken = (repo: string, operation: "download" | "upload") => {
  const expires = Date.now() + 10 * 60_000;
  const body = `${repo}|${operation}|${expires}`;
  return `${Buffer.from(body).toString("base64url")}.${createHmac("sha256", secret()).update(body).digest("base64url")}`;
};
export const checkToken = (token: string): { repo: string; operation: string } | null => {
  const [encoded, mac] = token.split(".");
  if (!encoded || !mac) return null;
  const body = Buffer.from(encoded, "base64url").toString();
  const want = createHmac("sha256", secret()).update(body).digest("base64url");
  if (mac.length !== want.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  const [repo, operation, expires] = body.split("|");
  if (!repo || !operation || Number(expires) < Date.now()) return null;
  return { repo, operation };
};
