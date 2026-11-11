// The desolate command, on the host. It drives everything, holds no key, and runs no git on
// desolate's repositories (P4).
import { parseArgs } from "node:util";
import { EXIT, Refusal } from "../shared/exit.ts";

const HELP = `desolate: a VM per workspace, an editor inside it, and every push through you.

  desolate bootstrap [--backend vz|qemu|fake] [--forge github]   from nothing to a working stack
  desolate doctor [--json]                                       check it; every failure names its fix
  desolate down                                                  stop every VM and the daemon; remove nothing
  desolate destroy [--all]                                       remove the VMs (--all: and ~/.desolate)
  desolate completion                                            tab completion: source <(desolate completion)

  desolate clone <owner/repo> [--no-push] [--anonymous]          keys, mirror (with LFS), root clone
  desolate fetch <owner/repo>                                    remote -> mirror
  desolate repos [--json]
  desolate keys [<owner/repo>] [--json]                          which keys the root holds; a key's public half

  desolate domain create <slug> [--title "..."]                  a trust boundary: repositories and secrets
  desolate domain <slug> add --repo <owner/repo>                 give the domain a repository
  desolate domain <slug> env [--from <owner/repo>]               whose devcontainer.json its workspaces run
  desolate domain <slug> net [open | enforce | allow <host>... | deny <host>...]
                                                                 the domain's network rules, at its proxies
  desolate net log [<domain>] [--json]                           what each workspace asked to reach, and the verdict
  desolate domain <domain> net recommend                         what it reached that is not on its list
  desolate domain <domain> secret set <NAME> --hosts <h>[,...] [--headers <h>[,...]] | list | off | on [--ttl 30m] | rm
                                                                 a secret: the value on stdin, the name in workspaces
  desolate up <domain> [--name <workspace>] [--fetch] [--base <ref>]
              [--checkout <owner/repo>=main|worktree:<branch>]   a workspace: one VM, its checkouts
  desolate list [<domain>] [--json]
  desolate status | board <domain>[/<workspace>] [--json]        how each checkout says its work is going
  desolate ports [<domain>/<workspace>] [--json]                 what is forwarded, at which URL; what is reserved
  desolate editor <domain>/<workspace> [--json]                  the address of its editor, for your browser
  desolate exec <domain>/<workspace> [--checkout <repo>] [--vm] -- <cmd>
                                                                 a command, or an agent, in its devcontainer
                                                                 (or in the VM itself: when it has none, or --vm)
  desolate stop | start | rm <domain>/<workspace>
  desolate rm <domain>                                           the domain and its clones; not the root's

  desolate offers [<domain>] [--json]                            what workspaces have offered: needs you
  desolate review <domain> <owner/repo> <branch> [--json]        what a push would send
  desolate push <domain> <owner/repo> <branch> --expect <commit> [--allow-default]
                                                                 to the remote; you approve it here, on the
                                                                 host: Touch ID on a Mac, else your terminal
  desolate approve [--selftest]                                  approve a raw git push waiting in the root shell
  desolate ui [--json]                                           the dashboard's address, and the root editor's
  desolate root shell                                            the root's terminal: git on the root clones

  desolate help                                                  this text

Every command that reads takes --json. Exit codes: 0 ok, 1 failed, 64 usage, 75 busy,
77 default branch refused, 78 no person confirmed the push, 79 --expect did not match.`;

const out = (line: string) => process.stdout.write(`${line}\n`);

type Flags = { values: Record<string, unknown>; positionals: string[] };
const flags = (argv: string[], options: Record<string, { type: "boolean" | "string"; multiple?: boolean }>): Flags => {
  try {
    return parseArgs({ args: argv, options: { json: { type: "boolean" }, help: { type: "boolean" }, ...options }, allowPositionals: true, strict: true }) as Flags;
  } catch (error) {
    throw new Refusal((error as Error).message, "desolate help", EXIT.usage);
  }
};

