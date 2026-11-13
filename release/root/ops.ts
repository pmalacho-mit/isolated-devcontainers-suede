// Every operation the host can ask of the root. A fixed table: the CLI channel carries an
// operation's name and JSON arguments, never a command line.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isBranch, isCommit } from "../shared/names.ts";
import { writeJson } from "../shared/json.ts";
import { git as gitIn, repoOf, writeKnownHosts } from "./git.ts";
import { bundleRefusal } from "./intake.ts";
import { pushCommit } from "./raw-push.ts";
import type { Forge } from "./git.ts";
import { ask } from "./keyring-client.ts";
import { withReviewer } from "./review-client.ts";
import { parseApproval } from "../shared/approval.ts";
import { APPROVALS, clonePath, domainPath, FORGE, GIT_IN, GITCONFIG, KEYRING, PINNED_FORGE, PUSHER, REVIEWER, ROOT } from "./layout.ts";
import { readHead } from "../shared/status.ts";
import { proxyUserOf } from "./proxy/as-proxy.ts";
import { SECRETS_DIR } from "./proxy/secret-store.ts";
import * as domains from "./domains.ts";
import { branchesOf, refusalsOf } from "./outbox.ts";
import * as offers from "./offers.ts";
import * as proxy from "./proxy/manage.ts";
import * as secrets from "./proxy/secrets.ts";
import * as repos from "./repos.ts";

type Log = (line: string) => void;
export type Op = (args: Record<string, unknown>, log: Log) => Promise<unknown>;

