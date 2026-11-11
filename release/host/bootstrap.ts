// bootstrap, doctor, destroy (section 13.1).
import * as fs from "node:fs";
import * as path from "node:path";
import { refuse } from "../shared/exit.ts";
import { waitFor } from "../shared/run.ts";
import { INSTANCE, paths, RELEASE_DIR, guest } from "./paths.ts";
import { backend, backendKind, config, ensureHome, ROOT_VM, rootctl, rootSpec, saveConfig } from "./stack.ts";
import type { Config, ForgeConfig } from "./stack.ts";
import type { Check } from "./vm/types.ts";

type Out = (line: string) => void;

const githubForge = (): ForgeConfig => ({
  kind: "github",
  ssh: { user: "git", host: "github.com", port: 22 },
  knownHosts: fs.readFileSync(path.join(RELEASE_DIR, "root", "github_known_hosts"), "utf8"),
});

/** `--forge stand-in:ssh://git@host:port --forge-known-hosts <file>`: a local git server
 *  standing in for GitHub, so no test needs the real one (section 13.2). */
export const parseForge = (spec: string | undefined, knownHostsFile: string | undefined): ForgeConfig => {
  if (!spec || spec === "github") return githubForge();
  const match = /^stand-in:ssh:\/\/([a-z_][a-z0-9_-]*)@([A-Za-z0-9.-]+):(\d+)$/.exec(spec);
  if (!match) refuse(`--forge '${spec}' is not understood`, "use --forge github, or --forge stand-in:ssh://git@<host>:<port> --forge-known-hosts <file>");
  if (!knownHostsFile || !fs.existsSync(knownHostsFile)) refuse("a stand-in forge needs its host key", "pass --forge-known-hosts <file> (known_hosts lines for the forge)");
  return { kind: "stand-in", ssh: { user: match![1]!, host: match![2]!, port: Number(match![3]) }, knownHosts: fs.readFileSync(knownHostsFile!, "utf8") };
};

const startRootServices = async () => {
  const uid = process.getuid!();
  const result = await backend().exec(ROOT_VM, ["bash", `${guest.release}/root/start.sh`, String(uid)], { root: true, timeoutMs: 120_000 });
  if (result.code !== 0) throw new Error(`the root's services did not start: ${(result.stderr || result.stdout).trim().slice(-600)}`);
};

/** From a clean machine to a working stack. Idempotent: run twice, the second run changes
 *  nothing and says so. */
export const bootstrap = async (options: { forge?: string; forgeKnownHosts?: string }, out: Out) => {
  const changed: string[] = [];
  const step = (did: boolean, text: string) => {
    out(`${did ? "  + " : "  = "}${text}`);
    if (did) changed.push(text);
  };
  const kind = backendKind();
  out(`desolate bootstrap: backend ${kind}${kind === "fake" ? " (NOT ISOLATED: containers standing in for VMs; tests only)" : ""}, instance ${INSTANCE}`);

  const fresh = !fs.existsSync(paths.state);
  ensureHome();
  step(fresh, `home ${paths.home}`);

  const b = backend();
  const missing = (await b.check()).filter((check) => !check.ok && check.name !== "base image");
  if (missing.length > 0) refuse(`the ${kind} backend is missing: ${missing.map((c) => `${c.name} (${c.detail})`).join("; ")}`, missing.map((c) => c.fix).filter(Boolean).join("; "));

  const before = (await b.check()).find((check) => check.name === "base image")?.ok ?? false;
  await b.ensureImage((line) => out(`    ${line}`));
  step(!before, "base image");

  const existing = config();
  const forge = options.forge ? parseForge(options.forge, options.forgeKnownHosts) : existing?.forge ?? parseForge(undefined, undefined);
  const next: Config = { backend: kind, forge };
  const configChanged = JSON.stringify(existing) !== JSON.stringify(next);
  if (configChanged) saveConfig(next);
  step(configChanged, `config: backend ${kind}, forge ${forge.kind} (${forge.ssh.host}:${forge.ssh.port})`);

  const info = await b.info(ROOT_VM);
  if (info.status === "missing") await b.create(rootSpec());
  step(info.status === "missing", `root VM ${ROOT_VM} created`);
  if (info.status !== "running") {
    if (info.status === "suspended") await b.resume(ROOT_VM);
    else await b.start(ROOT_VM);
  }
  step(info.status !== "running", "root VM running");

  const wasUp = await rootctl<{ keyring: boolean }>("ping", {}, { quiet: true, timeoutMs: 30_000 }).then((r) => r.keyring, () => false);
  if (!wasUp) {
    await startRootServices();
    const up = await waitFor(() => rootctl<{ keyring: boolean }>("ping", {}, { quiet: true, timeoutMs: 30_000 }).then((r) => r.keyring), 30_000, 500);
    if (!up) refuse("the root's keyring did not come up", "desolate doctor");
  }
  step(!wasUp, "root services: keyring");
  if (configChanged || !wasUp) await rootctl("forge.set", { forge }, { quiet: true });

  out(changed.length === 0 ? "bootstrap: nothing changed; the stack was already up." : `bootstrap: ${changed.length} step(s) done.`);
  const failed = await doctor(out);
  if (failed > 0) refuse(`bootstrap finished, but doctor found ${failed} problem(s)`, "fix what doctor names, then run `desolate bootstrap` again");
};

