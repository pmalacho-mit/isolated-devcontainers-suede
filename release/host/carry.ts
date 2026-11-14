// What the root VM holds that is not on a share, carried across a rebuild of it. The keys,
// the repository registry, every domain's secrets and network rules live on the root VM's
// own disk on purpose (root/layout.ts: no share, so no other VM has a path to them). So a
// `destroy` that keeps the home must keep them too, or it keeps clones that nothing can
// fetch or push any more and domains whose secrets are gone. `destroy` takes them out of
// the root as one archive, into a directory of the home no VM mounts, and the next
// `bootstrap` puts them into the new root before its services start, then deletes it.
//
// While it exists, the archive is the Mac's copy of the root's keys. That is no new
// exposure under desolate's rule (a program running as you on the Mac can already enter the
// root VM as root: decisions.md 5.3), and it lasts from `destroy` to the next `bootstrap`.
import * as fs from "node:fs";
import * as path from "node:path";
import { isSlug } from "../shared/names.ts";
import { paths } from "./paths.ts";
import { backend, ROOT_VM } from "./stack.ts";

type Out = (line: string) => void;

export const KEPT_DIR = path.join(paths.home, "root-kept");
export const KEPT = path.join(KEPT_DIR, "root-state.tgz");

/** The root's own directories that hold what must survive. Not kept: what start.sh makes
 *  again (its code and layout stamps, so the services restart on what was put back),
 *  sockets, and the list of proxies that were running (rootd starts them again). */
const DIRS = ["var/lib/desolate-root", "var/lib/desolate", "var/lib/desolate-proxies"];
const EXCLUDE = ["var/lib/desolate-root/code", "var/lib/desolate-root/layout", "var/lib/desolate/proxy/running", "*.sock"];

/** Take the root's state out, before its VM is removed. Returns false when there is no root
 *  VM (nothing to keep). Throws when there is one and its state could not be read: the
 *  caller must not remove a root whose keys it could not keep. */
export const keepRootState = async (out: Out): Promise<boolean> => {
  const b = backend();
  const info = await b.info(ROOT_VM);
  if (info.status === "missing") return false;
  if (info.status === "suspended") await b.resume(ROOT_VM);
  else if (info.status !== "running") await b.start(ROOT_VM);
  const script = `set -o pipefail; cd / && tar ${EXCLUDE.map((e) => `--exclude='${e}'`).join(" ")} -czf - $(for d in ${DIRS.join(" ")}; do [ -d "/$d" ] && echo "$d"; done) | base64 -w0`;
  const taken = await b.exec(ROOT_VM, ["bash", "-c", script], { root: true, timeoutMs: 600_000 });
  if (taken.code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(taken.stdout.trim())) throw new Error(`the root's keys and secrets could not be read out of it: ${(taken.stderr || taken.stdout).trim().slice(-300)}`);
  const bytes = Buffer.from(taken.stdout.trim(), "base64");
  fs.mkdirSync(KEPT_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(KEPT_DIR, 0o700);
  const partial = `${KEPT}.partial`;
  fs.writeFileSync(partial, bytes, { mode: 0o600 });
  fs.renameSync(partial, KEPT);
  out(`  = kept the root's keys, registry, secrets and network rules (${(bytes.length / 1024).toFixed(0)} KiB, ${path.relative(paths.home, KEPT)}): the next bootstrap puts them back`);
  return true;
};

/** Domains the home knows, from their records on the host: their proxies' users must exist
 *  in the new root before their files are put back, so the files keep their owners. */
const domainsOnHost = () => {
  try {
    return fs.readdirSync(paths.domains).filter((name) => isSlug(name) && fs.existsSync(path.join(paths.domains, name, "domain.json")));
  } catch {
    return [];
  }
};

/** Put kept state into a new root. Only into one that holds no keys of its own: a root that
 *  has keys is the truth, and the archive is left where it is, and said. Returns whether
 *  anything was put back; the caller restarts the root's services then. */
export const restoreRootState = async (out: Out, rootHoldsKeys: boolean): Promise<boolean> => {
  if (!fs.existsSync(KEPT)) return false;
  if (rootHoldsKeys) {
    out(`  ! ${KEPT} is a kept copy of a root's state, but this root holds keys of its own: left as it is. If it is not wanted: rm ${KEPT}`);
    return false;
  }
  const b = backend();
  // Each domain's proxies' user first (root/proxy-user.sh: a name from the domain's), so tar
  // gives their files back to them by name; then again after, for the directories it sets.
  const users = async () => {
    for (const domain of domainsOnHost()) {
      const made = await b.exec(ROOT_VM, ["bash", "/desolate/release/root/proxy-user.sh", String(process.getuid!()), domain], { root: true, timeoutMs: 60_000 });
      if (made.code !== 0) throw new Error(`the domain ${domain}'s proxies' user could not be made: ${(made.stderr || made.stdout).trim().slice(-300)}`);
    }
  };
  await users();
  const put = await b.exec(ROOT_VM, ["bash", "-c", "set -o pipefail; base64 -d | tar -C / --same-owner -xzf - && rm -f /var/lib/desolate-root/code"], { root: true, input: fs.readFileSync(KEPT).toString("base64"), timeoutMs: 600_000 });
  if (put.code !== 0) throw new Error(`the kept state could not be put into the new root (it is still at ${KEPT}): ${(put.stderr || put.stdout).trim().slice(-300)}`);
  await users();
  fs.rmSync(KEPT, { force: true });
  out("  + put back the root's keys, registry, secrets and network rules from before the destroy");
  return true;
};