export const ops: Record<string, Op> = {
  async ping() {
    const keyring = await ask(KEYRING.control, { op: "list" }, 3000).then((reply) => reply.ok === true, () => false);
    return { root: true, keyring, node: process.version, user: process.getuid!() };
  },

  async "forge.set"(args) {
    const forge = args.forge as Forge;
    if (!forge || (forge.kind !== "github" && forge.kind !== "stand-in") || !forge.ssh?.host || !forge.knownHosts)
      throw new Error("forge.set needs {kind, ssh:{user,host,port}, knownHosts}");
    if (!/^[A-Za-z0-9.-]+$/.test(forge.ssh.host) || !/^[a-z_][a-z0-9_-]*$/.test(forge.ssh.user) || !Number.isInteger(forge.ssh.port))
      throw new Error("forge.set: bad ssh user, host or port");
    writeJson(FORGE, forge);
    writeKnownHosts(forge);
    return { kind: forge.kind, host: forge.ssh.host };
  },

  async "repo.prepare"(args) {
    return repos.prepare(repoOf(args.repo), { push: args.push !== false, anonymous: args.anonymous === true });
  },
  async "repo.fetch"(args, log) {
    return repos.fetch(repoOf(args.repo), log);
  },
  async "repo.list"() {
    return repos.list();
  },

  async "domain.create"(args) {
    return domains.create(args.slug, args.title);
  },
  async "domain.add-repo"(args) {
    return domains.addRepo(args.slug, args.repo);
  },
  async "domain.env"(args) {
    return domains.setEnv(args.slug, args.repo);
  },
  async "domain.env-key"(args) {
    return domains.envKey(args.slug);
  },
  async "domain.list"() {
    return domains.domains().map((d) => ({ ...d, workspaces: domains.workspaces(d.slug) }));
  },
  async "domain.show"(args) {
    const d = domains.domain(domains.slugOf(args.slug, "domain"));
    return { ...d, workspaces: domains.workspaces(d.slug) };
  },
  async "domain.remove"(args) {
    return domains.remove(args.slug);
  },
  async "workspace.plan"(args) {
    return domains.plan(args as Parameters<typeof domains.plan>[0]);
  },
  async "workspace.state"(args) {
    domains.setState(domains.slugOf(args.domain, "domain"), domains.slugOf(args.name, "workspace"), args.state as "up" | "stopped");
    return {};
  },
  async "workspace.get"(args) {
    return domains.workspace(domains.slugOf(args.domain, "domain"), domains.slugOf(args.name, "workspace"));
  },
  async "workspace.remove"(args) {
    return domains.removeWorkspace(domains.slugOf(args.domain, "domain"), domains.slugOf(args.name, "workspace"));
  },

  async "proxy.start"(args) {
    // The domain's secrets proxy first (if it has secrets): after a restart of the root it
    // is not running, and a workspace must not start without it.
    await secrets.ensure(domains.domain(domains.slugOf(args.domain, "domain")).slug);
    return proxy.start(String(args.vm), domains.slugOf(args.domain, "domain"), domains.slugOf(args.workspace, "workspace"));
  },
  /** Names, hosts and headers. No operation returns a secret's value. */
  async "secret.list"(args) {
    return secrets.list(domains.domain(domains.slugOf(args.domain, "domain")).slug);
  },
  /** After root changed a domain's secrets (proxy/secret-store.ts, run by the host as root):
   *  its secrets proxy and its workspaces' list of names follow. This user never receives
   *  a value: there is no operation here that takes one. */
  async "secret.apply"(args) {
    return secrets.apply(domains.domain(domains.slugOf(args.domain, "domain")).slug);
  },
  async "proxy.stop"(args) {
    proxy.stop(String(args.vm));
    return {};
  },
  async "net.policy"(args) {
    const slug = domains.domain(domains.slugOf(args.domain, "domain")).slug;
    return args.change ? proxy.setPolicy(slug, args.change as Parameters<typeof proxy.setPolicy>[1]) : proxy.policy(slug);
  },
  async "net.recommend"(args) {
    return proxy.recommend(domains.domain(domains.slugOf(args.domain, "domain")).slug);
  },
  async "net.log"(args) {
    return proxy.auditLog({ domain: typeof args.domain === "string" ? args.domain : undefined, last: Number(args.last) || 100 });
  },

  async "offers.list"(args) {
    return offers.allOffers(typeof args.domain === "string" ? domains.slugOf(args.domain, "domain") : undefined);
  },
  /** Every branch each domain has (by the domain's own list), which of them are offered,
   *  and which workspace has each checked out: `desolate branches`. */
  async "branches.list"(args) {
    const only = typeof args.domain === "string" ? domains.slugOf(args.domain, "domain") : undefined;
    return domains.domains().filter((d) => !only || d.slug === only).flatMap((d) => {
      const offered = offers.offersOf(d.slug);
      const reposDir = path.join(domainPath(d.slug), "repos");
      const heads = domains.workspaces(d.slug).flatMap((w) => w.checkouts.map((c) => ({ workspace: w.workspace, repo: c.repo, head: readHead(reposDir, c) })));
      return branchesOf(d.slug, d.repos).map((b) => ({
        domain: d.slug, ...b,
        offered: offered.some((o) => o.repo === b.repo && o.branch === b.branch && o.commit === b.commit),
        checkedOutIn: heads.filter((h) => h.repo === b.repo && h.head?.branch === b.branch).map((h) => h.workspace),
      }));
    });
  },
  async "offers.refused"(args) {
    return domains.domains().filter((d) => typeof args.domain !== "string" || d.slug === args.domain).flatMap((d) => refusalsOf(d.slug));
  },
  async "review.diff"(args) {
    return offers.diff(domains.slugOf(args.domain, "domain"), args.repo, args.branch, args.against);
  },
  async "review"(args) {
    return offers.review(domains.slugOf(args.domain, "domain"), args.repo, args.branch, args.against);
  },

  /** Raw pushes in the root's terminal that are waiting for `desolate approve`. What the
   *  person is shown comes from the message the host parses itself, not from this list. */
  async "approvals.pending"() {
    const pending: { message: string; summary: string; at: string }[] = [];
    for (const file of fs.existsSync(APPROVALS) ? fs.readdirSync(APPROVALS).filter((name) => name.endsWith(".json")).sort() : []) {
      try {
        const entry = JSON.parse(fs.readFileSync(`${APPROVALS}/${file}`, "utf8")) as { message: string; summary: string; at: string };
        if (!parseApproval(entry.message) || Date.now() - Date.parse(entry.at) > 120_000) fs.rmSync(`${APPROVALS}/${file}`, { force: true });
        else pending.push({ message: entry.message, summary: String(entry.summary).slice(0, 200), at: entry.at });
      } catch {
        fs.rmSync(`${APPROVALS}/${file}`, { force: true });
      }
    }
    return pending;
  },
  /** A `git push` made in the git VM (host/git-vm.ts), handed over by the host: its bundle
   *  is checked like a domain's (intake.ts), taken in, and pushed as a raw push is, after
   *  the person's approval on the host. Returns what the person waiting should read. */
  async "git.push"(args) {
    const repo = repoOf(args.repo);
    const branch = String(args.branch ?? "");
    const commit = String(args.commit ?? "");
    const file = String(args.bundle ?? "");
    if (!isBranch(branch) || !isCommit(commit) || /^0{40}$/.test(commit) || !/^[0-9a-f]{16}\.bundle$/.test(file)) throw new Error("git.push names a branch, a commit, and a bundle the host left");
    const bundle = path.join(GIT_IN, file);
    const said: string[] = [];
    try {
      // (The host has just written it; a share can be a moment behind on vz.)
      for (let i = 0; i < 20 && !fs.existsSync(bundle); i++) await new Promise((resolve) => setTimeout(resolve, 250));
      const stat = fs.lstatSync(bundle);
      if (!stat.isFile()) throw new Error("the bundle is not a plain file");
      const clone = clonePath(repo);
      const gitDir = path.join(clone, ".git");
      const why = await bundleRefusal(bundle, gitDir);
      if (why) return { pushed: false, error: `the root refused the push's bundle: ${why}`, said };
      // One ref, of the shape the git VM's helper makes: what it names is checked below.
      const heads = (await gitIn(clone, ["bundle", "list-heads", bundle])).stdout.split("\n").filter(Boolean).map((line) => line.split(" "));
      if (heads.length !== 1 || !/^refs\/desolate\/out\/[0-9a-f]{16}$/.test(heads[0]![1] ?? "")) return { pushed: false, error: "the push's bundle does not carry the one ref the git VM's helper makes", said };
      const ref = `refs/desolate/git/${file.slice(0, 16)}`;
      const fetched = await gitIn(clone, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", bundle, `+${heads[0]![1]}:${ref}`]);
      if (fetched.code !== 0) return { pushed: false, error: `the root could not take the push in: ${fetched.stderr.trim().split("\n").pop() ?? ""}`, said };
      try {
        const found = (await gitIn(clone, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).stdout.trim();
        if (found !== commit) return { pushed: false, error: "the bundle did not hold the commit the push names", said };
        // Its new LFS objects, each only if it hashes to its name, into the clone's store
        // (where send.ts takes what the remote lacks).
        for (const oid of Array.isArray(args.lfs) ? (args.lfs as unknown[]) : []) {
          if (typeof oid !== "string" || !/^[0-9a-f]{64}$/.test(oid)) return { pushed: false, error: "an LFS object is not named by its sha256", said };
          const from = path.join(GIT_IN, `${file.slice(0, 16)}.lfs`, oid);
          const stat = fs.lstatSync(from);
          if (!stat.isFile()) return { pushed: false, error: "an LFS object is not a plain file", said };
          // Hashed while copied: what is hashed is what is kept.
          const to = path.join(gitDir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
          if (fs.existsSync(to)) continue;
          fs.mkdirSync(path.dirname(to), { recursive: true });
          const part = `${to}.part-${process.pid}`;
          const input = fs.openSync(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          const output = fs.openSync(part, "wx", 0o644);
          const hash = createHash("sha256");
          const buffer = Buffer.alloc(1024 * 1024);
          try {
            for (let read = fs.readSync(input, buffer); read > 0; read = fs.readSync(input, buffer)) {
              hash.update(buffer.subarray(0, read));
              fs.writeSync(output, buffer, 0, read);
            }
          } finally {
            fs.closeSync(input);
            fs.closeSync(output);
          }
          if (hash.digest("hex") !== oid) {
            fs.rmSync(part, { force: true });
            return { pushed: false, error: `the LFS object ${oid.slice(0, 12)} does not hash to its name`, said };
          }
          fs.renameSync(part, to);
        }
        if (args.domain !== undefined) {
          // A delivery (`git push <domain>` in the git VM): the root's own `git push <domain>`
          // in its clone (git-remote-desolate), to a domain that has this repository.
          const slug = domains.slugOf(args.domain, "domain");
          const id = `${repo.owner}/${repo.name}`;
          if (!domains.domain(slug).repos.includes(id)) return { pushed: false, error: `${id} is not in the domain '${slug}'`, said };
          const delivered = await gitIn(clone, ["push", "--porcelain", slug, `${commit}:refs/heads/${branch}`]);
          if (delivered.code !== 0) return { pushed: false, error: `not delivered: ${delivered.stderr.trim().split("\n").pop() ?? ""}`, said };
          said.push(`delivered to ${slug}: its workspaces see it as root/${branch}${Array.isArray(args.lfs) && args.lfs.length ? " (its new LFS objects stay in the root: a delivery carries commits)" : ""}`);
          return { pushed: true, said };
        }
        const failed = await pushCommit(repo, commit, branch, args.forced === true, "a git push from the git VM", (line) => said.push(line));
        return failed ? { pushed: false, error: failed, said } : { pushed: true, said };
      } finally {
        await gitIn(clone, ["update-ref", "-d", ref]).catch(() => {});
      }
    } finally {
      fs.rmSync(bundle, { force: true });
    }
  },
  /** The approval page's Refuse: the waiting push is taken off the list, and the `git push`
   *  that asked gives up (git-remote-desolate-push.ts watches for it). */
  async "approvals.refuse"(args) {
    const nonce = parseApproval(args.message)?.nonce;
    if (!nonce) throw new Error("not a push approval");
    fs.rmSync(`${APPROVALS}/${nonce}.json`, { force: true });
    return { refused: nonce };
  },
  async "approvals.answer"(args) {
    const reply = await ask(KEYRING.control, { op: "approve", message: args.message, signature: args.signature });
    if (reply.ok !== true) throw new Error(`the keyring did not accept the approval: ${String(reply.error)}`);
    return { id: reply.id };
  },

  async "keys.list"() {
    return (await ask(KEYRING.control, { op: "list" })).keys;
  },
  async "keys.audit"(args) {
    return (await ask(KEYRING.control, { op: "audit", last: args.last })).entries;
  },
  async "keys.pubkey"(args) {
    const reply = await ask(KEYRING.control, { op: "pubkey", repo: args.repo, role: args.role });
    if (reply.ok !== true) throw new Error(String(reply.error));
    return { pubkey: reply.pubkey };
  },

  async "doctor"() {
    const checks: { name: string; ok: boolean; detail: string; fix?: string }[] = [];
    const add = (name: string, ok: boolean, detail: string, fix?: string) => checks.push({ name, ok, detail, fix });
    const keyring = await ask(KEYRING.control, { op: "list" }, 3000).catch((error: Error) => ({ ok: false, error: error.message }) as Record<string, unknown>);
    add("root: keyring answers", keyring.ok === true, keyring.ok === true ? `${(keyring.keys as unknown[]).length} key(s) held` : String(keyring.error), "desolate bootstrap");
    let internal = "refused";
    try {
      fs.accessSync(KEYRING.internal, fs.constants.R_OK | fs.constants.W_OK);
      internal = "OPEN";
    } catch {
      /* refused, as it must be */
    }
    add("root: the write agent's askpass socket is closed to the root's own user", internal === "refused", internal === "refused" ? "only the keyring's user can answer for a signature" : "the root's user can open the internal socket", "desolate bootstrap");
    let keys = "unreadable";
    try {
      fs.readdirSync(KEYRING.keys);
      keys = "READABLE";
    } catch {
      /* unreadable, as it must be */
    }
    add("root: private keys are unreadable to the root's own user", keys === "unreadable", keys === "unreadable" ? `${KEYRING.keys} is the keyring user's alone` : `${KEYRING.keys} can be listed`, "desolate bootstrap");
    // Asked, not assumed (P6): this user runs everything here that reads a domain's data.
    const sudo = spawnSync("sudo", ["-n", "true"], { stdio: "ignore", timeout: 10_000 });
    add("root: the root's own user cannot become root", sudo.status !== 0, sudo.status !== 0 ? "sudo refuses it" : "`sudo -n true` succeeds: a bug in a proxy or in git would reach the write keys", "desolate bootstrap (root/start.sh removes the rule)");
    // What root (start.sh) and the keyring run: node, and every directory on root's PATH.
    const notRoots = ["/usr/local/bin", "/usr/local/sbin", "/usr/bin", "/usr/sbin", "/bin", "/sbin", process.execPath].filter((file) => {
      try {
        const stat = fs.statSync(file);
        return stat.uid !== 0 || (stat.mode & 0o022) !== 0;
      } catch {
        return false;
      }
    });
    add("root: the programs root runs are root's", notRoots.length === 0, notRoots.length === 0 ? `node (${process.execPath}) and root's PATH` : `${notRoots.join(", ")} could be changed by someone other than root`, "desolate bootstrap (root/start.sh gives them back)");
    // Each domain's proxies run as a user of that domain's own (proxy/as-proxy.ts): asked,
    // for every one of them, of every other domain's directory too.
    const members = (spawnSync("getent", ["group", "desolate-proxies"], { encoding: "utf8" }).stdout.trim().split(":")[3] ?? "").split(",").filter(Boolean);
    const mine = new Set(spawnSync("id", ["-G"], { encoding: "utf8" }).stdout.trim().split(/\s+/));
    const domainDirs = (() => {
      try {
        return fs.readdirSync(`${ROOT.proxies}/domains`).filter((name) => /^[a-z0-9-]{1,40}$/.test(name));
      } catch {
        return [] as string[];
      }
    })();
    const wrong: string[] = [];
    for (const member of members) {
      const groups = spawnSync("sudo", ["-n", "-u", member, "id", "-G"], { encoding: "utf8", timeout: 10_000 });
      if (groups.status !== 0) {
        wrong.push(`${member}: the root's user cannot start a program as it`);
        continue;
      }
      const own = spawnSync("id", ["-g", member], { encoding: "utf8" }).stdout.trim();
      const shared = groups.stdout.trim().split(/\s+/).filter((group) => group !== own && mine.has(group));
      if (shared.length > 0) wrong.push(`${member} shares the root's user's group(s) ${shared.join(", ")}`);
      if (spawnSync("sudo", ["-n", "-u", member, "test", "-x", "/desolate/root"], { timeout: 10_000 }).status === 0) wrong.push(`${member} can reach the shares`);
      for (const other of domainDirs) {
        if (proxyUserOf(other) === member) continue;
        if (spawnSync("sudo", ["-n", "-u", member, "test", "-r", `${ROOT.proxies}/domains/${other}`], { timeout: 10_000 }).status === 0 ||
          spawnSync("sudo", ["-n", "-u", member, "test", "-x", `${ROOT.proxies}/domains/${other}`], { timeout: 10_000 }).status === 0)
          wrong.push(`${member} can reach the domain ${other}'s directory`);
      }
    }
    add("root: each domain's proxies run as that domain's own user", wrong.length === 0,
      wrong.length > 0 ? wrong.join("; ") : "none shares a group with the root's user, reaches the shares, or reaches another domain's secrets",
      "desolate bootstrap (root/start.sh, root/proxy-user.sh)");
    // Secret values are root's, and their domain's proxies' to read (proxy/secret-store.ts).
    const readable: string[] = [];
    try {
      for (const name of fs.readdirSync(SECRETS_DIR).filter((n) => n.endsWith(".json") && !n.endsWith(".index.json")))
        try {
          fs.accessSync(`${SECRETS_DIR}/${name}`, fs.constants.R_OK);
          readable.push(name);
        } catch {
          /* refused, as it must be */
        }
    } catch {
      /* no secrets yet */
    }
    add("root: secret values are unreadable to the root's own user", readable.length === 0, readable.length === 0 ? `${SECRETS_DIR}: root's, and each domain's proxies'` : `it can read ${readable.join(", ")}`, "desolate bootstrap");
    let gitconfig = "";
    try {
      const stat = fs.lstatSync(GITCONFIG);
      gitconfig = stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0 ? "root's" : "";
    } catch {
      /* missing */
    }
    add("root: git's settings are root's", gitconfig !== "", gitconfig !== "" ? GITCONFIG : `${GITCONFIG} is missing, or could be changed by the root's own user`, "desolate bootstrap");
    let approver = "";
    try {
      const stat = fs.statSync(KEYRING.approver);
      approver = stat.uid === 0 && (stat.mode & 0o022) === 0 ? createHash("sha256").update(fs.readFileSync(KEYRING.approver)).digest("hex") : "";
    } catch {
      /* not installed */
    }
    add("root: approver key installed", approver !== "", approver !== "" ? `sha256 ${approver}` : `${KEYRING.approver} is missing, or not root's alone to write`, "desolate bootstrap");
    add("root: forge configured", fs.existsSync(FORGE), fs.existsSync(FORGE) ? "yes" : "no forge.json", "desolate bootstrap");
    // The write agent is the pusher's alone (pusher.ts): this user, which parses what domains
    // send, cannot even open its directory. Asked by trying, as this user.
    let reach = "";
    try {
      fs.readdirSync(KEYRING.writeRun);
      reach = `it can enter ${KEYRING.writeRun}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") reach = `${KEYRING.writeRun}: ${(error as Error).message}`;
    }
    add("root: only the pusher reaches the write agent", reach === "", reach === "" ? `${KEYRING.writeRun} is closed to the root's own user` : reach, "desolate bootstrap");
    const pusher = await ask(PUSHER.control, { op: "ping" }, 5_000).catch((error: Error) => ({ ok: false, error: error.message }));
    // And where it pushes is root's word, not this user's (root/forge-pin.ts).
    const pinned = [PINNED_FORGE.config, PINNED_FORGE.knownHosts].every((file) => {
      try {
        const stat = fs.lstatSync(file);
        return stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0;
      } catch {
        return false;
      }
    });
    // The reviewer: its own user, which this one cannot be, with a read relay this one
    // cannot reach.
    let review = "";
    try {
      fs.readdirSync(KEYRING.reviewRun);
      review = `it can enter ${KEYRING.reviewRun}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") review = `${KEYRING.reviewRun}: ${(error as Error).message}`;
    }
    // (One connection per reviewer process: between two, the next one is starting.)
    const reviewer = review ? { ok: false, error: review } : await withReviewer(() => ask(REVIEWER.control, { op: "ping" }, 5_000)).catch((error: Error) => ({ ok: false, error: error.message }));
    add("root: the reviewer answers", reviewer.ok === true, reviewer.ok === true ? `${REVIEWER.control}; it is not this user, and its read relay is closed to it` : String(reviewer.error), "desolate bootstrap; its log is /var/lib/desolate-root/reviewer.log");
    add("root: the pusher answers", pusher.ok === true && pinned, pusher.ok !== true ? String(pusher.error) : pinned ? `${PUSHER.control}; the forge it pushes to is root's copy` : `${PINNED_FORGE.config} or its host keys are missing, or not root's alone`, "desolate bootstrap; its log is /var/lib/desolate-root/pusher.log");
    return checks;
  },
};
