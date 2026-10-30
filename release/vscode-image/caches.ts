/**
 * caches.ts -- where the editor keeps copies of its own: each project's remote
 * as of its last push or pull (transfer.ts), and each target's last review
 * (review.ts). In the editor's cache, never in a project.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const cacheRoot = () => join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "desolate");

/** One bare repository per registered project, `<owner>__<repo>.git`, whose
 *  refs/heads/* are the remote's branches as the last push or pull left them. */
export const remoteCacheRoot = () => process.env.DESOLATE_REMOTE_CACHE ?? join(cacheRoot(), "remotes");
