// `desolate domain ...`: create, add, show.
import { EXIT, refuse } from "../shared/exit.ts";
import * as fs from "node:fs";
import { guest } from "./paths.ts";
import { backend, changeSecrets, ensureProxyUser, rootctl } from "./stack.ts";

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

export const domainCommand = async (args: string[], values: Record<string, unknown>, out: Out): Promise<void> => {
  const json = values.json === true;
  const [first, second] = args;
  if (first === "create") {
    if (!second) refuse("a domain needs a name", "desolate domain create <slug> [--title \"...\"]", EXIT.usage);
    const made = await rootctl<{ slug: string; title: string }>("domain.create", { slug: second, title: values.title }, { quiet: true });
    await ensureProxyUser(made.slug);
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
    // The spec's spelling for a secret (section 8): `add --secret NAME --hosts ... [--headers ...]`.
    if (typeof values.secret === "string") return domainCommand([first, "secret", "set", values.secret], values, out);
    refuse("add what?", `desolate domain ${first} add --repo <owner>/<repo> | add --secret <NAME> --hosts <host>[,...] [--headers <header>[,...]]`, EXIT.usage);
  }
  if (second === "env") {
    // desolate domain <d> env [--from <owner/repo>]   (section 4.5, way 1; `compose` is not built)
    if (args[2] === "compose") refuse("composing one environment from several specs is not built yet", `choose one repository's: desolate domain ${first} env --from <owner>/<repo>`);
    const env = await rootctl<{ env: string | null; repos: string[] }>("domain.env", { slug: first, repo: typeof values.from === "string" ? values.from : undefined }, { quiet: true });
    if (json) return out(JSON.stringify(env));
    return out(env.env ? `${first}: its workspaces run ${env.env}'s devcontainer.json. (New workspaces; an existing one keeps what it was made with.)` : `${first}: its workspaces run the devcontainer.json of the first checkout that has one${env.repos.length > 1 ? `. To choose: desolate domain ${first} env --from <owner>/<repo>` : ""}.`);
  }
  if (second === "net") {
    // desolate domain <d> net [show] | open | enforce | allow <host>... | deny <host>... | allow-internal <ip>
    const [, , action, ...rest] = args;
    type Policy = { mode: string; hosts: string[]; internal: string[] };
    if (action === "recommend") {
      type Ranked = { host: string; count: number }[];
      const r = await rootctl<{ mode: string; listed: string[]; reached: Ranked; refused: Ranked }>("net.recommend", { domain: first }, { quiet: true });
      if (json) return out(JSON.stringify(r));
      const names = (list: Ranked) => list.map((entry) => entry.host).join(" ");
      if (r.reached.length === 0 && r.refused.length === 0) return out(`${first}: its workspaces have reached nothing that is not already listed${r.listed.length ? ` (${r.listed.length} listed)` : ""}.`);
      if (r.reached.length) {
        out(`${first} (${r.mode}): hosts its workspaces reached that are not on its list, most used first:`);
        for (const entry of r.reached.slice(0, 60)) out(`  ${String(entry.count).padStart(5)}  ${entry.host}`);
        out(`to keep reaching them once the network is enforced:\n  desolate domain ${first} net allow ${names(r.reached.slice(0, 60))}\n  desolate domain ${first} net enforce`);
      }
      if (r.refused.length) {
        out(`refused for not being on the list:`);
        for (const entry of r.refused.slice(0, 60)) out(`  ${String(entry.count).padStart(5)}  ${entry.host}`);
        out(`to allow them:\n  desolate domain ${first} net allow ${names(r.refused.slice(0, 60))}`);
      }
      return out("Read the list before you allow it: a workspace chooses what it asks for.");
    }
    const change = action === "open" || action === "enforce" ? { mode: action } : action === "allow" ? { allow: rest } : action === "deny" ? { deny: rest } : action === "allow-internal" ? { internal: rest } : null;
    if (action && action !== "show" && !change) refuse(`'net ${action}' is not understood`, `desolate domain ${first} net show | open | enforce | allow <host>... | deny <host>... | allow-internal <address> | recommend`, EXIT.usage);
    const policy = await rootctl<Policy>("net.policy", { domain: first, change: change ?? undefined }, { quiet: true });
    if (json) return out(JSON.stringify(policy));
    out(`${first}: ${policy.mode === "enforce" ? `only these hosts are reachable: ${policy.hosts.join(", ") || "(none)"}` : "any public host is reachable (open). Its workspaces still reach nothing internal"}`);
    if (policy.mode === "open" && policy.hosts.length) out(`  listed, for when it is enforced: ${policy.hosts.join(", ")}`);
    if (policy.internal.length) out(`  internal addresses it may reach: ${policy.internal.join(", ")}`);
    return;
  }
  if (second === "secret") {
    await ensureProxyUser(first);
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
      const switched = (await changeSecrets<Listed[]>(first, "switch", { name, on: action === "on", ttlSeconds })).find((s) => s.name === name)!;
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
        const set = (await changeSecrets<Listed[]>(first, "set", { name, value, hosts: csv(values.hosts), headers: csv(values.headers) })).find((s) => s.name === name)!;
        await trustCa(first);
        if (json) return out(JSON.stringify(set));
        out(`${set.name} is held in the root for the domain ${first}. Its workspaces send the name; the value is put in its place on the way to: ${set.hosts.join(", ")}${set.headers ? ` (in the header${set.headers.length > 1 ? "s" : ""} ${set.headers.join(", ")} only)` : ""}.`);
        return out(`in a workspace: export SOME_API_KEY=${set.name}   (the name is not a secret)`);
      }
      const existed = (await rootctl<Listed[]>("secret.list", { domain: first }, { quiet: true })).some((s) => s.name === name);
      await changeSecrets<Listed[]>(first, "remove", { name });
      return out(json ? JSON.stringify({ existed }) : existed ? `${name} is no longer held for the domain ${first}.` : `the domain ${first} had no secret named ${name}.`);
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
