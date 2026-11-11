// Every operation the host can ask of the root. A fixed table: the CLI channel carries an
// operation's name and JSON arguments, never a command line.
import * as fs from "node:fs";
import { writeJson } from "../shared/json.ts";
import { repoOf, writeKnownHosts } from "./git.ts";
import type { Forge } from "./git.ts";
import { ask } from "./keyring-client.ts";
import { FORGE, KEYRING } from "./layout.ts";
import * as domains from "./domains.ts";
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
    add("root: approvals socket is closed to the root's own user", internal === "refused", internal === "refused" ? "only the keyring's user can file an approval" : "the root's user can open the internal socket", "desolate bootstrap");
    let keys = "unreadable";
    try {
      fs.readdirSync(KEYRING.keys);
      keys = "READABLE";
    } catch {
      /* unreadable, as it must be */
    }
    add("root: private keys are unreadable to the root's own user", keys === "unreadable", keys === "unreadable" ? `${KEYRING.keys} is the keyring user's alone` : `${KEYRING.keys} can be listed`, "desolate bootstrap");
    add("root: forge configured", fs.existsSync(FORGE), fs.existsSync(FORGE) ? "yes" : "no forge.json", "desolate bootstrap");
    return checks;
  },
};
