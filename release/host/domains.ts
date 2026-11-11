// `desolate domain ...`: create, add, show.
import { EXIT, refuse } from "../shared/exit.ts";
import * as fs from "node:fs";
import { guest } from "./paths.ts";
import { backend, rootctl } from "./stack.ts";

type Out = (line: string) => void;

/** One line from stdin; on a terminal, without echo. */
const readSecretLine = (): Promise<string> =>
  new Promise((resolve) => {
    const tty = process.stdin.isTTY;
    if (tty) process.stdin.setRawMode(true);
    let text = "";
    const done = () => {
      if (tty) {
        process.stdin.setRawMode(false);
        process.stderr.write("\n");
      }
      process.stdin.pause();
      resolve(text.replace(/\r?\n$/, ""));
    };
    process.stdin.on("data", (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (tty && (char === "\r" || char === "\n" || char === "\u0004")) return done();
        if (tty && char === "\u0003") process.exit(130);
        if (tty && (char === "\u007f" || char === "\b")) text = text.slice(0, -1);
        else text += char;
      }
      if (!tty && text.includes("\n")) {
        text = text.slice(0, text.indexOf("\n"));
        done();
      }
    });
    process.stdin.on("end", done);
    process.stdin.resume();
  });

/** A domain that has secrets has a CA its workspaces must trust: the running ones take it
 *  now, the others when they start. */
const trustCa = async (domain: string) => {
  const d = await rootctl<{ workspaces: { vm: string }[] }>("domain.show", { slug: domain }, { quiet: true });
  const b = backend();
  const running = new Set((await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name));
  for (const w of d.workspaces) if (running.has(w.vm)) await b.exec(w.vm, ["bash", `${guest.release}/workspace/net/trust-ca.sh`], { root: true, timeoutMs: 120_000 });
};

