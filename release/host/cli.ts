// The desolate command, on the host. It drives everything, holds no key, and runs no git on
// desolate's repositories (P4).
import { parseArgs } from "node:util";
import { EXIT, Refusal } from "../shared/exit.ts";

const HELP = `desolate: a VM per workspace, an editor inside it, and every push through you.

  desolate bootstrap [--backend vz|qemu|fake] [--forge github]   from nothing to a working stack
  desolate doctor [--json]                                       check it; every failure names its fix
  desolate destroy [--all]                                       remove the VMs (--all: and ~/.desolate)

  desolate clone <owner/repo> [--no-push] [--anonymous]          keys, mirror (with LFS), root clone
  desolate fetch <owner/repo>                                    remote -> mirror
  desolate repos [--json]

  desolate help                                                  this text

Every command that reads takes --json. Exit codes: 0 ok, 1 failed, 64 usage, 75 busy,
77 default branch refused, 78 no person confirmed the push, 79 --expect did not match.`;

const out = (line: string) => process.stdout.write(`${line}\n`);

const flags = (argv: string[], options: Record<string, { type: "boolean" | "string"; multiple?: boolean }>) => {
  try {
    return parseArgs({ args: argv, options: { json: { type: "boolean" }, help: { type: "boolean" }, ...options }, allowPositionals: true, strict: true });
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
  if (verb === "repos") {
    const { values } = flags(rest, {});
    const { repos } = await import("./repos.ts");
    await repos(out, values.json === true);
    return EXIT.ok;
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
