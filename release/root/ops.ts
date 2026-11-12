// Every operation the host can ask of the root. A fixed table: the CLI channel carries an
// operation's name and JSON arguments, never a command line.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { writeJson } from "../shared/json.ts";
import { repoOf, writeKnownHosts } from "./git.ts";
import type { Forge } from "./git.ts";
import { ask } from "./keyring-client.ts";
import { parseApproval } from "../shared/approval.ts";
import { APPROVALS, FORGE, GITCONFIG, KEYRING, ROOT } from "./layout.ts";
import { proxyUserOf } from "./proxy/as-proxy.ts";
import { SECRETS_DIR } from "./proxy/secret-store.ts";
import * as domains from "./domains.ts";
import { refusalsOf } from "./outbox.ts";
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
  async "offers.refused"(args) {
    return domains.domains().filter((d) => typeof args.domain !== "string" || d.slug === args.domain).flatMap((d) => refusalsOf(d.slug));
  },
  async "review.diff"(args) {
    return offers.diff(domains.slugOf(args.domain, "domain"), args.repo, args.branch);
  },
  async "review"(args) {
    return offers.review(domains.slugOf(args.domain, "domain"), args.repo, args.branch);
  },

  /** Raw pushes in the root's terminal that are waiting for `desolate approve`. What the
   *  person is shown comes from the message the host parses itself, not from this list. */
  async "approvals.pending"() {
    const pending: { message: string; summary: string; at: string }[] = [];
    for (const file of fs.existsSync(APPROVALS) ? fs.readdirSync(APPROVALS).sort() : []) {
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
    return checks;
  },
};