export const domainCommand = async (args: string[], values: Record<string, unknown>, out: Out) => {
  const json = values.json === true;
  const [first, second] = args;
  if (first === "create") {
    if (!second) refuse("a domain needs a name", "desolate domain create <slug> [--title \"...\"]", EXIT.usage);
    const made = await rootctl<{ slug: string; title: string }>("domain.create", { slug: second, title: values.title }, { quiet: true });
    return out(json ? JSON.stringify(made) : `created the domain ${made.slug} ("${made.title}").\nnext: desolate domain ${made.slug} add --repo <owner>/<repo>`);
  }
  if (!first) refuse("which domain?", "desolate domain create <slug> | desolate domain <slug> add --repo <owner>/<repo> | desolate domain <slug> show", EXIT.usage);
  if (second === "add") {
    if (typeof values.repo === "string") {
      const added = await rootctl<{ repo: string; added: boolean; note: string }>("domain.add-repo", { slug: first, repo: values.repo }, { quiet: true });
      if (json) return out(JSON.stringify(added));
      out(added.added ? `${added.repo} is now in the domain ${first}: every workspace in it gets a checkout, borrowing the mirror's objects.` : `${added.repo} was already in the domain ${first}.`);
      if (added.note) out(`note: ${added.note}`);
      return out(`next: desolate up ${first}`);
    }
    refuse("add what?", `desolate domain ${first} add --repo <owner>/<repo>`, EXIT.usage);
  }
  if (second === "net") {
    // desolate domain <d> net [show] | open | enforce | allow <host>... | deny <host>... | allow-internal <ip>
    const [, , action, ...rest] = args;
    type Policy = { mode: string; hosts: string[]; internal: string[] };
    const change = action === "open" || action === "enforce" ? { mode: action } : action === "allow" ? { allow: rest } : action === "deny" ? { deny: rest } : action === "allow-internal" ? { internal: rest } : null;
    if (action && action !== "show" && !change) refuse(`'net ${action}' is not understood`, `desolate domain ${first} net show | open | enforce | allow <host>... | deny <host>... | allow-internal <address>`, EXIT.usage);
    const policy = await rootctl<Policy>("net.policy", { domain: first, change: change ?? undefined }, { quiet: true });
    if (json) return out(JSON.stringify(policy));
    out(`${first}: ${policy.mode === "enforce" ? `only these hosts are reachable: ${policy.hosts.join(", ") || "(none)"}` : "any public host is reachable (open). Its workspaces still reach nothing internal"}`);
    if (policy.mode === "open" && policy.hosts.length) out(`  listed, for when it is enforced: ${policy.hosts.join(", ")}`);
    if (policy.internal.length) out(`  internal addresses it may reach: ${policy.internal.join(", ")}`);
    return;
  }
  if (second === "secret") {
    // desolate domain <d> secret [list] | set <NAME> --hosts a,b [--headers h,...] | rm <NAME>
    const [, , action, name] = args;
    type Listed = { name: string; hosts: string[]; headers: string[] | null; on: boolean; secondsLeft?: number };
    const usage = `desolate domain ${first} secret list | set <NAME> --hosts <host>[,...] [--headers <header>[,...]] | off <NAME> | on <NAME> [--ttl 30m] | rm <NAME>`;
    const left = (seconds: number) => (seconds >= 7200 ? `${Math.round(seconds / 3600)} h` : seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`);
    const stateOf = (s: Listed) => (!s.on ? "OFF" : s.secondsLeft !== undefined ? `on for ${left(s.secondsLeft)} more` : "on");
    const csv = (value: unknown) => (typeof value === "string" ? value.split(",").map((part) => part.trim()).filter(Boolean) : []);
    if (action === "on" || action === "off") {
      if (!name) refuse("which secret?", usage, EXIT.usage);
      let ttlSeconds: number | undefined;
      if (values.ttl !== undefined) {
        const match = /^(\d+)([smhd])$/.exec(String(values.ttl));
        if (!match || action === "off") refuse(action === "off" ? "--ttl goes with `secret on`" : `'${String(values.ttl)}' is not a time to live`, `desolate domain ${first} secret on ${name} --ttl 30m   (s, m, h or d)`, EXIT.usage);
        ttlSeconds = Number(match![1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match![2] as "s" | "m" | "h" | "d"];
      }
      const switched = await rootctl<Listed>("secret.switch", { domain: first, name, on: action === "on", ttlSeconds }, { quiet: true });
      if (json) return out(JSON.stringify(switched));
      return out(switched.on ? `${name} is ${stateOf(switched)}${switched.secondsLeft !== undefined ? ", then off" : ""}.` : `${name} is OFF: its value goes nowhere, and a request that carries its name toward ${switched.hosts.join(", ")} is refused. To switch it on: desolate domain ${first} secret on ${name} [--ttl 30m]`);
    }
    if (action === "set" || action === "rm") {
      if (!name) refuse("which secret?", usage, EXIT.usage);
      if (action === "set") {
        // The value comes on stdin, never as an argument: arguments are visible to every
        // process on the machine and are kept in shell history.
        if (process.stdin.isTTY) process.stderr.write(`Paste the value of ${name} and press Enter (it is not shown): `);
        const value = await readSecretLine();
        const set = await rootctl<Listed>("secret.set", { domain: first, name, value, hosts: csv(values.hosts), headers: csv(values.headers) }, { quiet: true });
        await trustCa(first);
        if (json) return out(JSON.stringify(set));
        out(`${set.name} is held in the root for the domain ${first}. Its workspaces send the name; the value is put in its place on the way to: ${set.hosts.join(", ")}${set.headers ? ` (in the header${set.headers.length > 1 ? "s" : ""} ${set.headers.join(", ")} only)` : ""}.`);
        return out(`in a workspace: export SOME_API_KEY=${set.name}   (the name is not a secret)`);
      }
      const removed = await rootctl<{ existed: boolean }>("secret.remove", { domain: first, name }, { quiet: true });
      return out(json ? JSON.stringify(removed) : removed.existed ? `${name} is no longer held for the domain ${first}.` : `the domain ${first} had no secret named ${name}.`);
    }
    if (action && action !== "list") refuse(`'secret ${action}' is not understood`, usage, EXIT.usage);
    const listed = await rootctl<Listed[]>("secret.list", { domain: first }, { quiet: true });
    if (json) return out(JSON.stringify(listed));
    if (listed.length === 0) return out(`the domain ${first} has no secrets. To add one: ${usage.split(" | ")[1]}`);
    for (const s of listed) out(`${s.name}  ->  ${s.hosts.join(", ")}${s.headers ? `  (headers: ${s.headers.join(", ")})` : ""}${stateOf(s) === "on" ? "" : `  [${stateOf(s)}]`}`);
    return;
  }
  if (second === "show" || second === undefined) {
    const d = await rootctl<{ slug: string; title: string; repos: string[]; workspaces: { workspace: string; state: string }[] }>("domain.show", { slug: first }, { quiet: true });
    if (json) return out(JSON.stringify(d));
    out(`${d.slug}  "${d.title}"`);
    out(`  repositories: ${d.repos.join(", ") || "none"}`);
    return out(`  workspaces: ${d.workspaces.map((w) => `${w.workspace} (${w.state})`).join(", ") || "none"}`);
  }
  refuse(`'desolate domain ${first} ${second}' is not a command`, `desolate domain ${first} add --repo <owner>/<repo> | desolate domain ${first} show | desolate domain ${first} secret ...`, EXIT.usage);
};
