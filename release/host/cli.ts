// The desolate command, on the host. It drives everything, holds no key, and runs no git on
// desolate's repositories (P4).
import { printable } from "../shared/text.ts";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { parseArgs } from "node:util";
import { EXIT, Refusal, refuse } from "../shared/exit.ts";
import { parseRepo } from "../shared/names.ts";

const HELP = `desolate: a VM per workspace, an editor inside it, and every push through you.

  desolate bootstrap [--backend vz|qemu|fake] [--forge github]   from nothing to a working stack
  desolate doctor [--json]                                       check it; every failure names its fix
  desolate down                                                  stop every VM and the daemon; remove nothing
  desolate destroy [--all]                                       remove the VMs (--all: and ~/.desolate)
  desolate completion                                            tab completion: source <(desolate completion)

  desolate clone <owner/repo> [--no-push] [--anonymous]          keys, mirror (with LFS), root clone, and a domain
                [--domain <d> | --no-domain]                    named after the repository (or <d>; or none)
  desolate fetch <owner/repo>                                    remote -> mirror
  desolate repos [--json]
  desolate keys [<owner/repo>] [--json]                          which keys the root holds; a key's public half

  desolate domain create <slug> [--title "..."] [--repo <owner/repo>]...
                                                                 a trust boundary: repositories and secrets
  desolate domain <slug> add --repo <owner/repo>                 give the domain a repository
  desolate domain <slug> size [--cpus <n>] [--memory <8g>] [--disk <60g>] [--clear]
                                                                 what its new workspaces get (shown: the effective size)
  desolate domain <slug> env [--from <owner/repo>]               whose devcontainer.json its workspaces run
  desolate domain <slug> net [open | enforce | allow <host>... | deny <host>...]
                                                                 the domain's network rules, at its proxies
  desolate net log [<domain>] [--json]                           what each workspace asked to reach, and the verdict
  desolate domain <domain> net recommend                         what it reached that is not on its list
  desolate domain <domain> secret set <NAME> --hosts <h>[,...] [--headers <h>[,...]] | list | off | on [--ttl 30m] | rm
                                                                 a secret: the value on stdin, the name in workspaces
  desolate up <domain> [--name <workspace>] [--branch <branch>] [--fetch] [--base <ref>]
              [--cpus <n>] [--memory <8g>] [--disk <60g>]   (defaults: from this Mac; per domain: domain <d> size)
              [--checkout <owner/repo>=main|worktree:<branch>]   a workspace: one VM, its checkouts
  desolate list [<domain>] [--json]
  desolate status | board <domain>[/<workspace>] [--json]        how each checkout says its work is going
  desolate ports [<domain>/<workspace>] [--json]                 what is forwarded, at which URL; what is reserved
  desolate editor <domain>/<workspace> [--open] [--json]         the address of its editor, for your browser
  desolate exec <domain>/<workspace> [--checkout <repo>] [--vm] -- <cmd>
                                                                 a command, or an agent, in its devcontainer
                                                                 (or in the VM itself: when it has none, or --vm)
  desolate stop | start | rm <domain>/<workspace>
  desolate rm <domain>                                           the domain and its clones; not the root's

  desolate offers [<domain>] [--json]                            what workspaces have offered: needs you
  desolate branches [<domain>] [--json]                          every branch each domain has (offered or not)
  desolate review <domain> <owner/repo> <branch> [--diff] [--against origin|domain] [--json]
                                                                 what a push would send; --diff: the diff itself
  desolate push <domain> <owner/repo> <branch> --expect <commit> [--allow-default]
                                                                 to the remote; you approve it here, on the
                                                                 host, on your terminal
  desolate events [--replay <n>]                                 what happens, as JSON lines, until stopped: pushed,
                                                                 offered, status, approval-waiting, workspace-up, ...
  desolate task <domain> "<what to do>" [--name <w>] [--branch <b>] [--attach] [-- <agent...>]
                                                                 a workspace, its branch and an agent on it, at once
  desolate agent start <domain>/<workspace> [--name <n>] [--checkout <repo>] -- <command...>
                                                                 an agent kept running in a workspace (no tmux)
  desolate agent attach|log|stop <domain>/<workspace> [--name <n>]   your terminal on it; Ctrl-] detaches
  desolate agent list [<domain>[/<workspace>]] [--json]          every agent, in every workspace
  desolate factory issues --repo <owner/repo> --domain <d> [--max 3]
                                                                 labelled issues -> workspaces with agents, in parallel
  desolate factory suede [--domain suede]                        pushes to a default branch -> an agent on each
                                                                 vendored suede dependency they changed
  desolate suede changed <owner/repo> <commit> [--from <commit>] [--json]
                                                                 which vendored suede dependencies a commit changed
  desolate notify                                                notifications on this Mac: a push waiting, an offer,
                                                                 an agent asking for you, a push done; until stopped
  desolate git [<owner/repo>] [--open]                           a shell in the git VM, in your browser: your own
                                                                 clones, git and nothing else; pushes wait for approval
  desolate approve [--web [--open] | --selftest]                 approve a raw git push waiting in the root shell
                                                                 (--web: the approval page's address, for one click)
  desolate ui [--open] [--json]                                  the dashboard's address, for your browser
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

/** `--open`: the address in a browser on this Mac. Chrome or Firefox if there is one:
 *  Safari cannot find desolate's *.localhost names. */
const openInBrowser = (url: string) => {
  if (process.platform !== "darwin") return void spawnSync("xdg-open", [url], { stdio: "ignore" });
  const browser = process.env.DESOLATE_BROWSER ?? ["Google Chrome", "Firefox", "Chromium", "Brave Browser", "Microsoft Edge"].find((app) => fs.existsSync(`/Applications/${app}.app`));
  const opened = spawnSync("open", browser ? ["-a", browser, url] : [url], { stdio: "ignore" });
  if (opened.status !== 0 || !browser) process.stderr.write(`desolate: ${browser ? `could not open ${browser}` : "no Chrome or Firefox found: Safari cannot open *.localhost addresses"}; open the address above in Chrome or Firefox\n`);
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
    const { values, positionals } = flags(rest, { "no-push": { type: "boolean" }, anonymous: { type: "boolean" }, domain: { type: "string" }, "no-domain": { type: "boolean" } });
    const { clone } = await import("./repos.ts");
    if (values.domain !== undefined && values["no-domain"] === true) refuse("--domain and --no-domain say opposite things", "give one of them", EXIT.usage);
    await clone(positionals[0], { push: values["no-push"] !== true && values.anonymous !== true, anonymous: values.anonymous === true, domain: values["no-domain"] === true ? false : values.domain as string | undefined }, out, values.json === true);
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
    const { values, positionals } = flags(rest, { title: { type: "string" }, repo: { type: "string", multiple: true }, cpus: { type: "string" }, memory: { type: "string" }, disk: { type: "string" }, clear: { type: "boolean" }, hosts: { type: "string" }, headers: { type: "string" }, ttl: { type: "string" }, secret: { type: "string" }, from: { type: "string" } });
    const { domainCommand } = await import("./domains.ts");
    await domainCommand(positionals, values, out);
    return EXIT.ok;
  }
  if (verb === "net" && rest[0] === "log") {
    const { values, positionals } = flags(rest.slice(1), {});
    const { rootctl } = await import("./stack.ts");
    const entries = await rootctl<{ time: string; domain: string; workspace: string; host: string; port: number; verdict: string; reason?: string; secrets?: string[] }[]>("net.log", { domain: positionals[0] }, { quiet: true });
    if (values.json === true) out(JSON.stringify(entries));
    else for (const e of entries) out(`${e.time}  domain=${e.domain} workspace=${e.workspace}  ${e.verdict}  ${String(e.host).replace(/[^\x21-\x7e]/g, "?")}:${e.port}${Array.isArray(e.secrets) ? `  [${e.secrets.join(", ").replace(/[^\x21-\x7e ]/g, "?")}]` : ""}${e.reason ? `  (${printable(e.reason)})` : ""}`);
    return EXIT.ok;
  }
  if (verb === "up") {
    const { values, positionals } = flags(rest, { name: { type: "string" }, checkout: { type: "string", multiple: true }, branch: { type: "string" }, base: { type: "string" }, fetch: { type: "boolean" }, cpus: { type: "string" }, memory: { type: "string" }, disk: { type: "string" } });
    const { up, sizeFlags } = await import("./workspaces.ts");
    await up(positionals[0], { name: values.name as string | undefined, checkouts: (values.checkout as string[] | undefined) ?? [], branch: values.branch as string | undefined, base: values.base as string | undefined, fetch: values.fetch === true, size: sizeFlags(values) }, out, values.json === true);
    return EXIT.ok;
  }
  if ((verb === "status" || verb === "board") && rest.some((arg) => !arg.startsWith("-"))) {
    const { values, positionals } = flags(rest, {});
    const { status } = await import("./status.ts");
    await status(positionals[0], out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "list" || verb === "status" || verb === "board") {
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
  if (verb === "branches") {
    const { values, positionals } = flags(rest, {});
    const { branches } = await import("./push.ts");
    await branches(positionals[0], out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "review") {
    const { values, positionals } = flags(rest, { diff: { type: "boolean" }, against: { type: "string" } });
    if (values.against !== undefined && values.against !== "origin" && values.against !== "domain") refuse(`--against '${String(values.against)}' is not understood`, "--against origin (the remote's default branch, as the mirror has it) or --against domain (the domain's own copy of it)", EXIT.usage);
    const { review } = await import("./push.ts");
    await review(values.diff === true ? [...positionals, "--diff"] : positionals, out, values.json === true, values.against === "domain" ? "domain" : "origin");
    return EXIT.ok;
  }
  if (verb === "push") {
    flags(rest, { expect: { type: "string" }, "allow-default": { type: "boolean" } });
    const { push } = await import("./push.ts");
    return push(rest);
  }
  if (verb === "ui") {
    const { values } = flags(rest, { open: { type: "boolean" } });
    const { ui } = await import("./daemon.ts");
    const shown = await ui();
    if (values.json === true) out(JSON.stringify(shown));
    else out(`dashboard    ${shown.dashboard}\napprovals    ${shown.approvals}`);
    if (values.open === true) openInBrowser(shown.dashboard);
    return EXIT.ok;
  }
  if (verb === "down") {
    if (flags(rest, {}).positionals.length > 0) refuse("desolate down takes no arguments: it stops every VM (and removes nothing)", "desolate down", EXIT.usage);
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
    const { values, positionals } = flags(rest, { open: { type: "boolean" } });
    const { editor } = await import("./workspaces.ts");
    let url = "";
    await editor(positionals[0], (line) => {
      url = /(http:\/\/\S+)/.exec(line)?.[1] ?? url;
      out(line);
    }, values.json === true);
    if (values.open === true && url) openInBrowser(url);
    return 0;
  }
  if (verb === "approve") {
    const { values } = flags(rest, { selftest: { type: "boolean" }, web: { type: "boolean" }, open: { type: "boolean" } });
    if (values.selftest === true) return (await import("./approver.ts")).selftest(out);
    if (values.web === true) {
      // The page's address carries this stack's token: it is the person's to open in a
      // browser on this Mac, and not to paste anywhere else.
      const { ensureDaemon } = await import("./daemon.ts");
      await ensureDaemon();
      const address = (await import("./approve-web.ts")).approveAddress();
      out(`approvals    ${address}`);
      if (values.open === true) openInBrowser(address);
      return EXIT.ok;
    }
    const { approve } = await import("./push.ts");
    return approve(out);
  }
  if (verb === "events") {
    // JSON lines, one per event, until stopped: for a script to act on (events.ts says how
    // far each kind of event can be believed).
    const { values } = flags(rest, { replay: { type: "string" } });
    const replay = values.replay === undefined ? 0 : Number(values.replay);
    if (!Number.isInteger(replay) || replay < 0) refuse("--replay takes a number", "desolate events --replay 20", EXIT.usage);
    const { followEvents } = await import("./daemon.ts");
    // (A reader that stops reading is let go by the daemon, with a "lagged" line: this
    // process does not pile lines up either, it stops when stdout does.)
    process.stdout.on("error", () => process.exit(0));
    await followEvents(replay, (line) => process.stdout.write(`${line}\n`), (resume) => process.stdout.once("drain", resume));
  }
  if (verb === "agent") {
    // `--` ends desolate's own flags: everything after it is the agent's command.
    const dash = rest.indexOf("--");
    const own = dash >= 0 ? rest.slice(0, dash) : rest;
    const command = dash >= 0 ? rest.slice(dash + 1) : [];
    const { values, positionals } = flags(own, { name: { type: "string" }, checkout: { type: "string" } });
    const agents = await import("./agent.ts");
    const [sub, where] = positionals;
    if (sub === "start") await agents.start(where, { name: values.name as string | undefined, checkout: values.checkout as string | undefined }, command, out, values.json === true);
    else if (sub === "attach") return agents.attach(where, { name: values.name as string | undefined });
    else if (sub === "list") await agents.list(where, out, values.json === true);
    else if (sub === "stop") await agents.stop(where, { name: values.name as string | undefined }, out);
    else if (sub === "log") await agents.log(where, { name: values.name as string | undefined });
    else refuse("desolate agent what?", "desolate agent start|attach|list|log|stop <domain>/<workspace> [--name <n>]", EXIT.usage);
    return EXIT.ok;
  }
  if (verb === "task") {
    // From a sentence to an agent at work on it (release/factory/task.ts).
    const { RELEASE_DIR } = await import("./paths.ts");
    const child = (await import("node:child_process")).spawn(process.execPath, ["--disable-warning=ExperimentalWarning", `${RELEASE_DIR}/factory/task.ts`, ...rest], { stdio: "inherit" });
    return new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  }
  if (verb === "factory") {
    // Harnesses on top of desolate (release/factory/): they drive this CLI and your gh.
    const [which, ...args] = rest;
    if (which !== "issues" && which !== "suede") refuse("desolate factory what?", "desolate factory issues --repo <owner/repo> --domain <d> | desolate factory suede [--domain <d>]", EXIT.usage);
    const { RELEASE_DIR } = await import("./paths.ts");
    const child = (await import("node:child_process")).spawn(process.execPath, ["--disable-warning=ExperimentalWarning", `${RELEASE_DIR}/factory/${which}.ts`, ...args], { stdio: "inherit" });
    return new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  }
  if (verb === "suede" && rest[0] === "changed") {
    const { values, positionals } = flags(rest.slice(1), { from: { type: "string" } });
    const { rootctl } = await import("./stack.ts");
    const changed = await rootctl<{ dir: string; remote: string | null; branch: string; files: string[] }[]>("suede.changed", { repo: positionals[0], to: positionals[1], from: values.from ?? null }, { quiet: true });
    if (values.json === true) out(JSON.stringify(changed));
    else for (const c of changed) out(`  ${c.dir}  ${c.remote ?? "(no remote)"} ${c.branch}  ${c.files.length ? `${c.files.length} file(s) changed` : "unchanged"}`);
    return EXIT.ok;
  }
  if (verb === "notify") {
    flags(rest, {});
    await (await import("./notify.ts")).notify(out);
    return EXIT.ok;
  }
  if (verb === "git") {
    // A shell in the git VM, in a browser tab: the address carries this stack's token, and
    // is the person's to open on this Mac.
    const { values: gitValues, positionals: gitArgs } = flags(rest, { open: { type: "boolean" } });
    const repo = gitArgs[0];
    if (repo !== undefined && !parseRepo(repo)) refuse(`'${repo}' is not a repository`, "desolate git <owner/repo>", EXIT.usage);
    const { ensureGitVm, ensureGitClone } = await import("./git-vm.ts");
    await ensureGitVm((line) => process.stderr.write(`${line}\n`));
    if (repo) await ensureGitClone(parseRepo(repo)!);
    const { ensureDaemon } = await import("./daemon.ts");
    await ensureDaemon();
    const address = (await import("./git-web.ts")).gitAddress(repo);
    out(`git          ${address}`);
    if (gitValues.open === true) openInBrowser(address);
    return EXIT.ok;
  }
  if (verb === "root" && rest[0] === "shell") {
    flags(rest.slice(1), {});
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

// Piped into something that stops reading (`desolate list | head -1`): done, not a crash.
process.stdout.on("error", (error: NodeJS.ErrnoException) => process.exit(error.code === "EPIPE" ? 0 : EXIT.failed));
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