/** Checks, with v2 preflight's false-pass discipline: a check that could not be asked is a
 *  failure, never a pass, and every failure names the command that fixes it. Returns how
 *  many failed. */
export const doctor = async (out: Out, json = false): Promise<number> => {
  const checks: Check[] = [];
  const kind = backendKind();
  const b = backend();
  checks.push({ name: "home", ok: fs.existsSync(paths.state), detail: paths.home, fix: "desolate bootstrap" });
  checks.push({
    name: "backend gives isolation", ok: b.isolated || process.env.DESOLATE_TEST_RUN === "1",
    detail: b.isolated ? kind : `${kind}: containers stand in for VMs. NOTHING here is isolated${process.env.DESOLATE_TEST_RUN === "1" ? " (allowed: DESOLATE_TEST_RUN=1)" : ""}`,
    fix: "use a real backend: `desolate destroy --all`, then `desolate bootstrap --backend qemu` (Linux) or `--backend vz` (macOS)",
  });
  try {
    checks.push(...(await b.check()));
  } catch (error) {
    checks.push({ name: "backend", ok: false, detail: `could not be checked: ${String(error)}`, fix: "desolate bootstrap" });
  }
  let rootUp = false;
  try {
    rootUp = (await b.info(ROOT_VM)).status === "running";
    checks.push({ name: "root VM running", ok: rootUp, detail: ROOT_VM, fix: "desolate bootstrap" });
  } catch (error) {
    checks.push({ name: "root VM running", ok: false, detail: `could not be asked: ${String(error)}`, fix: "desolate bootstrap" });
  }
  // What only the root can say. If it cannot be asked, each of these is a failure: a probe
  // that did not run is not a probe that found nothing (P6).
  const rootChecks = ["root: keyring answers", "root: approvals socket is closed to the root's own user", "root: private keys are unreadable to the root's own user", "root: forge configured"];
  let asked: Check[] | null = null;
  if (rootUp)
    try {
      asked = await rootctl<Check[]>("doctor", {}, { quiet: true, timeoutMs: 60_000 });
    } catch {
      asked = null;
    }
  if (asked) checks.push(...asked);
  else for (const name of rootChecks) checks.push({ name, ok: false, detail: "could not be asked: the root does not answer", fix: "desolate bootstrap" });

  const failed = checks.filter((check) => !check.ok);
  if (json) out(JSON.stringify({ ok: failed.length === 0, backend: kind, isolated: b.isolated, checks }, null, 2));
  else {
    for (const check of checks) out(`  ${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}${check.ok || !check.fix ? "" : `\n         fix: ${check.fix}`}`);
    out(failed.length === 0 ? "doctor: all checks passed." : `doctor: ${failed.length} of ${checks.length} checks FAILED.`);
  }
  return failed.length;
};

/** Put the machine back as it was. With --all the home goes too. Returns what is left that
 *  should not be (an empty list is the passing answer; the test asserts it). */
export const destroy = async (options: { all: boolean }, out: Out): Promise<string[]> => {
  const b = backend();
  const { stopForwarder } = await import("./daemon.ts");
  await stopForwarder();
  for (const vm of await b.list()) {
    out(`  - VM ${vm.name}${vm.labels.title ? ` (${vm.labels.title})` : ""}`);
    await b.destroy(vm.name);
  }
  if (options.all) {
    fs.rmSync(paths.home, { recursive: true, force: true });
    out(`  - ${paths.home}`);
  } else {
    fs.rmSync(paths.run, { recursive: true, force: true });
  }
  const left: string[] = [];
  for (const vm of await b.list()) left.push(`VM ${vm.name}`);
  if (options.all && fs.existsSync(paths.home)) left.push(paths.home);
  out(left.length === 0 ? "destroy: nothing of this stack is left." : `destroy: STILL PRESENT: ${left.join(", ")}`);
  return left;
};