const main = async (argv: string[]): Promise<number> => {
  const [verb, ...rest] = argv;
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    out(HELP);
    return verb ? EXIT.ok : EXIT.usage;
  }
  if (verb === "bootstrap") {
    const { values } = flags(rest, { backend: { type: "string" }, forge: { type: "string" }, "forge-known-hosts": { type: "string" } });
    if (values.backend) process.env.DESOLATE_BACKEND = String(values.backend);
    const { bootstrap } = await import("./bootstrap.ts");
    await bootstrap({ forge: values.forge as string | undefined, forgeKnownHosts: values["forge-known-hosts"] as string | undefined }, out);
    return EXIT.ok;
  }
  if (verb === "doctor") {
    const { values } = flags(rest, {});
    const { doctor } = await import("./bootstrap.ts");
    return (await doctor(out, values.json === true)) === 0 ? EXIT.ok : EXIT.failed;
  }
  if (verb === "destroy") {
    const { values } = flags(rest, { all: { type: "boolean" } });
    const { destroy } = await import("./bootstrap.ts");
    return (await destroy({ all: values.all === true }, out)).length === 0 ? EXIT.ok : EXIT.failed;
  }
  if (verb === "clone") {
    const { values, positionals } = flags(rest, { "no-push": { type: "boolean" }, anonymous: { type: "boolean" } });
    const { clone } = await import("./repos.ts");
    await clone(positionals[0], { push: values["no-push"] !== true && values.anonymous !== true, anonymous: values.anonymous === true }, out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "fetch") {
    const { values, positionals } = flags(rest, {});
    const { fetch } = await import("./repos.ts");
    await fetch(positionals[0], out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "keys") {
    const { values, positionals } = flags(rest, {});
    const { keys } = await import("./repos.ts");
    await keys(positionals[0], out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "repos") {
    const { values } = flags(rest, {});
    const { repos } = await import("./repos.ts");
    await repos(out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "domain") {
    const { values, positionals } = flags(rest, { title: { type: "string" }, repo: { type: "string" }, hosts: { type: "string" }, headers: { type: "string" }, ttl: { type: "string" }, secret: { type: "string" }, from: { type: "string" } });
    const { domainCommand } = await import("./domains.ts");
    await domainCommand(positionals, values, out);
    return EXIT.ok;
  }
  if (verb === "net" && rest[0] === "log") {
    const { values, positionals } = flags(rest.slice(1), {});
    const { rootctl } = await import("./stack.ts");
    const entries = await rootctl<{ time: string; domain: string; workspace: string; host: string; port: number; verdict: string; reason?: string; secrets?: string[] }[]>("net.log", { domain: positionals[0] }, { quiet: true });
    if (values.json === true) out(JSON.stringify(entries));
    else for (const e of entries) out(`${e.time}  domain=${e.domain} workspace=${e.workspace}  ${e.verdict}  ${String(e.host).replace(/[^\x21-\x7e]/g, "?")}:${e.port}${Array.isArray(e.secrets) ? `  [${e.secrets.join(", ").replace(/[^\x21-\x7e ]/g, "?")}]` : ""}${e.reason ? `  (${e.reason})` : ""}`);
    return EXIT.ok;
  }
  if (verb === "up") {
    const { values, positionals } = flags(rest, { name: { type: "string" }, checkout: { type: "string", multiple: true }, base: { type: "string" }, fetch: { type: "boolean" } });
    const { up } = await import("./workspaces.ts");
    await up(positionals[0], { name: values.name as string | undefined, checkouts: (values.checkout as string[] | undefined) ?? [], base: values.base as string | undefined, fetch: values.fetch === true }, out, values.json === true);
    return EXIT.ok;
  }
  if ((verb === "status" || verb === "board") && rest.some((arg) => !arg.startsWith("-"))) {
    const { values, positionals } = flags(rest, {});
    const { status } = await import("./status.ts");
    await status(positionals[0], out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "list" || verb === "status") {
    const { values, positionals } = flags(rest, {});
    const { list } = await import("./workspaces.ts");
    await list(out, values.json === true, positionals[0]);
    return EXIT.ok;
  }
  if (verb === "stop" || verb === "start" || verb === "rm") {
    const { positionals } = flags(rest, {});
    const workspaces = await import("./workspaces.ts");
    await (verb === "stop" ? workspaces.stop : verb === "start" ? workspaces.start : workspaces.remove)(positionals[0], out);
    return EXIT.ok;
  }
  if (verb === "offers") {
    const { values, positionals } = flags(rest, {});
    const { offers } = await import("./push.ts");
    await offers(positionals[0], out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "review") {
    const { values, positionals } = flags(rest, {});
    const { review } = await import("./push.ts");
    await review(positionals, out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "push") {
    flags(rest, { expect: { type: "string" }, "allow-default": { type: "boolean" } });
    const { push } = await import("./push.ts");
    return push(rest);
  }
  if (verb === "ui") {
    const { values } = flags(rest, {});
    const { ui } = await import("./daemon.ts");
    const shown = await ui();
    if (values.json === true) out(JSON.stringify(shown));
    else {
      out(`dashboard    ${shown.dashboard}`);
      out(shown.rootEditor ? `root editor  ${shown.rootEditor}` : "root editor  not running (desolate bootstrap starts it)");
    }
    return EXIT.ok;
  }
  if (verb === "down") {
    const { down } = await import("./bootstrap.ts");
    await down(out);
    return EXIT.ok;
  }
  if (verb === "completion") {
    const fs = await import("node:fs");
    const { RELEASE_DIR } = await import("./paths.ts");
    process.stdout.write(fs.readFileSync(`${RELEASE_DIR}/completion.bash`, "utf8"));
    return EXIT.ok;
  }
  if (verb === "editor") {
    const { values, positionals } = flags(rest, {});
    const { editor } = await import("./workspaces.ts");
    await editor(positionals[0], out, values.json === true);
    return 0;
  }
  if (verb === "approve") {
    if (rest.includes("--selftest")) return (await import("./approver.ts")).selftest(out);
    const { approve } = await import("./push.ts");
    return approve(out);
  }
  if (verb === "root" && rest[0] === "shell") {
    const { rootShell } = await import("./push.ts");
    return rootShell();
  }
  if (verb === "ports") {
    const { values, positionals } = flags(rest, {});
    const { ports } = await import("./daemon.ts");
    const view = (await ports()).filter((w) => !positionals[0] || w.workspace === positionals[0]);
    if (values.json === true) out(JSON.stringify(view));
    else if (view.length === 0) out("no workspace is running.");
    else for (const w of view) {
      out(w.workspace);
      if (w.forwarded.length === 0) out("  nothing is listening yet: start a dev server in it and its URL appears here");
      for (const f of w.forwarded) out(`  ${f.url}`);
      for (const r of w.reserved) out(`  port ${r.port} is kept taken here: ${r.why}`);
    }
    return EXIT.ok;
  }
  if (verb === "exec") {
    const split = rest.indexOf("--");
    const { values, positionals } = flags(split < 0 ? rest : rest.slice(0, split), { checkout: { type: "string" }, vm: { type: "boolean" } });
    const { exec } = await import("./workspaces.ts");
    return exec(positionals[0], split < 0 ? positionals.slice(1) : rest.slice(split + 1), { checkout: values.checkout as string | undefined, vm: values.vm === true });
  }
  throw new Refusal(`desolate has no command '${verb}'`, "desolate help", EXIT.usage);
};

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof Refusal) {
    process.stderr.write(`desolate: ${error.message}\n`);
    if (error.fix) process.stderr.write(`  fix: ${error.fix}\n`);
    process.exitCode = error.code;
  } else {
    process.stderr.write(`desolate: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = EXIT.failed;
  }
}
